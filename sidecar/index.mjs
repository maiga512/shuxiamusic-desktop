import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { service as musicSdkService } from './services/musicSdk/index.mjs'
import { service as pluginService } from './services/plugins/index.mjs'
import { service as downloadService } from './services/download/index.mjs'
import { service as systemService } from './services/system/index.mjs'
import { service as autoUpdateService } from './services/system/autoUpdate.mjs'
import { service as notificationService } from './services/system/notification.mjs'
import { service as windowLifecycleService } from './services/system/windowLifecycle.mjs'

const startedAt = Date.now()

const protocolConsole = globalThis.console
globalThis.console = {
  ...protocolConsole,
  log: (...args) => protocolConsole.error(...args),
  info: (...args) => protocolConsole.error(...args),
  debug: (...args) => protocolConsole.error(...args),
}

globalThis.__ceruSidecarEmit = (event, payload) => sendEvent(event, payload)

globalThis.__ceruSidecarReady = { startedAt }

const services = {
  async health() {
    return {
      ok: true,
      runtime: 'node-sidecar',
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      startedAt
    }
  },

  async echo(payload) {
    return payload ?? null
  },

  async 'music.sdk.health'() {
    return await musicSdkService.health()
  },

  async 'music.sdk.request'(payload) {
    return await musicSdkService.request(payload)
  },

  async 'music.sdk.probeDownloadUrl'(payload) {
    return await musicSdkService.probeDownloadUrl(payload)
  },

  async 'plugin.health'() {
    return await pluginService.health()
  },

  async 'plugin.initializeSystem'() {
    return await pluginService.initializeSystem()
  },

  async 'plugin.loadAll'() {
    return await pluginService.loadAll()
  },

  async 'plugin.installFromCode'(payload) {
    return await pluginService.installFromCode(payload)
  },

  async 'plugin.addPlugin'(payload) {
    return await pluginService.addPlugin(payload)
  },

  async 'plugin.downloadAndAdd'(payload) {
    return await pluginService.downloadAndAdd(payload)
  },

  async 'plugin.uninstall'(payload) {
    return await pluginService.uninstall(payload)
  },

  async 'plugin.getConfig'(payload) {
    return await pluginService.getConfig(payload)
  },

  async 'plugin.getPluginCode'(payload) {
    return await pluginService.getPluginCode(payload)
  },

  async 'plugin.saveConfig'(payload) {
    return await pluginService.saveConfig(payload)
  },

  async 'plugin.getConfigSchema'(payload) {
    return await pluginService.getConfigSchema(payload)
  },

  async 'plugin.getPluginType'(payload) {
    return await pluginService.getPluginType(payload)
  },

  async 'plugin.getServiceRole'(payload) {
    return await pluginService.getServiceRole(payload)
  },

  async 'plugin.reloadAll'() {
    return await pluginService.reloadAll()
  },

  async 'plugin.getLog'(payload) {
    return await pluginService.getLog(payload)
  },

  async 'plugin.invoke'(payload) {
    return await pluginService.invoke(payload)
  },

  async 'plugin.pin'(payload) {
    return await pluginService.pin(payload)
  },

  async 'plugin.unpin'(payload) {
    return await pluginService.unpin(payload)
  },

  async 'plugin.notice'(payload) {
    return await pluginService.notice(payload)
  },

  async 'download.health'() {
    return await downloadService.health()
  },

  async 'download.getTasks'() {
    return await downloadService.getTasks()
  },

  async 'download.addTask'(payload) {
    return await downloadService.addTask(payload)
  },

  async 'download.addTasks'(payload) {
    return await downloadService.addTasks(payload)
  },

  async 'download.updateTaskStatus'(payload) {
    return await downloadService.updateTaskStatus(payload)
  },

  async 'download.pauseTask'(payload) {
    return await downloadService.pauseTask(payload)
  },

  async 'download.resumeTask'(payload) {
    return await downloadService.resumeTask(payload)
  },

  async 'download.cancelTask'(payload) {
    return await downloadService.cancelTask(payload)
  },

  async 'download.deleteTask'(payload) {
    return await downloadService.deleteTask(payload)
  },

  async 'download.clearTasks'(payload) {
    return await downloadService.clearTasks(payload)
  },

  async 'download.pauseAllTasks'() {
    return await downloadService.pauseAllTasks()
  },

  async 'download.resumeAllTasks'() {
    return await downloadService.resumeAllTasks()
  },

  async 'download.retryTask'(payload) {
    return await downloadService.retryTask(payload)
  },

  async 'download.validateFiles'() {
    return await downloadService.validateFiles()
  },

  async 'download.getMaxConcurrent'() {
    return await downloadService.getMaxConcurrent()
  },

  async 'download.setMaxConcurrent'(payload) {
    return await downloadService.setMaxConcurrent(payload)
  },

  async 'download.setDownloadDir'(payload) {
    return await downloadService.setDownloadDir(payload)
  },

  // 下载列表里"文件夹"图标：在 Finder/资源管理器里定位已下载的文件。
  // 服务实现早已存在（services/download/index.mjs 的 openFileLocation），
  // 但此前漏注册路由，调用会抛 "Unsupported sidecar method"，
  // 被 tauri-bridge 静默吞掉 → 点图标毫无反应。
  async 'download.openFileLocation'(payload) {
    return await downloadService.openFileLocation(payload)
  },

  async 'music.url.cache.get'(payload) {
    return await downloadService.urlCacheGet(payload)
  },

  async 'music.url.cache.save'(payload) {
    return await downloadService.urlCacheSave(payload)
  },

  async 'music.url.cache.invalidate'(payload) {
    return await downloadService.urlCacheInvalidate(payload)
  },

  async 'music.url.cache.clear'() {
    return await downloadService.urlCacheClear()
  },

  async 'music.cache.getInfo'() {
    return await downloadService.musicCacheGetInfo()
  },

  async 'music.cache.getSize'() {
    return await downloadService.musicCacheGetSize()
  },

  async 'music.cache.clear'() {
    return await downloadService.musicCacheClear()
  },

  async 'system.health'() {
    return await systemService.health()
  },

  async 'system.hotkeys.get'(payload) {
    return await systemService.getHotkeys(payload)
  },

  async 'system.hotkeys.set'(payload) {
    return await systemService.setHotkeys(payload)
  },

  async 'system.hotkeys.validate'(payload) {
    return await systemService.validateHotkeys(payload)
  },

  async 'system.hotkeys.entriesToConfig'(payload) {
    return await systemService.entriesToHotkeyConfig(payload)
  },

  async 'system.hotkeys.configToEntries'(payload) {
    return await systemService.hotkeyConfigToEntries(payload)
  },

  async 'system.autoUpdate.health'() {
    return await autoUpdateService.health()
  },

  async 'system.autoUpdate.getState'() {
    return await autoUpdateService.getState()
  },

  async 'system.autoUpdate.recordChecking'() {
    return await autoUpdateService.recordChecking()
  },

  async 'system.autoUpdate.recordCheckResult'(payload) {
    return await autoUpdateService.recordCheckResult(payload)
  },

  async 'system.autoUpdate.recordDownloadStarted'(payload) {
    return await autoUpdateService.recordDownloadStarted(payload)
  },

  async 'system.autoUpdate.recordProgress'(payload) {
    return await autoUpdateService.recordProgress(payload)
  },

  async 'system.autoUpdate.recordDownloaded'(payload) {
    return await autoUpdateService.recordDownloaded(payload)
  },

  async 'system.autoUpdate.recordPending'() {
    return await autoUpdateService.recordPending()
  },

  async 'system.autoUpdate.recordError'(payload) {
    return await autoUpdateService.recordError(payload)
  },

  async 'system.autoUpdate.recordEvent'(payload) {
    return await autoUpdateService.recordEvent(payload)
  },

  async 'system.autoUpdate.reset'() {
    return await autoUpdateService.reset()
  },

  async 'system.notification.health'() {
    return await notificationService.health()
  },

  async 'system.notification.getState'() {
    return await notificationService.getState()
  },

  async 'system.notification.setPolicy'(payload) {
    return await notificationService.setPolicy(payload)
  },

  async 'system.notification.record'(payload) {
    return await notificationService.record(payload)
  },

  async 'system.notification.clearHistory'() {
    return await notificationService.clearHistory()
  },

  async 'system.windowLifecycle.health'() {
    return await windowLifecycleService.health()
  },

  async 'system.windowLifecycle.getState'() {
    return await windowLifecycleService.getState()
  },

  async 'system.windowLifecycle.setCloseToTray'(payload) {
    return await windowLifecycleService.setCloseToTray(payload)
  },

  async 'system.windowLifecycle.recordWindowState'(payload) {
    return await windowLifecycleService.recordWindowState(payload)
  },

  async 'system.windowLifecycle.updateTray'(payload) {
    return await windowLifecycleService.updateTray(payload)
  },

  async 'system.windowLifecycle.decideClose'(payload) {
    return await windowLifecycleService.decideClose(payload)
  },

  async 'system.windowLifecycle.decideTrayLeftClick'(payload) {
    return await windowLifecycleService.decideTrayLeftClick(payload)
  }
}

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const sendEvent = (event, payload) => {
  send({ type: 'event', event, payload })
}

const sendResult = (id, result) => {
  send({ type: 'response', id, ok: true, result })
}

const sendError = (id, error) => {
  send({
    type: 'response',
    id,
    ok: false,
    error: error instanceof Error ? error.message : String(error || 'unknown sidecar error')
  })
}

const dispatch = async (request) => {
  const { id, method, payload } = request || {}
  if (!id) return
  try {
    const handler = services[method]
    if (!handler) {
      throw new Error(`Unsupported sidecar method: ${method}`)
    }
    const result = await handler(payload)
    sendResult(id, result)
  } catch (error) {
    sendError(id, error)
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
})

let shuttingDown = false
const shutdown = () => {
  if (shuttingDown) return
  shuttingDown = true
  try {
    rl.close()
  } catch {}
  process.exit(0)
}

process.stdin.on('end', shutdown)
process.stdin.on('error', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('disconnect', shutdown)
rl.on('close', shutdown)

const SIDECAR_MAX_CONCURRENCY = (() => {
  const raw = process.env.CERU_SIDECAR_CONCURRENCY
  if (raw == null || raw.trim() === '') return Number.POSITIVE_INFINITY
  const configured = Number.parseInt(raw, 10)
  if (!Number.isFinite(configured) || configured <= 0) return Number.POSITIVE_INFINITY
  return Math.min(configured, 128)
})()
const requestQueue = []
let activeRequestCount = 0

const drainRequestQueue = () => {
  while (activeRequestCount < SIDECAR_MAX_CONCURRENCY && requestQueue.length > 0) {
    const request = requestQueue.shift()
    activeRequestCount += 1
    void dispatch(request)
      .catch((error) => {
        sendError(request?.id || randomUUID(), error)
      })
      .finally(() => {
        activeRequestCount -= 1
        drainRequestQueue()
      })
  }
}

rl.on('line', (line) => {
  const raw = line.trim()
  if (!raw) return
  try {
    const request = JSON.parse(raw)
    requestQueue.push(request)
    drainRequestQueue()
  } catch (error) {
    sendError(randomUUID(), error)
  }
})

process.on('uncaughtException', (error) => {
  sendEvent('sidecar:error', {
    message: error.message,
    stack: error.stack
  })
})

process.on('unhandledRejection', (reason) => {
  sendEvent('sidecar:error', {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  })
})

sendEvent('sidecar:ready', {
  pid: process.pid,
  startedAt
})
