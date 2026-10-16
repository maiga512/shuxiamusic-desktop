import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import axios from 'axios'
import { pipeline } from 'node:stream/promises'

const AUDIO_CACHE_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.wma', '.ape', '.dsf'])

// ==================== LRU 缓存索引 ====================
// cache-index.json 记录每个缓存文件的元信息，用于：
//   1) 显示"已缓存歌曲"列表（歌名、歌手、大小、缓存时间）
//   2) LRU 淘汰：超出容量上限时按 lastAccessedAt 最旧的先删
//   3) 容量统计（不用每次全目录扫描）
// 索引写入走"临时文件 + rename"原子操作，崩溃不会损坏。
const CACHE_INDEX_FILE = 'cache-index.json'
let cacheIndex = new Map()   // filePath -> { path, name, artist, size, addedAt, lastAccessedAt }
let cacheMaxBytes = 5 * 1024 * 1024 * 1024   // 默认 5GB
let cacheIndexLoaded = false

async function cacheIndexPath() {
  return path.join(state.cacheDir, CACHE_INDEX_FILE)
}

async function loadCacheIndex() {
  if (cacheIndexLoaded) return
  cacheIndexLoaded = true
  try {
    const raw = await fs.readFile(await cacheIndexPath(), 'utf8')
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item && item.path) cacheIndex.set(item.path, item)
      }
    }
  } catch { /* 索引不存在或损坏，从磁盘重建 */ }
  // 重建：扫描缓存目录，把索引里没有的文件补进来，删掉索引里已不存在的
  await rebuildCacheIndexFromDisk()
}

async function saveCacheIndex() {
  try {
    const tmp = (await cacheIndexPath()) + '.tmp'
    await fs.writeFile(tmp, JSON.stringify([...cacheIndex.values()], null, 2), 'utf8')
    await fs.rename(tmp, await cacheIndexPath())
  } catch { /* 索引写失败不影响下载 */ }
}

async function rebuildCacheIndexFromDisk() {
  const seen = new Set()
  async function scan(dir) {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const fp = path.join(dir, e.name)
      if (e.isDirectory()) { await scan(fp); continue }
      if (!e.isFile()) continue
      if (!AUDIO_CACHE_EXTENSIONS.has(path.extname(e.name).toLowerCase())) continue
      seen.add(fp)
      if (!cacheIndex.has(fp)) {
        const stat = await fs.stat(fp).catch(() => null)
        if (!stat) continue
        cacheIndex.set(fp, {
          path: fp,
          name: path.basename(fp, path.extname(fp)),
          artist: '',
          size: stat.size,
          addedAt: stat.mtimeMs,
          lastAccessedAt: stat.mtimeMs,
        })
      }
    }
  }
  await scan(state.cacheDir)
  // 清掉索引里已不存在的文件
  for (const fp of [...cacheIndex.keys()]) {
    if (!seen.has(fp)) cacheIndex.delete(fp)
  }
  await saveCacheIndex()
}

function cacheIndexTotalSize() {
  let total = 0
  for (const item of cacheIndex.values()) total += item.size || 0
  return total
}

/** 记录一个缓存文件（下载完成后调用） */
async function addCacheEntry(filePath, meta = {}) {
  await loadCacheIndex()
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat) return
  cacheIndex.set(filePath, {
    path: filePath,
    name: meta.name || path.basename(filePath, path.extname(filePath)),
    artist: meta.artist || '',
    size: stat.size,
    addedAt: Date.now(),
    lastAccessedAt: Date.now(),
  })
  await saveCacheIndex()
  await evictCacheIfNeeded()
}

/** 触碰缓存文件（播放命中缓存时调用，刷新 LRU 时间戳） */
export async function touchCacheEntry(filePath) {
  await loadCacheIndex()
  const item = cacheIndex.get(filePath)
  if (item) {
    item.lastAccessedAt = Date.now()
    await saveCacheIndex()
  }
}

/** LRU 淘汰：超出容量上限时，按 lastAccessedAt 最旧的先删，直到降到上限内 */
async function evictCacheIfNeeded() {
  await loadCacheIndex()
  let total = cacheIndexTotalSize()
  if (total <= cacheMaxBytes) return
  // 按 lastAccessedAt 升序（最久未用在前）
  const sorted = [...cacheIndex.values()].sort((a, b) => (a.lastAccessedAt || 0) - (b.lastAccessedAt || 0))
  const evicted = []
  for (const item of sorted) {
    if (total <= cacheMaxBytes) break
    try {
      await fs.unlink(item.path).catch(() => undefined)
      cacheIndex.delete(item.path)
      total -= item.size || 0
      evicted.push(item.name)
    } catch { /* 文件可能已被删 */ }
  }
  if (evicted.length > 0) {
    await saveCacheIndex()
    emit('music:cache-evicted', { count: evicted.length, names: evicted.slice(0, 20) })
  }
}

// ==================== 在线播放音频文件缓存 ====================
// 对齐 Electron 的 MusicCacheService：在线听歌时把音频文件落盘到 cacheDir/playback/，
// key = md5(source:songmid:quality)。命中时返回 file:// 本地文件（第二次听直接播本地、可离线），
// 未命中时异步下载落盘并登记进 LRU 索引（不阻塞播放）。
// 容量上限 / 淘汰 / 清空 / 统计全部复用现有 cacheIndex + evictCacheIfNeeded + clearAudioCache，
// 因为 playback 是 cacheDir 的子目录，rebuildCacheIndexFromDisk / clearAudioCache 都会递归覆盖到。
function playbackCacheDir() {
  return path.join(state.cacheDir, 'playback')
}

function playbackCachePath(key, ext) {
  const safeExt = String(ext || 'mp3').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp3'
  return path.join(playbackCacheDir(), `${key}.${safeExt}`)
}

// 查找某个 key 已缓存的播放文件（不限扩展名：同一首不同音质/格式扩展名可能不同）
async function findPlaybackCacheFile(key) {
  const dir = playbackCacheDir()
  let entries
  try {
    entries = await fs.readdir(dir)
  } catch {
    return null
  }
  const prefix = `${key}.`
  for (const name of entries) {
    if (!name.startsWith(prefix) || name.endsWith('.temp')) continue
    const fp = path.join(dir, name)
    const ok = await fs.access(fp).then(() => true).catch(() => false)
    if (ok) return fp
  }
  return null
}

function playbackHeadersFromPayload(payload = {}) {
  const headers = {}
  const raw = payload.headers || {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      const name = String(k || '').trim()
      const text = firstText(v)
      if (name && text) headers[name] = text
    }
  }
  const referrer = firstText(payload.referrer, payload.referer)
  const userAgent = firstText(payload.userAgent)
  if (referrer && !Object.keys(headers).some((k) => k.toLowerCase() === 'referer')) {
    headers.Referer = referrer
  }
  headers['User-Agent'] =
    userAgent ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  return headers
}

// 后台真正执行落盘下载（fire-and-forget 调用的目标，永不向外抛错）
async function doPlaybackCacheDownload(key, url, filePath, tempPath, payload) {
  state.playbackCaching.add(key)
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const response = await axios({
      method: 'GET',
      url,
      responseType: 'stream',
      headers: playbackHeadersFromPayload(payload),
      timeout: 180000,
      validateStatus: (status) => status >= 200 && status < 400,
    })
    await pipeline(response.data, await fs.createWriteStream(tempPath))
    await fs.rename(tempPath, filePath)
    await addCacheEntry(filePath, {
      name: firstText(payload.name),
      artist: firstText(payload.artist),
    })
    emit('music:cache-playback-cached', {
      key,
      path: filePath,
      name: firstText(payload.name),
    })
  } catch {
    await fs.unlink(tempPath).catch(() => undefined)
  } finally {
    state.playbackCaching.delete(key)
  }
}

const DEFAULT_IDENTIFIER = 'com.shuxiamusic.tauri'

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
  // 正在做"在线播放落盘缓存"的 key 集合，防止同一首歌并发重复下载
  playbackCaching: new Set(),
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
    // 下载(isCache=false) vs 在线播放自动缓存(isCache=true) 的语义标志，必须随任务持久化，
    // 否则 markCompleted 无法判断是否登记进缓存索引，缓存/下载会互相串味。
    isCache: input.isCache === true,
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
  // 下载/缓存目录优先用 Rust 侧启动时注入的"用户已配置"目录（CERU_DOWNLOAD_DIR /
  // CERU_CACHE_DIR），这样 sidecar 一启动就落在正确位置，不必等用户打开设置页才同步；
  // 未注入时回退到 appDataDir 下的默认目录。
  state.cacheDir = path.resolve(
    process.env.CERU_CACHE_DIR || path.join(state.appDataDir, 'music-cache')
  )
  state.downloadDir = path.resolve(
    process.env.CERU_DOWNLOAD_DIR || path.join(state.appDataDir, 'downloads')
  )
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

  // 启动自愈：历史脏数据里"用户下载(isCache=false)却落在某 music-cache 目录"的记录，
  // 纠正回下载目录（文件在就把物理文件一起搬过去，不在就只改记录路径）。
  // 只针对 basename 为 music-cache 的目录（明确的缓存位置），不会因用户改下载目录而误搬其它文件。
  await selfHealMisfiledDownloadTasks()

  state.initialized = true
  await persistTasks()
  // 重启后自动恢复队列：退出前等待中的任务不必等手动点"开始"
  processQueue().catch(() => undefined)
}

/**
 * 把"落在缓存目录里的用户下载"纠正回下载目录（强不变量的历史数据兜底）。
 * 判定条件：非缓存任务 && 文件所在目录的 basename === 'music-cache'（缓存位置）。
 */
async function selfHealMisfiledDownloadTasks() {
  let changed = false
  for (const task of state.tasks.values()) {
    if (task.isCache || !task.filePath) continue
    const dirOf = path.dirname(task.filePath)
    if (path.basename(dirOf) !== 'music-cache') continue
    const target = path.join(state.downloadDir, path.basename(task.filePath))
    try {
      const srcExists = await fs.access(task.filePath).then(() => true).catch(() => false)
      const dstExists = await fs.access(target).then(() => true).catch(() => false)
      if (srcExists && !dstExists) {
        await fs.mkdir(state.downloadDir, { recursive: true })
        await fs.rename(task.filePath, target).catch(() => undefined)
      }
    } catch {}
    task.filePath = target
    changed = true
  }
  if (changed) emit('download:tasks-reset', getTaskList())
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
  // isCache 任务写缓存目录，其余写下载目录
  return path.join(task.isCache ? state.cacheDir : state.downloadDir, taskFileName(task))
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
  if (updated) {
    // isCache 任务下载完成后登记进 LRU 缓存索引，用于容量统计与淘汰
    if (updated.isCache && updated.filePath) {
      addCacheEntry(updated.filePath, {
        name: updated.songInfo?.name || updated.name,
        artist: updated.songInfo?.singer || updated.singer,
      }).catch(() => undefined)
    }
    emit('download:task-completed', updated)
  }
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

  const requestStream = () =>
    axios({
      method: 'GET',
      url,
      responseType: 'stream',
      headers: (() => {
        const headers = buildDownloadHeaders(task)
        if (startByte > 0) headers.Range = `bytes=${startByte}-`
        return headers
      })(),
      signal,
      timeout: 60000,
      validateStatus: (status) => status >= 200 && status < 400,
    })

  let response
  try {
    response = await requestStream()
  } catch (error) {
    // 416 Range Not Satisfiable：已有 temp 达到/超过服务端文件大小（上次可能已下完），清掉重下整份
    if (Number(error?.response?.status) === 416 && startByte > 0) {
      await fs.unlink(tempPath).catch(() => undefined)
      startByte = 0
      response = await requestStream()
    } else {
      throw error
    }
  }

  // 服务端忽略 Range 直接返回 200 全量内容时必须从头重写，否则追加写会损坏文件
  const baseByte = response.status === 206 ? startByte : 0
  if (baseByte !== startByte) {
    await fs.unlink(tempPath).catch(() => undefined)
  }

  const totalSize = Number.parseInt(response.headers['content-length'] || '0', 10) + baseByte
  let downloadedSize = baseByte
  let lastReportedTime = Date.now()
  let lastDownloadedSize = baseByte
  // 卡死保护：连续 30s 无数据到达视为失败（可重试），避免"下载中"0 速度挂死
  const lastDataAt = { value: Date.now() }
  const stallTimer = setInterval(() => {
    if (Date.now() - lastDataAt.value > 30000) {
      const meta = state.active.get(task.id)
      if (meta) meta.mode = 'stall'
      controller.abort('stall')
    }
  }, 5000)

  response.data.on('data', (chunk) => {
    lastDataAt.value = Date.now()
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

  try {
    await pipeline(response.data, await fs.open(tempPath, baseByte > 0 ? 'a' : 'w').then((handle) => handle.createWriteStream({ start: baseByte })))
  } finally {
    clearInterval(stallTimer)
  }

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
    const abortedByStall = activeMeta?.mode === 'stall'
    const abortedByPause =
      !abortedByStall && (activeMeta?.mode === 'pause' || reason.includes('AbortError') || reason.includes('ERR_CANCELED'))
    const abortedByCancel = activeMeta?.mode === 'cancel'

    if (abortedByStall) {
      const failedTask = await updateTask(taskId, {
        status: 'error',
        speed: 0,
        remainingTime: null,
        error: '下载停滞（30 秒无数据），可点重试',
      }, null)
      if (failedTask) emit('download:task-error', failedTask)
    } else if (abortedByPause) {
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
    // 强不变量：文件落哪个目录只由 isCache 决定，与调用方/历史传入的 filePath 目录无关。
    //   isCache=false（用户下载）→ 下载目录（永久保留，不进 LRU）
    //   isCache=true （在线自动缓存）→ 缓存目录（受容量上限/LRU 管理）
    // 只沿用传入路径的文件名，目录一律强制为 canonicalDir，根治"下载落到缓存目录"。
    const canonicalDir = incomingTask?.isCache ? state.cacheDir : state.downloadDir
    const baseName = path.basename(
      firstText(payload.filePath, payload.file_path) || taskFileName(incomingTask || {})
    )
    const task = normalizeTask({
      ...payload,
      filePath: path.join(canonicalDir, baseName),
      status: payload.status || incomingTask?.status || 'queued',
    })
    if (!task) throw new Error('Invalid download task')

    // 再强制一次：normalizeTask 可能带入 payload 里的旧 filePath 目录，统一钉回 canonicalDir。
    task.filePath = path.join(canonicalDir, path.basename(task.filePath || ''))
    if (!path.basename(task.filePath)) task.filePath = path.join(canonicalDir, taskFileName(task))

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
      if (!remove) {
        keep.push(task)
        continue
      }
      const active = state.active.get(task.id)
      if (active) {
        active.mode = 'cancel'
        active.controller.abort('cancel')
      }
      await fs.unlink(`${task.filePath}.temp`).catch(() => undefined)
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

  async openFileLocation(payload = {}) {
    await initializeSystem()
    const filePath = firstText(payload.filePath, payload.path, payload.file_path)
    if (!filePath) return { success: false, message: '文件路径为空' }
    const resolved = path.resolve(filePath)
    const exists = await fs.access(resolved).then(() => true).catch(() => false)
    if (!exists) return { success: false, message: '文件不存在（可能已被移动或删除）' }
    const { execFile } = await import('node:child_process')
    const run = (cmd, args) =>
      new Promise((resolve) => {
        execFile(cmd, args, (error) => resolve(error ? String(error?.message || error) : null))
      })
    if (process.platform === 'darwin') {
      // Finder 打开所在文件夹并选中文件
      const err = await run('open', ['-R', resolved])
      return err ? { success: false, message: err } : { success: true }
    }
    if (process.platform === 'win32') {
      const err = await run('explorer.exe', [`/select,${resolved}`])
      return err ? { success: false, message: err } : { success: true }
    }
    const err = await run('xdg-open', [path.dirname(resolved)])
    return err ? { success: false, message: err } : { success: true }
  },

  async setDownloadDir(payload = {}) {
    return setDownloadDir(payload)
  },

  async setCacheDir(payload = {}) {
    await initializeSystem()
    const dir = firstText(payload.dir, payload.path, payload.cacheDir)
    if (!dir) return { success: false, message: '缓存目录为空' }
    const resolved = path.resolve(dir)
    await fs.mkdir(resolved, { recursive: true }).catch(() => undefined)
    state.cacheDir = resolved
    return { success: true, cacheDir: state.cacheDir }
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
    await loadCacheIndex()
    // 优先用索引统计（快），索引为空时回退全目录扫描
    let size = cacheIndexTotalSize()
    let count = cacheIndex.size
    if (count === 0) {
      const scanned = await scanDirectorySize(state.cacheDir)
      size = scanned.size
      count = scanned.count
    }
    return {
      count,
      size,
      sizeFormatted: formatBytes(size),
      maxBytes: cacheMaxBytes,
      maxFormatted: formatBytes(cacheMaxBytes),
      entries: [...cacheIndex.values()]
        .sort((a, b) => (b.lastAccessedAt || 0) - (a.lastAccessedAt || 0))
        .slice(0, 200)
        .map(e => ({
          path: e.path,
          name: e.name,
          artist: e.artist || '',
          size: e.size,
          sizeFormatted: formatBytes(e.size || 0),
          addedAt: e.addedAt,
          lastAccessedAt: e.lastAccessedAt,
        })),
    }
  },

  async musicCacheGetSize() {
    const info = await this.musicCacheGetInfo()
    return info.size
  },

  async musicCacheSetLimit(payload = {}) {
    await initializeSystem()
    const raw = Number(payload.bytes ?? payload.maxBytes ?? payload.size ?? 0)
    if (!Number.isFinite(raw) || raw <= 0) {
      return { success: false, message: '缓存上限必须大于 0' }
    }
    cacheMaxBytes = Math.floor(raw)
    await evictCacheIfNeeded()
    return { success: true, maxBytes: cacheMaxBytes, maxFormatted: formatBytes(cacheMaxBytes) }
  },

  async musicCacheTouch(payload = {}) {
    await initializeSystem()
    const fp = firstText(payload.path, payload.filePath)
    if (fp) await touchCacheEntry(fp)
    return { success: true }
  },

  async musicCacheClear() {
    await initializeSystem()
    await loadCacheIndex()
    const deleted = await clearAudioCache(state.cacheDir)
    cacheIndex.clear()
    await saveCacheIndex()
    return { success: true, message: '缓存已清空', deleted }
  },

  // 在线播放命中查询：返回 file:// 本地文件（存在且大小>0）
  async musicCachePlaybackGet(payload = {}) {
    await initializeSystem()
    const key = firstText(payload.key, payload.songId)
    if (!key) return { hit: false }
    const fp = await findPlaybackCacheFile(key)
    if (!fp) return { hit: false }
    const stat = await fs.stat(fp).catch(() => null)
    if (!stat || stat.size <= 0) return { hit: false }
    // 刷新 LRU 时间戳
    await touchCacheEntry(fp).catch(() => undefined)
    return { hit: true, path: fp, url: pathToFileURL(fp).href, size: stat.size }
  },

  // 在线播放落盘缓存（调用方 fire-and-forget，绝不阻塞/影响播放 URL 的返回）
  async musicCachePlaybackCache(payload = {}) {
    await initializeSystem()
    const key = firstText(payload.key, payload.songId)
    const url = firstText(payload.url)
    if (!key || !url) return { success: false }
    // 只缓存可重新拉取的真实 CDN 直链；本地流代理/服务插件临时流无法二次下载，跳过
    if (!/^https?:\/\//i.test(url) || /127\.0\.0\.1|localhost/i.test(url)) {
      return { success: false, reason: 'unsupported-url' }
    }
    const existing = await findPlaybackCacheFile(key)
    if (existing) return { success: true, cached: true }
    if (state.playbackCaching.has(key)) return { success: true, inflight: true }
    const ext = getFileExtension(url, firstText(payload.quality))
    const filePath = playbackCachePath(key, ext)
    const tempPath = `${filePath}.temp`
    // 异步落盘，立即返回
    void doPlaybackCacheDownload(key, url, filePath, tempPath, payload).catch(() => undefined)
    return { success: true, started: true }
  },
}
