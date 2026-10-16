import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const DEFAULT_IDENTIFIER = 'com.shuxiamusic.tauri'
const HISTORY_LIMIT = 200

const defaultState = {
  closeToTray: true,
  platform: process.platform,
  window: {
    visible: true,
    focused: false,
    minimized: false,
    hidden: false,
    fullscreen: false,
  },
  tray: {
    interactive: process.platform !== 'darwin',
    leftClickAction: process.platform === 'darwin' ? 'menu' : 'toggle-main-window',
    showMenuOnLeftClick: process.platform === 'darwin',
    menu: [
      { id: 'prev', label: '上一首', enabled: true },
      { id: 'play_pause', label: '播放/暂停', enabled: true },
      { id: 'next', label: '下一首', enabled: true },
      { id: 'show', label: '显示主窗口', enabled: true },
      { id: 'toggle_desktop_lyric', label: '显示桌面歌词', enabled: true },
      { id: 'toggle_desktop_lyric_lock', label: '锁定桌面歌词', enabled: true },
      { id: 'quit', label: '退出', enabled: true },
    ],
  },
  lastDecision: null,
  history: [],
}

const state = {
  initialized: false,
  appDataDir: '',
  statePath: '',
  data: structuredClone(defaultState),
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

function normalizeWindowState(input = {}) {
  const visible = input.visible !== false
  const minimized = Boolean(input.minimized)
  return {
    visible,
    focused: Boolean(input.focused),
    minimized,
    hidden: input.hidden === true || !visible || minimized,
    fullscreen: Boolean(input.fullscreen),
  }
}

function normalizeTrayState(input = {}) {
  const platform = String(input.platform || process.platform)
  const macInteractive = platform === 'darwin' ? Boolean(input.macStatusBarLyricEnabled) : true
  const interactive = platform === 'darwin' ? macInteractive : input.interactive !== false
  const lyricVisible = Boolean(input.desktopLyricVisible)
  const lyricLocked = Boolean(input.desktopLyricLocked)
  return {
    interactive,
    leftClickAction: platform === 'darwin' ? 'menu' : 'toggle-main-window',
    showMenuOnLeftClick: platform === 'darwin',
    menu: [
      { id: 'prev', label: '上一首', enabled: interactive },
      { id: 'play_pause', label: '播放/暂停', enabled: interactive },
      { id: 'next', label: '下一首', enabled: interactive },
      { id: 'show', label: '显示主窗口', enabled: interactive },
      { id: 'toggle_desktop_lyric', label: lyricVisible ? '隐藏桌面歌词' : '显示桌面歌词', enabled: interactive },
      { id: 'toggle_desktop_lyric_lock', label: lyricLocked ? '解锁桌面歌词' : '锁定桌面歌词', enabled: interactive },
      { id: 'quit', label: '退出', enabled: interactive },
    ],
  }
}

function normalizeData(input = {}) {
  const platform = String(input.platform || process.platform)
  return {
    ...structuredClone(defaultState),
    ...input,
    platform,
    closeToTray: input.closeToTray !== false,
    window: normalizeWindowState(input.window || defaultState.window),
    tray: normalizeTrayState({ platform, ...(input.tray || {}) }),
    history: Array.isArray(input.history) ? input.history.slice(-HISTORY_LIMIT) : [],
  }
}

async function persist() {
  await writeJson(state.statePath, state.data)
}

async function initialize() {
  if (state.initialized) return
  state.appDataDir = resolveAppDataDir()
  state.statePath = path.join(state.appDataDir, 'system', 'windowLifecycle.json')
  state.data = normalizeData(await readJson(state.statePath, defaultState))
  state.initialized = true
}

function pushHistory(type, payload, decision) {
  state.data.history.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: Date.now(),
    type,
    payload: payload || null,
    decision,
  })
  state.data.history = state.data.history.slice(-HISTORY_LIMIT)
  state.data.lastDecision = decision
}

function closeDecision(payload = {}) {
  const closeToTray = payload.closeToTray ?? state.data.closeToTray
  const decision = closeToTray === false
    ? { action: 'exit-app', preventClose: true, reason: 'close-to-tray-disabled' }
    : { action: 'hide-main-window', preventClose: true, reason: 'close-to-tray-enabled' }
  state.data.closeToTray = closeToTray !== false
  pushHistory('close-requested', payload, decision)
  return decision
}

function trayLeftClickDecision(payload = {}) {
  const platform = String(payload.platform || state.data.platform || process.platform)
  const window = normalizeWindowState(payload.window || state.data.window)
  state.data.platform = platform
  state.data.window = window
  state.data.tray = normalizeTrayState({ platform, ...(payload.tray || {}) })

  let decision
  if (platform === 'darwin') {
    decision = state.data.tray.interactive
      ? { action: 'show-menu', reason: 'macos-status-bar-lyric-menu' }
      : { action: 'noop', reason: 'macos-status-bar-lyric-disabled' }
  } else if (window.minimized) {
    decision = { action: 'restore-and-focus-main-window', reason: 'non-macos-minimized-left-click' }
  } else if (window.visible && !window.hidden) {
    decision = { action: 'hide-main-window', reason: 'non-macos-visible-left-click' }
  } else {
    decision = { action: 'show-and-focus-main-window', reason: 'non-macos-hidden-left-click' }
  }

  pushHistory('tray-left-click', payload, decision)
  return decision
}

export const service = {
  async health() {
    await initialize()
    return {
      ok: true,
      service: 'window-lifecycle',
      appDataDir: state.appDataDir,
      closeToTray: state.data.closeToTray,
      platform: state.data.platform,
    }
  },

  async getState() {
    await initialize()
    return { success: true, data: state.data }
  },

  async setCloseToTray(payload = {}) {
    await initialize()
    const value = typeof payload === 'boolean' ? payload : payload?.value
    state.data.closeToTray = value !== false
    pushHistory('set-close-to-tray', { value: state.data.closeToTray }, { action: 'save-policy' })
    await persist()
    return { success: true, data: state.data }
  },

  async recordWindowState(payload = {}) {
    await initialize()
    state.data.window = normalizeWindowState(payload.window || payload)
    pushHistory('window-state', state.data.window, { action: 'record-state' })
    await persist()
    return { success: true, data: state.data.window }
  },

  async updateTray(payload = {}) {
    await initialize()
    const platform = String(payload.platform || state.data.platform || process.platform)
    state.data.platform = platform
    state.data.tray = normalizeTrayState({ platform, ...payload })
    pushHistory('tray-state', payload, { action: 'update-menu-state' })
    await persist()
    return { success: true, data: state.data.tray }
  },

  async decideClose(payload = {}) {
    await initialize()
    const decision = closeDecision(payload)
    await persist()
    return { success: true, decision, data: state.data }
  },

  async decideTrayLeftClick(payload = {}) {
    await initialize()
    const decision = trayLeftClickDecision(payload)
    await persist()
    return { success: true, decision, data: state.data }
  },
}