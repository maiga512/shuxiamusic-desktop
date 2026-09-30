import vm from 'node:vm'
import crypto from 'node:crypto'
import { parentPort, isMainThread } from 'node:worker_threads'

if (isMainThread) {
  throw new Error('pluginWorker.mjs must run inside a worker thread')
}

const API_VERSION = '1.0.4'
const ENVIRONMENT = 'nodejs'
const INIT_SYNC_TIMEOUT_MS = 5000
const DEFAULT_REQUEST_TIMEOUT_MS = 10000
const LOG_RATE_PER_SECOND = 50
const NOTICE_RATE_PER_SECOND = 20
const THROTTLE_RATE_PER_SECOND = 5

let pluginId = ''
let pluginExports = null
let sandboxContext = null
const activeTimers = new Set()

class RateLimiter {
  constructor(limit) {
    this.limit = limit
    this.windowStart = 0
    this.count = 0
  }

  allow(now = Date.now()) {
    if (now - this.windowStart >= 1000) {
      this.windowStart = now
      this.count = 0
    }
    if (this.count < this.limit) {
      this.count++
      return true
    }
    return false
  }
}

const logLimiter = new RateLimiter(LOG_RATE_PER_SECOND)
const noticeLimiter = new RateLimiter(NOTICE_RATE_PER_SECOND)
const throttleLimiter = new RateLimiter(THROTTLE_RATE_PER_SECOND)

const send = (message) => parentPort?.postMessage(message)

const safeSerialize = (value) => {
  if (value == null) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

const serializeLogArg = (value) => {
  if (value == null) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Error) return value.message
  return safeSerialize(value)
}

const validateEncoding = (encoding) => {
  const supported = ['base64', 'hex', 'utf8', 'utf-8', 'latin1', 'binary']
  if (encoding && !supported.includes(String(encoding).toLowerCase())) {
    throw new Error(`Unsupported encoding: ${encoding}`)
  }
  return encoding || 'utf8'
}

const buildCryptoApi = () => ({
  aesEncrypt(data, mode, key, iv) {
    const algorithm = String(mode || '').toLowerCase().includes('ecb') ? 'aes-128-ecb' : 'aes-128-cbc'
    const cipher = crypto.createCipheriv(
      algorithm,
      Buffer.isBuffer(key) ? key : Buffer.from(key || ''),
      algorithm.endsWith('ecb') ? null : Buffer.isBuffer(iv) ? iv : Buffer.from(iv || '')
    )
    const input = Buffer.isBuffer(data) ? data : typeof data === 'string' ? Buffer.from(data) : Buffer.from(JSON.stringify(data))
    return Buffer.concat([cipher.update(input), cipher.final()])
  },
  md5(value) {
    return crypto.createHash('md5').update(value).digest('hex')
  },
  sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex')
  },
  randomBytes(size) {
    return crypto.randomBytes(Math.max(0, Number(size) || 0))
  },
  rsaEncrypt(data, key) {
    return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(data))).toString('base64')
  }
})

const parseResponseBody = async (response) => {
  const contentType = response.headers.get('content-type') || ''
  try {
    if (contentType.includes('application/json')) return await response.json()
    // Audio/binary streams are only fetched so plugins can observe redirects
    // and auth headers. Never materialize the full body into the worker.
    if (isBinaryMediaContentType(contentType)) return null
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  } catch (error) {
    return { error: 'Parse failed', message: error?.message, statusCode: response.status }
  }
}

const isBinaryMediaContentType = (contentType = '') => {
  const value = String(contentType || '').toLowerCase()
  return (
    value.includes('audio/') ||
    value.includes('video/') ||
    value.includes('octet-stream') ||
    value.includes('application/ogg') ||
    value.includes('binary/')
  )
}

const normalizeRequestBody = (body) => {
  if (body == null) return undefined
  if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) return body
  if (body instanceof URLSearchParams) return body
  if (Buffer.isBuffer(body)) return body
  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

const buildCerumusicApi = () => {
  const throttles = new Map()
  const isThrottled = () => {
    const now = Date.now()
    for (const [id, item] of throttles) {
      if (now < item.until) return item.reason
      throttles.delete(id)
    }
    return null
  }

  const request = async (url, optionsOrCallback, callback) => {
    let options = {}
    let cb = callback
    if (typeof optionsOrCallback === 'function') {
      cb = optionsOrCallback
    } else if (optionsOrCallback) {
      options = optionsOrCallback
    }

    const run = async () => {
      const throttleReason = isThrottled()
      if (throttleReason) {
        return { body: { error: 'throttled', message: throttleReason, url }, statusCode: 429, headers: {} }
      }

      const timeout = Math.max(1, Number(options.timeout || DEFAULT_REQUEST_TIMEOUT_MS))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout > 1000 ? timeout : timeout * 1000)
      try {
        const response = await fetch(url, {
          method: options.method || 'GET',
          headers: options.headers || undefined,
          body: normalizeRequestBody(options.body),
          signal: controller.signal
        })
        const headers = {}
        response.headers.forEach((value, key) => {
          headers[key] = value
        })
        const contentType = headers['content-type'] || headers['Content-Type'] || ''
        const finalUrl = response.url || url
        // Match Electron: always expose response.url so service plugins
        // (especially Feiniu stream) can return the redirected playable URL.
        if (isBinaryMediaContentType(contentType)) {
          try { response.body?.cancel?.() } catch {}
          return { body: null, statusCode: response.status, headers, url: finalUrl }
        }
        return {
          body: await parseResponseBody(response),
          statusCode: response.status,
          headers,
          url: finalUrl,
        }
      } catch (error) {
        return {
          body: { error: error?.name || 'RequestError', message: error?.message || String(error), url },
          statusCode: error?.name === 'AbortError' ? 408 : 500,
          headers: {}
        }
      } finally {
        clearTimeout(timer)
      }
    }

    if (cb) {
      run().then((result) => cb(null, result)).catch((error) => cb(error, undefined))
      return undefined
    }
    return await run()
  }

  const cryptoApi = buildCryptoApi()
  return {
    env: ENVIRONMENT,
    version: API_VERSION,
    request,
    http: request,
    NoticeCenter(type, data) {
      if (!noticeLimiter.allow()) return
      send({ type: 'notice', noticeType: type, data: safeSerialize(data) })
    },
    stopRequests(reason, durationMs = 30000) {
      if (!throttleLimiter.allow()) return
      const duration = Math.max(0, Number(durationMs) || 30000)
      throttles.set(`throttle_${Date.now()}_${Math.random()}`, {
        reason: String(reason || ''),
        until: Date.now() + duration
      })
      send({ type: 'throttle', reason: String(reason || ''), duration })
    },
    config: {
      async get() {
        return await requestHost('config.get')
      },
      async set(config) {
        return await requestHost('config.set', { config })
      },
      async save(config) {
        return await requestHost('config.set', { config })
      }
    },
    storage: {
      async get(key, fallback = null) {
        return await requestHost('storage.get', { key, fallback })
      },
      async set(key, value) {
        return await requestHost('storage.set', { key, value })
      },
      async remove(key) {
        return await requestHost('storage.remove', { key })
      }
    },
    cache: {
      async get(key, fallback = null) {
        return await requestHost('cache.get', { key, fallback })
      },
      async set(key, value) {
        return await requestHost('cache.set', { key, value })
      },
      async remove(key) {
        return await requestHost('cache.remove', { key })
      }
    },
    logger: buildLoggerApi(),
    log: buildLoggerApi(),
    utils: {
      buffer: {
        from: (data, encoding) => Buffer.from(data, validateEncoding(encoding)),
        bufToString: (buffer, encoding) => Buffer.from(buffer).toString(validateEncoding(encoding))
      },
      crypto: cryptoApi
    }
  }
}

const buildLoggerApi = () => {
  const logger = {}
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    logger[level] = (...args) => {
      if (!logLimiter.allow()) return
      send({ type: 'log', level: level === 'log' ? 'info' : level, args: args.map(serializeLogArg) })
    }
  }
  return logger
}

const buildConsoleProxy = () => {
  const logger = buildLoggerApi()
  return {
    ...logger,
    trace: logger.debug,
    group: logger.info,
    groupCollapsed: logger.info,
    groupEnd: () => {}
  }
}

const buildTimerApis = () => {
  const wrappedSetTimeout = (cb, ms, ...args) => {
    const timer = setTimeout((...innerArgs) => {
      activeTimers.delete(timer)
      try {
        cb(...innerArgs)
      } catch (error) {
        send({ type: 'log', level: 'error', args: ['[plugin-timer]', error?.message || String(error)] })
      }
    }, ms, ...args)
    activeTimers.add(timer)
    return timer
  }
  const wrappedSetInterval = (cb, ms, ...args) => {
    const timer = setInterval((...innerArgs) => {
      try {
        cb(...innerArgs)
      } catch (error) {
        send({ type: 'log', level: 'error', args: ['[plugin-interval]', error?.message || String(error)] })
      }
    }, ms, ...args)
    activeTimers.add(timer)
    return timer
  }
  const wrappedClearTimer = (timer) => {
    activeTimers.delete(timer)
    clearTimeout(timer)
    clearInterval(timer)
  }
  return { wrappedSetTimeout, wrappedSetInterval, wrappedClearTimer }
}

const requestHost = (method, payload = {}) => new Promise((resolve, reject) => {
  const id = `host_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const onMessage = (message) => {
    if (message?.type !== 'host-response' || message.id !== id) return
    parentPort.off('message', onMessage)
    message.ok ? resolve(message.result) : reject(new Error(message.error || 'host request failed'))
  }
  parentPort.on('message', onMessage)
  send({ id, type: 'host-request', method, payload })
})

const createSandbox = () => {
  const moduleObj = { exports: {} }
  const cerumusic = buildCerumusicApi()
  const timers = buildTimerApis()
  const sandbox = {
    module: moduleObj,
    exports: moduleObj.exports,
    cerumusic,
    console: buildConsoleProxy(),
    setTimeout: timers.wrappedSetTimeout,
    clearTimeout: timers.wrappedClearTimer,
    setInterval: timers.wrappedSetInterval,
    clearInterval: timers.wrappedClearTimer,
    Buffer,
    JSON,
    Math,
    Date,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Promise,
    fetch,
    crypto: buildCryptoApi(),
    process: { env: { NODE_ENV: 'production' } },
    require(name) {
      const moduleName = String(name || '')
      if (moduleName === 'crypto') return crypto
      if (moduleName === 'buffer') return { Buffer }
      throw new Error(`require(${moduleName}) is not available in plugin sandbox`)
    }
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.global = sandbox

  const context = vm.createContext(sandbox, {
    name: `ceru-plugin-worker:${pluginId || 'unknown'}`,
    codeGeneration: { strings: true, wasm: false }
  })
  vm.runInContext(`
    'use strict';
    try {
      const guarded = [Buffer, Promise, Date, URL, URLSearchParams, TextEncoder, TextDecoder];
      for (const item of guarded) {
        try { Object.freeze(item); } catch (_) {}
        try { Object.freeze(item.prototype); } catch (_) {}
      }
    } catch (_) {}
  `, context, { timeout: 1000 })
  return { context, moduleObj, cerumusic }
}

const snapshotMeta = () => ({
  pluginInfo: safeSerialize(pluginExports?.pluginInfo) || null,
  sources: safeSerialize(pluginExports?.sources || pluginExports?.supportedSources || []),
  pluginType: pluginExports?.pluginType || 'music-source',
  configSchema: safeSerialize(pluginExports?.configSchema || []),
  hasMethods: Object.fromEntries(
    ['search', 'request', 'musicUrl', 'getMusicUrl', 'getSongUrl', 'getPic', 'getLyric', 'testConnection', 'getPlaylists', 'getPlaylistSongs', 'onConfigUpdate']
      .map((method) => [method, typeof pluginExports?.[method] === 'function'])
  )
})

const initPlugin = ({ pluginCode, pluginId: nextPluginId }) => {
  pluginId = String(nextPluginId || '')
  const { context, moduleObj } = createSandbox()
  sandboxContext = context
  vm.runInContext(String(pluginCode || ''), context, {
    timeout: INIT_SYNC_TIMEOUT_MS,
    displayErrors: true
  })
  pluginExports = moduleObj.exports
  if (!pluginExports || typeof pluginExports !== 'object') {
    throw new Error('Plugin did not export a module.exports object')
  }
  if (!pluginExports.pluginInfo) {
    throw new Error('Invalid plugin structure. Required field: pluginInfo')
  }
  if (!pluginExports.pluginType) pluginExports.pluginType = 'music-source'
  return snapshotMeta()
}

const invokePlugin = async ({ method, args = [] }) => {
  if (!pluginExports) throw new Error('Plugin not initialized')
  const fn = pluginExports[method]
  if (typeof fn !== 'function') throw new Error(`Action "${method}" is not implemented in plugin`)
  const cerumusic = sandboxContext?.cerumusic
  return safeSerialize(await fn.call({ cerumusic }, ...(Array.isArray(args) ? args : [])))
}

const clearTimers = () => {
  for (const timer of activeTimers) {
    clearTimeout(timer)
    clearInterval(timer)
  }
  activeTimers.clear()
}

parentPort.on('message', async (message) => {
  if (!message?.id) return
  try {
    if (message.type === 'init') {
      const meta = initPlugin(message)
      send({ id: message.id, type: 'init-ok', meta })
      return
    }
    if (message.type === 'invoke') {
      const data = await invokePlugin(message)
      send({ id: message.id, type: 'result', data })
      return
    }
    if (message.type === 'dispose') {
      clearTimers()
      send({ id: message.id, type: 'disposed' })
      process.exit(0)
    }
    throw new Error(`Unsupported worker message: ${message.type}`)
  } catch (error) {
    send({
      id: message.id,
      type: 'error',
      error: {
        name: error?.name || 'PluginWorkerError',
        message: error?.message || String(error),
        stack: error?.stack,
        method: message.method
      }
    })
  }
})

setInterval(() => {
  send({ type: 'heartbeat', ts: Date.now() })
}, 1000).unref()
