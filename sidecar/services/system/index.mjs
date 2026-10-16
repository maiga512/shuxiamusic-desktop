import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const DEFAULT_IDENTIFIER = 'com.shuxiamusic.tauri'
const hotkeyActions = new Set([
  'toggle',
  'playNext',
  'playPrev',
  'seekForward',
  'seekBackward',
  'volumeUp',
  'volumeDown',
  'toggleDesktopLyric',
  'setPlayModeSequence',
  'setPlayModeRandom',
  'togglePlayModeSingle',
  'toggleAudioOutputSelector',
])

const actionLabel = {
  toggle: '播放/暂停',
  playNext: '下一首',
  playPrev: '上一首',
  seekForward: '快进',
  seekBackward: '快退',
  volumeUp: '音量 +',
  volumeDown: '音量 -',
  toggleDesktopLyric: '桌面歌词',
  setPlayModeSequence: '顺序播放',
  setPlayModeRandom: '随机播放',
  togglePlayModeSingle: '单曲循环切换',
  toggleAudioOutputSelector: '切换音频输出设备',
}

const defaultHotkeyConfig = {
  enabled: true,
  bindings: {
    toggle: 'CommandOrControl+Alt+P',
    playPrev: 'CommandOrControl+Alt+Left',
    playNext: 'CommandOrControl+Alt+Right',
    seekBackward: 'CommandOrControl+Alt+J',
    seekForward: 'CommandOrControl+Alt+L',
    volumeDown: 'CommandOrControl+Alt+Down',
    volumeUp: 'CommandOrControl+Alt+Up',
    toggleDesktopLyric: 'CommandOrControl+Alt+D',
    setPlayModeSequence: 'CommandOrControl+Alt+4',
    setPlayModeRandom: 'CommandOrControl+Alt+5',
    togglePlayModeSingle: 'CommandOrControl+Alt+6',
    toggleAudioOutputSelector: 'Alt+O',
  },
}

const state = {
  initialized: false,
  appDataDir: '',
  configPath: '',
  config: structuredClone(defaultHotkeyConfig),
  status: { failedActions: [], actionErrors: {} },
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

function normalizeAccelerator(input) {
  if (typeof input !== 'string') return ''
  return input.trim().replace(/\s+/g, '')
}

function normalizeConfig(input = {}) {
  const bindings = { ...defaultHotkeyConfig.bindings }
  const rawBindings = input?.bindings && typeof input.bindings === 'object' ? input.bindings : {}
  for (const [action, shortcut] of Object.entries(rawBindings)) {
    if (!hotkeyActions.has(action)) continue
    bindings[action] = normalizeAccelerator(shortcut)
  }
  return {
    enabled: input?.enabled !== false,
    bindings,
  }
}

function entriesToConfig(entries = []) {
  const bindings = {}
  for (const entry of Array.isArray(entries) ? entries : []) {
    const action = String(entry?.action || '')
    if (!hotkeyActions.has(action)) continue
    bindings[action] = normalizeAccelerator(entry?.shortcut)
  }
  return normalizeConfig({ enabled: true, bindings })
}

function configToEntries(config) {
  const normalized = normalizeConfig(config)
  if (!normalized.enabled) return []
  return Object.entries(normalized.bindings)
    .filter(([action, shortcut]) => hotkeyActions.has(action) && shortcut)
    .map(([action, shortcut]) => ({ action, shortcut }))
}

function validateConfig(config) {
  const normalized = normalizeConfig(config)
  const failedActions = new Set()
  const actionErrors = {}
  const seen = new Map()

  if (!normalized.enabled) {
    return { success: true, errors: [], status: { failedActions: [], actionErrors: {} } }
  }

  for (const [action, shortcut] of Object.entries(normalized.bindings)) {
    if (!shortcut) continue
    const key = shortcut.toLowerCase()
    const existed = seen.get(key)
    if (!existed) {
      seen.set(key, action)
      continue
    }
    const message = `快捷键冲突：${shortcut}`
    for (const failed of [existed, action]) {
      failedActions.add(failed)
      actionErrors[failed] = [...(actionErrors[failed] || []), message]
    }
  }

  const status = { failedActions: Array.from(failedActions), actionErrors }
  const errors = Array.from(new Set(Object.values(actionErrors).flat()))
  return { success: errors.length === 0, errors, status }
}

async function initializeSystem() {
  if (state.initialized) return
  state.appDataDir = resolveAppDataDir()
  state.configPath = path.join(state.appDataDir, 'system', 'hotkeys.json')
  const stored = await readJson(state.configPath, null)
  state.config = normalizeConfig(stored || defaultHotkeyConfig)
  state.status = validateConfig(state.config).status
  state.initialized = true
}

export const service = {
  async health() {
    await initializeSystem()
    return {
      ok: true,
      service: 'system-integration',
      appDataDir: state.appDataDir,
      hotkeysEnabled: state.config.enabled,
      hotkeyCount: Object.values(state.config.bindings).filter(Boolean).length,
    }
  },

  async getHotkeys(payload = {}) {
    await initializeSystem()
    payload = payload && typeof payload === 'object' ? payload : {}
    if (Array.isArray(payload.backendEntries) && payload.backendEntries.length > 0) {
      const fromBackend = entriesToConfig(payload.backendEntries)
      state.config = normalizeConfig({
        enabled: state.config.enabled,
        bindings: fromBackend.bindings,
      })
      await writeJson(state.configPath, state.config)
    }
    state.status = validateConfig(state.config).status
    return { success: true, data: state.config, status: state.status }
  },

  async setHotkeys(payload = {}) {
    await initializeSystem()
    const nextConfig = normalizeConfig(payload.config || payload)
    const validation = validateConfig(nextConfig)
    if (!validation.success) {
      state.status = validation.status
      return {
        success: false,
        error: '保存失败',
        errors: validation.errors,
        data: state.config,
        status: state.status,
        entries: configToEntries(state.config),
      }
    }

    state.config = nextConfig
    state.status = validation.status
    await writeJson(state.configPath, state.config)
    return {
      success: true,
      data: state.config,
      status: state.status,
      entries: configToEntries(state.config),
    }
  },

  async validateHotkeys(payload = {}) {
    await initializeSystem()
    const config = normalizeConfig(payload.config || payload)
    const validation = validateConfig(config)
    return { ...validation, data: config, entries: configToEntries(config) }
  },

  entriesToHotkeyConfig(payload = {}) {
    return { success: true, data: entriesToConfig(payload.entries || payload) }
  },

  hotkeyConfigToEntries(payload = {}) {
    return { success: true, entries: configToEntries(payload.config || payload) }
  },
}
