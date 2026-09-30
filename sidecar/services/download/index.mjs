import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import axios from 'axios'
import { pipeline } from 'node:stream/promises'

const AUDIO_CACHE_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.wma', '.ape', '.dsf'])
const DEFAULT_IDENTIFIER = 'com.cerumusic.tauri'

const state = {
  initialized: false,
  appDataDir: '',
  cacheDir: '',
  downloadDir: '',
  urlCachePath: '',
  downloadTasksPath: '',
  urlCache: new Map(),
  tasks: new Map(),
  queue: [],
  active: new Map(),
  maxConcurrent: 3,
}

function now() {
  return Date.now()
}

function emit(event, payload) {
  try {
    if (typeof globalThis.__ceruSidecarEmit === 'function') {
      globalThis.__ceruSidecarEmit(event, payload)
    }
  } catch {}
}

function homeDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', DEFAULT_IDENTIFIER)
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), DEFAULT_IDENTIFIER)
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), DEFAULT_IDENTIFIER)
}

function resolveAppDataDir() {
  return path.resolve(
    process.env.CERU_TAURI_APP_DATA_DIR ||
      process.env.CERU_APP_DATA_DIR ||
      homeDataDir()
  )
}

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return index === 0 ? `${value} ${units[index]}` : `${size.toFixed(2)} ${units[index]}`
}

function firstText(...items) {
  for (const item of items) {
    if (typeof item === 'string' && item.trim()) return item.trim()
    if (typeof item === 'number' && Number.isFinite(item)) return String(item)
  }
  return ''
}

function formatMusicInfo(template, data = {}) {
  const patterns = {
    '%t': ['name', 'title'],
    '%s': ['singer', 'artist'],
    '%a': ['albumName', 'album'],
    '%u': ['source', 'platform'],
    '%d': ['date'],
    '%q': ['quality'],
  }

  const date = new Date()
  const fallbackDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const resultTemplate = String(template || '%t - %s')

  return resultTemplate.replace(/%[tsaudq]/g, (match) => {
    const keys = patterns[match]
    if (!keys) return match
    for (const key of keys) {
      const value = data[key]
      if (value !== undefined && value !== null && String(value).trim()) return String(value)
    }
    if (match === '%d') return fallbackDate
    return match
  })
}

function getFileExtension(url, quality) {
  const normalizedUrl = String(url || '')
  if (normalizedUrl) {
    try {
      const urlObj = new URL(normalizedUrl)
      const pathname = urlObj.pathname
      const lastDotIndex = pathname.lastIndexOf('.')
      if (lastDotIndex !== -1 && lastDotIndex < pathname.length - 1) {
        const extension = pathname.substring(lastDotIndex + 1).toLowerCase()
        const validExtensions = ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'wma']
        if (validExtensions.includes(extension)) {
          return extension
        }
      }
    } catch {}
  }

  const qualityText = String(quality || '').toLowerCase()
  if (qualityText.includes('flac')) return 'flac'
  if (qualityText.includes('m4a')) return 'm4a'
  if (qualityText.includes('ogg')) return 'ogg'
  if (qualityText.includes('wav')) return 'wav'
  return 'mp3'
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function normalizeStatus(status) {
  const value = String(status || '').toLowerCase()
  if (value === 'pending') return 'queued'
  if (value === 'failed') return 'error'
  return value || 'queued'
}

function taskFileName(task) {
  const songInfo = task.songInfo || {}
  const template = firstText(songInfo.template, '%t - %s')
  const quality = firstText(task.quality, task.requestedQuality, songInfo.__nativeMedia?.quality, 'default')
  const date = songInfo.date || ''
  const rawName = formatMusicInfo(template, {
    ...songInfo,
    date,
    quality,
  })
  const extension = getFileExtension(task.url || songInfo.__nativeMedia?.url, quality)
  return `${rawName}.${extension}`
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.+$/g, '')
    .replace(/^\.+/g, '')
    .trim()
}

function normalizeTask(input) {
  if (!input || typeof input !== 'object') return null
  const songInfo = { ...(input.songInfo || input.song_info || input.song || {}) }
  const id = firstText(input.id, input.taskId, input.task_id) || randomUUID()
  const createdAt = Number(input.createdAt ?? input.created_at ?? now())
  const totalSize = Number(input.totalSize ?? input.totalBytes ?? input.total_bytes ?? 0)
  const downloadedSize = Number(input.downloadedSize ?? input.downloadedBytes ?? input.downloaded_bytes ?? 0)
  const speed = Number(input.speed ?? 0)
  const quality = firstText(input.quality, input.requestedQuality, input.requested_quality, songInfo.__nativeMedia?.quality)
  const requestedQuality = firstText(input.requestedQuality, input.requested_quality, quality)
  const source = firstText(input.source, songInfo.source, songInfo.platform)
  return {
    id,
    songInfo: {
      ...songInfo,
      songmid: firstText(songInfo.songmid, songInfo.id, songInfo.mid, songInfo.hash),
      name: firstText(input.name, songInfo.name, songInfo.songName, 'Unknown'),
      singer: firstText(input.singer, songInfo.singer, songInfo.artist, 'Unknown'),
      img: firstText(input.cover, songInfo.img, songInfo.cover),
      source,
      template: firstText(songInfo.template, input.template, '%t - %s'),
    },
    source,
    url: firstText(input.url, songInfo.__nativeMedia?.url),
    pluginId: firstText(input.pluginId, input.plugin_id),
    quality,
    requestedQuality,
    tagWriteOptions: input.tagWriteOptions || input.tag_write_options || {},
    filePath: firstText(input.filePath, input.file_path),
    status: normalizeStatus(input.status),
    progress: Number.isFinite(Number(input.progress ?? 0)) ? Number(input.progress ?? 0) : 0,
    speed: Number.isFinite(speed) ? speed : 0,
    totalSize: Number.isFinite(totalSize) ? totalSize : 0,
    downloadedSize: Number.isFinite(downloadedSize) ? downloadedSize : 0,
    remainingTime: input.remainingTime ?? input.remaining_time ?? null,
    error: input.error ?? input.errorMessage ?? input.error_message ?? null,
    priority: Number(input.priority ?? 0),
    retries: Number(input.retries ?? 0),
    createdAt: Number.isFinite(createdAt) ? createdAt : now(),
  }
}

function taskKey(task) {
  return firstText(task.filePath, task.songInfo?.songmid, task.id)
}

async function persistUrlCache() {
  const payload = Object.fromEntries(state.urlCache.entries())
  await writeJson(state.urlCachePath, payload)
}

async function persistTasks() {
  await writeJson(state.downloadTasksPath, Array.from(state.tasks.values()))
}

async function initializeSystem() {
  if (state.initialized) return

  state.appDataDir = resolveAppDataDir()
  state.cacheDir = path.join(state.appDataDir, 'music-cache')
  state.downloadDir = path.join(state.appDataDir, 'downloads')
  state.urlCachePath = path.join(state.appDataDir, 'url-cache.json')
  state.downloadTasksPath = path.join(state.appDataDir, 'download-tasks.json')

  await fs.mkdir(state.appDataDir, { recursive: true })
  await fs.mkdir(state.cacheDir, { recursive: true })
  await fs.mkdir(state.downloadDir, { recursive: true })

  const rawUrlCache = await readJson(state.urlCachePath, {})
  state.urlCache = new Map(
    Object.entries(rawUrlCache || {})
      .map(([songId, entry]) => {
        if (typeof entry === 'string') return [songId, { url: entry, updatedAt: 0 }]
        return [songId, { url: String(entry?.url || ''), updatedAt: Number(entry?.updatedAt || entry?.updated_at || 0) }]
      })
      .filter(([, entry]) => entry.url)
  )

  const rawTasks = await readJson(state.downloadTasksPath, [])
  const tasks = Array.isArray(rawTasks) ? rawTasks : Array.isArray(rawTasks?.tasks) ? rawTasks.tasks : []
  state.tasks = new Map(tasks.map((task) => normalizeTask(task)).filter(Boolean).map((task) => [task.id, task]))
  state.queue = Array.from(state.tasks.values())
    .filter((task) => task.status === 'queued')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((task) => task.id)

  for (const task of state.tasks.values()) {
    if (task.status === 'downloading') task.status = 'paused'
  }

  state.initialized = true
  await persistTasks()
}

async function setDownloadDir(payload = {}) {
  await initializeSystem()
  const dir = firstText(payload.dir, payload.path, payload.downloadDir)
  if (!dir) throw new Error('下载目录不能为空')
  const resolved = path.resolve(dir)
  await fs.mkdir(resolved, { recursive: true })
  state.downloadDir = resolved
  return { success: true, downloadDir: state.downloadDir }
}

function getTaskList() {
  return Array.from(state.tasks.values()).sort((a, b) => {
    const ap = Number(a.priority ?? 0)
    const bp = Number(b.priority ?? 0)
    if (ap !== bp) return ap - bp
    return Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0)
  })
}

function emitTaskListReset() {
  emit('download:tasks-reset', getTaskList())
}

function buildDownloadHeaders(task) {
  const media = task.songInfo?.__nativeMedia || {}
  const headers = {}
  const rawHeaders = media.headers || task.songInfo?.headers || {}
  if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
    for (const [key, value] of Object.entries(rawHeaders)) {
      const name = String(key || '').trim()
      const text = firstText(value)
      if (name && text) headers[name] = text
    }
  }

  const referrer = firstText(media.referrer, media.referer, task.songInfo?.referrer, task.songInfo?.referer)
  const userAgent = firstText(media.userAgent, media.user_agent, task.songInfo?.userAgent, task.songInfo?.user_agent)

  if (referrer && !Object.keys(headers).some((key) => key.toLowerCase() === 'referer')) {
    headers.Referer = referrer
  }
  if (userAgent && !Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = userAgent
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'accept')) {
    headers.Accept = '*/*'
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'connection')) {
    headers.Connection = 'keep-alive'
  }
  return headers
}

function resolveDownloadFilePath(task) {
  const current = firstText(task.filePath)
  if (current) return current
  return path.join(state.downloadDir, taskFileName(task))
}

async function scanDirectorySize(dirPath) {
  let size = 0
  let count = 0
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        const child = await scanDirectorySize(entryPath)
        size += child.size
        count += child.count
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!AUDIO_CACHE_EXTENSIONS.has(ext)) continue
      const stat = await fs.stat(entryPath).catch(() => null)
      if (!stat) continue
      size += stat.size
      count += 1
    }
  } catch {}
  return { size, count }
}

async function clearAudioCache(dirPath) {
  let deleted = 0
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        deleted += await clearAudioCache(entryPath)
        continue
      }
      if (!entry.isFile()) continue
      if (!AUDIO_CACHE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      await fs.unlink(entryPath).then(() => { deleted += 1 }).catch(() => undefined)
    }
  } catch {}
  return deleted
}

async function updateTask(taskId, patch = {}, eventName = 'download:task-status-changed') {
  const existing = state.tasks.get(taskId)
  if (!existing) return null
  const updated = normalizeTask({ ...existing, ...patch, id: taskId })
  state.tasks.set(taskId, updated)
  await persistTasks()
  if (eventName) emit(eventName, updated)
  return updated
}

function removeFromQueue(taskId) {
  state.queue = state.queue.filter((id) => id !== taskId)
}

function getActiveEntry(taskId) {
  return state.active.get(taskId) || null
}

async function markPaused(taskId) {
  const updated = await updateTask(taskId, { status: 'paused' })
  if (updated) emit('download:task-status-changed', updated)
  return updated
}

async function markCancelled(taskId) {
  const updated = await updateTask(taskId, { status: 'cancelled' })
  if (updated) emit('download:task-status-changed', updated)
  return updated
}

async function markError(taskId, error) {
  const updated = await updateTask(taskId, { status: 'error', error: String(error || '下载失败') })
  if (updated) emit('download:task-error', updated)
  return updated
}

async function markCompleted(taskId) {
  const updated = await updateTask(taskId, { status: 'completed', progress: 100, speed: 0, remainingTime: 0, error: null })
  if (updated) emit('download:task-completed', updated)
  return updated
}

async function finalizeQueuedTasks() {
  await persistTasks()
  emitTaskListReset()
  processQueue().catch((error) => emit('download:task-error', { id: 'queue', error: String(error?.message || error) }))
}

async function performDownload(task, controller) {
  const url = firstText(task.url, task.songInfo?.__nativeMedia?.url, task.songInfo?.typeUrl?.[task.quality], task.songInfo?.typeUrl?.[task.requestedQuality])
  if (!url) throw new Error('无法获取歌曲下载链接')

  const filePath = resolveDownloadFilePath(task)
  const tempPath = `${filePath}.temp`
  const signal = controller.signal

  await fs.mkdir(path.dirname(filePath), { recursive: true })

  if (url.startsWith('file://')) {
    const sourcePath = fileURLToPath(url)
    await fs.copyFile(sourcePath, tempPath)
    await fs.rename(tempPath, filePath)
    const stat = await fs.stat(filePath)
    return {
      totalSize: stat.size,
      downloadedSize: stat.size,
      progress: 100,
    }
  }

  let startByte = 0
  try {
    const stat = await fs.stat(tempPath)
    if (stat.isFile()) startByte = stat.size
  } catch {}

  const headers = buildDownloadHeaders(task)
  if (startByte > 0) headers.Range = `bytes=${startByte}-`

  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    headers,
    signal,
    timeout: 60000,
    validateStatus: (status) => status >= 200 && status < 400,
  })

  const totalSize = Number.parseInt(response.headers['content-length'] || '0', 10) + startByte
  let downloadedSize = startByte
  let lastReportedTime = Date.now()
  let lastDownloadedSize = startByte

  response.data.on('data', (chunk) => {
    downloadedSize += chunk.length
    const current = Date.now()
    const elapsed = current - lastReportedTime
    if (elapsed < 1000) return

    const delta = downloadedSize - lastDownloadedSize
    const speed = elapsed > 0 ? delta / (elapsed / 1000) : 0
    const progress = totalSize > 0 ? Math.min(100, (downloadedSize / totalSize) * 100) : 0
    const remainingTime = speed > 0 && totalSize > 0 ? Math.max(0, (totalSize - downloadedSize) / speed) : null

    lastReportedTime = current
    lastDownloadedSize = downloadedSize

    const nextTask = state.tasks.get(task.id)
    if (!nextTask) return
    Object.assign(nextTask, {
      status: 'downloading',
      progress,
      speed,
      totalSize,
      downloadedSize,
      remainingTime,
    })
    emit('download:task-progress', normalizeTask(nextTask))
  })

  await pipeline(response.data, await fs.open(tempPath, startByte > 0 ? 'a' : 'w').then((handle) => handle.createWriteStream({ start: startByte })))

  await fs.rename(tempPath, filePath)
  const finalStat = await fs.stat(filePath)
  return {
    totalSize: finalStat.size,
    downloadedSize: finalStat.size,
    progress: 100,
  }
}

async function startTask(taskId) {
  const task = state.tasks.get(taskId)
  if (!task || !['queued', 'paused'].includes(task.status)) return

  const controller = new AbortController()
  const meta = { controller, mode: null }
  state.active.set(taskId, meta)
  state.queue = state.queue.filter((id) => id !== taskId)

  const startedTask = await updateTask(taskId, {
    status: 'downloading',
    error: null,
    progress: 0,
    speed: 0,
    remainingTime: null,
  })
  if (startedTask) emit('download:task-status-changed', startedTask)

  try {
    const result = await performDownload(startedTask || task, controller)
    const completedTask = await updateTask(taskId, {
      status: 'completed',
      progress: 100,
      speed: 0,
      totalSize: result.totalSize,
      downloadedSize: result.downloadedSize,
      remainingTime: 0,
      error: null,
    }, null)
    if (completedTask) emit('download:task-completed', completedTask)
  } catch (error) {
    const reason = String(error?.name || error?.code || error?.message || error || '')
    const activeMeta = state.active.get(taskId)
    const abortedByPause = activeMeta?.mode === 'pause' || reason.includes('AbortError') || reason.includes('ERR_CANCELED')
    const abortedByCancel = activeMeta?.mode === 'cancel'

    if (abortedByPause) {
      const pausedTask = await updateTask(taskId, { status: 'paused', speed: 0, remainingTime: null }, null)
      if (pausedTask) emit('download:task-status-changed', pausedTask)
    } else if (abortedByCancel) {
      const cancelledTask = await updateTask(taskId, { status: 'cancelled', speed: 0, remainingTime: null }, null)
      if (cancelledTask) emit('download:task-status-changed', cancelledTask)
      const filePath = resolveDownloadFilePath(task)
      await fs.unlink(`${filePath}.temp`).catch(() => undefined)
    } else {
      const failedTask = await updateTask(taskId, {
        status: 'error',
        speed: 0,
        remainingTime: null,
        error: String(error?.message || error || '下载失败'),
      }, null)
      if (failedTask) emit('download:task-error', failedTask)
    }
  } finally {
    state.active.delete(taskId)
    await persistTasks()
    processQueue().catch((queueError) => emit('download:task-error', { id: 'queue', error: String(queueError?.message || queueError) }))
  }
}

async function processQueue() {
  await initializeSystem()
  while (state.active.size < state.maxConcurrent && state.queue.length > 0) {
    const nextTaskId = state.queue.shift()
    if (!nextTaskId) break
    const task = state.tasks.get(nextTaskId)
    if (!task || task.status !== 'queued') continue
    startTask(nextTaskId).catch((error) => {
      emit('download:task-error', { id: nextTaskId, error: String(error?.message || error) })
    })
  }
}

export const service = {
  async health() {
    await initializeSystem()
    return {
      ok: true,
      service: 'download-cache',
      appDataDir: state.appDataDir,
      cacheDir: state.cacheDir,
      downloadDir: state.downloadDir,
      taskCount: state.tasks.size,
      queueCount: state.queue.length,
      activeCount: state.active.size,
      urlCacheCount: state.urlCache.size,
    }
  },

  async getTasks() {
    await initializeSystem()
    return getTaskList()
  },

  async addTask(payload = {}) {
    await initializeSystem()
    const incomingTask = normalizeTask(payload)
    const task = normalizeTask({
      ...payload,
      filePath: payload.filePath || payload.file_path || path.join(state.downloadDir, taskFileName(incomingTask || {})),
      status: payload.status || incomingTask?.status || 'queued',
    })
    if (!task) throw new Error('Invalid download task')

    const nextFilePath = resolveDownloadFilePath(task)
    task.filePath = nextFilePath

    for (const existing of state.tasks.values()) {
      if (taskKey(existing) !== taskKey(task)) continue
      if (existing.status === 'completed' && existing.filePath) {
        const exists = await fs.access(existing.filePath).then(() => true).catch(() => false)
        if (exists) throw new Error('歌曲已下载完成')
      }
      if (['queued', 'paused', 'downloading'].includes(existing.status) && existing.filePath === task.filePath) {
        throw new Error('歌曲正在下载中')
      }
    }

    state.tasks.set(task.id, task)
    if (task.status === 'queued') {
      state.queue.push(task.id)
      state.queue.sort((a, b) => (state.tasks.get(a)?.priority ?? 0) - (state.tasks.get(b)?.priority ?? 0))
    }
    await persistTasks()
    emit('download:task-added', task)
    processQueue().catch((error) => emit('download:task-error', { id: task.id, error: String(error?.message || error) }))
    return { success: true, task, added: 1, filePath: task.filePath }
  },

  async addTasks(payload = {}) {
    await initializeSystem()
    const items = Array.isArray(payload) ? payload : Array.isArray(payload.tasks) ? payload.tasks : []
    const results = []
    for (const item of items) {
      const result = await this.addTask(item)
      results.push(result.task)
    }
    return { success: true, added: results.length, tasks: results }
  },

  async updateTaskStatus(payload = {}) {
    await initializeSystem()
    const taskId = firstText(payload.taskId, payload.task_id, payload.id)
    if (!taskId) throw new Error('taskId is required')
    const existing = state.tasks.get(taskId)
    if (!existing) return { success: false, message: '任务不存在' }
    const updated = normalizeTask({ ...existing, ...payload, id: taskId, status: payload.status || existing.status })
    state.tasks.set(taskId, updated)
    if (updated.status === 'queued') {
      if (!state.queue.includes(taskId)) state.queue.push(taskId)
    } else {
      removeFromQueue(taskId)
    }
    await persistTasks()
    emit('download:task-status-changed', updated)
    processQueue().catch(() => undefined)
    return { success: true, task: updated }
  },

  async pauseTask(payload = {}) {
    await initializeSystem()
    const taskId = firstText(payload.taskId, payload.task_id, payload.id)
    if (!taskId) throw new Error('taskId is required')
    const active = getActiveEntry(taskId)
    if (active) {
      active.mode = 'pause'
      active.controller.abort('pause')
      return { success: true }
    }
    removeFromQueue(taskId)
    return markPaused(taskId) || { success: true }
  },

  async resumeTask(payload = {}) {
    await initializeSystem()
    const taskId = firstText(payload.taskId, payload.task_id, payload.id)
    if (!taskId) throw new Error('taskId is required')
    const updated = await updateTask(taskId, { status: 'queued', error: null, progress: 0, remainingTime: null }, null)
    if (updated && !state.queue.includes(taskId)) state.queue.push(taskId)
    state.queue.sort((a, b) => (state.tasks.get(a)?.priority ?? 0) - (state.tasks.get(b)?.priority ?? 0))
    await persistTasks()
    if (updated) emit('download:task-status-changed', updated)
    processQueue().catch(() => undefined)
    return { success: true, task: updated }
  },

  async cancelTask(payload = {}) {
    await initializeSystem()
    const taskId = firstText(payload.taskId, payload.task_id, payload.id)
    if (!taskId) throw new Error('taskId is required')
    const active = getActiveEntry(taskId)
    if (active) {
      active.mode = 'cancel'
      active.controller.abort('cancel')
      return { success: true }
    }
    removeFromQueue(taskId)
    return markCancelled(taskId) || { success: true }
  },

  async deleteTask(payload = {}) {
    await initializeSystem()
    const taskId = firstText(payload.taskId, payload.task_id, payload.id)
    if (!taskId) throw new Error('taskId is required')
    const task = state.tasks.get(taskId)
    if (!task) return { success: false }
    const active = getActiveEntry(taskId)
    if (active) {
      active.mode = 'cancel'
      active.controller.abort('cancel')
    }
    removeFromQueue(taskId)
    state.tasks.delete(taskId)
    await persistTasks()
    if (payload.deleteFile && task.filePath) {
      await fs.unlink(task.filePath).catch(() => undefined)
      await fs.unlink(`${task.filePath}.temp`).catch(() => undefined)
    }
    emit('download:task-deleted', taskId)
    emitTaskListReset()
    return { success: true }
  },

  async clearTasks(payload = {}) {
    await initializeSystem()
    const type = String(payload.type || 'all')
    const keep = []
    for (const task of state.tasks.values()) {
      const remove =
        type === 'all' ||
        (type === 'queue' && ['queued', 'paused'].includes(task.status)) ||
        (type === 'completed' && task.status === 'completed') ||
        (type === 'failed' && task.status === 'error')
      if (!remove) keep.push(task)
    }
    state.tasks = new Map(keep.map((task) => [task.id, task]))
    state.queue = state.queue.filter((taskId) => state.tasks.has(taskId))
    await persistTasks()
    emitTaskListReset()
    return { success: true, tasks: keep }
  },

  async pauseAllTasks() {
    await initializeSystem()
    const updates = []
    for (const task of state.tasks.values()) {
      if (['queued', 'downloading'].includes(task.status)) {
        const active = getActiveEntry(task.id)
        if (active) {
          active.mode = 'pause'
          active.controller.abort('pause')
        }
        removeFromQueue(task.id)
        task.status = 'paused'
        task.speed = 0
        task.remainingTime = null
        updates.push(task)
      }
    }
    await persistTasks()
    updates.forEach((task) => emit('download:task-status-changed', task))
    emitTaskListReset()
    return { success: true }
  },

  async resumeAllTasks() {
    await initializeSystem()
    for (const task of state.tasks.values()) {
      if (task.status === 'paused' || task.status === 'error') {
        task.status = 'queued'
        task.error = null
        if (!state.queue.includes(task.id)) state.queue.push(task.id)
      }
    }
    state.queue.sort((a, b) => (state.tasks.get(a)?.priority ?? 0) - (state.tasks.get(b)?.priority ?? 0))
    await persistTasks()
    emitTaskListReset()
    processQueue().catch(() => undefined)
    return { success: true }
  },

  async retryTask(payload = {}) {
    return this.resumeTask(payload)
  },

  async validateFiles() {
    await initializeSystem()
    const tasks = []
    for (const task of state.tasks.values()) {
      if (task.filePath && task.status === 'completed') {
        const exists = await fs.access(task.filePath).then(() => true).catch(() => false)
        if (!exists) {
          task.status = 'error'
          task.error = '文件不存在'
          task.progress = 0
          emit('download:task-error', task)
        }
      }
      tasks.push(task)
    }
    await persistTasks()
    emitTaskListReset()
    return tasks
  },

  async getMaxConcurrent() {
    await initializeSystem()
    return state.maxConcurrent
  },

  async setMaxConcurrent(payload = {}) {
    await initializeSystem()
    const max = Number(payload.max || payload.maxConcurrent || 3)
    state.maxConcurrent = Number.isFinite(max) && max > 0 ? Math.floor(max) : 3
    processQueue().catch(() => undefined)
    return { success: true, max: state.maxConcurrent }
  },

  async urlCacheGet(payload = {}) {
    await initializeSystem()
    const songId = firstText(payload.key, payload.songId, payload.song_id)
    if (!songId) return null
    let entry = state.urlCache.get(songId)
    if (!entry?.url) {
      const suffix = `_${songId}`
      for (const [key, value] of state.urlCache.entries()) {
        if (key !== songId && key.endsWith(suffix) && value?.url) {
          entry = value
          break
        }
      }
    }
    if (!entry?.url) return null

    const updatedAt = Number(entry.updatedAt || 0)
    const maxAgeSeconds = songId.startsWith('git_') ? 7 * 24 * 60 * 60 : 6 * 60 * 60
    if (updatedAt > 0 && Math.floor(now() / 1000) - updatedAt > maxAgeSeconds) {
      state.urlCache.delete(songId)
      await persistUrlCache()
      return null
    }
    return entry.url
  },

  async urlCacheSave(payload = {}) {
    await initializeSystem()
    const songId = firstText(payload.key, payload.songId, payload.song_id)
    const url = firstText(payload.url)
    if (!songId || !url) return { success: false }
    state.urlCache.set(songId, { url, updatedAt: Math.floor(now() / 1000) })
    await persistUrlCache()
    return { success: true }
  },

  async urlCacheInvalidate(payload = {}) {
    await initializeSystem()
    const songId = firstText(payload.key, payload.songId, payload.song_id)
    if (songId) state.urlCache.delete(songId)
    await persistUrlCache()
    return { success: true }
  },

  async urlCacheClear() {
    await initializeSystem()
    state.urlCache.clear()
    await persistUrlCache()
    return { success: true }
  },

  async musicCacheGetInfo() {
    await initializeSystem()
    const { size, count } = await scanDirectorySize(state.cacheDir)
    return { count, size, sizeFormatted: formatBytes(size) }
  },

  async musicCacheGetSize() {
    const info = await this.musicCacheGetInfo()
    return info.size
  },

  async musicCacheClear() {
    await initializeSystem()
    const deleted = await clearAudioCache(state.cacheDir)
    return { success: true, message: '缓存已清空', deleted }
  },
}
