/**
 * 前端插件沙箱 (Plugin Sandbox)
 *
 * 在 WebView 中直接执行插件 JS 代码，提供与 Electron VM 沙箱兼容的
 * 树夏Music 插件 Host API（兼容名 cerumusic）。HTTP 请求和加密操作通过 Tauri invoke 委托给 Rust。
 *
 * 使用方式：
 *   const sandbox = new PluginSandbox()
 *   await sandbox.load('my-plugin', jsCode)
 *   const result = await sandbox.call('my-plugin', 'getPlaylists')
 *   sandbox.unload('my-plugin')
 */

import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import * as CryptoJS from 'crypto-js'
import { BufferShim } from '../../stubs/buffer-polyfill'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PluginExports {
  pluginInfo?: { name: string; version: string; author: string; description: string }
  pluginType?: 'music-source' | 'service'
  sources?: string[]
  configSchema?: any[]
  __cerumusic?: any
  [key: string]: any
}

export interface HttpRequestResult {
  body: any
  statusCode: number
  headers: Record<string, string>
}

function normalizeBytes(input: any): Uint8Array {
  if (input instanceof BufferShim) return input.toUint8Array()
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (Array.isArray(input)) return new Uint8Array(input)
  return BufferShim.from(String(input ?? '')).toUint8Array()
}

function toCryptoWordArray(input: any) {
  const bytes = normalizeBytes(input)
  const words: number[] = []
  for (let i = 0; i < bytes.length; i++) {
    words[i >>> 2] |= bytes[i] << (24 - (i % 4) * 8)
  }
  return CryptoJS.lib.WordArray.create(words, bytes.length)
}

function cryptoMode(mode: string) {
  return String(mode || '').toLowerCase().includes('ecb') ? CryptoJS.mode.ECB : CryptoJS.mode.CBC
}

function cryptoPadding(_mode: string) {
  return CryptoJS.pad.Pkcs7
}

function createNodeCryptoShim() {
  return {
    createHash: (algorithm: string) => {
      const chunks: any[] = []
      const hashApi = {
        update: (data: any) => {
          chunks.push(data)
          return hashApi
        },
        digest: (encoding?: string) => {
          const joined = chunks.map((chunk) => BufferShim.from(chunk).toString()).join('')
          const hash = String(algorithm).toLowerCase() === 'md5'
            ? CryptoJS.MD5(joined)
            : CryptoJS.SHA256(joined)
          if (encoding === 'base64') return CryptoJS.enc.Base64.stringify(hash)
          return hash.toString(CryptoJS.enc.Hex)
        },
      }
      return hashApi
    },
    randomBytes: (size: number) => {
      const bytes = new Uint8Array(Math.max(0, Number(size) || 0))
      globalThis.crypto?.getRandomValues?.(bytes)
      return BufferShim.from(bytes)
    },
  }
}

/* ------------------------------------------------------------------ */
/*  树夏Music API Factory                                              */
/* ------------------------------------------------------------------ */

function createShuxiumusicApi(pluginId?: string, pluginInfo?: PluginExports['pluginInfo']) {
  const requestQueue = new Map<string, { reason: string; until: number }>()

  function isThrottled(): string | null {
    const now = Date.now()
    for (const [id, entry] of requestQueue) {
      if (now < entry.until) return entry.reason
      requestQueue.delete(id)
    }
    return null
  }

  function normalizeRequestTimeoutSeconds(timeout: any): number {
    const value = Number(timeout)
    if (!Number.isFinite(value) || value <= 0) return 10
    return value > 1000 ? Math.ceil(value / 1000) : value
  }

  function normalizeRequestBody(body: any): string | undefined {
    if (body == null) return undefined
    if (typeof body === 'string') return body
    if (body instanceof URLSearchParams) return body.toString()
    if (body instanceof BufferShim) return body.toString()
    if (body instanceof Uint8Array) return BufferShim.from(body).toString()
    try {
      return JSON.stringify(body)
    } catch {
      return String(body)
    }
  }

  return {
    env: 'nodejs',
    version: '1.0.4',

    /**
     * HTTP 请求代理 — 匹配 Electron sandbox 的 cerumusic.request()
     *
     * 签名 1 (回调): request(url, options, callback)
     * 签名 2 (Promise): request(url, options) → Promise
     * 签名 3 (简化): request(url, callback)
     */
    request: async (
      url: string,
      optionsOrCallback?: any,
      callback?: (err: any, result?: HttpRequestResult) => void,
    ): Promise<HttpRequestResult | void> => {
      // 解析参数: 支持 request(url, callback) 简写
      let options: any = {}
      let cb: ((err: any, result?: HttpRequestResult) => void) | undefined = callback

      if (typeof optionsOrCallback === 'function') {
        cb = optionsOrCallback
      } else if (optionsOrCallback != null) {
        options = optionsOrCallback
      }

      // 限流检查
      const throttleReason = isThrottled()
      if (throttleReason) {
        const err = { body: { error: 'throttled', message: throttleReason, url }, statusCode: 429 }
        cb?.(err)
        return
      }

      try {
        const result: any = await invoke('plugin_http_request', {
          url,
          options: {
            method: options.method || 'GET',
            headers: options.headers || undefined,
            body: normalizeRequestBody(options.body),
            timeout: normalizeRequestTimeoutSeconds(options.timeout),
          },
        })

        // 自动解析 JSON 响应体
        let parsedBody: any = result.body
        if (typeof result.body === 'string') {
          try {
            parsedBody = JSON.parse(result.body)
          } catch {
            // 不是 JSON，保持原样
          }
        }

        const response: HttpRequestResult = {
          body: parsedBody,
          statusCode: result.status,
          headers: result.headers || {},
        }

        cb?.(null, response)
        return response
      } catch (e: any) {
        const err = { body: { error: e?.name || 'RequestError', message: String(e?.message || e), url }, statusCode: 500, headers: {} }
        cb?.(err, undefined)
        if (cb) return undefined
        return err
      }
    },

    utils: {
      /**
       * Buffer 工具 — 包装 BufferShim
       */
      buffer: {
        from: (data: string | Uint8Array, encoding?: string) => BufferShim.from(data, encoding),
        bufToString: (buffer: any, encoding?: string) => {
          if (buffer instanceof BufferShim) return buffer.toString(encoding)
          if (buffer instanceof Uint8Array) return new TextDecoder().decode(buffer)
          return String(buffer)
        },
      },

      /**
       * 加密工具 — 委托给 Rust
       */
      crypto: {
        md5: (data: string): string => CryptoJS.MD5(data).toString(),
        sha256: (data: string): string => CryptoJS.SHA256(data).toString(),

        randomBytes: (size: number): BufferShim => {
          const bytes = new Uint8Array(Math.max(0, Number(size) || 0))
          globalThis.crypto?.getRandomValues?.(bytes)
          return BufferShim.from(bytes)
        },

        aesEncrypt: (
          data: any,
          mode: string,
          key: any,
          iv?: any,
        ): BufferShim => {
          const encrypted = CryptoJS.AES.encrypt(toCryptoWordArray(data), toCryptoWordArray(key), {
            iv: cryptoMode(mode) === CryptoJS.mode.ECB ? undefined : toCryptoWordArray(iv || ''),
            mode: cryptoMode(mode),
            padding: cryptoPadding(mode),
          })
          return BufferShim.from(CryptoJS.enc.Base64.stringify(encrypted.ciphertext), 'base64')
        },

        rsaEncrypt: (_data: string, _key: string): string => {
          console.warn('[plugin-sandbox] RSA 加密暂未实现')
          return ''
        },
      },
    },

    /**
     * 通知中心 — 向 UI 发送通知
     */
    NoticeCenter: (type: string, data: any) => {
      // 原始 notice；tauri-bridge.normalizeDialogNotice 会格式化成弹窗数据
      emit('plugin-notice', {
        type,
        data,
        pluginId,
        pluginName: pluginInfo?.name,
        currentVersion: pluginInfo?.version,
        updateUrl: data?.url || data?.updateUrl,
        pluginType: data?.pluginInfo?.type,
        newVersion: data?.version,
        title: data?.title,
        message: data?.content || data?.message,
      }).catch(console.warn)
    },

    /**
     * 请求限流 — 暂停后续请求一段时间
     */
    stopRequests: (reason: string, durationMs?: number) => {
      const throttleId = `throttle_${Date.now()}_${Math.random()}`
      const duration = durationMs ?? 30000
      requestQueue.set(throttleId, {
        reason,
        until: Date.now() + duration,
      })
      emit('plugin-throttle', { pluginId, reason, duration }).catch(console.warn)
    },
  }
}

/* ------------------------------------------------------------------ */
/*  Plugin Sandbox                                                     */
/* ------------------------------------------------------------------ */

export class PluginSandbox {
  private plugins = new Map<string, PluginExports>()
  private timers = new Map<string, Set<number>>()

  /**
   * 加载并执行插件 JS 代码
   * @param id 插件唯一 ID
   * @param code 插件 JS 源码
   * @returns 插件导出的 API
   */
  async load(id: string, code: string): Promise<PluginExports> {
    if (this.plugins.has(id)) {
      console.warn(`[plugin-sandbox] 插件 ${id} 已加载，跳过`)
      return this.plugins.get(id)!
    }

    const mod = { exports: {} as any }
    const cerumusic = createShuxiumusicApi(id)
    const timerSet = new Set<number>()
    this.timers.set(id, timerSet)
    const nodeCrypto = createNodeCryptoShim()
    const processShim = { env: { NODE_ENV: 'production' } }
    const requireShim = (name: string) => {
      const moduleName = String(name || '')
      if (moduleName === 'crypto') return nodeCrypto
      if (moduleName === 'buffer') return { Buffer: BufferShim }
      throw new Error(`require(${moduleName}) is not available in plugin sandbox`)
    }
    const globalScope: Record<string, any> = {
      module: mod,
      exports: mod.exports,
      cerumusic,
      // 新名别名：老插件继续用 cerumusic，新插件可用 shuxiaMusic。
      shuxiaMusic: cerumusic,
      console,
      Buffer: BufferShim,
      BufferShim,
      JSON,
      Math,
      Date,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      Promise,
      crypto: nodeCrypto,
      process: processShim,
      require: requireShim,
    }
    globalScope.globalThis = globalScope
    globalScope.window = globalScope
    globalScope.self = globalScope
    globalScope.global = globalScope

    // 安全的 setTimeout/setInterval — 可追踪清理
    const safeSetTimeout = (fn: Function, ms?: number): number => {
      const id = window.setTimeout(fn, ms)
      timerSet.add(id)
      return id
    }
    const safeClearTimeout = (id: number) => {
      timerSet.delete(id)
      window.clearTimeout(id)
    }
    const safeSetInterval = (fn: Function, ms?: number): number => {
      const id = window.setInterval(fn, ms)
      timerSet.add(id)
      return id
    }
    const safeClearInterval = (id: number) => {
      timerSet.delete(id)
      window.clearInterval(id)
    }
    globalScope.setTimeout = safeSetTimeout
    globalScope.clearTimeout = safeClearTimeout
    globalScope.setInterval = safeSetInterval
    globalScope.clearInterval = safeClearInterval

    try {
      // 使用 Function 构造函数创建隔离作用域
      const fn = new Function(
        'module',
        'exports',
        'cerumusic',
        'shuxiaMusic',
        'console',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Buffer',
        'BufferShim',
        'globalThis',
        'window',
        'self',
        'global',
        'process',
        'require',
        'URL',
        'URLSearchParams',
        'TextEncoder',
        'TextDecoder',
        code,
      )

      fn.call(
        globalScope,
        mod,
        mod.exports,
        cerumusic,
        cerumusic,
        console,
        safeSetTimeout,
        safeClearTimeout,
        safeSetInterval,
        safeClearInterval,
        BufferShim,
        BufferShim,
        globalScope,
        globalScope,
        globalScope,
        globalScope,
        processShim,
        requireShim,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
      )
    } catch (e) {
      this.timers.delete(id)
      console.error(`[plugin-sandbox] 插件 ${id} 加载失败:`, e)
      throw new Error(`插件 ${id} 加载失败: ${e instanceof Error ? e.message : String(e)}`)
    }

    // 验证插件导出了必要字段（对齐 Electron：pluginInfo 必须，pluginType 缺失默认 music-source）
    const exports = mod.exports as PluginExports
    if (!exports.pluginInfo) {
      this.timers.delete(id)
      throw new Error(`插件 ${id} 缺少 pluginInfo`)
    }
    if (!exports.pluginType) {
      exports.pluginType = 'music-source'
    }
    Object.defineProperty(exports, '__cerumusic', {
      value: cerumusic,
      enumerable: false,
      configurable: true,
    })

    this.plugins.set(id, exports)
    console.log(`[plugin-sandbox] 插件 ${id} (${exports.pluginInfo.name}) 加载成功`)
    return exports
  }

  /**
   * 调用插件的方法
   */
  async call<T = any>(id: string, method: string, ...args: any[]): Promise<T> {
    const plugin = this.plugins.get(id)
    if (!plugin) throw new Error(`插件 ${id} 未加载`)
    const fn = plugin[method]
    if (typeof fn !== 'function') throw new Error(`插件 ${id} 没有导出 ${method} 方法`)
    const cerumusic = plugin.__cerumusic || createShuxiumusicApi(id, plugin.pluginInfo)
    return fn.call({ cerumusic, shuxiaMusic: cerumusic }, ...args) as T
  }

  /**
   * 获取插件导出
   */
  get(id: string): PluginExports | undefined {
    return this.plugins.get(id)
  }

  /**
   * 列出所有已加载的插件
   */
  list(): Array<{ id: string; exports: PluginExports }> {
    const result: Array<{ id: string; exports: PluginExports }> = []
    this.plugins.forEach((exports, id) => {
      result.push({ id, exports })
    })
    return result
  }

  /**
   * 卸载插件并清理定时器
   */
  unload(id: string): boolean {
    // 清理所有定时器
    const timerSet = this.timers.get(id)
    if (timerSet) {
      timerSet.forEach((tid) => {
        window.clearTimeout(tid)
        window.clearInterval(tid)
      })
      this.timers.delete(id)
    }
    return this.plugins.delete(id)
  }

  /**
   * 卸载所有插件
   */
  clear() {
    this.plugins.forEach((_exports, id) => this.unload(id))
  }
}

/** 全局单例 */
export const pluginSandbox = new PluginSandbox()

export default PluginSandbox
