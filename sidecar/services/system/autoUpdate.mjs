import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const DEFAULT_IDENTIFIER = 'com.shuxiamusic.tauri'
const DEFAULT_PROGRESS = { percent: 0, transferred: 0, total: 0 }

const state = {
  initialized: false,
  appDataDir: '',
  statePath: '',
  status: 'idle',
  shouldUpdate: false,
  updateInfo: null,
  progress: { ...DEFAULT_PROGRESS },
  isDownloading: false,
  lastCheckedAt: 0,
  lastEventAt: 0,
  mode: 'full',
  error: null,
  history: [],
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

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
}

async function persistState() {
  await writeJson(state.statePath, publicState())
}

async function initializeSystem() {
  if (state.initialized) return
  state.appDataDir = resolveAppDataDir()
  state.statePath = path.join(state.appDataDir, 'system', 'auto-update-state.json')
  const stored = await readJson(state.statePath, null)
  if (stored && typeof stored === 'object') {
    state.status = normalizeStatus(stored.status || 'idle')
    state.shouldUpdate = Boolean(stored.shouldUpdate)
    state.updateInfo = normalizeUpdateInfo(stored.updateInfo)
    state.progress = normalizeProgress(stored.progress)
    state.isDownloading = Boolean(stored.isDownloading)
    state.lastCheckedAt = Number(stored.lastCheckedAt || 0)
    state.lastEventAt = Number(stored.lastEventAt || 0)
    state.mode = normalizeMode(stored.mode)
    state.error = normalizeError(stored.error)
    state.history = normalizeHistory(stored.history)
  }
  state.initialized = true
}

function normalizeStatus(input) {
  const value = String(input || '').toLowerCase().replace(/_/g, '-')
  if ([
    'idle',
    'checking',
    'update-available',
    'up-to-date',
    'downloading',
    'downloaded',
    'pending',
    'error',
  ].includes(value)) return value
  return 'idle'
}

function normalizeMode(input) {
  return input === 'differential' ? 'differential' : 'full'
}

function firstText(...items) {
  for (const item of items) {
    if (typeof item === 'string' && item.trim()) return item.trim()
    if (typeof item === 'number' && Number.isFinite(item)) return String(item)
  }
  return ''
}

function normalizeUpdateInfo(input) {
  if (!input || typeof input !== 'object') return null
  const name = firstText(input.name, input.version)
  const notes = firstText(input.notes, input.body)
  const pubDate = firstText(input.pub_date, input.pubDate, input.date)
  const url = firstText(input.url)
  if (!name && !notes && !pubDate && !url) return null
  return {
    url,
    name,
    notes,
    pub_date: pubDate,
    supportsDifferential: Boolean(input.supportsDifferential),
    mode: normalizeMode(input.mode),
  }
}

function normalizeProgress(input) {
  const total = Number(input?.total ?? input?.contentLength ?? 0)
  const transferred = Number(input?.transferred ?? input?.downloaded ?? input?.downloadedBytes ?? 0)
  const rawPercent = Number(input?.percent ?? 0)
  const percent = total > 0 ? Math.round((transferred / total) * 100) : rawPercent
  return {
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
    transferred: Number.isFinite(transferred) ? Math.max(0, transferred) : 0,
    total: Number.isFinite(total) ? Math.max(0, total) : 0,
  }
}

function normalizeError(input) {
  if (!input) return null
  if (typeof input === 'string') return { message: input }
  if (typeof input === 'object') {
    return {
      code: firstText(input.code),
      message: firstText(input.message, input.raw, input.error, '更新过程发生错误'),
      raw: firstText(input.raw),
    }
  }
  return { message: String(input) }
}

function normalizeHistory(input) {
  return (Array.isArray(input) ? input : [])
    .filter((item) => item && typeof item === 'object')
    .slice(-20)
}

function pushHistory(type, payload = {}) {
  state.lastEventAt = Date.now()
  state.history = normalizeHistory([
    ...state.history,
    { type, at: state.lastEventAt, ...payload },
  ])
}

function publicState() {
  return {
    status: state.status,
    shouldUpdate: state.shouldUpdate,
    updateInfo: state.updateInfo,
    progress: state.progress,
    isDownloading: state.isDownloading,
    lastCheckedAt: state.lastCheckedAt,
    lastEventAt: state.lastEventAt,
    mode: state.mode,
    error: state.error,
    history: state.history,
  }
}

async function setState(patch, historyType, historyPayload) {
  Object.assign(state, patch)
  if (historyType) pushHistory(historyType, historyPayload)
  await persistState()
  return { success: true, data: publicState() }
}

function normalizeCheckResult(payload = {}) {
  const result = payload?.result || payload
  const manifest = result?.manifest || payload?.manifest || null
  const updateInfo = normalizeUpdateInfo(manifest || payload?.updateInfo)
  return {
    shouldUpdate: Boolean(result?.shouldUpdate ?? payload?.shouldUpdate),
    updateInfo,
  }
}

function normalizeUpdaterEvent(payload = {}) {
  const status = String(payload?.status || payload?.event?.status || '').toUpperCase()
  const data = payload?.data || payload?.event?.data || {}
  const error = payload?.error || payload?.event?.error
  return { status, data, error }
}

export const service = {
  async health() {
    await initializeSystem()
    return {
      ok: true,
      service: 'system-auto-update',
      appDataDir: state.appDataDir,
      status: state.status,
      shouldUpdate: state.shouldUpdate,
      isDownloading: state.isDownloading,
    }
  },

  async getState() {
    await initializeSystem()
    return { success: true, data: publicState() }
  },

  async recordChecking() {
    await initializeSystem()
    return await setState({
      status: 'checking',
      error: null,
      lastCheckedAt: Date.now(),
    }, 'checking')
  },

  async recordCheckResult(payload = {}) {
    await initializeSystem()
    const result = normalizeCheckResult(payload)
    return await setState({
      status: result.shouldUpdate ? 'update-available' : 'up-to-date',
      shouldUpdate: result.shouldUpdate,
      updateInfo: result.updateInfo,
      isDownloading: false,
      progress: { ...DEFAULT_PROGRESS },
      error: null,
      lastCheckedAt: Date.now(),
    }, result.shouldUpdate ? 'update-available' : 'up-to-date', { updateInfo: result.updateInfo })
  },

  async recordDownloadStarted(payload = {}) {
    await initializeSystem()
    return await setState({
      status: 'downloading',
      isDownloading: true,
      mode: normalizeMode(payload.mode),
      progress: { ...DEFAULT_PROGRESS },
      error: null,
    }, 'download-started', { mode: normalizeMode(payload.mode) })
  },

  async recordProgress(payload = {}) {
    await initializeSystem()
    const progress = normalizeProgress(payload.progress || payload)
    return await setState({
      status: 'downloading',
      isDownloading: true,
      progress,
      error: null,
    }, 'download-progress', { progress })
  },

  async recordDownloaded(payload = {}) {
    await initializeSystem()
    return await setState({
      status: 'downloaded',
      isDownloading: false,
      progress: { ...state.progress, percent: 100 },
      error: null,
      mode: normalizeMode(payload.mode || state.mode),
    }, 'downloaded')
  },

  async recordPending() {
    await initializeSystem()
    return await setState({ status: 'pending', isDownloading: false }, 'pending')
  },

  async recordError(payload = {}) {
    await initializeSystem()
    const error = normalizeError(payload.error || payload)
    return await setState({
      status: 'error',
      isDownloading: false,
      error,
    }, 'error', { error })
  },

  async recordEvent(payload = {}) {
    await initializeSystem()
    const event = normalizeUpdaterEvent(payload)
    switch (event.status) {
      case 'CHECKING':
        return await service.recordChecking()
      case 'UPDATE_AVAILABLE':
        return await service.recordCheckResult({ shouldUpdate: true, manifest: event.data })
      case 'UPTODATE':
        return await service.recordCheckResult({ shouldUpdate: false })
      case 'DOWNLOAD_PROGRESS':
        return await service.recordProgress(event.data)
      case 'DOWNLOADED':
        return await service.recordDownloaded()
      case 'PENDING':
        return await service.recordPending()
      case 'ERROR':
        return await service.recordError({ error: event.error || event.data })
      default:
        pushHistory('event', { status: event.status || 'UNKNOWN' })
        await persistState()
        return { success: true, data: publicState() }
    }
  },

  async reset() {
    await initializeSystem()
    return await setState({
      status: 'idle',
      shouldUpdate: false,
      updateInfo: null,
      progress: { ...DEFAULT_PROGRESS },
      isDownloading: false,
      error: null,
    }, 'reset')
  },
}