import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

const DEFAULT_IDENTIFIER = 'com.cerumusic.tauri'
const HISTORY_LIMIT = 120
const DEFAULT_POLICY = {
  enabled: true,
  historyLimit: HISTORY_LIMIT,
  cooldownMs: {
    system: 4000,
    plugin: 3000,
    listenTogether: 4000,
    ui: 800,
    default: 1500,
  },
}

const state = {
  initialized: false,
  appDataDir: '',
  statePath: '',
  policyPath: '',
  policy: structuredClone(DEFAULT_POLICY),
  history: [],
  suppressedCount: 0,
  lastShownByKey: new Map(),
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

function firstText(...items) {
  for (const item of items) {
    if (typeof item === 'string' && item.trim()) return item.trim()
    if (typeof item === 'number' && Number.isFinite(item)) return String(item)
  }
  return ''
}

function normalizeSeverity(input) {
  const value = String(input || '').toLowerCase()
  if (['success', 'info', 'warning', 'warn', 'error', 'update'].includes(value)) {
    return value === 'warn' ? 'warning' : value
  }
  return 'info'
}

function normalizeChannel(input) {
  const value = String(input || '').trim()
  if (['system', 'plugin', 'listenTogether', 'ui'].includes(value)) return value
  return 'default'
}

function normalizePolicy(input = {}) {
  const rawCooldown = input?.cooldownMs && typeof input.cooldownMs === 'object' ? input.cooldownMs : {}
  return {
    enabled: input?.enabled !== false,
    historyLimit: Math.max(10, Math.min(500, Number(input?.historyLimit || HISTORY_LIMIT))),
    cooldownMs: {
      ...DEFAULT_POLICY.cooldownMs,
      ...Object.fromEntries(
        Object.entries(rawCooldown)
          .map(([key, value]) => [key, Number(value)])
          .filter(([, value]) => Number.isFinite(value) && value >= 0)
      ),
    },
  }
}

function normalizeNotification(input = {}) {
  const data = input && typeof input === 'object' ? input : {}
  const channel = normalizeChannel(data.channel)
  const severity = normalizeSeverity(data.severity || data.type || data.dialogType)
  const pluginId = firstText(data.pluginId, data.plugin_id)
  const title = firstText(data.title, data.data?.title, data.header, '通知')
  const body = firstText(data.body, data.message, data.content, data.data?.message, data.data?.content)
  const tag = firstText(
    data.tag,
    data.id,
    pluginId && `${channel}:${pluginId}`,
    `${channel}:${severity}:${title}`
  )
  const now = Date.now()
  return {
    id: firstText(data.id) || randomUUID(),
    channel,
    severity,
    title,
    body,
    tag,
    source: firstText(data.source, data.pluginName, data.sender, channel),
    pluginId,
    payload: data.payload ?? data.notice ?? null,
    force: Boolean(data.force),
    at: Number(data.at || data.timestamp || now),
  }
}

function normalizeHistory(input) {
  return (Array.isArray(input) ? input : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => normalizeNotification(item))
    .slice(-state.policy.historyLimit)
}

async function initializeSystem() {
  if (state.initialized) return
  state.appDataDir = resolveAppDataDir()
  state.statePath = path.join(state.appDataDir, 'system', 'notification-state.json')
  state.policyPath = path.join(state.appDataDir, 'system', 'notification-policy.json')
  state.policy = normalizePolicy(await readJson(state.policyPath, DEFAULT_POLICY))
  const stored = await readJson(state.statePath, {})
  state.history = normalizeHistory(stored.history)
  state.suppressedCount = Number(stored.suppressedCount || 0)
  state.lastShownByKey = new Map(
    Object.entries(stored.lastShownByKey || {})
      .map(([key, value]) => [key, Number(value)])
      .filter(([, value]) => Number.isFinite(value))
  )
  state.initialized = true
}

async function persistPolicy() {
  await writeJson(state.policyPath, state.policy)
}

async function persistState() {
  await writeJson(state.statePath, {
    history: state.history.slice(-state.policy.historyLimit),
    suppressedCount: state.suppressedCount,
    lastShownByKey: Object.fromEntries(state.lastShownByKey.entries()),
  })
}

function publicState() {
  return {
    policy: state.policy,
    history: state.history.slice(-state.policy.historyLimit),
    suppressedCount: state.suppressedCount,
  }
}

function getDecision(notification) {
  if (!state.policy.enabled && !notification.force) {
    return { show: false, reason: 'disabled' }
  }
  if (notification.force) return { show: true, reason: 'force' }

  const cooldown = Number(
    state.policy.cooldownMs[notification.channel] ?? state.policy.cooldownMs.default ?? 0
  )
  if (cooldown <= 0) return { show: true, reason: 'allowed' }

  const key = notification.tag || `${notification.channel}:${notification.title}`
  const lastShownAt = Number(state.lastShownByKey.get(key) || 0)
  const elapsed = Date.now() - lastShownAt
  if (elapsed < cooldown) {
    return { show: false, reason: 'cooldown', retryAfterMs: cooldown - elapsed }
  }
  return { show: true, reason: 'allowed' }
}

export const service = {
  async health() {
    await initializeSystem()
    return {
      ok: true,
      service: 'system-notification',
      appDataDir: state.appDataDir,
      enabled: state.policy.enabled,
      historyCount: state.history.length,
      suppressedCount: state.suppressedCount,
    }
  },

  async getState() {
    await initializeSystem()
    return { success: true, data: publicState() }
  },

  async setPolicy(payload = {}) {
    await initializeSystem()
    state.policy = normalizePolicy(payload.policy || payload)
    state.history = state.history.slice(-state.policy.historyLimit)
    await persistPolicy()
    await persistState()
    return { success: true, data: publicState() }
  },

  async record(payload = {}) {
    await initializeSystem()
    const notification = normalizeNotification(payload)
    const decision = getDecision(notification)
    if (decision.show) {
      state.lastShownByKey.set(notification.tag, Date.now())
    } else {
      state.suppressedCount += 1
    }
    state.history = [...state.history, { ...notification, shown: decision.show, reason: decision.reason }]
      .slice(-state.policy.historyLimit)
    await persistState()
    return {
      success: true,
      show: decision.show,
      reason: decision.reason,
      retryAfterMs: decision.retryAfterMs || 0,
      notification,
      data: publicState(),
    }
  },

  async clearHistory() {
    await initializeSystem()
    state.history = []
    state.suppressedCount = 0
    state.lastShownByKey.clear()
    await persistState()
    return { success: true, data: publicState() }
  },
}