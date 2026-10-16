/**
 * Tauri API Bridge
 * 
 * Replaces Electron preload API (window.api / window.electron.ipcRenderer)
 * with Tauri invoke() + event system.
 * 
 * Phase 1: Full API surface mapped. Backend commands that don't exist yet
 * return sensible defaults/errors.
 */

import { invoke as tauriInvoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen, emit } from '@tauri-apps/api/event'
import {
  getCurrentWindow,
  ProgressBarStatus,
} from '@tauri-apps/api/window'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { exit as exitApp, relaunch as relaunchApp } from '@tauri-apps/plugin-process'
import { BaseDirectory, remove } from '@tauri-apps/plugin-fs'
import { checkUpdate, onUpdaterEvent, type UpdaterEvent, type UpdateResult } from './stubs/tauri-plugin-updater'
import { pluginSandbox } from './utils/plugin/pluginSandbox'
import convertEventDrivenPlugin from './utils/plugin/converter-event-driven'
import convertMusicFreePlugin, {
  looksLikeMusicFreePlugin,
  isConvertedMusicFreePlugin,
} from './utils/plugin/converter-musicfree'

/* ------------------------------------------------------------------ */
/*  Type declarations (same shape as Electron preload)                */
/* ------------------------------------------------------------------ */

declare global {
  interface Window {
    api: Record<string, any>
    electron: Record<string, any>
    __shuxiaVisibilityHandler?: EventListener
    musicEmitter?: any
    __shuxiaPluginAddLinkHandlerInstalled?: boolean
    __shuxiaIpcStats?: {
      total: number
      byCmd: Record<string, number>
      startedAt: number
      lastCmd?: string
      lastAt?: number
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Channel name mapping: Electron kebab/colon → Tauri snake_case     */
/* ------------------------------------------------------------------ */

const INVOKE_CHANNEL_MAP: Record<string, string> = {
  'dialog:openFile': 'dialog_open_file',
  'clipboard:read-text': 'clipboard_read_text',
  'get-pending-open-playlist-files': 'get_pending_open_playlist_files',
  'get-pending-oauth-callbacks': 'get_pending_oauth_callbacks',
  'get-pending-lt-codes': 'get_pending_lt_codes',
  // DLNA store still uses Electron channel names; colon form must map
  // explicitly because replace(/-/g, '_') leaves `dlna:startSearch` intact.
  'dlna:startSearch': 'dlna_start_search',
  'dlna:stopSearch': 'dlna_stop_search',
  'dlna:getDevices': 'dlna_get_devices',
  'dlna:play': 'dlna_play',
  'dlna:pause': 'dlna_pause',
  'dlna:resume': 'dlna_resume',
  'dlna:stop': 'dlna_stop',
  'dlna:seek': 'dlna_seek',
  'dlna:getPosition': 'dlna_get_position',
  'dlna:getVolume': 'dlna_get_volume',
  'dlna:setVolume': 'dlna_set_volume',
  'get-app-version': 'get_app_version',
  'get-font-list': 'get_font_list',
}

/** Map an Electron IPC channel name to a Tauri command name */
function mapInvokeChannel(channel: string): string {
  if (INVOKE_CHANNEL_MAP[channel]) return INVOKE_CHANNEL_MAP[channel]
  return channel.replace(/-/g, '_')
}

/**
 * Pack Electron `ipcRenderer.invoke(channel, ...args)` payloads for Tauri.
 *
 * Most Tauri commands expect a flat named-args object. A few legacy shims
 * (notably `dialog_open_file`) still take `{ args: [...] }` because the Rust
 * side mirrors Electron's multi-arg IPC style.
 */
function packInvokeArgs(
  channel: string,
  tauriCmd: string,
  args: any[],
): Record<string, unknown> | undefined {
  if (!args.length) return undefined

  // dialog_open_file(args: Option<Vec<Value>>) expects the Electron arg list.
  if (channel === 'dialog:openFile' || tauriCmd === 'dialog_open_file') {
    return { args }
  }

  // Scalar Electron IPC args need named Tauri fields.
  if (channel === 'dlna:seek' || tauriCmd === 'dlna_seek') {
    return { seconds: Number(args[0]) }
  }
  if (channel === 'dlna:setVolume' || tauriCmd === 'dlna_set_volume') {
    return { volume: Number(args[0]) }
  }

  // Single plain object → pass through as Tauri command args.
  if (
    args.length === 1 &&
    args[0] != null &&
    typeof args[0] === 'object' &&
    !Array.isArray(args[0])
  ) {
    return args[0] as Record<string, unknown>
  }

  // Fallback keeps the old `{ args }` shape for unknown multi/scalar payloads.
  return { args }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const appWindow = getCurrentWindow()

let shuxiaIpcStatsFlusherStarted = false
function ensureShuxiaIpcStatsFlusher() {
  if (shuxiaIpcStatsFlusherStarted) return
  const enableStats =
    import.meta.env.DEV ||
    (typeof localStorage !== 'undefined' && localStorage.getItem('enable-ipc-stats') === 'true')
  if (!enableStats) return
  shuxiaIpcStatsFlusherStarted = true
  window.setInterval(() => {
    try {
      const stats = window.__shuxiaIpcStats
      if (!stats || !stats.total) return
      const snapshot = {
        total: stats.total,
        lastCmd: stats.lastCmd || '',
        lastAt: stats.lastAt || 0,
        startedAt: stats.startedAt,
        byCmd: { ...(stats.byCmd || {}) },
        at: Date.now(),
      }
      // Reset window counters each flush so rates are visible.
      stats.total = 0
      stats.byCmd = Object.create(null) as Record<string, number>
      const top = Object.entries(snapshot.byCmd || {})
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 6)
        .map(([cmd, count]) => `${cmd}:${count}`)
        .join(',')
      void tauriInvoke('mpv_debug_hot_ping', {
        label: `ipc:${snapshot.total}|${top}|last:${snapshot.lastCmd || ''}`,
      }).catch(() => {})
      ;(window as any).__shuxiaIpcStatsLast = snapshot
    } catch {}
  }, 2000)
}

function recordIpcInvoke(cmd: string) {
  ensureShuxiaIpcStatsFlusher()
  try {
    const stats = (window.__shuxiaIpcStats ||= {
      total: 0,
      byCmd: Object.create(null) as Record<string, number>,
      startedAt: Date.now(),
    })
    stats.total += 1
    stats.byCmd[cmd] = (stats.byCmd[cmd] || 0) + 1
    stats.lastCmd = cmd
    stats.lastAt = Date.now()
  } catch {
    // Never block playback because of diagnostics.
  }
}

async function invoke<T = any>(cmd: string, args?: Record<string, unknown>, options?: any): Promise<T> {
  recordIpcInvoke(cmd)
  return tauriInvoke<T>(cmd, args, options)
}

type AppWindowStatePayload = {
  visible: boolean
  focused: boolean
  minimized: boolean
  hidden: boolean
  fullscreen: boolean
}

let lastWindowStatePayload: AppWindowStatePayload | null = null

let lastProgressBarKey = ''
let lastProgressBarAt = 0

const IPC_NOISE_EVENTS = new Set([
  'play-lyric-progress',
  'play-lyric-index',
  'play-lyric-change',
  'play-song-change',
  'play-status-change',
  'update-tray-lyric',
  'thumbar:set-state',
  'thumbar:set-cover',
  'app:set-progress',
  'startPing',
  'stopPing',
])

function shouldDropNoiseEvent(channel: string): boolean {
  if (!IPC_NOISE_EVENTS.has(channel)) return false
  // Never drop lyric/song/status events — the Rust side efficiently ignores
  // them when no consumer is active, and the renderer's settings flag may not
  // be restored yet at startup (race with DB load).
  if (
    channel === 'play-lyric-progress' ||
    channel === 'play-lyric-index' ||
    channel === 'play-lyric-change' ||
    channel === 'play-song-change' ||
    channel === 'play-status-change' ||
    channel === 'update-tray-lyric'
  ) {
    return false
  }
  // macOS Dock progress is handled by applyWindowProgressBar. The legacy emit
  // path only burns custom-protocol IPC.
  if (channel === 'app:set-progress' || channel === 'thumbar:set-state' || channel === 'thumbar:set-cover') {
    return true
  }
  if (channel === 'startPing' || channel === 'stopPing') return true
  return false
}

async function applyWindowProgressBar(progress: number, options?: { paused?: boolean }) {
  const paused = Boolean(options?.paused)
  const finite = typeof progress === 'number' && Number.isFinite(progress)
  const clear = !finite || progress < 0
  const normalized = clear ? -1 : Math.max(0, Math.min(1, progress))
  const rounded = clear ? -1 : Math.round(normalized * 100)
  const key = clear ? 'none' : `${rounded}:${paused ? 1 : 0}`
  const now = Date.now()
  // Dock/taskbar progress does not need sub-second IPC; skip unchanged frames.
  if (key === lastProgressBarKey && now - lastProgressBarAt < 1500) return
  lastProgressBarKey = key
  lastProgressBarAt = now
  if (clear) {
    await appWindow.setProgressBar({ status: ProgressBarStatus.None }).catch(console.warn)
    return
  }
  await appWindow
    .setProgressBar({
      status: paused ? ProgressBarStatus.Paused : ProgressBarStatus.Normal,
      progress: rounded,
    })
    .catch(console.warn)
}

async function getWindowStatePayload(): Promise<AppWindowStatePayload> {
  const [focused, minimized, visible, nativeFullscreen, windowedFullscreen] = await Promise.all([
    appWindow.isFocused().catch(() => typeof document.hasFocus === 'function' ? document.hasFocus() : true),
    appWindow.isMinimized().catch(() => false),
    appWindow.isVisible().catch(() => !document.hidden),
    appWindow.isFullscreen().catch(() => false),
    // 窗口化全屏（网易云式）不进原生全屏 Space，native isFullscreen 恒为 false，需问 Rust 端状态
    safeInvoke<boolean>('windowed_fullscreen_get', undefined, false),
  ])
  return {
    visible: Boolean(visible),
    focused: Boolean(focused),
    minimized: Boolean(minimized),
    hidden: document.hidden || !visible,
    fullscreen: Boolean(nativeFullscreen || windowedFullscreen),
  }
}

async function emitWindowStateChanged() {
  const next = await getWindowStatePayload()
  const serialized = JSON.stringify(next)
  if (serialized === JSON.stringify(lastWindowStatePayload)) return
  lastWindowStatePayload = next
  await invokeNodeWindowLifecycle('recordWindowState', { window: next }).catch(() => undefined)
  await emit('app-window-state-changed', next).catch(console.warn)
}

function createLocalId(prefix = 'local'): string {
  const randomId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${randomId}`
}

function normalizeSongListRecord(input: any): any {
  if (!input || typeof input !== 'object') return input
  const coverImgUrl = firstText(input.coverImgUrl, input.cover_img_url, input.cover, input.img)
  const createTime = firstText(input.createTime, input.create_time)
  const updateTime = firstText(input.updateTime, input.update_time)
  return {
    ...input,
    coverImgUrl,
    cover_img_url: firstText(input.cover_img_url, coverImgUrl),
    createTime,
    create_time: firstText(input.create_time, createTime),
    updateTime,
    update_time: firstText(input.update_time, updateTime),
    description: input.description || '',
    source: input.source || 'local',
    meta: input.meta && typeof input.meta === 'object' ? input.meta : {},
  }
}

function normalizeSongListRecords(input: any): any[] {
  return Array.isArray(input) ? input.map(normalizeSongListRecord) : []
}

function ipcSuccess<T = any>(data?: T) {
  return { success: true, data }
}

function ipcFailure(error: unknown, fallbackMessage: string) {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error || fallbackMessage),
  }
}

async function invokeIpc<T = any>(
  cmd: string,
  args?: Record<string, unknown>,
  normalize: (value: any) => T = (value) => value as T,
  fallbackMessage = '操作失败',
) {
  try {
    return ipcSuccess(normalize(await invoke(cmd, args)))
  } catch (error) {
    console.warn(`[tauri-bridge] invoke ${cmd} failed:`, error)
    return ipcFailure(error, fallbackMessage)
  }
}

function toSongmidList(songmids: (string | number)[]): string[] {
  return songmids.map((item) => String(item)).filter(Boolean)
}

function toStoredSongs(songs: any[]): any[] {
  return songs.map((song) => {
    const normalized = {
      ...song,
      songmid: String(song?.songmid ?? song?.id ?? song?.hash ?? '').trim(),
      name: String(song?.name ?? song?.title ?? ''),
      singer: String(song?.singer ?? song?.artist ?? ''),
      albumName: String(song?.albumName ?? song?.album ?? ''),
      img: String(song?.img ?? song?.artworkUrl ?? ''),
      source: String(song?.source ?? '').trim(),
      interval: String(song?.interval ?? song?.durationText ?? song?.duration ?? ''),
    }
    if (song?.hash !== undefined && song?.hash !== null) {
      normalized.hash = String(song.hash)
    }
    return normalized
  }).filter((song) => song.songmid && song.source)
}

function normalizeAddedSongsResult(raw: any, total: number) {
  const added = Number(raw ?? 0)
  const safeAdded = Number.isFinite(added) ? Math.max(0, added) : 0
  return {
    added: safeAdded,
    skipped: Math.max(0, total - safeAdded),
    total,
  }
}

function normalizeDialogSelection(result: string | string[] | null): string[] {
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}

async function openFileDialog(options: any = {}): Promise<string[]> {
  const properties = Array.isArray(options?.properties) ? options.properties : []
  const result = await openDialog({
    title: options?.title,
    defaultPath: options?.defaultPath,
    multiple: Boolean(options?.multiple || properties.includes('multiSelections')),
    directory: Boolean(options?.directory || properties.includes('openDirectory')),
    filters: options?.filters,
  })
  return normalizeDialogSelection(result)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: number | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (typeof timer === 'number') window.clearTimeout(timer)
  })
}

/** In-memory plugin config store (replaces DB persistence for now) */
const pluginConfigStore: Record<string, Record<string, any>> = {}

const FEINIU_AUTO_IMPORT_VERSION = 2
const FEINIU_API_PATH = '/music/api/v1/'
const coverProxyUrlCache = new Map<string, string>()
const coverProxyUrlPending = new Map<string, Promise<string>>()
const COVER_PROXY_URL_CACHE_MAX = 128

const rememberCoverProxyUrl = (key: string, value: string) => {
  if (coverProxyUrlCache.has(key)) coverProxyUrlCache.delete(key)
  coverProxyUrlCache.set(key, value)
  while (coverProxyUrlCache.size > COVER_PROXY_URL_CACHE_MAX) {
    const oldest = coverProxyUrlCache.keys().next().value
    if (oldest === undefined) break
    coverProxyUrlCache.delete(oldest)
  }
}

let coverProxyBase = ''
let coverProxyBasePending: Promise<string> | null = null
let feiniuStartupSyncPromise: Promise<any> | null = null
let feiniuPluginIdCache: string | null | undefined

const SOURCE_NAME_MAP: Record<string, string> = {
  kw: '酷我音乐',
  kg: '酷狗音乐',
  tx: 'QQ音乐',
  wy: '网易云音乐',
  mg: '咪咕音乐',
}

const SOURCE_ALIAS_MAP: Record<string, string> = {
  qq: 'tx',
  wyy: 'wy',
  qqmusic: 'tx',
  'qq音乐': 'tx',
  tencent: 'tx',
  netease: 'wy',
  neteasecloud: 'wy',
  cloudmusic: 'wy',
  kuwo: 'kw',
  'kuwo-music': 'kw',
  kuwo_music: 'kw',
  kugou: 'kg',
  'kugou-music': 'kg',
  migu: 'mg',
  '酷我': 'kw',
  '酷我音乐': 'kw',
  '酷狗': 'kg',
  '酷狗音乐': 'kg',
  '腾讯音乐': 'tx',
  '网易': 'wy',
  '网易云': 'wy',
  '网易云音乐': 'wy',
  '咪咕': 'mg',
  '咪咕音乐': 'mg',
}

function normalizeSourceKey(input?: string | null): string {
  const key = String(input || '').trim().toLowerCase()
  return SOURCE_ALIAS_MAP[key] || key
}

const BUILTIN_PLAYABLE_SOURCES = new Set(['wy', 'tx', 'kg', 'kw', 'mg'])
const BUILTIN_METADATA_APIS = new Set([
  'getLyric',
  'getPic',
  'getComment',
  'getHotComment',
  'getCommentList',
  'getCommentReply',
  'getPlaylistTags',
  'getCategoryPlaylists',
  'getHotSonglist',
  'getPlaylistDetail',
  'getListSongs',
  'getLeaderboards',
  'getLeaderboardDetail',
  'getToplist',
  'getToplistDetail',
])
const BUILTIN_CATALOG_APIS = new Set(['search', 'tipSearch', 'searchPlaylist'])

function shouldUseBuiltinCatalog(apiName: string, source?: string | null): boolean {
  return BUILTIN_CATALOG_APIS.has(apiName) && isBuiltinMetadataSource(source)
}

function isBuiltinPlayableSource(source?: string | null): boolean {
  return BUILTIN_PLAYABLE_SOURCES.has(normalizeSourceKey(source))
}

function isBuiltinMetadataSource(source?: string | null): boolean {
  const key = normalizeSourceKey(source)
  return key === 'all' || BUILTIN_PLAYABLE_SOURCES.has(key)
}

const SOURCE_KEY_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(SOURCE_NAME_MAP).map(([key, name]) => [name, key]),
)

/** Maps source keys (e.g. 'kw', 'kg', 'tx') to the plugin that manages them */
const sourcePluginMap = new Map<string, string>()

function normalizeQualitys(input: any, fallback: string[] = ['128k', '320k']): string[] {
  if (Array.isArray(input)) return input.map((item) => String(item)).filter(Boolean)
  const qualitys = input?.qualitys || input?.qualities || input?.quality || input?.types
  if (Array.isArray(qualitys)) return qualitys.map((item: any) => String(item)).filter(Boolean)
  return fallback
}

function normalizePluginSources(input: any): Record<string, any> {
  const candidates = [
    input?.supportedSources,
    input?.sources,
    input?.source,
    input?.platforms,
    input?.platform,
    input?.musicSources,
    input?.pluginInfo?.supportedSources,
    input?.pluginInfo?.sources,
    input?.pluginInfo?.source,
    input?.pluginInfo?.platforms,
    input?.pluginInfo?.platform,
    input?.metadata?.supportedSources,
    input?.metadata?.sources,
    input?.metadata?.source,
    input?.meta?.supportedSources,
    input?.meta?.sources,
    input?.meta?.source,
  ].filter((item) => item !== undefined && item !== null && item !== '')

  const result: Record<string, any> = {}
  const pushSource = (sourceKey: any, sourceInfo: any = {}) => {
    const info = sourceInfo && typeof sourceInfo === 'object' && !Array.isArray(sourceInfo) ? sourceInfo : {}
    const key = normalizeSourceKey(
      firstText(
        sourceKey,
        info.id,
        info.source,
        info.key,
        info.platform,
        info.platformId,
        info.platform_id,
        SOURCE_KEY_BY_NAME[info.name],
      ),
    )
    if (!key || key === 'all') return

    const sourceName = firstText(info.name, SOURCE_NAME_MAP[key], key.toUpperCase())
    result[key] = {
      ...info,
      name: sourceName,
      type: info.type || 'music',
      qualitys: normalizeQualitys(info),
    }
  }

  const consume = (raw: any) => {
    if (typeof raw === 'string') {
      raw
        .split(/[|,，/\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach((item) => {
          const key = normalizeSourceKey(SOURCE_KEY_BY_NAME[item] || item)
          pushSource(key, { name: SOURCE_NAME_MAP[key] || item })
        })
      return
    }

    if (Array.isArray(raw)) {
      raw.forEach((item: any) => {
        if (typeof item === 'string') {
          consume(item)
          return
        }
        pushSource(
          item?.id || item?.source || item?.key || item?.platform || item?.platformId || item?.platform_id || SOURCE_KEY_BY_NAME[item?.name],
          item,
        )
      })
      return
    }

    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        const sourceKey = normalizeSourceKey(SOURCE_KEY_BY_NAME[key] || key)
        if (Array.isArray(value)) {
          pushSource(sourceKey, { name: SOURCE_NAME_MAP[sourceKey] || sourceKey.toUpperCase(), qualitys: value })
        } else if (typeof value === 'string') {
          const valueAsSource = normalizeSourceKey(SOURCE_KEY_BY_NAME[value] || value)
          if (SOURCE_NAME_MAP[valueAsSource] || SOURCE_ALIAS_MAP[valueAsSource] || BUILTIN_PLAYABLE_SOURCES.has(valueAsSource)) {
            pushSource(valueAsSource, { name: SOURCE_NAME_MAP[valueAsSource] || value })
          } else {
            pushSource(sourceKey, { name: value })
          }
        } else {
          pushSource(sourceKey, value)
        }
      }
    }
  }

  candidates.forEach(consume)
  return result
}

function registerPluginSources(pluginId: string, exports: any) {
  const normalizedSources = normalizePluginSources(exports)
  for (const [source, mappedPluginId] of Array.from(sourcePluginMap.entries())) {
    if (mappedPluginId === pluginId) sourcePluginMap.delete(source)
  }
  for (const key of Object.keys(normalizedSources)) {
    sourcePluginMap.set(key, pluginId)
  }
  if (exports && typeof exports === 'object') {
    exports.sources = normalizedSources
    exports.supportedSources = normalizedSources
  }
}

function pluginNameScore(name: string): number {
  const text = String(name || '')
  if (text.includes('赞助版')) return 100
  if (text.includes('全豆要')) return 90
  if (text.includes('聚合API')) return 80
  if (text.includes('公益版')) return 70
  if (text.includes('ikun')) return 60
  return 10
}

function registerSidecarPluginSources(pluginId: string, plugin: any) {
  const id = String(pluginId || '').trim()
  if (!id) return
  const sources = normalizePluginSources(plugin)
  for (const key of Object.keys(sources)) {
    sourcePluginMap.set(key, id)
  }
}

function findNodePluginEntry(entries: any[], pluginId: string) {
  const id = String(pluginId || '').trim()
  if (!id) return undefined
  return (Array.isArray(entries) ? entries : []).find(
    (entry: any) => String(entry?.pluginId || entry?.id || '').trim() === id,
  )
}

function extractPluginMetaExports(exports: any, fallbackId = '') {
  const supportedSources = getPluginSupportedSources(exports)
  return {
    pluginInfo: exports?.pluginInfo || {
      name: fallbackId,
      version: '',
      author: '',
      description: '',
    },
    pluginType: exports?.pluginType || 'music-source',
    supportedSources,
    sources: supportedSources,
    configSchema: exports?.configSchema,
    serviceRole: exports?.serviceRole,
  }
}

function isSidecarPluginEnabled(entry: any): boolean {
  return Boolean(entry) && entry.disabled !== true && entry.enabled !== false
}

function normalizeLocalMusicUrlResult(input: any) {
  const rawUrl = typeof input === 'string' ? input : input?.url
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return input
  const url = rawUrl.trim()
  if (url.startsWith('file://')) {
    try {
      return convertFileSrc(decodeURI(url.replace(/^file:\/\//, '')))
    } catch {
      return url
    }
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    try {
      return convertFileSrc(url)
    } catch {
      return url
    }
  }
  return url
}

function normalizePluginInstallFailure(e: any) {
  const message = String(e?.message || e || '未知错误')
  return { success: false, error: message, message }
}

function normalizePluginType(input: any): 'lx' | 'cr' {
  return input === 'lx' ? 'lx' : 'cr'
}

function isValidHttpUrl(input?: string | null): boolean {
  try {
    const parsed = new URL(String(input || ''))
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Electron 对照：src/main/events/pluginNotice.ts sendPluginNotice
 * sidecar 会发完整 DialogNotice；前端沙箱 fallback 常发原始 {type,data}。
 * 两类都要能进 PluginNoticeDialog，尤其是插件 updateAlert 主动更新弹窗。
 */
function getPluginNoticeTitle(type: string) {
  const titleMap: Record<string, string> = {
    update: '插件更新',
    error: '插件错误',
    warning: '插件警告',
    warn: '插件警告',
    info: '插件信息',
    success: '操作成功',
  }
  return titleMap[type] || '插件通知'
}

function getPluginNoticeDefaultMessage(type: string, data: any, pluginName: string) {
  switch (type) {
    case 'error':
      return `插件 "${pluginName}" 发生错误: ${data?.error || data?.message || '未知错误'}`
    case 'warning':
    case 'warn':
      return `插件 "${pluginName}" 警告: ${data?.warning || data?.message || '需要注意'}`
    case 'success':
      return `插件 "${pluginName}" 操作成功: ${data?.message || ''}`
    case 'info':
    default:
      return data?.message || data?.content || `插件 "${pluginName}" 信息`
  }
}

function buildDialogNoticeFromRaw(raw: any) {
  if (!raw || typeof raw !== 'object') return null

  const type = String(raw.type || raw.dialogType || 'info')
  const data = raw.data && typeof raw.data === 'object' ? raw.data : {}
  const pluginName = String(raw.pluginName || data.pluginInfo?.name || 'Unknown Plugin')
  const pluginId = raw.pluginId || data.pluginId
  const url = String(raw.updateUrl || data.url || data.updateUrl || '').trim()
  const hasUrl = isValidHttpUrl(url)
  const pluginType = normalizePluginType(raw.pluginType || data.pluginInfo?.type || data.type)
  const currentVersion = raw.currentVersion || data.currentVersion || '未知'
  const newVersion = raw.newVersion || data.version

  if (type === 'update' && hasUrl) {
    return {
      type: 'update',
      data,
      timestamp: raw.timestamp || Date.now(),
      pluginName,
      pluginId,
      dialogType: 'update',
      title: data.title || raw.title || '插件更新',
      message: data.content || data.message || raw.message || `插件 "${pluginName}" 有新版本可用`,
      updateUrl: url,
      pluginType,
      currentVersion,
      newVersion,
      actions: [
        { text: '稍后更新', type: 'cancel' },
        { text: '立即更新', type: 'update', primary: true },
      ],
    }
  }

  const dialogType =
    type === 'error'
      ? 'error'
      : type === 'warn' || type === 'warning'
        ? 'warning'
        : type === 'success'
          ? 'success'
          : 'info'

  return {
    type,
    data,
    timestamp: raw.timestamp || Date.now(),
    pluginName,
    pluginId,
    dialogType,
    title: data.title || raw.title || getPluginNoticeTitle(type),
    message:
      data.message ||
      data.content ||
      raw.message ||
      getPluginNoticeDefaultMessage(type, data, pluginName),
    ...(hasUrl
      ? {
          updateUrl: url,
          pluginType,
        }
      : {}),
    actions: hasUrl
      ? [
          { text: '取消', type: 'cancel' },
          { text: '安装并使用', type: 'confirm', primary: true },
        ]
      : [{ text: '我知道了', type: 'confirm', primary: true }],
  }
}

function normalizeDialogNotice(raw: any) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.dialogType && raw.title && Array.isArray(raw.actions)) return raw
  return buildDialogNoticeFromRaw(raw)
}

function parsePluginAddLinkPayload(payload: any): { url: string; type: 'lx' | 'cr'; targetPluginId?: string } | null {
  if (payload && typeof payload === 'object') {
    const url = String(payload.url || payload.pluginUrl || '').trim()
    if (!isValidHttpUrl(url)) return null
    const targetPluginId = String(payload.targetPluginId || payload.pluginId || '').trim() || undefined
    return { url, type: normalizePluginType(payload.type), targetPluginId }
  }

  const raw = String(payload || '').trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    const url = String(parsed.searchParams.get('url') || '').trim()
    if (!isValidHttpUrl(url)) return null
    const targetPluginId = String(parsed.searchParams.get('targetPluginId') || parsed.searchParams.get('pluginId') || '').trim() || undefined
    return { url, type: normalizePluginType(parsed.searchParams.get('type')), targetPluginId }
  } catch {
    return null
  }
}

function createPluginInstallNotice(payload: { url: string; type: 'lx' | 'cr'; targetPluginId?: string }) {
  return {
    type: 'info',
    data: {
      title: '外部插件安装请求',
      message: '检测到外部 Deeplink 安装请求。请确认来源可靠，谨慎安装来路不明插件。',
      url: payload.url,
      pluginInfo: { type: payload.type },
    },
    timestamp: Date.now(),
    pluginName: '插件安装',
    pluginId: payload.targetPluginId,
    dialogType: 'info',
    title: '外部插件安装请求',
    message: '检测到外部 Deeplink 安装请求。请确认来源可靠，谨慎安装来路不明插件。',
    updateUrl: payload.url,
    pluginType: payload.type,
    actions: [
      { text: '取消', type: 'cancel' },
      { text: '安装并使用', type: 'confirm', primary: true },
    ],
  }
}

function normalizePluginId(input?: string | null): string {
  const normalized = String(input || '')
    .trim()
    .replace(/\.js$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || `plugin_${Date.now()}`
}

function createPluginId(): string {
  const uuid = globalThis.crypto?.randomUUID?.().replace(/-/g, '')
  return uuid || `plugin_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function getPluginSupportedSources(exports: any) {
  return normalizePluginSources(exports)
}

function isConvertedLxPluginCode(code: string): boolean {
  return (
    code.includes('由 ShuxiaMusic 插件转换器转换') ||
    (code.includes('const originalPluginCode') && code.includes('pluginInfo'))
  )
}

function looksLikeHtmlDocument(code: string): boolean {
  const text = String(code || '').trim()
  if (/^<!doctype html/i.test(text) || /^<html[\s>]/i.test(text)) return true
  if (isConvertedLxPluginCode(text)) {
    const original = extractConvertedLxOriginalCode(text)
    if (original) {
      const originalText = original.trim()
      return /^<!doctype html/i.test(originalText) || /^<html[\s>]/i.test(originalText)
    }
  }
  return false
}

function hasModuleExports(code: string): boolean {
  return /\bmodule\.exports\s*=/.test(code)
}

function decodePluginDetectionText(code: string): string {
  return String(code || '')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

function looksLikeLxEventPlugin(code: string): boolean {
  const text = decodePluginDetectionText(code)
  return (
    /\blx\.on\s*\(/.test(text) ||
    (/\bEVENT_NAMES\b/.test(text) && /\blx\.send\s*\(/.test(text)) ||
    /\blx\.request\s*\(/.test(text)
  )
}

function looksLikeLxPluginCode(code: string): boolean {
  const raw = String(code || '')
  if (looksLikeHtmlDocument(raw)) return false
  if (raw.toLowerCase().includes('lx')) return true
  return decodePluginDetectionText(raw).toLowerCase().includes('lx')
}

function isShuxiaPluginCode(code: string): boolean {
  return (
    hasModuleExports(code) ||
    /\bexports\s*\./.test(code) ||
    /\bpluginInfo\b/.test(code) ||
    /\bgetMusicUrl\b/.test(code) ||
    /\bmusicUrl\b/.test(code) ||
    /\bcerumusic\b/i.test(code)
  )
}

/**
 * 插件导入智能识别 —— 与安卓 PluginFormatDetector 保持一致：
 * 用户不再手动选「澜音 / 洛雪」类别，导入时按脚本内容自动识别。
 * 只有洛雪事件协议插件与树夏music(澜音) CommonJS 插件受支持，其余（统一标记 SHUXIA、
 * 无法识别入口的脚本、下载到的网页）一律判为不兼容，让上层弹窗提示。
 *
 * type 字段是喂给 preparePluginCode 的有效类别：
 *   - 'cr' 走澜音校验（脚本一定含 cerumusic 关键字，校验必过）
 *   - 'lx' 走洛雪转换（脚本含 lx 关键字时使用）
 *   - undefined 走宽松自动路径（识别为音源脚本但无 lx 关键字的兜底情况）
 */
interface ImportPluginCompatibility {
  compatible: boolean
  type?: 'lx' | 'cr' | 'mf'
  formatName: string
  reason: string
}

function detectImportPluginCompatibility(code: string): ImportPluginCompatibility {
  const raw = String(code || '')
  if (looksLikeHtmlDocument(raw)) {
    return { compatible: false, formatName: '网页文件', reason: '下载到的是 HTML 页面，不是可执行的音源脚本' }
  }

  const lower = (raw + '\n' + decodePluginDetectionText(raw)).toLowerCase()
  const looksLikeLxEvent =
    lower.includes('lx.on(') ||
    lower.includes('globalthis.lx.on') ||
    lower.includes('event_names') ||
    lower.includes('lx.send(') ||
    lower.includes('globalthis.lx') ||
    lower.includes('window.lx') ||
    lower.includes("on('request'") ||
    lower.includes('on("request"') ||
    lower.includes('lx.utils') ||
    lower.includes('lx.currentscriptinfo') ||
    lower.includes('lx.request') ||
    lower.includes('lx_api')
  const usesCerumusicApi = lower.includes('cerumusic')
  const hasLxToken = looksLikeLxPluginCode(raw)
  const looksLikeShuxia = lower.includes('shuxia') || raw.includes('树夏')
  const looksLikeGenericSource =
    /\bhandler\b/i.test(raw) ||
    lower.includes('musicurl') ||
    lower.includes('getmediasource') ||
    lower.includes('lyric')

  if (usesCerumusicApi && lower.includes('worker_thread')) {
    return { compatible: true, type: 'cr', formatName: '树夏music插件', reason: '树夏music Host 插件，按 cerumusic 兼容层加载' }
  }
  if (looksLikeLxEvent) {
    return { compatible: true, type: hasLxToken ? 'lx' : undefined, formatName: '洛雪插件', reason: '洛雪事件协议插件' }
  }
  if (usesCerumusicApi) {
    return { compatible: true, type: 'cr', formatName: '树夏music插件', reason: '树夏music CommonJS 插件' }
  }
  if (looksLikeShuxia) {
    return { compatible: false, formatName: '树夏music统一插件', reason: '当前桌面运行时尚未实现统一 Host' }
  }
  if (!looksLikeLxEvent && looksLikeMusicFreePlugin(raw)) {
    return { compatible: true, type: 'mf', formatName: 'MusicFree插件', reason: 'MusicFree 音源插件，按兼容层加载' }
  }
  if (looksLikeGenericSource) {
    return { compatible: true, type: hasLxToken ? 'lx' : undefined, formatName: '洛雪插件', reason: '按音源脚本加载' }
  }
  return { compatible: false, formatName: '未知插件', reason: '未检测到受支持的插件入口' }
}

function injectPluginHeaders(
  code: string,
  meta: { name: string; version: string; author: string },
) {
  const hasName = /@name\s+\S+/.test(code)
  const hasVersion = /@version\s+\S+/.test(code)
  const hasAuthor = /@author\s+\S+/.test(code)
  if (hasName && hasVersion && hasAuthor) return code
  return `/**
 * @name ${meta.name}
 * @version ${meta.version}
 * @author ${meta.author}
 */
${code}`
}

function extractConvertedLxOriginalCode(code: string): string | null {
  const marker = 'const originalPluginCode = '
  const start = code.indexOf(marker)
  if (start < 0) return null
  const valueStart = start + marker.length
  if (code[valueStart] !== '"') return null
  let escaped = false
  for (let index = valueStart + 1; index < code.length; index += 1) {
    const char = code[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      try {
        const parsed = JSON.parse(code.slice(valueStart, index + 1))
        return typeof parsed === 'string' && parsed.trim() ? parsed : null
      } catch {
        return null
      }
    }
  }
  return null
}

function preparePluginCode(pluginCode: string, type?: 'lx' | 'cr' | 'mf', fallbackName?: string) {
  let code = String(pluginCode || '')
  if (!code.trim()) throw new Error('插件内容为空')
  if (looksLikeHtmlDocument(code)) {
    throw new Error('插件格式校验失败：下载到了 HTML 页面，不是可执行的音源脚本')
  }

  if (type === 'cr') {
    if (!code.toLowerCase().includes('cerumusic')) {
      throw new Error('树夏Music插件格式校验失败：代码有可能不是树夏Music格式插件')
    }
    return code
  }

  if (isConvertedMusicFreePlugin(code)) {
    return code
  }

  if (type === 'mf') {
    if (!looksLikeMusicFreePlugin(code)) {
      throw new Error('MusicFree 插件格式校验失败：代码有可能不是标准的 MusicFree 插件')
    }
    return convertMusicFreePlugin(code)
  }

  if (type === 'lx') {
    if (!looksLikeLxPluginCode(code)) {
      throw new Error('洛雪插件格式校验失败：代码有可能不是标准的洛雪插件')
    }
    if (isConvertedLxPluginCode(code)) {
      const originalLxCode = extractConvertedLxOriginalCode(code)
      return originalLxCode ? convertEventDrivenPlugin(originalLxCode) : code
    }
    return convertEventDrivenPlugin(code)
  }

  const name = String(fallbackName || '').replace(/\.js$/i, '').trim() || '未知插件'
  code = injectPluginHeaders(code, { name, version: '1.0.0', author: 'Unknown' })
  if (!isConvertedLxPluginCode(code) && looksLikeLxEventPlugin(code)) {
    return convertEventDrivenPlugin(code)
  }
  if (!isConvertedLxPluginCode(code) && looksLikeLxPluginCode(code) && !hasModuleExports(code)) {
    return convertEventDrivenPlugin(code)
  }
  if (looksLikeMusicFreePlugin(code)) {
    return convertMusicFreePlugin(code)
  }
  return code
}

const nodePluginPrepared = new Set<string>()
const nodePluginPreparationInFlight = new Map<string, Promise<boolean>>()
let pluginSystemInitializationPromise: Promise<any> | null = null

async function readPersistedPluginCode(pluginId: string): Promise<string> {
  const id = String(pluginId || '').trim()
  if (!id) return ''

  const appDataDir = await invoke<string>('plugin_get_app_data_dir').catch(() => '')
  if (!appDataDir) return ''
  return await invoke<string>('plugin_read_file', {
    path: `${appDataDir}/plugins/${id}.js`,
  }).catch(() => '')
}

/**
 * Electron converts LX event plugins during installation and persists the
 * converted code before the plugin host loads it. Legacy Tauri profiles may
 * still contain the original LX file, so repair that file once per session
 * before asking the Node worker to execute it.
 */
async function ensureNodePluginPrepared(pluginId: string): Promise<boolean> {
  const id = String(pluginId || '').trim()
  if (!id) return false
  if (nodePluginPrepared.has(id)) return true

  const pending = nodePluginPreparationInFlight.get(id)
  if (pending) return await pending

  const preparation = (async () => {
    const code = await readPersistedPluginCode(id)
    if (!code) return false

    if (looksLikeHtmlDocument(code)) {
      console.warn(`[tauri-bridge] 插件 ${id} 是 HTML 页面，已跳过加载`)
      return false
    }
    if (!looksLikeLxPluginCode(code) || isConvertedLxPluginCode(code) || isConvertedMusicFreePlugin(code)) {
      nodePluginPrepared.add(id)
      return true
    }

    const preparedCode = preparePluginCode(code, 'lx')
    const installed = await invokeNodePlugin('installFromCode', {
      pluginCode: preparedCode,
      pluginName: id,
      targetPluginId: id,
      type: 'lx',
    })
    if (!installed) return false

    nodePluginPrepared.add(id)
    console.info(`[tauri-bridge] 已按 Electron 流程转换并加载插件 ${id}`)
    return true
  })()
    .catch((error) => {
      console.warn(`[tauri-bridge] 准备插件 ${id} 失败:`, error)
      return false
    })
    .finally(() => {
      if (nodePluginPreparationInFlight.get(id) === preparation) {
        nodePluginPreparationInFlight.delete(id)
      }
    })

  nodePluginPreparationInFlight.set(id, preparation)
  return await preparation
}

async function prepareInstalledNodePlugins(): Promise<void> {
  const loaded = await invokeNodePlugin('loadAll')
  const entries = Array.isArray(loaded)
    ? loaded
    : await safeInvoke<any[]>('plugin_load_registry', undefined, [])

  // Only refresh the registry. Convert LX files on first play, not at startup.
  if (Array.isArray(entries)) {
    nodePluginEntriesCache = { at: Date.now(), entries: Promise.resolve(entries) }
  }
}

function getPluginInvocationError(result: any): string {
  const error = result?.__pluginError
  return String(error?.message || error || '')
}

function needsNodePluginRepair(result: any): boolean {
  return /globalThis\.lx|EVENT_NAMES|did not export a module\.exports|Invalid plugin structure/i.test(
    getPluginInvocationError(result),
  )
}

function extractMusicUrl(input: any): string {
  if (typeof input === 'string') return input.trim()
  if (!input || typeof input !== 'object') return ''

  const candidates = [
    input.url,
    input.location,
    input.playUrl,
    input.musicUrl,
    input.data?.url,
    input.data?.location,
    input.data?.playUrl,
    input.data?.musicUrl,
    input.body?.url,
    input.body?.location,
    input.body?.playUrl,
    input.body?.musicUrl,
    Array.isArray(input.data) ? input.data[0]?.url : undefined,
    Array.isArray(input.body) ? input.body[0]?.url : undefined,
    Array.isArray(input.result) ? input.result[0]?.url : undefined,
  ]

  const url = candidates.find((item) => typeof item === 'string' && item.trim())
  return typeof url === 'string' ? url.trim() : ''
}

function isUsableMediaUrl(input: any): input is string {
  const url = typeof input === 'string' ? input.trim() : extractMusicUrl(input)
  if (!url) return false
  if (/^(none|null|undefined|error)(\?|$)/i.test(url)) return false
  if (/[?&](?:error|errmsg|message)=/i.test(url) && !/^https?:\/\//i.test(url)) return false
  return /^(?:https?:|blob:|file:|asset:|tauri:|\/\/)/i.test(url)
}

function hasMediaAuthHeaders(headers: unknown): headers is Record<string, string> {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return false
  return Object.values(headers as Record<string, unknown>).some((value) => firstText(value))
}

function isLocalStreamProxyUrl(url: string): boolean {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/stream\//i.test(url)
}

function normalizeMediaHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {}
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>)
      .map(([key, value]) => [String(key).trim(), firstText(value)] as const)
      .filter(([key, value]) => key && value),
  )
}

// Electron wraps Feiniu `{ url, headers }` results as `shuxiamusic-service://`.
// Tauri's equivalent is the local media stream proxy, so the WebView audio
// element can play cookie-protected streams without dropping auth headers.
async function wrapPlaybackStreamIfNeeded(input: any, args: any = {}): Promise<any> {
  void args
  const normalized = normalizePluginMusicUrlResult(input)
  const url = extractMusicUrl(normalized)
  if (!isUsableMediaUrl(url) || isLocalStreamProxyUrl(url)) return normalized
  // mpv 直接拉源并带 headers，不再经本地 TCP 代理拷一遍音频。
  return normalized
}

function normalizePluginMusicUrlResult(input: any) {
  const url = extractMusicUrl(input)
  if (!url || typeof input === 'string') return url || input
  const raw = input && typeof input === 'object' ? input : {}
  const data = raw.data && typeof raw.data === 'object' ? raw.data : {}
  const urlInfo = raw.urlInfo && typeof raw.urlInfo === 'object'
    ? raw.urlInfo
    : data.urlInfo && typeof data.urlInfo === 'object'
      ? data.urlInfo
      : {}
  return {
    ...raw,
    ...data,
    url,
    headers: raw.headers || data.headers || urlInfo.headers || raw.header || data.header || {},
    referrer: firstText(raw.referrer, raw.referer, data.referrer, data.referer, urlInfo.referrer, urlInfo.referer),
    userAgent: firstText(raw.userAgent, raw.user_agent, data.userAgent, data.user_agent, urlInfo.userAgent, urlInfo.user_agent),
    urlInfo,
  }
}

function normalizePluginSongInfo(input: any, source?: string) {
  const songInfo = input && typeof input === 'object' ? { ...input } : {}
  if (source && !songInfo.source) songInfo.source = source
  const resolvedId = firstText(songInfo.songmid, songInfo.hash, songInfo.id, songInfo.mid)
  if (resolvedId) songInfo.id = resolvedId
  // Some plugins use `hash ?? songmid`. An empty hash therefore masks a valid
  // songmid and makes the plugin report that the track ID does not exist.
  if (!firstText(songInfo.hash)) delete songInfo.hash
  return songInfo
}

function firstText(...items: any[]): string {
  for (const item of items) {
    if (typeof item === 'string' && item.trim()) return item.trim()
    if (typeof item === 'number' && Number.isFinite(item)) return String(item)
  }
  return ''
}

function joinNames(input: any): string {
  if (Array.isArray(input)) {
    return input
      .map((item) => firstText(item?.name, item?.nickname, item))
      .filter(Boolean)
      .join(' / ')
  }
  return firstText(input?.name, input?.nickname, input)
}

function normalizeSongForUi(song: any, fallbackSource?: string): any {
  if (!song || typeof song !== 'object') return song
  const source = normalizeSourceKey(firstText(song.source, song.platform, fallbackSource))
  const songmid = firstText(song.songmid, song.id, song.mid, song.songId, song.song_id, song.hash)
  const name = firstText(song.name, song.title, song.songName, song.song_name, '未知歌曲')
  const singer = firstText(song.singer, song.artist, song.author, joinNames(song.artists), joinNames(song.singers), '未知歌手')
  const albumName = firstText(song.albumName, song.album_name, song.album?.name, song.album, song.albumTitle)
  const img = firstText(
    song.img,
    song.picUrl,
    song.pic_url,
    song.coverImg,
    song.coverImgUrl,
    song.cover,
    song.artwork,
    song.image,
    song.pic,
    song.album?.picUrl,
    song.album?.cover,
    song.album?.coverImgUrl,
  )
  const interval = firstText(song.interval, song.durationText, song.timeText, song.duration)

  return {
    ...song,
    ...(songmid ? { songmid } : {}),
    ...(song.id === undefined && songmid ? { id: songmid } : {}),
    name,
    singer,
    albumName,
    album_name: firstText(song.album_name, albumName),
    img,
    source,
    interval,
    lrc: song.lrc ?? null,
    types: Array.isArray(song.types) ? song.types : [],
    _types: song._types && typeof song._types === 'object' ? song._types : {},
  }
}

function normalizeSearchResponse(result: any, fallbackSource: string) {
  const normalizeList = (list: any[]) => list.map((song) => normalizeSongForUi(song, fallbackSource))
  if (Array.isArray(result)) return { list: normalizeList(result), total: result.length }
  if (result?.list) return { ...result, list: normalizeList(Array.isArray(result.list) ? result.list : []) }
  if (result?.result?.songs) return {
    ...result,
    list: normalizeList(result.result.songs),
    total: result.result.songCount || result.result.songs.length,
  }
  if (result?.songs) return { ...result, list: normalizeList(result.songs), total: result.total || result.songs.length }
  if (result?.data?.songs) return { ...result, list: normalizeList(result.data.songs), total: result.data.total || result.data.songs.length }
  if (result?.data?.list) return { ...result, list: normalizeList(result.data.list), total: result.data.total || result.data.list.length }
  return { list: [], total: 0 }
}

function normalizeLyricResponse(input: any) {
  const raw = input?.success && input?.data !== undefined ? input.data : input
  if (typeof raw === 'string') return { lyric: raw }
  if (!raw || typeof raw !== 'object') return { lyric: '' }
  const data = raw.data && typeof raw.data === 'object' ? raw.data : raw
  const lrc = data.lrc
  const yrc = data.yrc || data.ylyric
  const qrc = data.qrc
  const tlyric = data.tlyric || data.tlrc || data.trans || data.translation
  const rlyric = data.rlyric || data.romalrc || data.romaLyric || data.romanLyric
  const lyricText = firstText(data.lyric, typeof lrc === 'string' ? lrc : lrc?.lyric, data.lrcText)
  const crlyricText = firstText(
    data.crlyric,
    data.cr_lyric,
    typeof yrc === 'string' ? yrc : yrc?.lyric,
    typeof qrc === 'string' ? qrc : qrc?.lyric,
  )
  const transText = firstText(
    typeof tlyric === 'string' ? tlyric : tlyric?.lyric,
    data.tlyricText,
  )
  const romaText = firstText(
    typeof rlyric === 'string' ? rlyric : rlyric?.lyric,
    data.rlyricText,
  )

  return {
    ...raw,
    ...data,
    lyric: lyricText,
    crlyric: crlyricText,
    tlyric: transText,
    rlyric: romaText,
  }
}

function normalizeCommentItem(input: any): any {
  if (!input || typeof input !== 'object') return input
  const user = input.user || input.owner || input.creator || {}
  const rawTime = input.time ?? input.timestamp ?? input.timeStamp ?? input.createdAt ?? input.pubTime
  const time = Number(rawTime || 0)
  const normalizedTime = Number.isFinite(time) ? time : 0
  const timeMs = normalizedTime > 0 && normalizedTime < 1000000000000 ? normalizedTime * 1000 : normalizedTime
  const images = input.images || input.pics || input.picUrls || input.pic || input.Pic || input.mpic
  const imageList = Array.isArray(images) ? images : images ? [images] : []
  const replyList = input.reply || input.replies || input.beReplied || input.subComments || input.SubComments || []

  return {
    ...input,
    id: firstText(input.id, input.commentId, input.commentid, input.CmId, input.SeqNo, `${Date.now()}_${Math.random()}`),
    text: firstText(input.text, input.content, input.msg, input.commentContent, input.Content),
    time: normalizedTime,
    timeStr: firstText(input.timeStr, input.time_str, input.date) || (timeMs ? new Date(timeMs).toLocaleDateString() : ''),
    location: firstText(input.location, input.ipLocation?.location, input.ipLocation, input.Location),
    userName: firstText(input.userName, input.nickname, input.nick, input.Nick, user.nickname, user.name),
    avatar: firstText(input.avatar, input.avatarUrl, input.avatarurl, input.Avatar, user.avatarUrl, user.avatar),
    userId: firstText(input.userId, input.user_id, input.uid, input.uin, input.EncryptUin, user.userId, user.id),
    likedCount: Number(input.likedCount ?? input.likeCount ?? input.liked_count ?? input.praisenum ?? input.PraiseNum ?? 0),
    images: imageList.map((item: any) => firstText(item?.url, item)).filter(Boolean),
    reply: Array.isArray(replyList) ? replyList.map(normalizeCommentItem) : [],
  }
}

function normalizeCommentResponse(apiName: string, result: any) {
  const raw = result?.success && result?.data !== undefined ? result.data : result
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw
  const source = firstText(data?.source, raw?.source)
  const list =
    data?.comments ||
    data?.hotComments ||
    data?.hot_comments ||
    data?.commentList ||
    data?.list ||
    data?.result?.comments ||
    data?.result?.hotComments ||
    []
  const comments = Array.isArray(list) ? list.map(normalizeCommentItem) : []
  const total = Number(data?.total ?? data?.totalCount ?? data?.commentTotal ?? data?.count ?? comments.length)
  const limit = Number(data?.limit ?? data?.pageSize ?? (apiName === 'getHotComment' ? 100 : 20))
  const page = Number(data?.page ?? data?.pageNo ?? 1)
  const maxPage = Number(data?.maxPage ?? (Math.ceil((Number.isFinite(total) ? total : comments.length) / Math.max(1, limit)) || 1))
  return {
    ...(data || {}),
    source,
    comments,
    total: Number.isFinite(total) ? total : comments.length,
    page: Number.isFinite(page) ? page : 1,
    limit: Number.isFinite(limit) ? limit : comments.length || 20,
    maxPage: Number.isFinite(maxPage) ? maxPage : 1,
  }
}

function normalizePluginMethodResult(input: any) {
  if (Array.isArray(input)) return input
  if (Array.isArray(input?.songs)) return input.songs
  if (Array.isArray(input?.data)) return input.data
  if (Array.isArray(input?.data?.songs)) return input.data.songs
  return input || []
}

function normalizeServiceSongs(input: any, pluginId: string) {
  const rawSongs = normalizePluginMethodResult(input)
  return (Array.isArray(rawSongs) ? rawSongs : [])
    .map((song: any) => ({
      ...normalizeSongForUi(song, pluginId),
      url: song?.url || null,
      _servicePluginId: pluginId,
    }))
    .filter((song: any) => song.songmid)
}

async function getPluginConfigValue(pluginId: string): Promise<Record<string, any>> {
  if (pluginConfigStore[pluginId]) return pluginConfigStore[pluginId]
  const nodeResult = await invokeNodePlugin('getConfig', { pluginId })
  if (nodeResult && typeof nodeResult === 'object' && !Array.isArray(nodeResult)) {
    pluginConfigStore[pluginId] = nodeResult as Record<string, any>
    return pluginConfigStore[pluginId]
  }
  const config = await safeInvoke<string | null>('plugin_load_config', { pluginId }, '{}')
  try {
    const parsed = JSON.parse(config || '{}')
    pluginConfigStore[pluginId] = parsed
    return parsed
  } catch {
    pluginConfigStore[pluginId] = {}
    return {}
  }
}

function normalizePluginConfigSchema(input: any) {
  if (Array.isArray(input)) return input
  if (input && typeof input === 'object') return input
  return []
}

function pluginFieldSize(value: any): number {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') return Object.keys(value).length
  return 0
}

function toSettingsPluginListItem(plugin: any) {
  const pluginId = String(plugin?.pluginId || plugin?.id || '').trim()
  const exports = pluginSandbox.get(pluginId)
  const sandboxSources = getPluginSupportedSources(exports)
  const sidecarSources = normalizePluginSources({ supportedSources: plugin?.supportedSources })
  const sandboxSchema = normalizePluginConfigSchema(exports?.configSchema)
  const sidecarSchema = normalizePluginConfigSchema(plugin?.configSchema)
  const pluginInfo = exports?.pluginInfo || plugin?.pluginInfo || {
    name: plugin?.pluginName || plugin?.name || pluginId,
    version: plugin?.version || '',
    author: plugin?.author || '',
    description: plugin?.description || '',
  }
  const pluginType = exports?.pluginType || plugin?.pluginType || plugin?.plugin_type || 'music-source'
  const serviceRole = exports?.serviceRole || plugin?.serviceRole || plugin?.service_role
  if (pluginId && pluginFieldSize(sandboxSources) > 0) {
    registerPluginSources(pluginId, exports)
  } else if (pluginId) {
    for (const key of Object.keys(sidecarSources)) {
      if (!sourcePluginMap.has(key)) sourcePluginMap.set(key, pluginId)
    }
  }
  return {
    ...plugin,
    id: pluginId,
    pluginId,
    pluginName: pluginInfo.name || plugin?.pluginName || pluginId,
    name: pluginInfo.name || plugin?.name || pluginId,
    pluginInfo,
    pluginType,
    plugin_type: pluginType,
    serviceRole,
    configSchema: pluginFieldSize(sandboxSchema) > 0 ? sandboxSchema : sidecarSchema,
    supportedSources: pluginFieldSize(sandboxSources) > 0 ? sandboxSources : sidecarSources,
    disabled: Boolean(plugin?.disabled || plugin?.enabled === false),
  }
}

function hydrateMissingPluginRuntimes(plugins: any[]) {
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    const pluginId = String(plugin?.pluginId || plugin?.id || '').trim()
    if (!pluginId) continue
    registerSidecarPluginSources(pluginId, plugin)
  }
}

async function persistPluginConfigValue(pluginId: string, config: Record<string, any>) {
  const previous: Record<string, any> = await getPluginConfigValue(pluginId).catch(() => ({}))
  const nextConfig = { ...(config || {}) }
  const role = await getPluginServiceRoleValue(pluginId).catch(() => '')
  if (role === 'nas-sync') {
    const previousPairCode = String(previous.pairCode || '').trim()
    const nextPairCode = String(nextConfig.pairCode || '').trim()
    if (previousPairCode && !nextPairCode) nextConfig.pairCode = previousPairCode
  }
  pluginConfigStore[pluginId] = nextConfig
  const nodeResult = await invokeNodePlugin('saveConfig', { pluginId, config: nextConfig })
  if (!nodeResult) {
    await safeInvoke('plugin_save_config', { pluginId, config: JSON.stringify(nextConfig) })
  }
  await callPluginMethodNodeFirst(pluginId, 'onConfigUpdate', nextConfig).catch(() => undefined)
}

function shouldTryPluginMethod(plugin: any, method: string): boolean {
  return !plugin || typeof plugin[method] === 'function'
}

function collectPluginRequestInfo(args: any) {
  const info: any = {}
  for (const key of Object.keys(args || {})) {
    if (key !== 'source' && key !== 'pluginId') info[key] = args[key]
  }
  return info
}

/**
 * 将 SDK 请求路由到 sidecar 插件。渲染进程沙箱只作最后兜底，不再要求预加载整份插件 JS。
 * 返回 undefined 表示插件无法处理该请求，应由 Rust 后端兜底。
 */
async function routeSdkToPlugin(apiName: string, args: any, pluginId: string): Promise<any> {
  const plugin = pluginSandbox.get(pluginId)
  const config = await getPluginConfigValue(pluginId)
  const canUse = (method: string) => shouldTryPluginMethod(plugin, method)

  switch (apiName) {
    case 'search': {
      const keyword = args.keyword || ''
      const page = args.page || 1
      const limit = args.limit || 30
      const source = args.source || 'all'

      if (canUse('request')) {
        const result = await callPluginMethodNodeFirst(pluginId, 'request', source, 'search', {
          keyword,
          page,
          limit,
        })
        return normalizeSearchResponse(result, source)
      }

      if (!canUse('search')) return undefined
      const result = await callPluginMethodNodeFirst(pluginId, 'search', keyword, page, limit, config)
      return normalizeSearchResponse(result, source)
    }

    case 'getMusicUrl':
    case 'getSongUrl':
    case 'musicUrl': {
      const source = args.source || args.songInfo?.source || ''
      const songInfo = normalizePluginSongInfo(args.songInfo, source)
      const quality = args.quality || '128k'
      const acceptUrl = (value: any) => isUsableMediaUrl(value)

      if (canUse('musicUrl')) {
        const url = await callFirstPluginMethod(pluginId, 'musicUrl', [
          [source, songInfo, quality],
          [source, songInfo, quality, config],
          [songInfo, quality],
          [songInfo, quality, config],
          [songInfo],
        ], acceptUrl).catch(() => undefined)
        if (url !== undefined) return normalizePluginMusicUrlResult(url)
      }
      if (canUse('getMusicUrl')) {
        const url = await callFirstPluginMethod(pluginId, 'getMusicUrl', [
          [source, songInfo, quality, config],
          [source, songInfo, quality],
          [songInfo, quality],
          [songInfo, quality, config],
          [songInfo],
        ], acceptUrl).catch(() => undefined)
        if (url !== undefined) return normalizePluginMusicUrlResult(url)
      }
      if (canUse('getSongUrl')) {
        const url = await callFirstPluginMethod(pluginId, 'getSongUrl', [
          [source, songInfo, quality, config],
          [source, songInfo, quality],
          [songInfo, quality],
          [songInfo, quality, config],
          [songInfo],
        ], acceptUrl).catch(() => undefined)
        if (url !== undefined) return normalizePluginMusicUrlResult(url)
      }
      if (canUse('request')) {
        const info = { musicInfo: songInfo, songInfo, type: quality, quality }
        for (const action of ['musicUrl', 'getMusicUrl', 'getSongUrl', 'songUrl', 'url']) {
          const result = await callPluginMethodNodeFirst(pluginId, 'request', source, action, info).catch(() => undefined)
          if (acceptUrl(result)) return normalizePluginMusicUrlResult(result)
        }
      }
      return undefined
    }

    case 'getLyric': {
      const source = args.source || args.songInfo?.source || 'wy'
      const songInfo = normalizePluginSongInfo(args.songInfo || { id: args.id, source }, source)
      const hasText = (value: any) => {
        const normalized = normalizeLyricResponse(value)
        return Boolean(normalized.lyric || normalized.crlyric || normalized.tlyric || normalized.rlyric)
      }
      if (canUse('getLyric')) {
        const lyric = await callFirstPluginMethod(pluginId, 'getLyric', [
          [source, songInfo],
          [songInfo, config],
          [source, songInfo, config],
        ], hasText).catch(() => undefined)
        if (lyric !== undefined) return normalizeLyricResponse(lyric)
      }
      if (canUse('lyric')) {
        const lyric = await callFirstPluginMethod(pluginId, 'lyric', [
          [source, songInfo, config],
          [source, songInfo],
          [songInfo, config],
        ], hasText).catch(() => undefined)
        if (lyric !== undefined) return normalizeLyricResponse(lyric)
      }
      if (canUse('musicLyric')) {
        const lyric = await callFirstPluginMethod(pluginId, 'musicLyric', [
          [source, songInfo, config],
          [source, songInfo],
          [songInfo, config],
        ], hasText).catch(() => undefined)
        if (lyric !== undefined) return normalizeLyricResponse(lyric)
      }
      if (canUse('request')) {
        for (const requestName of ['getLyric', 'lyric', 'musicLyric']) {
          try {
            const lyric = await callPluginMethodNodeFirst(pluginId, 'request', source, requestName, {
              musicInfo: songInfo,
              songInfo,
            })
            const normalized = normalizeLyricResponse(lyric)
            if (normalized.lyric || normalized.crlyric || normalized.tlyric || normalized.rlyric) {
              return normalized
            }
          } catch {}
        }
      }
      return undefined
    }

    case 'getPic': {
      const source = args.source || args.songInfo?.source || 'wy'
      const songInfo = normalizePluginSongInfo(args.songInfo || { id: args.id, source }, source)
      const extractPic = (value: any) => firstText(
        typeof value === 'string' ? value : '',
        value?.url,
        value?.body,
        value?.data?.url,
        value?.data?.body,
        value?.picUrl,
        value?.pic_url,
        value?.cover,
        value?.img,
      )
      if (canUse('getPic')) {
        const pic = await callFirstPluginMethod(pluginId, 'getPic', [
          [source, songInfo],
          [songInfo, config],
          [source, songInfo, config],
        ], (value) => Boolean(extractPic(value))).catch(() => undefined)
        if (pic !== undefined) return extractPic(pic) || pic
      }
      if (canUse('request')) {
        const info = { musicInfo: songInfo, songInfo }
        for (const action of ['getPic', 'pic', 'musicPic']) {
          const result = await callPluginMethodNodeFirst(pluginId, 'request', source, action, info).catch(() => undefined)
          if (extractPic(result)) return extractPic(result)
        }
      }
      return undefined
    }

    case 'getSongDetail': {
      if (!canUse('getSongDetail')) return undefined
      const songInfo = normalizePluginSongInfo(args.songInfo || { id: args.id }, args.source)
      return callPluginMethodNodeFirst(pluginId, 'getSongDetail', songInfo, config)
    }

    // ---- 歌单/排行榜/评论 API — 通过通用 request 委派 ----
    case 'getPlaylistTags':
    case 'getCategoryPlaylists':
    case 'getLeaderboards':
    case 'getLeaderboardDetail':
    case 'getPlaylistDetail':
    case 'getListSongs':
    case 'getCommentList':
    case 'getCommentReply':
    case 'getHotComment':
    case 'getComment': {
      if (!canUse('request')) return undefined
      const source = args.source || 'all'
      const info = collectPluginRequestInfo(args)
      const result = await callPluginMethodNodeFirst(pluginId, 'request', source, apiName, info)
      return normalizeCommentResponse(apiName, result)
    }
    case 'getHotSearch':
    case 'getSuggestSearch':
    case 'searchPlaylist':
    case 'tipSearch':
    case 'parsePlaylistId':
    case 'downloadSingleSong':
    case 'downloadBatchSongs':
    case 'recognize': {
      if (!canUse('request')) return undefined
      const source = args.source || 'all'
      const info = collectPluginRequestInfo(args)
      const result = await callPluginMethodNodeFirst(pluginId, 'request', source, apiName, info)
      return normalizePluginApiResponse(apiName, result)
    }

    default: {
      // 通用回退：任何 apiName 都尝试通过 plugin.request 转发
      if (!canUse('request')) return undefined
      const source = args.source || 'all'
      const info = collectPluginRequestInfo(args)
      const result = await callPluginMethodNodeFirst(pluginId, 'request', source, apiName, info)
      return normalizePluginApiResponse(apiName, result)
    }
  }
}

/**
 * 标准化插件返回的原始数据，使其匹配前端 UI 的预期格式。
 */
function normalizePluginApiResponse(apiName: string, result: any): any {
  if (result == null) return result

  switch (apiName) {
    case 'getPlaylistTags': {
      // UI 期望 { tags: [...], hotTag: [...] }
      if (result.tags) return result
      if (result.data?.tags) return { tags: result.data.tags, hotTag: result.data.hotTag || [] }
      if (result.data) return result.data
      return result
    }
    case 'getCategoryPlaylists': {
      // UI 期望 { list: [...], total: N }
      if (result.list) return result
      if (result.data?.list) return { list: result.data.list, total: result.data.total || 0 }
      if (result.playlists) return { list: result.playlists, total: result.total || 0 }
      if (result.data?.playlists) return { list: result.data.playlists, total: result.data.total || 0 }
      return result
    }
    case 'getLeaderboards': {
      // UI 期望直接拿数组
      if (Array.isArray(result)) return result
      if (Array.isArray(result.list)) return result.list
      if (Array.isArray(result.data)) return result.data
      if (Array.isArray(result.data?.list)) return result.data.list
      return result
    }
    case 'getPlaylistDetail':
    case 'getLeaderboardDetail':
    case 'getListSongs': {
      // UI 期望 { list: [...], total: N, limit: N, info?: {...} }
      if (result.list) return result
      if (result.data?.list) return {
        list: result.data.list,
        total: result.data.total || 0,
        limit: result.data.limit || result.data.list.length,
        info: result.data.info || result.info,
      }
      if (result.playlist?.tracks) return {
        list: result.playlist.tracks,
        total: result.playlist.trackCount || 0,
        limit: result.playlist.tracks.length,
        info: { name: result.playlist.name, author: result.playlist.creator?.nickname, desc: result.playlist.description, total: result.playlist.trackCount },
      }
      if (result.songs) return {
        list: result.songs,
        total: result.total || result.songs.length,
        limit: result.limit || result.songs.length,
        info: result.info,
      }
      return result
    }
    case 'searchPlaylist': {
      if (result.result) return result
      if (result.data?.result) return result.data
      if (result.playlists) return { result: { playlists: result.playlists, playlistCount: result.total || result.playlists.length } }
      return result
    }
    case 'tipSearch':
    case 'getSuggestSearch':
    case 'getHotSearch': {
      if (Array.isArray(result)) return result
      if (Array.isArray(result.data)) return result.data
      if (Array.isArray(result.result)) return result.result
      return result
    }
    case 'getComment':
    case 'getCommentList':
    case 'getCommentReply':
    case 'getHotComment':
      return normalizeCommentResponse(apiName, result)
    default:
      return result
  }
}

async function getServiceImportDescription(pluginId: string): Promise<string> {
  const role = await getPluginServiceRoleValue(pluginId)
  if (role === 'feiniu') return '由飞牛服务插件导入'
  if (role === 'navidrome') return '由 Navidrome 服务插件导入'
  if (role === 'nas-sync') return '由 NAS 同步服务插件导入'

  const plugins = await invokeNodePlugin('loadAll').catch(() => [])
  const entry = Array.isArray(plugins)
    ? plugins.find((item: any) => String(item?.pluginId || item?.id || '') === pluginId)
    : null
  const name = String(entry?.pluginInfo?.name || entry?.pluginName || entry?.name || '').trim()
  if (name) return `由${name}导入`
  return '由服务插件导入'
}

async function createSongListFromService(
  pluginId: string,
  playlistId: string,
  playlistName: string | undefined,
  songs: any[],
) {
  const remotePlaylistId = String(playlistId)
  const hashId = `service_${pluginId}_${remotePlaylistId}`
  const name = playlistName || '导入的歌单'
  const description = await getServiceImportDescription(pluginId)
  await invoke('songlist_create_with_id', {
    hashId,
    name,
    description,
    source: 'local',
    meta: {
      importedFrom: pluginId,
      remotePlaylistId,
      servicePluginId: pluginId,
      servicePlaylistId: remotePlaylistId,
      importedAt: new Date().toISOString(),
    },
  })
  const added = await invoke<number>('songlist_add_songs', { hashId, songs })
  return { hashId, name, added, created: true, songListId: hashId, total: songs.length }
}

async function getPluginServiceRoleValue(pluginId: string): Promise<string> {
  const plugins = await invokeNodePlugin('loadAll')
  if (Array.isArray(plugins)) {
    const entry = plugins.find((item: any) => String(item?.pluginId || item?.id || '') === pluginId)
    const role = String(entry?.serviceRole || '').trim()
    if (role) return role
  }
  const plugin = pluginSandbox.get(pluginId)
  return String(
    (plugin?.pluginInfo as any)?.serviceRole ||
    plugin?.serviceRole ||
    plugin?.exports?.serviceRole ||
    '',
  ).trim()
}

async function isFeiniuPlugin(pluginId: string): Promise<boolean> {
  return (await getPluginServiceRoleValue(pluginId)) === 'feiniu'
}

async function getFeiniuPluginId(): Promise<string> {
  if (feiniuPluginIdCache) return feiniuPluginIdCache
  const plugins = await invokeNodePlugin('loadAll')
  const list = Array.isArray(plugins) ? plugins : []
  const feiniu = list.find((plugin: any) => String(plugin?.serviceRole || '') === 'feiniu')
  const id = String(feiniu?.pluginId || feiniu?.id || '').trim()
  if (id) feiniuPluginIdCache = id
  return id
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(String(value || ''))
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}

function encodeUrlSafeBase64(value: string): string {
  return encodeUtf8Base64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function buildFeiniuOrigin(config: Record<string, any> | null | undefined): string {
  const rawHost = String(config?.host || '').trim()
  if (!rawHost) return ''
  try {
    const protocol = config?.useHttps === true ? 'https' : 'http'
    const url = new URL(/^https?:\/\//i.test(rawHost) ? rawHost : `${protocol}://${rawHost}`)
    if (!url.port) {
      const port = Number(config?.port)
      if (Number.isFinite(port) && port > 0) url.port = String(port)
    }
    return url.origin
  } catch {
    return ''
  }
}

function buildFeiniuAuthHeaders(config: Record<string, any> | null | undefined): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = firstText((config as any)?.token)
  if (token) headers.Cookie = `music-token=${token}`
  const accessCode = firstText((config as any)?.accessCode)
  if (accessCode) {
    headers['x-access-code'] = encodeUtf8Base64(accessCode)
    headers['x-access-source'] = 'app'
  }
  return headers
}

function buildFeiniuStreamPlayback(config: Record<string, any> | null | undefined, songInfo: any): { url: string; headers: Record<string, string> } | null {
  const origin = buildFeiniuOrigin(config)
  if (!origin) return null
  const trackId = firstText(songInfo?.songmid, songInfo?.id, songInfo?.hash).replace(/^feiniu_/i, '')
  if (!trackId) return null
  const existingUrl = firstText(songInfo?.url, songInfo?.typeUrl?.['128k'], songInfo?.type_url?.['128k'])
  const url =
    isUsableMediaUrl(existingUrl) && /\/music\/api\/v1\/track\/stream/i.test(existingUrl)
      ? existingUrl
      : `${origin}/music/api/v1/track/stream?guid=${encodeURIComponent(trackId)}`
  return {
    url,
    headers: buildFeiniuAuthHeaders(config),
  }
}

function isFeiniuApiImageUrl(url?: string | null): boolean {
  return typeof url === 'string' && url.includes(FEINIU_API_PATH)
}

function isLocalCoverProxyUrl(url?: string | null): boolean {
  return typeof url === 'string' && /https?:\/\/(127\.0\.0\.1|localhost):\d+\/cover\//i.test(url)
}

function isRemoteCleartextHttpUrl(url?: string | null): boolean {
  return typeof url === 'string' && /^http:\/\//i.test(url) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(url)
}

function needsCoverProxy(url?: string | null): boolean {
  if (!url) return false
  if (isLocalCoverProxyUrl(url)) return false
  if (isFeiniuApiImageUrl(url)) return true
  // 公共 CDN 封面也走本地代理，复用内存 + 磁盘缓存，避免每次进页面重新下载。
  // 只代理远程 http(s) 图片；若代理抓取失败，sImage 会回退到直连原地址。
  return /^https?:\/\//i.test(url)
}

async function ensureCoverProxyBase(): Promise<string> {
  if (coverProxyBase) return coverProxyBase
  if (coverProxyBasePending) return coverProxyBasePending
  coverProxyBasePending = invoke<string>('cover_proxy_base')
    .then((value) => {
      coverProxyBase = String(value || '').replace(/\/$/, '')
      coverProxyBasePending = null
      return coverProxyBase
    })
    .catch(() => {
      coverProxyBasePending = null
      return ''
    })
  return coverProxyBasePending
}

function wrapCoverUrlSync(url: string): string {
  const trimmed = String(url || '').trim()
  if (!trimmed) return ''
  if (
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('file:') ||
    isLocalCoverProxyUrl(trimmed) ||
    !needsCoverProxy(trimmed)
  ) {
    return trimmed
  }
  const cached = coverProxyUrlCache.get(trimmed)
  if (cached) return cached
  if (!coverProxyBase) return trimmed
  const proxied = `${coverProxyBase}/cover/${encodeUrlSafeBase64(trimmed)}`
  rememberCoverProxyUrl(trimmed, proxied)
  return proxied
}

function wrapThumbCoverUrlSync(url: string): string {
  // 公共 CDN 封面同样通过本地代理缓存。sImage 会先在 CDN 侧压缩缩略图，
  // 代理抓取失败时回退到直连地址，因此封面不会再出现“消失”问题。
  return wrapCoverUrlSync(url)
}

async function wrapThumbCoverUrlIfNeeded(url: string): Promise<string> {
  return wrapCoverUrlIfNeeded(url)
}

async function wrapCoverUrlIfNeeded(url: string): Promise<string> {
  const trimmed = String(url || '').trim()
  if (!trimmed) return ''
  if (
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('file:') ||
    isLocalCoverProxyUrl(trimmed) ||
    !needsCoverProxy(trimmed)
  ) {
    return trimmed
  }
  const cached = coverProxyUrlCache.get(trimmed)
  if (cached) return cached
  const pending = coverProxyUrlPending.get(trimmed)
  if (pending) return pending
  const task = (async () => {
    await ensureCoverProxyBase()
    const syncValue = wrapCoverUrlSync(trimmed)
    if (isLocalCoverProxyUrl(syncValue)) return syncValue
    try {
      const proxied = String((await invoke<string>('cover_proxy_url', { url: trimmed })) || trimmed)
      rememberCoverProxyUrl(trimmed, proxied)
      return proxied
    } catch {
      return trimmed
    }
  })().finally(() => {
    coverProxyUrlPending.delete(trimmed)
  })
  coverProxyUrlPending.set(trimmed, task)
  return task
}

async function getFeiniuCoverAuthHeaders(url: string): Promise<Record<string, string> | null> {
  if (!isFeiniuApiImageUrl(url)) return null
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return null
  }
  const pluginId = await getFeiniuPluginId()
  if (!pluginId) return null
  const config = await getPluginConfigValue(pluginId)
  const origin = buildFeiniuOrigin(config)
  if (!origin || target.origin !== origin) return null
  const token = String(config?.token || '').trim()
  if (!token) return null
  const headers: Record<string, string> = {
    Cookie: `music-token=${token}`,
  }
  const accessCode = String(config?.accessCode || '')
  if (accessCode) {
    headers['x-access-code'] = encodeUtf8Base64(accessCode)
    headers['x-access-source'] = 'app'
  }
  return headers
}

async function imageUrlToDataUrl(url: string): Promise<string> {
  const trimmed = String(url || '').trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('file:')) {
    return trimmed
  }
  const headers = await getFeiniuCoverAuthHeaders(trimmed)
  return await invoke<string>('image_url_to_data_url', { url: trimmed, headers: headers || null })
}

async function findImportedServicePlaylist(pluginId: string, remotePlaylistId: string) {
  const records = normalizeSongListRecords(await invoke('songlist_get_all').catch(() => []))
  const remoteId = String(remotePlaylistId)
  return records.find((item: any) => {
    const meta = item?.meta && typeof item.meta === 'object' ? item.meta : {}
    const importedFrom = String(meta.importedFrom || meta.servicePluginId || '')
    const remote = String(meta.remotePlaylistId || meta.servicePlaylistId || '')
    if (importedFrom === pluginId && remote === remoteId) return true
    const id = String(item?.id || '')
    return id === `service_${pluginId}_${remoteId}` || id.startsWith(`service_${pluginId}_${remoteId}_`)
  })
}

async function importConfiguredServicePlaylist(
  pluginId: string,
  playlistId: string,
  playlistName?: string,
) {
  const config = await getPluginConfigValue(pluginId)
  const result = await callPluginMethodNodeFirst(pluginId, 'getPlaylistSongs', config, playlistId)
  const songs = normalizeServiceSongs(result, pluginId)
  if (!songs.length) return { error: '歌单为空或获取失败' }
  const remotePlaylistId = String(playlistId)
  const existing = await findImportedServicePlaylist(pluginId, remotePlaylistId)
  if (existing) {
    const hashId = String(existing.id)
    await invoke('songlist_edit', {
      hashId,
      updates: {
        name: playlistName || existing.name,
        description: await getServiceImportDescription(pluginId),
        source: 'local',
        meta: {
          ...(existing.meta && typeof existing.meta === 'object' ? existing.meta : {}),
          importedFrom: pluginId,
          remotePlaylistId,
          servicePluginId: pluginId,
          servicePlaylistId: remotePlaylistId,
        },
      },
    }).catch(() => undefined)
    const added = await invoke<number>('songlist_add_songs', { hashId, songs }).catch(() => 0)
    return {
      success: true,
      data: {
        songListId: hashId,
        hashId,
        added: Number(added || 0),
        total: songs.length,
        created: false,
      },
    }
  }
  const created = await createSongListFromService(pluginId, playlistId, playlistName, songs)
  return {
    success: true,
    data: {
      songListId: created.hashId,
      hashId: created.hashId,
      name: created.name,
      added: created.added,
      total: songs.length,
      created: true,
    },
  }
}

async function autoImportConfiguredFeiniuPlaylists(pluginId: string) {
  const config = await getPluginConfigValue(pluginId)
  const result = await callPluginMethodNodeFirst(pluginId, 'getPlaylists', config)
  const playlists = normalizePluginMethodResult(result)
  const importable = (Array.isArray(playlists) ? playlists : []).filter(
    (item: any) => item?.id && (item.id !== 'favorite-track' || Number(item.songCount || 0) > 0),
  )
  const imported: any[] = []
  const skipped: any[] = []
  const errors: string[] = []
  for (const playlist of importable) {
    try {
      const importedResult = await importConfiguredServicePlaylist(
        pluginId,
        String(playlist.id),
        String(playlist.name || '导入的歌单'),
      )
      if (importedResult?.error === '歌单为空或获取失败') {
        skipped.push({ playlistId: String(playlist.id), name: String(playlist.name || '') })
      } else if (importedResult?.error) {
        errors.push(`${playlist.name || playlist.id}：${importedResult.error}`)
      } else {
        imported.push({
          playlistId: String(playlist.id),
          name: String(playlist.name || '导入的歌单'),
          ...importedResult.data,
        })
      }
    } catch (error: any) {
      errors.push(`${playlist.name || playlist.id}：${error?.message || '导入失败'}`)
    }
  }
  return { playlistCount: importable.length, imported, skipped, errors }
}

async function persistFeiniuSessionConfig(pluginId: string, result: any) {
  if (!result?.success || !result.config || typeof result.config !== 'object') return result
  if (!(await isFeiniuPlugin(pluginId))) return result
  const current = await getPluginConfigValue(pluginId)
  await persistPluginConfigValue(pluginId, { ...current, ...result.config })
  return result
}

async function refreshFeiniuSession(pluginId: string) {
  const config = await getPluginConfigValue(pluginId)
  const result = await callPluginMethodNodeFirst(pluginId, 'testConnection', config)
  return persistFeiniuSessionConfig(pluginId, result || { success: true })
}

async function autoImportFeiniuAfterLogin(pluginId: string, result: any) {
  if (!result?.success || !(await isFeiniuPlugin(pluginId))) return result
  try {
    const autoImport = await autoImportConfiguredFeiniuPlaylists(pluginId)
    if (!Array.isArray(autoImport.errors) || autoImport.errors.length === 0) {
      const config = await getPluginConfigValue(pluginId)
      await persistPluginConfigValue(pluginId, {
        ...config,
        autoImportVersion: FEINIU_AUTO_IMPORT_VERSION,
        autoImportedAt: new Date().toISOString(),
      })
    }
    return { ...result, autoImport }
  } catch (error: any) {
    console.warn('[tauri-bridge] 飞牛歌单自动导入失败:', error)
    return { ...result, autoImport: { errors: [error?.message || '歌单自动导入失败'] } }
  }
}

async function runConfiguredFeiniuStartupSync() {
  const pluginId = await getFeiniuPluginId()
  if (!pluginId) return null
  const config = await getPluginConfigValue(pluginId)
  if (!config?.host || !config?.username || !config?.password) return null
  const loginResult = await refreshFeiniuSession(pluginId)
  if (!loginResult?.success) {
    return { errors: [loginResult?.message || '飞牛登录失败'] }
  }
  const latest = await getPluginConfigValue(pluginId)
  if (latest?.autoImportVersion === FEINIU_AUTO_IMPORT_VERSION) {
    return { playlistCount: 0, imported: [], skipped: [], errors: [] }
  }
  const autoImport = await autoImportConfiguredFeiniuPlaylists(pluginId)
  if (!Array.isArray(autoImport.errors) || autoImport.errors.length === 0) {
    const next = await getPluginConfigValue(pluginId)
    await persistPluginConfigValue(pluginId, {
      ...next,
      autoImportVersion: FEINIU_AUTO_IMPORT_VERSION,
      autoImportedAt: new Date().toISOString(),
    })
  }
  return autoImport
}

function syncConfiguredFeiniuOnStartup() {
  if (!feiniuStartupSyncPromise) {
    feiniuStartupSyncPromise = runConfiguredFeiniuStartupSync().catch((error) => {
      feiniuStartupSyncPromise = null
      throw error
    })
  }
  return feiniuStartupSyncPromise
}

async function persistPluginFile(pluginId: string, pluginCode: string): Promise<void> {
  await invoke('plugin_write_file', { pluginId, code: pluginCode })
}

function unregisterPluginSources(pluginId: string) {
  for (const [source, mappedPluginId] of Array.from(sourcePluginMap.entries())) {
    if (mappedPluginId === pluginId) sourcePluginMap.delete(source)
  }
}

function unloadPluginRuntime(pluginId: string) {
  unregisterPluginSources(pluginId)
  pluginSandbox.unload(pluginId)
}

async function removePersistedPluginFile(pluginId: string) {
  await remove(`plugins/${pluginId}.js`, { baseDir: BaseDirectory.AppData }).catch(() => {})
}

// Last-resort helper: playback/list/search must not call this. Install inspect still uses a
// temporary sandbox load, then unloads. Keeping the persisted loader only for emergencies.
async function loadPersistedPluginRuntime(
  pluginId: string,
  options: { force?: boolean } = {},
): Promise<any | undefined> {
  const id = String(pluginId || '').trim()
  if (!id) return undefined

  if (!options.force) {
    const loaded = pluginSandbox.get(id)
    if (loaded) {
      registerPluginSources(id, loaded)
      return loaded
    }
  }

  const code = await readPersistedPluginCode(id)
  if (!code) return undefined

  if (options.force) unloadPluginRuntime(id)
  const exports = await pluginSandbox.load(id, preparePluginCode(code))
  registerPluginSources(id, exports)
  return exports
}


function sidecarEntrySupportsSource(entry: any, source: string): boolean {
  const key = normalizeSourceKey(source)
  if (!key || !isSidecarPluginEnabled(entry)) return false
  const pluginType = String(entry?.pluginType || '').trim()
  const serviceRole = String(entry?.serviceRole || '').trim()
  if (serviceRole || pluginType === 'service') return false
  if (pluginType && pluginType !== 'music-source') return false
  const sources = normalizePluginSources(entry)
  return Object.keys(sources).length === 0 || Boolean(sources[key])
}

async function ensurePluginRuntimeForSource(
  source: string,
  preferredPluginId?: string,
): Promise<string | undefined> {
  const key = normalizeSourceKey(source)
  if (!key || key === 'local') return undefined

  const entries = await getNodePluginEntries()
  const preferred = String(preferredPluginId || '').trim()
  if (preferred) {
    const entry = findNodePluginEntry(entries, preferred)
    if (entry && sidecarEntrySupportsSource(entry, key)) {
      registerSidecarPluginSources(preferred, entry)
      return preferred
    }
    if (!entry) {
      sourcePluginMap.set(key, preferred)
      return preferred
    }
  }

  const mapped = sourcePluginMap.get(key)
  if (mapped) {
    const mappedEntry = findNodePluginEntry(entries, mapped)
    if (!mappedEntry || sidecarEntrySupportsSource(mappedEntry, key)) return mapped
  }

  const candidates = await getMusicPluginCandidatesForSource(key)
  const selected = candidates[0]
  if (selected) {
    const selectedEntry = findNodePluginEntry(entries, selected)
    if (selectedEntry) registerSidecarPluginSources(selected, selectedEntry)
    else sourcePluginMap.set(key, selected)
  }
  return selected
}

async function getMusicPluginCandidatesForSource(
  source: string,
  excludedPluginIds: Iterable<string> = [],
): Promise<string[]> {
  const key = normalizeSourceKey(source)
  if (!key || key === 'local') return []

  const excluded = new Set(Array.from(excludedPluginIds).map((item) => String(item || '').trim()).filter(Boolean))
  const entries = await getNodePluginEntries()
  const candidates: Array<{ id: string; score: number }> = []

  for (const entry of entries) {
    const id = String(entry?.pluginId || entry?.id || '').trim()
    if (!id || excluded.has(id) || !sidecarEntrySupportsSource(entry, key)) continue
    const name = String(entry?.pluginInfo?.name || entry?.pluginName || entry?.name || id)
    candidates.push({ id, score: pluginNameScore(name) })
    registerSidecarPluginSources(id, entry)
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((item) => item.id)
}

// Keep the selected plugin as the primary path, matching Electron's
// `getSongRealUrl` ordering. These are platform safety ceilings only; normal
// plugins return in roughly 0.4-2.5 seconds.
// Electron's ShuxiaMusicPluginHost uses INVOKE_TIMEOUT = 30_000 for musicUrl.
// Keep the Tauri bridge at the same boundary; shortening this makes slow but
// valid plugin responses look like failures and triggers duplicate work.
const NODE_URL_DIRECT_TIMEOUT_MS = 30_000
const NODE_URL_FALLBACK_TIMEOUT_MS = 6000
const NODE_URL_BUILTIN_TIMEOUT_MS = 5000
const NODE_URL_SUCCESS_TTL_MS = 90_000
const NODE_URL_FAILURE_TTL_MS = 5_000
const NODE_URL_HEALTH_TTL_MS = 5 * 60_000

type UrlResolutionResult = { data?: any; error?: string }

const nodeUrlResolutionCache = new Map<
  string,
  { at: number; ttl: number; result: UrlResolutionResult }
>()
const nodeUrlResolutionInFlight = new Map<string, Promise<UrlResolutionResult>>()
let nodePluginEntriesCache:
  | { at: number; entries: Promise<any[]> }
  | undefined
const nodePluginHealth = new Map<
  string,
  { success: number; failure: number; failureStreak: number; lastFailureAt: number }
>()

function getNodePluginEntries(): Promise<any[]> {
  const now = Date.now()
  if (nodePluginEntriesCache && now - nodePluginEntriesCache.at < 30_000) {
    return nodePluginEntriesCache.entries
  }
  const entries = invokeNodePlugin('loadAll')
    .then((value) => (Array.isArray(value) ? value : []))
    .catch(() => [])
  nodePluginEntriesCache = { at: now, entries }
  return entries
}

function invalidateNodePluginEntriesCache() {
  nodePluginEntriesCache = undefined
}

async function rememberInstalledPlugin(result: any) {
  const pluginId = String(result?.pluginId || result?.id || '').trim()
  if (!pluginId) return
  invalidateNodePluginEntriesCache()
  const entries = await getNodePluginEntries()
  const entry = findNodePluginEntry(entries, pluginId) || result
  registerSidecarPluginSources(pluginId, entry)
}

function getNodePluginHealthKey(pluginId: string, source: string): string {
  return `${pluginId}::${normalizeSourceKey(source)}`
}

function getNodePluginHealth(pluginId: string, source: string) {
  const key = getNodePluginHealthKey(pluginId, source)
  const current = nodePluginHealth.get(key)
  if (!current) return { success: 0, failure: 0, failureStreak: 0, lastFailureAt: 0 }
  if (current.lastFailureAt > 0 && Date.now() - current.lastFailureAt > NODE_URL_HEALTH_TTL_MS) {
    current.failure = 0
    current.failureStreak = 0
  }
  return current
}

function recordNodePluginHealth(pluginId: string, source: string, success: boolean): void {
  if (!pluginId) return
  const key = getNodePluginHealthKey(pluginId, source)
  const current = getNodePluginHealth(pluginId, source)
  if (success) {
    current.success += 1
    current.failure = 0
    current.failureStreak = 0
  } else {
    current.failure += 1
    current.failureStreak += 1
    current.lastFailureAt = Date.now()
  }
  nodePluginHealth.set(key, current)
}

function isNodePluginCoolingDown(pluginId: string, source: string): boolean {
  const health = getNodePluginHealth(pluginId, source)
  return health.success === 0 && health.failureStreak >= 2
}

function nodePluginScore(entry: any, source: string): number {
  const pluginId = String(entry?.pluginId || entry?.id || '')
  const name = String(entry?.pluginInfo?.name || entry?.pluginName || entry?.name || entry?.id || '')
  const nameScore = pluginNameScore(name)
  const health = getNodePluginHealth(pluginId, source)
  const recentSuccessBonus = health.success > 0 ? Math.min(60, health.success * 30) : 0
  const failurePenalty = Math.min(90, health.failure * 30)
  const brokenStreakPenalty = health.failureStreak >= 2 ? 80 : 0
  return nameScore + recentSuccessBonus - failurePenalty - brokenStreakPenalty
}

async function getNodePluginCandidatesForSource(
  source: string,
  preferredPluginId?: string,
): Promise<string[]> {
  const key = normalizeSourceKey(source)
  if (!key || key === 'local') return []

  const entries = await getNodePluginEntries()
  const enabled = entries.filter((entry: any) => entry && !entry.disabled)
  const result: string[] = []
  const seen = new Set<string>()
  const add = (value: any) => {
    const id = String(value || '').trim()
    if (!id || seen.has(id)) return
    seen.add(id)
    result.push(id)
  }

  add(preferredPluginId)
  enabled
    .filter((entry: any) => {
      const sources = entry?.supportedSources
      const pluginId = String(entry?.pluginId || entry?.id || '')
      return (
        sources &&
        typeof sources === 'object' &&
        sources[key] &&
        !isNodePluginCoolingDown(pluginId, key)
      )
    })
    .sort((a: any, b: any) => nodePluginScore(b, key) - nodePluginScore(a, key))
    .forEach((entry: any) => add(entry.pluginId || entry.id))

  if (result.length === 0 || (!preferredPluginId && result.length < 2)) {
    enabled
      .filter((entry: any) => {
        const sources = entry?.supportedSources
        const pluginId = String(entry?.pluginId || entry?.id || '')
        return (
          (!sources || Object.keys(sources).length === 0) &&
          !isNodePluginCoolingDown(pluginId, key)
        )
      })
      .sort((a: any, b: any) => nodePluginScore(b, key) - nodePluginScore(a, key))
      .forEach((entry: any) => add(entry.pluginId || entry.id))
  }

  // Some converted LX plugins only expose source metadata after they are
  // instantiated, so the registry can legitimately contain an empty
  // supportedSources object. Those plugins still have a callable musicUrl
  // method and must participate in fallback, otherwise one broken configured
  // plugin can block playback for the full resolution budget.
  enabled
    .filter((entry: any) => {
      const pluginType = String(entry?.pluginType || '').trim()
      const serviceRole = String(entry?.serviceRole || '').trim()
      if (serviceRole || pluginType === 'service') return false
      if (pluginType && pluginType !== 'music-source') return false
      const sources = entry?.supportedSources
      const pluginId = String(entry?.pluginId || entry?.id || '')
      return (
        (!sources || Object.keys(sources).length === 0) &&
        !isNodePluginCoolingDown(pluginId, key)
      )
    })
    .sort((a: any, b: any) => nodePluginScore(b, key) - nodePluginScore(a, key))
    .forEach((entry: any) => add(entry.pluginId || entry.id))

  return result
}

async function tryNodePluginUrl(
  pluginId: string,
  args: any,
  source: string,
  timeoutMs: number,
): Promise<{ data?: any; error?: string }> {
  const songInfo = normalizePluginSongInfo(args?.songInfo || args?.song || {}, source)
  const quality = firstText(args?.quality, args?.requestedQuality, '128k')
  const cacheEnabled = args?.isCache !== false && !songInfo?._servicePluginId
  const cacheKey =
    cacheEnabled
      ? `${source}_${firstText(songInfo?.songmid, songInfo?.hash, `${songInfo?.name || ''}_${songInfo?.singer || ''}`)}_${quality}`
      : ''

  if (cacheKey) {
    let cachedUrl = await invokeNodeMusicUrlCache('get', { key: cacheKey })
    if (!isUsableMediaUrl(cachedUrl)) {
      cachedUrl = await safeInvoke<string | null>('music_url_cache_get', { key: cacheKey }, null)
    }
    if (isUsableMediaUrl(cachedUrl)) {
      return { data: cachedUrl }
    }
  }

  await ensureNodePluginPrepared(pluginId)

  let pluginConfig = await invokeNodePlugin('getConfig', { pluginId }).catch(() => undefined)
  if ((!pluginConfig || typeof pluginConfig !== 'object') && songInfo?._servicePluginId) {
    pluginConfig = await getPluginConfigValue(pluginId).catch(() => undefined)
  }
  if (pluginConfig && typeof pluginConfig === 'object') {
    pluginConfigStore[pluginId] = pluginConfig as Record<string, any>
  }
  const pluginSongInfo = {
    ...songInfo,
    ...(pluginConfig ? { _serviceConfig: pluginConfig } : {}),
  }

  // Electron's ShuxiaMusicPluginHost.getMusicUrl always calls the selected
  // plugin's musicUrl method once with [source, songInfo, quality]. Converted
  // legacy plugins are normalized to musicUrl during installation.
  const invokeMusicMethod = async (method: string) =>
    await invokeNodePluginMethod(
      pluginId,
      method,
      [source, pluginSongInfo, quality],
      Math.max(500, timeoutMs),
    ).catch((error) => ({ __pluginError: error }))

  let method = 'musicUrl'
  let raw = await invokeMusicMethod(method)
  if (needsNodePluginRepair(raw)) {
    nodePluginPrepared.delete(pluginId)
    if (await ensureNodePluginPrepared(pluginId)) {
      raw = await invokeMusicMethod(method)
    }
  }
  const firstErrorText = getPluginInvocationError(raw)
  if (/not implemented|is not a function|no method/i.test(firstErrorText)) {
    for (const legacyMethod of ['getMusicUrl', 'getSongUrl']) {
      const legacyRaw = await invokeMusicMethod(legacyMethod)
      const legacyErrorText = getPluginInvocationError(legacyRaw)
      if (!legacyErrorText) {
        method = legacyMethod
        raw = legacyRaw
        break
      }
    }
  }

  let normalized = normalizePluginMusicResult(method, raw, source)
  // 飞牛等服务插件常返回 {url, headers}；若只剩裸 URL，补上会话 Cookie，避免 WebView 丢鉴权。
  if (isUsableMediaUrl(normalized) && pluginConfig && typeof normalized === 'string') {
    const role = await getPluginServiceRoleValue(pluginId).catch(() => '')
    if (role === 'feiniu' || firstText(songInfo?.source, source) === 'feiniu') {
      const headers = buildFeiniuAuthHeaders(pluginConfig as Record<string, any>)
      if (Object.keys(headers).length) {
        normalized = { url: extractMusicUrl(normalized), headers }
      }
    }
  }
  // 飞牛 musicUrl 若因整曲下载超时失败，直接用配置拼鉴权流地址。
  if (!isUsableMediaUrl(normalized) && pluginConfig) {
    const role = await getPluginServiceRoleValue(pluginId).catch(() => '')
    if (role === 'feiniu' || firstText(songInfo?.source, source) === 'feiniu') {
      const fallback = buildFeiniuStreamPlayback(pluginConfig as Record<string, any>, pluginSongInfo)
      if (fallback && isUsableMediaUrl(fallback.url)) {
        normalized = fallback
      }
    }
  }
  if (isUsableMediaUrl(normalized)) {
    // 服务插件取流地址带鉴权，不能写入持久 URL 缓存。
    if (cacheKey && !songInfo?._servicePluginId) {
      const cachedUrl = extractMusicUrl(normalized)
      invokeNodeMusicUrlCache('save', {
        key: cacheKey,
        url: cachedUrl,
      }).catch(() => undefined)
      safeInvoke('music_url_cache_save', { key: cacheKey, url: cachedUrl }).catch(() => undefined)
    }
    recordNodePluginHealth(pluginId, source, true)
    return { data: normalized }
  }

  recordNodePluginHealth(pluginId, source, false)
  const pluginError = (raw as any)?.__pluginError
  const lastError = firstText(
    normalized?.error?.message,
    normalized?.error,
    pluginError?.message,
    pluginError,
  )
  return { error: lastError || `插件 ${pluginId} 未返回有效播放链接` }
}

async function requestMusicUrlWithFallback(
  apiName: string,
  args: any,
  source: string,
  preferredPluginId?: string,
): Promise<UrlResolutionResult> {
  const songInfo = args?.songInfo || args?.song || {}
  const quality = firstText(args?.quality, args?.requestedQuality, '128k')
  const isPodcastProgram =
    String(source || '').toLowerCase() === 'wy' &&
    Boolean(
      songInfo?.contentType === 'radio-program' ||
      songInfo?.programId ||
      songInfo?.podcastProgramId,
    )

  // Official podcast programs are not regular songs and must use the podcast API.
  if (isPodcastProgram) {
    try {
      // Electron: musicSdkService.getMusicUrl -> getOfficialPlayUrl(songInfo, quality)
      // Tauri 这里也必须直打官方播客取链，不能再走普通 getMusicUrl / 插件链。
      const data = await invokeNodeMusicSdk('podcast.getPlayUrl', {
        song: songInfo,
        quality,
      })
      const payload = data as Record<string, any> | string | undefined
      const normalized = normalizePluginMusicResult('getMusicUrl', data, source || 'wy')
      if (isUsableMediaUrl(normalized)) return { data: normalized }
      // 兼容官方直接返回 {url} / string
      const directUrl = firstText(
        typeof payload === 'string' ? payload : '',
        typeof payload === 'object' ? payload?.url : '',
        typeof payload === 'object' ? payload?.playUrl : '',
        typeof payload === 'object' ? payload?.musicUrl : '',
        normalized?.url,
      )
      if (isUsableMediaUrl(directUrl)) return { data: directUrl }
      return {
        error:
          firstText(
            typeof payload === 'object' ? payload?.error?.message : '',
            typeof payload === 'object' ? payload?.error : '',
            normalized?.error?.message,
            normalized?.error,
          ) ||
          '官方播客未返回播放链接',
      }
    } catch (error: any) {
      return { error: String(error?.message || error || '官方播客未返回播放链接') }
    }
  }

  const cacheKey = [
    'node-url',
    apiName,
    source,
    firstText(songInfo?.songmid, songInfo?.hash, songInfo?.id, songInfo?.name),
    quality,
    String(preferredPluginId || ''),
  ].join('::')
  const cached = nodeUrlResolutionCache.get(cacheKey)
  if (cached && Date.now() - cached.at < cached.ttl) return cached.result
  const pending = nodeUrlResolutionInFlight.get(cacheKey)
  if (pending) return await pending

  const resolve = async (): Promise<UrlResolutionResult> => {
    const directPluginId = String(preferredPluginId || '').trim()
    let lastError = ''

    const selectedPluginId =
      directPluginId || (await ensurePluginRuntimeForSource(source, preferredPluginId))
    if (selectedPluginId) {
      void invokeNodePlugin('pin', { pluginId: selectedPluginId }).catch(() => undefined)
    }
    // Electron asks the configured plugin for this one quality and returns.
    // Multi-source fallback belongs to renderer getSongRealUrl/tryUrlSequential,
    // not this bridge, otherwise every failed quality multiplies plugin work.
    if (selectedPluginId) {
      try {
        const directResult = await withTimeout(
          tryNodePluginUrl(selectedPluginId, args, source, NODE_URL_DIRECT_TIMEOUT_MS),
          NODE_URL_DIRECT_TIMEOUT_MS + 500,
          `插件 ${selectedPluginId} 响应超时`,
        )
        if (directResult?.data) return directResult
        lastError = directResult?.error || lastError
      } catch (error: any) {
        lastError = String(error?.message || error || lastError)
      }

      const candidates = await getNodePluginCandidatesForSource(source, selectedPluginId)
      for (const pluginId of candidates) {
        if (pluginId === selectedPluginId) continue
        try {
          const fallbackResult = await withTimeout(
            tryNodePluginUrl(pluginId, args, source, NODE_URL_FALLBACK_TIMEOUT_MS),
            NODE_URL_FALLBACK_TIMEOUT_MS + 500,
            `插件 ${pluginId} 响应超时`,
          )
          if (fallbackResult?.data) return fallbackResult
          lastError = fallbackResult?.error || lastError
        } catch (error: any) {
          lastError = String(error?.message || error || lastError)
        }
      }
      return { error: lastError || `插件 ${selectedPluginId} 未返回播放链接` }
    }

    if (isBuiltinPlayableSource(source)) {
      try {
        const data = await withTimeout(
          invokeNodeMusicSdk(apiName, source ? { ...args, source } : args),
          NODE_URL_BUILTIN_TIMEOUT_MS,
          '内置音源响应超时',
        )
        const normalized = normalizePluginMusicResult(apiName, data, source)
        if (isUsableMediaUrl(normalized)) return { data: normalized }
        lastError = normalized?.error?.message || normalized?.error || lastError
      } catch (error: any) {
        lastError = String(error?.message || error || lastError)
      }
    }

    return { error: lastError || '没有可用音源处理当前歌曲' }
  }

  const request = resolve()
    .then((result) => {
      nodeUrlResolutionCache.set(cacheKey, {
        at: Date.now(),
        ttl: result.data ? NODE_URL_SUCCESS_TTL_MS : NODE_URL_FAILURE_TTL_MS,
        result,
      })
      if (nodeUrlResolutionCache.size > 120) {
        const oldestKey = nodeUrlResolutionCache.keys().next().value
        if (oldestKey !== undefined) nodeUrlResolutionCache.delete(oldestKey)
      }
      return result
    })
    .finally(() => {
      nodeUrlResolutionInFlight.delete(cacheKey)
    })

  nodeUrlResolutionInFlight.set(cacheKey, request)
  return await request
}

async function resolveDownloadMedia(
  args: any,
  source: string,
  preferredPluginId?: string,
) {
  const songInfo = args?.songInfo || args?.song || {}
  const quality = firstText(args?.quality, args?.requestedQuality, '320k')
  const candidateUrl = firstText(
    args?.url,
    songInfo?.typeUrl?.[quality],
    songInfo?.__nativeMedia?.url,
  )
  // Playback URLs from the local stream proxy are tied to the current audio
  // session. Re-resolve a fresh URL instead of handing a stale proxy to the
  // download queue.
  const directUrl =
    isUsableMediaUrl(candidateUrl) &&
    !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/stream\//i.test(candidateUrl)
      ? candidateUrl
      : ''
  if (directUrl) {
    return {
      url: extractMusicUrl(directUrl),
      headers: songInfo?.__nativeMedia?.headers || {},
      referrer: songInfo?.__nativeMedia?.referrer || songInfo?.referrer || '',
      userAgent: songInfo?.__nativeMedia?.userAgent || songInfo?.userAgent || '',
    }
  }

  const result = await requestMusicUrlWithFallback(
    'getMusicUrl',
    {
      ...args,
      source,
      quality,
      songInfo,
      isCache: args?.isCache !== false,
    },
    source,
    preferredPluginId,
  )
  if (!result.data) {
    throw new Error(result.error || '无法获取歌曲下载链接')
  }

  const normalized = normalizePluginMusicUrlResult(result.data)
  const url = extractMusicUrl(normalized)
  if (!isUsableMediaUrl(url)) {
    throw new Error(result.error || '无法获取歌曲下载链接')
  }

  return {
    url,
    headers: normalized?.headers || {},
    referrer: normalized?.referrer || '',
    userAgent: normalized?.userAgent || '',
  }
}

async function invokeNodeDownloadStrict(method: string, payload?: any) {
  return await invoke('node_sidecar_request', {
    method: `download.${method}`,
    payload: payload ?? null,
  })
}

async function enqueueSingleDownload(args: any) {
  const source = normalizeSourceKey(args?.source || args?.songInfo?.source || '')
  const preferredPluginId = String(args?.pluginId || '').trim()
  const songInfo = args?.songInfo || args?.song || {}
  const quality = firstText(args?.quality, args?.requestedQuality, '320k')
  const resolved = await resolveDownloadMedia(args, source, preferredPluginId)

  return await invokeNodeDownloadStrict('addTask', {
    ...args,
    source,
    pluginId: preferredPluginId,
    quality,
    requestedQuality: quality,
    url: resolved.url,
    status: 'queued',
    songInfo: {
      ...songInfo,
      source: songInfo.source || source,
      typeUrl: {
        ...(songInfo.typeUrl || {}),
        [quality]: resolved.url,
      },
      __nativeMedia: {
        ...(songInfo.__nativeMedia || {}),
        url: resolved.url,
        headers: resolved.headers,
        referrer: resolved.referrer,
        userAgent: resolved.userAgent,
      },
    },
  })
}

async function enqueueBatchDownloads(args: any) {
  const tasks = Array.isArray(args?.tasks) ? args.tasks : []
  const results: any[] = []
  const queue = [...tasks]
  const worker = async () => {
    while (queue.length > 0) {
      const task = queue.shift()
      if (!task) continue
      try {
        const result = await enqueueSingleDownload(task)
        const normalizedResult = (result || {}) as Record<string, any>
        results.push({ success: true, task: normalizedResult.task, ...normalizedResult })
      } catch (error: any) {
        results.push({
          success: false,
          songmid: task?.songInfo?.songmid,
          error: String(error?.message || error),
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, tasks.length || 1) }, worker))
  return {
    success: results.every((item) => item.success),
    added: results.filter((item) => item.success).length,
    tasks: results,
    errors: results.filter((item) => !item.success).map((item) => item.error),
  }
}

function normalizePluginMusicResult(apiName: string, result: any, fallbackSource: string) {
  if (apiName === 'search') return normalizeSearchResponse(result, fallbackSource)
  if (apiName === 'getMusicUrl' || apiName === 'getSongUrl' || apiName === 'musicUrl') return normalizePluginMusicUrlResult(result)
  if (apiName === 'getPic') {
    if (typeof result === 'string') return result
    return firstText(result?.url, result?.body, result?.data?.url, result?.data?.body, result?.picUrl, result?.cover) || result
  }
  if (apiName === 'getLyric') return normalizeLyricResponse(result)
  if (
    apiName === 'getComment' ||
    apiName === 'getHotComment' ||
    apiName === 'getCommentList' ||
    apiName === 'getCommentReply'
  ) {
    return normalizeCommentResponse(apiName, result)
  }
  return result
}

async function callPluginMethodNodeFirst(
  pluginId: string,
  method: string,
  ...args: any[]
): Promise<any> {
  const nodeResult = await invokeNodePluginMethod(pluginId, method, args)
  if (nodeResult !== undefined) return nodeResult
  if (!pluginSandbox.get(pluginId)) return undefined
  return pluginSandbox.call(pluginId, method, ...args)
}

async function callFirstPluginMethod(
  pluginId: string,
  method: string,
  variants: any[][],
  accept: (value: any) => boolean,
): Promise<any> {
  let lastError: unknown
  for (const args of variants) {
    try {
      const nodeResult = await invokeNodePluginMethod(pluginId, method, args)
      if (nodeResult !== undefined && accept(nodeResult)) return nodeResult
    } catch (error) {
      lastError = error
    }

    try {
      if (!pluginSandbox.get(pluginId)) continue
      const result = await pluginSandbox.call(pluginId, method, ...args)
      if (accept(result)) return result
    } catch (error) {
      lastError = error
    }
  }
  if (lastError) throw lastError
  return undefined
}

export async function requestMusicPluginAdapter(apiName: string, args: any = {}) {
  const source = normalizeSourceKey(args?.source || args?.songInfo?.source || '')
  const preferredPluginId = String(args?.pluginId || '').trim()

  if (apiName === 'getMusicUrl' || apiName === 'getSongUrl' || apiName === 'musicUrl') {
    const pluginId = await ensurePluginRuntimeForSource(source, preferredPluginId)
    if (!pluginId) return undefined
    try {
      const result = await routeSdkToPlugin(apiName, { ...args, source, pluginId }, pluginId)
      return normalizePluginMusicResult(apiName, result, source)
    } catch (e: any) {
      return { error: String(e?.message || e) }
    }
  }

  const pluginId = preferredPluginId || await ensurePluginRuntimeForSource(source)
  if (!pluginId) return undefined

  const result = await routeSdkToPlugin(apiName, { ...args, source, pluginId }, pluginId)
  if (result === undefined) return undefined
  return normalizePluginMusicResult(apiName, result, source)
}

async function findInstalledPluginByName(pluginName?: string) {
  const name = String(pluginName || '').trim()
  if (!name) return null
  const registry = await safeInvoke<any[]>('plugin_load_registry', undefined, [])
  return registry.find((entry: any) => String(entry?.name || '').trim() === name) || null
}

async function savePluginRegistry(pluginId: string, exports: any) {
  await invoke('plugin_save_registry', {
    id: pluginId,
    name: exports.pluginInfo?.name || pluginId,
    pluginType: exports.pluginType || 'unknown',
    version: exports.pluginInfo?.version || '',
    author: exports.pluginInfo?.author || '',
    description: exports.pluginInfo?.description || '',
    enabled: true,
  })
}

async function installPluginFromCode(
  pluginCode: string,
  preferredId?: string,
  fallbackName?: string,
  type?: 'lx' | 'cr' | 'mf',
): Promise<{ id: string; name: string; exports: any }> {
  const normalizedCode = preparePluginCode(pluginCode, type)
  const tempId = normalizePluginId(`install_${Date.now()}_${Math.random().toString(36).slice(2)}`)
  unloadPluginRuntime(tempId)

  let inspectedExports: any
  try {
    inspectedExports = await pluginSandbox.load(tempId, normalizedCode)
  } catch (e) {
    unloadPluginRuntime(tempId)
    throw e
  }

  const pluginName = inspectedExports.pluginInfo?.name || fallbackName || preferredId || tempId
  const pluginVersion = inspectedExports.pluginInfo?.version || ''
  const existing = await findInstalledPluginByName(pluginName)

  if (existing?.id && existing.version === pluginVersion) {
    unloadPluginRuntime(tempId)
    throw new Error(`插件 "${pluginName} v${pluginVersion}" 已存在，不能重复添加`)
  }

  const finalId = normalizePluginId(existing?.id || preferredId || createPluginId())
  unloadPluginRuntime(tempId)
  unloadPluginRuntime(finalId)

  const inspectedMeta = extractPluginMetaExports(inspectedExports, pluginName)
  await persistPluginFile(finalId, normalizedCode)
  await savePluginRegistry(finalId, inspectedMeta)
  registerSidecarPluginSources(finalId, inspectedMeta)

  if (existing?.id && existing.id !== finalId) {
    unloadPluginRuntime(existing.id)
    await safeInvoke('plugin_remove_registry', { id: existing.id })
    await removePersistedPluginFile(existing.id)
  }

  const nodeInstalled = await invokeNodePlugin('installFromCode', {
    pluginCode: normalizedCode,
    pluginName,
    targetPluginId: finalId,
    type,
  }).catch(() => undefined)
  if (nodeInstalled) await rememberInstalledPlugin(nodeInstalled)
  else invalidateNodePluginEntriesCache()

  return {
    id: finalId,
    name: inspectedMeta.pluginInfo?.name || pluginName || finalId,
    exports: inspectedMeta,
  }
}

function toElectronPluginResult(installed: { id: string; name: string; exports: any }) {
  const supportedSources = getPluginSupportedSources(installed.exports)
  return {
    pluginId: installed.id,
    pluginName: installed.name,
    id: installed.id,
    name: installed.name,
    pluginInfo: installed.exports?.pluginInfo || {
      name: installed.name,
      version: '',
      author: '',
      description: '',
    },
    pluginType: installed.exports?.pluginType || 'music-source',
    supportedSources,
  }
}

/** Wrapper that calls Tauri command, logs & returns fallback on error */
async function safeInvoke<T = any>(cmd: string, args?: Record<string, unknown>, fallback?: T): Promise<T> {
  try {
    return await invoke<T>(cmd, args)
  } catch (e) {
    console.warn(`[tauri-bridge] invoke ${cmd} failed:`, e)
    return fallback as T
  }
}

const powerSaveBlockerReasons = new Set<string>()
let powerSaveBlockerNativeActive = false
let powerSaveBlockerSwitching: Promise<void> | null = null

async function syncPowerSaveBlockerState(): Promise<void> {
  if (powerSaveBlockerSwitching) await powerSaveBlockerSwitching.catch(() => undefined)

  const shouldRun = powerSaveBlockerReasons.size > 0
  if (shouldRun === powerSaveBlockerNativeActive) return

  powerSaveBlockerSwitching = (async () => {
    if (shouldRun) {
      await safeInvoke('power_save_blocker_start')
      powerSaveBlockerNativeActive = true
    } else {
      await safeInvoke('power_save_blocker_stop')
      powerSaveBlockerNativeActive = false
    }
  })().finally(() => {
    powerSaveBlockerSwitching = null
  })

  await powerSaveBlockerSwitching
}

async function holdPowerSaveBlocker(reason = 'default'): Promise<void> {
  powerSaveBlockerReasons.add(String(reason || 'default'))
  await syncPowerSaveBlockerState()
}

async function releasePowerSaveBlocker(reason = 'default'): Promise<void> {
  powerSaveBlockerReasons.delete(String(reason || 'default'))
  await syncPowerSaveBlockerState()
}

const delayMs = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

async function ensurePluginSystemReady(): Promise<void> {
  if (!pluginSystemInitializationPromise) {
    pluginSystemInitializationPromise = (async () => {
      const result = await invokeNodePlugin('initializeSystem')
      try {
        const saved = JSON.parse(localStorage.getItem('userInfo') || '{}')
        const pluginId = String(saved?.pluginId || '').trim()
        if (pluginId) void invokeNodePlugin('pin', { pluginId })
      } catch {}
      return result ?? true
    })().catch((error) => {
      pluginSystemInitializationPromise = null
      throw error
    })
  }
  try {
    await pluginSystemInitializationPromise
  } catch {}
}

async function invokeNodeMusicSdk(apiName: string, args: any) {
  await ensurePluginSystemReady()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const data = await invoke('node_sidecar_request', {
        method: 'music.sdk.request',
        payload: {
          api: apiName,
          args: args || {},
        },
      })
      if (data !== undefined) return data
    } catch (error) {
      console.warn(`[tauri-bridge] node music sdk ${apiName} failed:`, error)
    }
    if (attempt < 3) await delayMs(400 * (attempt + 1))
  }
  return undefined
}

async function invokeNodePlugin(method: string, payload?: any) {
  try {
    return await invoke('node_sidecar_request', {
      method: `plugin.${method}`,
      payload: payload ?? null,
    })
  } catch (error) {
    console.warn(`[tauri-bridge] node plugin ${method} failed, fallback to frontend sandbox:`, error)
    return undefined
  }
}

async function invokeNodeDownload(method: string, payload?: any) {
  try {
    return await invoke('node_sidecar_request', {
      method: `download.${method}`,
      payload: payload ?? null,
    })
  } catch (error) {
    console.warn(`[tauri-bridge] node download ${method} failed:`, error)
    return undefined
  }
}

async function invokeNodeMusicCache(method: string, payload?: any) {
  try {
    return await invoke('node_sidecar_request', {
      method: `music.cache.${method}`,
      payload: payload ?? null,
    })
  } catch (error) {
    console.warn(`[tauri-bridge] node music cache ${method} failed:`, error)
    return undefined
  }
}

async function invokeNodeMusicUrlCache(method: string, payload?: any) {
  try {
    return await invoke('node_sidecar_request', {
      method: `music.url.cache.${method}`,
      payload: payload ?? null,
    })
  } catch (error) {
    console.warn(`[tauri-bridge] node music url cache ${method} failed:`, error)
    return undefined
  }
}

async function probeNodeDownloadUrl(
  url: string,
): Promise<{ ok: boolean; size?: number; reason?: string }> {
  try {
    return await invoke('node_sidecar_request', {
      method: 'music.sdk.probeDownloadUrl',
      payload: { url },
    })
  } catch (error) {
    console.warn('[tauri-bridge] node download probe failed:', error)
    return { ok: false, size: 0, reason: String((error as any)?.message || error) }
  }
}

async function invokeNodeSystem(method: string, payload?: any) {
  try {
    return await invoke('node_sidecar_request', {
      method: `system.${method}`,
      payload: payload ?? null,
    })
  } catch (error) {
    console.warn(`[tauri-bridge] node system ${method} failed:`, error)
    return undefined
  }
}

async function invokeNodeAutoUpdate(method: string, payload?: any) {
  return await invokeNodeSystem(`autoUpdate.${method}`, payload)
}

async function invokeNodeNotification(method: string, payload?: any) {
  return await invokeNodeSystem(`notification.${method}`, payload)
}

async function invokeNodeWindowLifecycle(method: string, payload?: any) {
  return await invokeNodeSystem(`windowLifecycle.${method}`, payload)
}

async function recordNotificationDecision(payload: any) {
  const result = await invokeNodeNotification('record', payload) as any
  if (result?.success) return result
  return { success: false, show: true, reason: 'fallback', notification: payload }
}

function normalizeNotificationPayload(input: any, fallback: Record<string, any> = {}) {
  const raw = input && typeof input === 'object' ? input : { body: String(input || '') }
  return {
    ...fallback,
    ...raw,
    title: String(raw.title || fallback.title || '通知'),
    body: String(raw.body || raw.message || raw.content || fallback.body || ''),
    channel: raw.channel || fallback.channel || 'system',
    severity: raw.severity || raw.type || fallback.severity || 'info',
  }
}

function normalizeUpdateManifest(input: any) {
  if (!input || typeof input !== 'object') return null
  return {
    url: String(input.url || ''),
    name: String(input.name || input.version || ''),
    notes: String(input.notes || input.body || ''),
    pub_date: String(input.pub_date || input.pubDate || input.date || ''),
    supportsDifferential: Boolean(input.supportsDifferential),
    mode: input.mode === 'differential' ? 'differential' : 'full',
  }
}

function normalizeUpdaterError(error: any) {
  if (!error) return { message: '更新过程发生错误' }
  if (typeof error === 'string') return { message: error }
  return {
    code: String(error.code || ''),
    message: String(error.message || error.raw || error.error || '更新过程发生错误'),
    raw: String(error.raw || ''),
  }
}

function normalizeUpdaterProgress(input: any) {
  const downloaded = Number(input.downloaded ?? input.transferred ?? 0)
  const total = Number(input.total ?? 0)
  const percent = Number(input.percent ?? (total > 0 ? Math.round((downloaded / total) * 100) : 0))
  return {
    percent: Number.isFinite(percent) ? percent : 0,
    transferred: Number.isFinite(downloaded) ? downloaded : 0,
    total: Number.isFinite(total) ? total : 0,
  }
}

const updaterListenerDisposers = new Set<() => void>()

// 缓存最近一次 checkUpdate 的结果（含 rid 与绑定好的 downloadAndInstall 闭包）。
// 目的是下载/安装时复用 rid，避免 downloadUpdate/quitAndInstall 再跑一次 checkUpdate
// （那会重复发 CHECKING 事件、重复“正在检查更新”，并多一次网络探测）。
let lastCheckResult: UpdateResult | null = null

function onUpdaterStatus(status: UpdaterEvent['status'], cb: (event: UpdaterEvent) => void): () => void {
  let disposed = false
  let innerDispose: (() => void) | null = null

  const dispose = () => {
    disposed = true
    updaterListenerDisposers.delete(dispose)
    innerDispose?.()
    innerDispose = null
  }

  updaterListenerDisposers.add(dispose)

  onUpdaterEvent((event) => {
    if (!disposed && event.status === status) cb(event)
  }).then((unlisten) => {
    if (disposed) {
      unlisten()
      return
    }
    innerDispose = unlisten
  }).catch((error) => {
    console.warn('[tauri-bridge] updater listener failed:', error)
    dispose()
  })

  return dispose
}

function clearUpdaterListeners() {
  Array.from(updaterListenerDisposers).forEach((dispose) => dispose())
}

const aiStreamListenerDisposers = new Set<() => void>()

function onAiStreamEvent<T = any>(event: string, cb: (payload: T) => void): () => void {
  let disposed = false
  let innerDispose: (() => void) | null = null

  const dispose = () => {
    disposed = true
    aiStreamListenerDisposers.delete(dispose)
    innerDispose?.()
    innerDispose = null
  }

  aiStreamListenerDisposers.add(dispose)

  listen<T>(event, (e) => {
    if (!disposed) cb(e.payload)
  }).then((unlisten) => {
    if (disposed) {
      unlisten()
      return
    }
    innerDispose = unlisten
  }).catch((error) => {
    console.warn('[tauri-bridge] ai stream listener failed:', error)
    dispose()
  })

  return dispose
}

function clearAiStreamListeners() {
  Array.from(aiStreamListenerDisposers).forEach((dispose) => dispose())
}

function onTrackedTauriEvent<T = any>(
  event: string,
  cb: (payload: T) => void,
  disposers: Set<() => void>,
  logScope: string,
): () => void {
  let disposed = false
  let innerDispose: (() => void) | null = null

  const dispose = () => {
    disposed = true
    disposers.delete(dispose)
    innerDispose?.()
    innerDispose = null
  }

  disposers.add(dispose)

  listen<T>(event, (e) => {
    if (!disposed) cb(e.payload)
  }).then((unlisten) => {
    if (disposed) {
      unlisten()
      return
    }
    innerDispose = unlisten
  }).catch((error) => {
    console.warn(`[tauri-bridge] ${logScope} listener failed:`, error)
    dispose()
  })

  return dispose
}

function clearTrackedListeners(disposers: Set<() => void>) {
  Array.from(disposers).forEach((dispose) => dispose())
}

const localMusicScanProgressListenerDisposers = new Set<() => void>()
const localMusicScanFinishedListenerDisposers = new Set<() => void>()
const localMusicBatchMatchListenerDisposers = new Set<() => void>()
const electronIpcListenerDisposers = new Map<string, Set<() => void>>()

function getElectronIpcListenerDisposers(channel: string) {
  let disposers = electronIpcListenerDisposers.get(channel)
  if (!disposers) {
    disposers = new Set<() => void>()
    electronIpcListenerDisposers.set(channel, disposers)
  }
  return disposers
}

function clearElectronIpcListeners(channel?: string) {
  if (typeof channel === 'string') {
    const disposers = electronIpcListenerDisposers.get(channel)
    if (!disposers) return
    clearTrackedListeners(disposers)
    electronIpcListenerDisposers.delete(channel)
    return
  }

  Array.from(electronIpcListenerDisposers.values()).forEach(clearTrackedListeners)
  electronIpcListenerDisposers.clear()
}

async function recordAutoUpdateState(method: string, payload?: any) {
  return await invokeNodeAutoUpdate(method, payload).catch(() => undefined)
}

async function invokeNodePluginMethod(pluginId: string, method: string, args: any[] = [], timeoutMs?: number) {
  const result = await invokeNodePlugin('invoke', {
    pluginId,
    method,
    args,
    timeoutMs,
  })
  return result === undefined ? undefined : result
}

function normalizeNodePluginInstallResult(result: any) {
  if (!result || typeof result !== 'object') return result
  return { success: true, ...result, data: result }
}

/** Subscribe to a Tauri event, returns unsubscribe fn */
function onTauriEvent<T = any>(event: string, cb: (payload: T) => void): () => void {
  return onTrackedTauriEvent<T>(event, cb, new Set<() => void>(), `event ${event}`)
}

/**
 * Subscribe to a Tauri event, passing null as first arg and payload as second.
 * Matches Electron IPC convention: (event, ...args) => void.
 */
function onElectronEvent<T = any>(event: string, cb: (event: null, payload: T) => void): () => void {
  return onTrackedTauriEvent<T>(event, (payload) => cb(null, payload), new Set<() => void>(), `electron event ${event}`)
}

async function handlePluginAddLinkPayload(api: Record<string, any>, raw: any) {
  const payload = parsePluginAddLinkPayload(raw)
  if (!payload) {
    console.warn('[tauri-bridge] 无效的插件安装链接:', raw)
    return
  }

  if (payload.targetPluginId) {
    const result = await api.plugins.downloadAndAddPlugin(payload.url, payload.type, payload.targetPluginId)
    if (result?.success === false || result?.error) {
      console.error('[tauri-bridge] DeepLink 更新插件失败:', result?.error || result?.message)
    }
    return
  }

  const notice = createPluginInstallNotice(payload)
  const decision = await recordNotificationDecision({
    channel: 'plugin',
    severity: notice.dialogType,
    title: notice.title,
    body: notice.message,
    tag: `plugin-install:${payload.url}`,
    pluginId: payload.targetPluginId,
    payload: notice,
  })
  if (decision.show !== false) emit('plugin-notice', notice).catch(console.warn)
}

const HOTKEY_CONFIG_STORAGE_KEY = 'shuxia_hotkey_config_v1'
const DEFAULT_HOTKEY_BINDINGS: Record<string, string> = {
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
}

type HotkeyConfigShape = {
  enabled: boolean
  bindings: Record<string, string>
}

function formatBytes(input: unknown): string {
  const bytes = Number(input || 0)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index++
  }
  return index === 0 ? `${bytes} ${units[index]}` : `${size.toFixed(2)} ${units[index]}`
}

function parseDownloadTimestamp(input: unknown): number {
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input === 'string' && input.trim()) {
    const parsed = Date.parse(input)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

function normalizeDirectorySettings(input: any) {
  return {
    cacheDir: input?.cacheDir || input?.cache_dir || '',
    downloadDir: input?.downloadDir || input?.download_dir || '',
  }
}

function normalizeDirectorySize(input: any) {
  const size = Number(
    typeof input === 'number'
      ? input
      : input?.size ?? input?.bytes ?? input?.cache_size ?? input?.cacheSize ?? 0,
  )
  return {
    size: Number.isFinite(size) ? size : 0,
    formatted: input?.formatted || input?.sizeFormatted || formatBytes(size),
  }
}

function normalizeMusicCacheInfo(input: any) {
  const size = Number(input?.size ?? input?.cache_size ?? input?.cacheSize ?? 0)
  const count = Number(input?.count ?? input?.file_count ?? input?.fileCount ?? input?.trackCount ?? 0)
  return {
    ...(input || {}),
    size: Number.isFinite(size) ? size : 0,
    count: Number.isFinite(count) ? count : 0,
    sizeFormatted: input?.sizeFormatted || input?.formatted || formatBytes(size),
  }
}

const downloadTaskCache = new Map<string, any>()
const DOWNLOAD_TASK_CACHE_MAX = 200

const rememberDownloadTask = (id: string, task: any) => {
  if (downloadTaskCache.has(id)) downloadTaskCache.delete(id)
  downloadTaskCache.set(id, task)
  while (downloadTaskCache.size > DOWNLOAD_TASK_CACHE_MAX) {
    const oldest = downloadTaskCache.keys().next().value
    if (oldest === undefined) break
    downloadTaskCache.delete(oldest)
  }
}


function normalizeDownloadStatus(status: any): string {
  const value = String(status || '').toLowerCase()
  if (value === 'pending') return 'queued'
  if (value === 'failed') return 'error'
  return value || 'queued'
}

function normalizeDownloadTask(input: any, previous?: any) {
  if (!input || typeof input !== 'object') return input
  const id = String(input.id || input.taskId || input.task_id || previous?.id || '')
  if (!id) return input

  const totalSize = Number(
    input.totalSize ?? input.totalBytes ?? input.total_bytes ?? previous?.totalSize ?? 0,
  )
  const downloadedSize = Number(
    input.downloadedSize ?? input.downloadedBytes ?? input.downloaded_bytes ?? previous?.downloadedSize ?? 0,
  )
  const speed = Number(input.speed ?? previous?.speed ?? 0)
  const remainingTime =
    speed > 0 && totalSize > downloadedSize ? Math.ceil((totalSize - downloadedSize) / speed) : null
  const songInfo = {
    ...(previous?.songInfo || {}),
    ...(input.songInfo || input.song_info || {}),
  }
  const tagWriteOptions = input.tagWriteOptions ?? input.tag_write_options ?? previous?.tagWriteOptions
  const name = input.name ?? songInfo.name ?? previous?.songInfo?.name ?? ''
  const singer = input.singer ?? songInfo.singer ?? previous?.songInfo?.singer ?? ''
  const cover = input.cover ?? songInfo.img ?? previous?.songInfo?.img ?? ''

  const status = normalizeDownloadStatus(input.status ?? previous?.status)
  const error = input.error ?? input.errorMessage ?? input.error_message ?? previous?.error ?? null

  const task = {
    ...(previous || {}),
    id,
    songInfo: {
      ...songInfo,
      songmid: input.songmid ?? songInfo.songmid ?? previous?.songInfo?.songmid ?? '',
      name,
      singer,
      img: cover,
    },
    url: input.url ?? previous?.url ?? '',
    pluginId: input.pluginId ?? input.plugin_id ?? previous?.pluginId,
    quality: input.quality ?? previous?.quality,
    tagWriteOptions: tagWriteOptions || {},
    metadataError: input.metadataError ?? input.metadata_error ?? previous?.metadataError,
    filePath: input.filePath ?? input.file_path ?? previous?.filePath ?? '',
    status,
    progress: Number(input.progress ?? previous?.progress ?? 0),
    speed: Number.isFinite(speed) ? speed : 0,
    totalSize: Number.isFinite(totalSize) ? totalSize : 0,
    downloadedSize: Number.isFinite(downloadedSize) ? downloadedSize : 0,
    remainingTime,
    error,
    priority: input.priority ?? previous?.priority,
    createdAt: parseDownloadTimestamp(input.createdAt ?? input.created_at ?? previous?.createdAt),
  }
  downloadTaskCache.set(id, task)
  return task
}

function normalizeDownloadTaskEvent(input: any) {
  const id = String(input?.id || input?.taskId || input?.task_id || '')
  const previous = id ? downloadTaskCache.get(id) : undefined
  return normalizeDownloadTask(input, previous)
}

function normalizeDownloadTaskList(input: any): any[] {
  const raw = input && typeof input === 'object' && 'data' in input ? (input as any).data : input
  const tasks = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any)?.tasks)
      ? (raw as any).tasks
      : []
  return tasks.map((task) => normalizeDownloadTask(task)).filter(Boolean)
}

function mergeDownloadTaskLists(...lists: any[][]): any[] {
  const merged = new Map<string, any>()
  for (const list of lists) {
    for (const task of normalizeDownloadTaskList(list)) {
      if (!task?.id) continue
      merged.set(task.id, normalizeDownloadTask(task, merged.get(task.id)))
    }
  }
  return Array.from(merged.values())
}

function hotkeyEntriesToConfig(entries: any[] = []): HotkeyConfigShape {
  const bindings: Record<string, string> = {}
  for (const entry of entries) {
    const action = String(entry?.action || '')
    const shortcut = String(entry?.shortcut || '')
    if (action) bindings[action] = shortcut
  }
  return {
    enabled: true,
    bindings: { ...DEFAULT_HOTKEY_BINDINGS, ...bindings },
  }
}

function readHotkeyConfigCache(): HotkeyConfigShape | null {
  try {
    const raw = localStorage.getItem(HOTKEY_CONFIG_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return {
      enabled: parsed?.enabled !== false,
      bindings: { ...DEFAULT_HOTKEY_BINDINGS, ...(parsed?.bindings || {}) },
    }
  } catch {
    return null
  }
}

function writeHotkeyConfigCache(config: HotkeyConfigShape) {
  try {
    localStorage.setItem(HOTKEY_CONFIG_STORAGE_KEY, JSON.stringify(config))
  } catch {}
}

function hotkeyConfigToEntries(config: HotkeyConfigShape) {
  if (!config.enabled) return []
  return Object.entries(config.bindings || {})
    .filter(([action, shortcut]) => action && shortcut)
    .map(([action, shortcut]) => ({ action, shortcut }))
}

/* ------------------------------------------------------------------ */
/*  Construct window.api                                               */
/* ------------------------------------------------------------------ */

let tauriBridgeInitialized = false

export function createTauriBridge() {
  if (tauriBridgeInitialized) return
  tauriBridgeInitialized = true

  document.addEventListener('visibilitychange', () => {
    emitWindowStateChanged().catch(console.warn)
  })
  window.addEventListener('focus', () => {
    emitWindowStateChanged().catch(console.warn)
  })
  window.addEventListener('blur', () => {
    emitWindowStateChanged().catch(console.warn)
  })
  emitWindowStateChanged().catch(console.warn)
  void appWindow.onFocusChanged(() => {
    emitWindowStateChanged().catch(console.warn)
  })
  void appWindow.onResized(() => {
    emitWindowStateChanged().catch(console.warn)
  })
  void appWindow.listen('tauri://blur', () => {
    emitWindowStateChanged().catch(console.warn)
  })
  void appWindow.listen('tauri://focus', () => {
    emitWindowStateChanged().catch(console.warn)
  })
  // 封面代理只在真正需要封面时懒加载，避免启动阶段额外占用一次 Tauri IPC。
  window.setTimeout(() => {
    void ensureCoverProxyBase()
  }, 0)

  // ---- Window Controls ----
  const api: Record<string, any> = {
    minimize: () => { appWindow.minimize().then(emitWindowStateChanged).catch(console.warn) },
    maximize: () => { appWindow.toggleMaximize().then(emitWindowStateChanged).catch(console.warn) },
    close: () => { appWindow.close().catch(console.warn) },
    show: () => { appWindow.show().then(emitWindowStateChanged).catch(console.warn) },
    toggleFullscreen: async (enter?: boolean) => {
      try {
        // 网易云式窗口化全屏（对齐 Electron 参考实现 enterWindowedFullScreen）：
        // macOS 不进原生全屏独立 Space，而是窗口直接占满整块显示器并提高窗口层级，
        // 真正盖住顶部菜单栏/状态栏；退出时 Rust 端快照完整还原窗口。
        const current = await safeInvoke<boolean>('windowed_fullscreen_get', undefined, false)
        const target = typeof enter === 'boolean' ? enter : !current
        if (target !== current) {
          await safeInvoke('windowed_fullscreen_set', { enter: target })
        }
        await emitWindowStateChanged()
      } catch (error) {
        console.warn('[tauri-bridge] 切换全屏失败:', error)
      }
    },
    setMiniMode: (isMini: boolean) => {
      if (isMini) {
        appWindow.hide().then(emitWindowStateChanged).catch(console.warn)
      } else {
        appWindow.show().then(() => appWindow.setFocus()).then(emitWindowStateChanged).catch(console.warn)
      }
    },
    onFullscreenChanged: (cb: (v: boolean) => void) => onTauriEvent<boolean>('app-fullscreen-changed', cb),

    // ---- Window Close Handler (native close button → frontend decision) ----
    windowClose: {
      ackRequest: () => { emit('app-close-request-ack').catch(console.warn) },
      onRequest: (cb: () => void) => onTauriEvent('app-close-requested', cb),
    },

    onMusicCtrl: (cb: (...args: any[]) => void) => onTauriEvent<any>('music-control', cb),

    // ---- Node Sidecar Business Runtime ----
    sidecar: {
      health: () => safeInvoke('node_sidecar_health'),
      request: (method: string, payload?: any) => safeInvoke('node_sidecar_request', {
        method,
        payload: payload ?? null,
      }),
      onEvent: (cb: (payload: { event: string; payload: any }) => void) =>
        onTauriEvent('node-sidecar:event', cb),
      onError: (cb: (payload: { message: string; stack?: string }) => void) =>
        onTauriEvent('node-sidecar:error', cb),
    },

    // ---- Music SDK ----
    music: {
      request: async (apiName: string, args: any) => {
        const source = normalizeSourceKey(args?.source || args?.songInfo?.source || '')
        const preferredPluginId = String(args?.pluginId || '').trim()

        if (apiName === 'getMusicUrl' || apiName === 'getSongUrl' || apiName === 'musicUrl') {
          const result = await requestMusicUrlWithFallback(
            apiName,
            args,
            source,
            preferredPluginId,
          )
          if (!result.data) {
            return { success: false, error: { message: result.error || '插件未返回播放链接' } }
          }
          return {
            success: true,
            data: await wrapPlaybackStreamIfNeeded(result.data, args),
          }
        }

        if (
          (BUILTIN_METADATA_APIS.has(apiName) && isBuiltinMetadataSource(source)) ||
          shouldUseBuiltinCatalog(apiName, source)
        ) {
          try {
            const invokeArgs = source ? { ...args, source } : args
            const data = await invokeNodeMusicSdk(apiName, invokeArgs)
            if (data === undefined) throw new Error(`node sidecar music sdk ${apiName} 无返回`)
            return { success: true, data: normalizePluginMusicResult(apiName, data, source) }
          } catch (e: any) {
            return { success: false, error: { message: String(e?.message || e) } }
          }
        }

        if (!(apiName === 'getMusicUrl' || apiName === 'getSongUrl')) {
          const pluginId = await ensurePluginRuntimeForSource(source, preferredPluginId)
          if (pluginId) {
            try {
              const result = await routeSdkToPlugin(apiName, { ...args, source, pluginId }, pluginId)
              if (result !== undefined) return { success: true, data: normalizePluginMusicResult(apiName, result, source) }
            } catch (e) {
              console.warn(`[tauri-bridge] 插件 ${pluginId} 处理 ${apiName} 失败，回退后端:`, e)
            }
          }
        }

        try {
          const invokeArgs = source ? { ...args, source } : args
          const data = await invokeNodeMusicSdk(apiName, invokeArgs)
          if (data === undefined) throw new Error(`node sidecar music sdk ${apiName} 无返回`)
          return { success: true, data: normalizePluginMusicResult(apiName, data, source) }
        } catch (e: any) {
          return { success: false, error: { message: String(e?.message || e) } }
        }
      },
      requestSdk: async (apiName: string, args: any) => {
        if (apiName === 'downloadSingleSong') {
          return await enqueueSingleDownload(args || {})
        }

        if (apiName === 'downloadBatchSongs') {
          return await enqueueBatchDownloads(args || {})
        }

        const source = normalizeSourceKey(args?.source || args?.songInfo?.source || '')
        const preferredPluginId = String(args?.pluginId || '').trim()

        if (apiName === 'checkDownloadable') {
          const quality = firstText(args?.quality, args?.requestedQuality, '320k')
          const result = await requestMusicUrlWithFallback(
            'getMusicUrl',
            {
              ...args,
              quality,
              isCache: false,
            },
            source,
            preferredPluginId,
          )
          if (!result.data) {
            return {
              ok: false,
              source,
              quality,
              error: result.error || '无法获取该音质下载链接',
            }
          }
          const normalized = normalizePluginMusicUrlResult(result.data)
          const url = extractMusicUrl(normalized)
          if (!isUsableMediaUrl(url)) {
            return {
              ok: false,
              source,
              quality,
              error: result.error || '无法获取该音质下载链接',
            }
          }
          const probe = await probeNodeDownloadUrl(url)
          if (!probe?.ok) {
            return {
              ok: false,
              source,
              quality,
              error: probe?.reason || '下载探测失败',
            }
          }
          return {
            ok: true,
            source,
            quality,
            actualQuality: firstText(normalized?.actualQuality, normalized?.quality, quality),
            url,
            size: probe.size || 0,
            headers: normalized?.headers || {},
            referrer: normalized?.referrer || '',
            userAgent: normalized?.userAgent || '',
          }
        }

        if (apiName === 'getMusicUrl' || apiName === 'getSongUrl' || apiName === 'musicUrl') {
          const result = await requestMusicUrlWithFallback(
            apiName,
            args,
            source,
            preferredPluginId,
          )
          if (result.data) return await wrapPlaybackStreamIfNeeded(result.data, args)
          throw new Error(result.error || '插件未返回播放链接')
        }

        if (
          (BUILTIN_METADATA_APIS.has(apiName) && isBuiltinMetadataSource(source)) ||
          shouldUseBuiltinCatalog(apiName, source)
        ) {
          const invokeArgs = source ? { ...args, source } : args
          const data = await invokeNodeMusicSdk(apiName, invokeArgs)
          if (data === undefined) throw new Error(`node sidecar music sdk ${apiName} 无返回`)
          return normalizePluginMusicResult(apiName, data, source)
        }

        if (!(apiName === 'getMusicUrl' || apiName === 'getSongUrl')) {
          const pluginId = await ensurePluginRuntimeForSource(source, preferredPluginId)
          if (pluginId) {
            try {
              const result = await routeSdkToPlugin(apiName, { ...args, source, pluginId }, pluginId)
              if (result !== undefined) return normalizePluginMusicResult(apiName, result, source)
            } catch (e) {
              console.warn(`[tauri-bridge] 插件 ${pluginId} 处理 ${apiName} 失败，回退后端:`, e)
            }
          }
        }

        const invokeArgs = source ? { ...args, source } : args
        const data = await invokeNodeMusicSdk(apiName, invokeArgs)
        if (data === undefined) throw new Error(`node sidecar music sdk ${apiName} 无返回`)
        return normalizePluginMusicResult(apiName, data, source)
      },
      // 登录 / URL 打开
      openExternal: async (url: string) => openUrl(url),
      getPendingCallbacks: () => safeInvoke('get_pending_oauth_callbacks', undefined, []),
      onCallback: (cb: (url: string) => void) => onTauriEvent('logto-callback', cb),
    },

    // ---- MPV Sidecar Audio ----
    mpv: {
      init: () => invoke('mpv_init'),
      load: (request: {
        url: string
        headers?: Record<string, string>
        referrer?: string
        userAgent?: string
        autoplay?: boolean
        startTimeSeconds?: number
        volume?: number
        playbackRate?: number
      }) => invoke('mpv_load', { request }),
      play: () => invoke('mpv_play'),
      pause: () => invoke('mpv_pause'),
      toggle: () => invoke('mpv_toggle'),
      stop: () => invoke('mpv_stop'),
      seek: (seconds: number) => invoke('mpv_seek', { seconds }),
      setVolume: (volume: number) => invoke('mpv_set_volume', { volume }),
      setPlaybackRate: (playbackRate: number) =>
        invoke('mpv_set_playback_rate', { playbackRate }),
      probe: (request: {
        url: string
        headers?: Record<string, string>
        referrer?: string
        userAgent?: string
        timeoutMs?: number
      }) => invoke('mpv_probe', { request }),
      setAudioFilters: (request: {
        filters?: string[]
        equalizer?: { enabled?: boolean; gains?: number[] }
        bassBoost?: { enabled?: boolean; gain?: number }
        surround?: { enabled?: boolean; mode?: 'off' | 'small' | 'medium' | 'large' }
        balance?: { enabled?: boolean; value?: number }
        loudness?: { enabled?: boolean; target?: 'gentle' | 'standard' | 'strong' }
      }) =>
        invoke('mpv_set_audio_filters', { request }),
      getState: () => invoke('mpv_get_state'),
      reloadAudioOutput: () => invoke('mpv_reload_audio_output'),
      shutdown: () => invoke('mpv_shutdown'),
      onState: (cb: (payload: any) => void) => onTauriEvent('mpv://state', cb),
      onProgress: (cb: (payload: any) => void) => onTauriEvent('mpv://progress', cb),
      onEnded: (cb: (payload: any) => void) => onTauriEvent('mpv://ended', cb),
      onError: (cb: (payload: any) => void) => onTauriEvent('mpv://error', cb),
    },

    // ---- Native Audio ----
    nativeAudio: {
      load: (request: {
        url: string
        headers?: Record<string, string>
        referrer?: string
        userAgent?: string
        songInfo?: any
        autoplay?: boolean
        startTimeSeconds?: number
        volume?: number
      }) => invoke('native_audio_load', { request }),
      play: () => invoke('native_audio_play'),
      pause: () => invoke('native_audio_pause'),
      stop: () => invoke('native_audio_stop'),
      seek: (seconds: number) => invoke('native_audio_seek', { seconds }),
      setVolume: (volume: number) => invoke('native_audio_set_volume', { volume }),
      setPlaybackRate: (playbackRate: number) =>
        invoke('native_audio_set_playback_rate', { playbackRate }),
      setEqualizer: (request: { enabled: boolean; gains: number[] }) =>
        invoke('native_audio_set_equalizer', { request }),
      getEqualizer: () => invoke('native_audio_get_equalizer'),
      getState: () => invoke('native_audio_get_state'),
      getAnalyserUrl: (request: {
        url: string
        headers?: Record<string, string>
        referrer?: string
        userAgent?: string
      }) => invoke('media_stream_proxy_url', { request }),
      onState: (cb: (payload: any) => void) => onTauriEvent('native-audio:state', cb),
      onProgress: (cb: (payload: any) => void) => onTauriEvent('native-audio:progress', cb),
      onEnded: (cb: (payload: any) => void) => onTauriEvent('native-audio:ended', cb),
      onError: (cb: (payload: any) => void) => onTauriEvent('native-audio:error', cb),
      onEqualizer: (cb: (payload: any) => void) => onTauriEvent('native-audio:equalizer', cb),
    },

    // ---- Images ----
    images: {
      toDataUrl: async (url: string) => imageUrlToDataUrl(url),
      proxyUrl: async (url: string) => wrapCoverUrlIfNeeded(url),
      proxyUrlSync: (url: string) => wrapCoverUrlSync(url),
      wrapThumbUrl: async (url: string) => wrapThumbCoverUrlIfNeeded(url),
      wrapThumbUrlSync: (url: string) => wrapThumbCoverUrlSync(url),
      isFeiniuProtected: (url?: string) => isFeiniuApiImageUrl(url),
      wrapPlaybackUrl: async (url: string, songInfo?: any) => {
        const wrapped = await wrapPlaybackStreamIfNeeded(
          typeof url === 'string' ? { url, headers: songInfo?.__nativeMedia?.headers || songInfo?.headers } : url,
          { songInfo, song: songInfo, source: songInfo?.source },
        )
        return extractMusicUrl(wrapped) || (typeof url === 'string' ? url : extractMusicUrl(url))
      },
    },

    // ---- Plugins ----
    plugins: {
      /**
       * 查询某个 source 当前是否有插件接管。
       */
      getPluginForSource: async (source: string, preferredPluginId?: string) => {
        const key = normalizeSourceKey(source)
        const preferred = String(preferredPluginId || '').trim()
        if (!preferred) return null
        const entries = await getNodePluginEntries()
        const entry = findNodePluginEntry(entries, preferred)
        if (entry) {
          const supportedSources = normalizePluginSources(entry)
          if (key && Object.keys(supportedSources).length > 0 && !supportedSources[key]) return null
          registerSidecarPluginSources(preferred, entry)
          return {
            pluginId: preferred,
            pluginInfo: entry.pluginInfo || { name: preferred },
            supportedSources,
          }
        }
        const plugin = pluginSandbox.get(preferred)
        if (!plugin) return null
        const supportedSources = getPluginSupportedSources(plugin)
        const normalizedSources = normalizePluginSources(plugin)
        if (key && Object.keys(normalizedSources).length > 0 && !normalizedSources[key]) return null
        return {
          pluginId: preferred,
          pluginInfo: plugin.pluginInfo,
          supportedSources,
        }
      },

      /**
       * 选择并添加插件 — 通过文件对话框选择 .js 插件文件，安装到 sidecar。
       */
      selectAndAddPlugin: async (_type?: 'lx' | 'cr') => {
        try {
          const files = await openFileDialog({
            title: '请选择插件 js 文件（格式自动识别）',
            filters: [
              { name: 'JavaScript 文件', extensions: ['js'] },
              { name: '所有文件', extensions: ['*'] },
            ],
          })
          if (!files || files.length === 0) return { canceled: true }

          const filePath = files[0]
          const content = await withTimeout(
            invoke<string>('plugin_read_file', { path: filePath }),
            15000,
            '读取插件文件超时',
          )
          const detection = detectImportPluginCompatibility(content)
          if (!detection.compatible) {
            throw new Error(`插件不兼容：${detection.formatName}（${detection.reason}）`)
          }
          const effectiveType = detection.type
          const fileName = filePath.split(/[/\\]/).pop()?.replace(/\.js$/i, '') || 'unknown'
          const nodeResult = await withTimeout(
            invokeNodePlugin('installFromCode', {
              pluginCode: preparePluginCode(content, effectiveType, fileName),
              pluginName: fileName,
              type: effectiveType,
            }),
            15000,
            '插件安装超时，请检查插件文件是否包含阻塞逻辑',
          )
          if (nodeResult) {
            await rememberInstalledPlugin(nodeResult)
            return normalizeNodePluginInstallResult(nodeResult)
          }

          const installed = await withTimeout(
            installPluginFromCode(content, undefined, fileName, effectiveType),
            15000,
            '插件安装超时，请检查插件文件是否包含阻塞逻辑',
          )
          return { success: true, ...toElectronPluginResult(installed), data: toElectronPluginResult(installed) }
        } catch (e: any) {
          return normalizePluginInstallFailure(e)
        }
      },

      /**
       * 从 URL 下载并添加插件
       */
      downloadAndAddPlugin: async (
        url: string,
        _type?: 'lx' | 'cr',
        targetPluginId?: string,
      ) => {
        try {
          if (!isValidHttpUrl(url)) {
            throw new Error('插件下载地址不是有效的 HTTP/HTTPS 链接')
          }
          const result: any = await withTimeout(
            invoke('plugin_http_request', {
              url,
              options: {
                method: 'GET',
                timeout: 30,
                headers: { 'User-Agent': 'ShuxiaMusic/1.0' },
              },
            }),
            35000,
            '在线插件下载超时',
          )
          if (!result || Number(result.status) !== 200) {
            throw new Error(`下载失败: HTTP ${result?.status || 'unknown'}`)
          }
          const code = typeof result.body === 'string' ? result.body : JSON.stringify(result.body)
          if (!code || !code.trim()) {
            throw new Error('下载的文件内容为空')
          }
          const contentType = String(
            result.headers?.['content-type'] || result.headers?.['Content-Type'] || '',
          ).toLowerCase()
          if (contentType.includes('text/html') || looksLikeHtmlDocument(code)) {
            throw new Error('更新地址指向网页而不是插件脚本，请在浏览器中下载安装')
          }
          const detection = detectImportPluginCompatibility(code)
          if (!detection.compatible) {
            throw new Error(`插件不兼容：${detection.formatName}（${detection.reason}）`)
          }
          const effectiveType = detection.type
          const urlName = url.split('/').pop()?.split('?')[0]?.replace(/\.js$/i, '') || undefined
          const nodeResult = await withTimeout(
            invokeNodePlugin('installFromCode', {
              pluginCode: preparePluginCode(code, effectiveType, urlName),
              pluginName: urlName,
              targetPluginId,
              type: effectiveType,
            }),
            15000,
            '插件安装超时，请检查插件文件是否包含阻塞逻辑',
          )
          if (nodeResult) {
            await rememberInstalledPlugin(nodeResult)
            return normalizeNodePluginInstallResult(nodeResult)
          }
          const installed = await withTimeout(
            installPluginFromCode(code, targetPluginId, urlName, effectiveType),
            15000,
            '插件安装超时，请检查插件文件是否包含阻塞逻辑',
          )
          return {
            success: true,
            ...toElectronPluginResult(installed),
            data: toElectronPluginResult(installed),
          }
        } catch (e: any) {
          return normalizePluginInstallFailure(e)
        }
      },

      /**
       * 直接添加插件代码
       */
      addPlugin: async (
        pluginCode: string,
        pluginName: string,
        targetPluginId?: string,
      ) => {
        try {
          const nodeResult = await invokeNodePlugin('addPlugin', {
            pluginCode: preparePluginCode(pluginCode),
            pluginName,
            targetPluginId,
          })
          if (nodeResult) {
            await rememberInstalledPlugin(nodeResult)
            return normalizeNodePluginInstallResult(nodeResult)
          }

          const installed = await installPluginFromCode(pluginCode, targetPluginId, pluginName)
          return { success: true, ...toElectronPluginResult(installed), data: toElectronPluginResult(installed) }
        } catch (e: any) {
          return normalizePluginInstallFailure(e)
        }
      },

      /**
       * 根据 ID 获取插件信息
       */
      getPluginById: (id: string) => {
        return (async () => {
          const pluginId = String(id || '').trim()
          if (!pluginId) return null
          const entries = await getNodePluginEntries()
          const entry = findNodePluginEntry(entries, pluginId)
          if (entry) {
            return {
              id: pluginId,
              name: entry.pluginInfo?.name || entry.pluginName || entry.name || pluginId,
              plugin_type: entry.pluginType || 'unknown',
              version: entry.pluginInfo?.version || '',
              author: entry.pluginInfo?.author || '',
              description: entry.pluginInfo?.description || '',
              enabled: isSidecarPluginEnabled(entry),
              installed_at: entry.installedAt || entry.installed_at || new Date().toISOString(),
            }
          }
          const plugin = pluginSandbox.get(pluginId)
          if (!plugin) return null
          return {
            id: pluginId,
            name: plugin.pluginInfo?.name || pluginId,
            plugin_type: plugin.pluginType || 'unknown',
            version: plugin.pluginInfo?.version || '',
            author: plugin.pluginInfo?.author || '',
            description: plugin.pluginInfo?.description || '',
            enabled: true,
            installed_at: new Date().toISOString(),
          }
        })()
      },

      /**
       * 只加载插件注册表。worker 按源按需启动，空闲后卸载。
       * 欢迎页仍等待同一个初始化 Promise。
       */
      initializeSystem: async () => {
        await ensurePluginSystemReady()
        return true
      },

      getPluginCode: async (pluginId: string) => {
        const nodeResult = await invokeNodePlugin('getPluginCode', { pluginId })
        if (nodeResult && typeof nodeResult === 'object' && 'code' in nodeResult) {
          return nodeResult
        }
        if (typeof nodeResult === 'string' && nodeResult) {
          return { code: nodeResult }
        }
        try {
          const appDataDir = await invoke<string>('plugin_get_app_data_dir')
          const code = await invoke<string>('plugin_read_file', {
            path: `${appDataDir}/plugins/${pluginId}.js`,
          })
          return { code }
        } catch (error: any) {
          return { error: String(error?.message || error || '无法读取插件源码') }
        }
      },

      getServiceRole: async (pluginId: string) => {
        const nodeResult = await invokeNodePlugin('getServiceRole', { pluginId })
        if (nodeResult !== undefined && nodeResult !== null) {
          return { data: typeof nodeResult === 'object' && 'data' in nodeResult ? nodeResult.data : nodeResult }
        }
        const plugin = pluginSandbox.get(pluginId)
        return {
          data:
            (plugin?.pluginInfo as any)?.serviceRole ||
            plugin?.serviceRole ||
            plugin?.exports?.serviceRole ||
            undefined,
        }
      },

      reloadAllPlugins: async () => {
        invalidateNodePluginEntriesCache()
        await invokeNodePlugin('reloadAll')
        return await api.plugins.loadAllPlugins()
      },

      reorderPlugins: async (orderedIds: string[]) => {
        const ids = [...new Set((orderedIds || []).map(String).filter(Boolean))]
        const nodeResult = await invokeNodePlugin('reorder', { orderedIds: ids })
        await safeInvoke('plugin_reorder_registry', { orderedIds: ids })
        invalidateNodePluginEntriesCache()
        return nodeResult || { success: true, orderedIds: ids }
      },

      pinPlugin: async (pluginId: string) => {
        const id = String(pluginId || '').trim()
        if (!id) return false
        return await invokeNodePlugin('pin', { pluginId: id })
      },

      unpinPlugin: async (pluginId: string) => {
        const id = String(pluginId || '').trim()
        if (!id) return false
        return await invokeNodePlugin('unpin', { pluginId: id })
      },

      onPlaylistsSynced: (callback: (summary: any) => void) =>
        onTauriEvent('playlists-synced', callback),

      /**
       * 加载所有插件 — 从 sidecar 读取注册信息和音源映射，不再把 JS 灌进 WebView。
       */
      loadAllPlugins: async () => {
        try {
          const nodePlugins = await invokeNodePlugin('loadAll') as any[] | undefined
          if (Array.isArray(nodePlugins)) {
            nodePluginEntriesCache = { at: Date.now(), entries: Promise.resolve(nodePlugins) }
            const list = nodePlugins.map((plugin: any) => toSettingsPluginListItem(plugin))
            hydrateMissingPluginRuntimes(list)
            return list
          }

          const registry: any[] = await safeInvoke('plugin_load_registry', undefined, [])
          // 串行 await 每个插件配置会让插件面板在启动期（sidecar 还没就绪、
          // 走兜底路径时）连发上百个 IPC 并长时间转圈。这里并行取，并且已经有
          // 缓存的插件不再重复请求。
          await Promise.all(registry.map(async (entry) => {
            if (!entry?.id || pluginConfigStore[entry.id]) return
            const config = await safeInvoke<string>('plugin_load_config', { pluginId: entry.id }, '{}')
            try {
              pluginConfigStore[entry.id] = JSON.parse(config)
            } catch {
              pluginConfigStore[entry.id] = {}
            }
          }))

          const seen = new Set<string>()
          const result: any[] = []
          for (const entry of registry) {
            seen.add(entry.id)
            result.push(toSettingsPluginListItem({
              ...entry,
              pluginId: entry.id,
              pluginName: entry.name,
              pluginInfo: {
                name: entry.name,
                version: entry.version,
                author: entry.author,
                description: entry.description,
              },
              pluginType: entry.plugin_type,
              serviceRole: entry.serviceRole || entry.service_role,
              configSchema: entry.configSchema,
              supportedSources: entry.supportedSources,
              disabled: entry.enabled === false,
            }))
          }

          for (const { id, exports } of pluginSandbox.list()) {
            if (seen.has(id)) continue
            result.push(toSettingsPluginListItem({
              pluginId: id,
              pluginName: exports.pluginInfo?.name || id,
              pluginInfo: exports.pluginInfo,
              pluginType: exports.pluginType || 'unknown',
              serviceRole: exports.serviceRole,
              configSchema: exports.configSchema,
              supportedSources: getPluginSupportedSources(exports),
              disabled: false,
            }))
          }

          hydrateMissingPluginRuntimes(result)
          return result
        } catch (e: any) {
          console.warn('[tauri-bridge] 加载插件失败:', e)
          return []
        }
      },

      uninstallPlugin: async (pluginId: string) => {
        unloadPluginRuntime(pluginId)
        invalidateNodePluginEntriesCache()
        const nodeResult = await invokeNodePlugin('uninstall', { pluginId })
        if (nodeResult) return nodeResult
        await safeInvoke('plugin_remove_registry', { id: pluginId })
        await removePersistedPluginFile(pluginId)
        return { success: true, message: '已卸载' }
      },

      /**
       * 获取插件日志
       */
      getPluginLog: async (pluginId: string) => {
        const nodeResult = await invokeNodePlugin('getLog', { pluginId })
        if (Array.isArray(nodeResult)) return nodeResult
        return []
      },

      /**
       * 写入插件日志
       */
      appendPluginLog: async (pluginId: string, level: string, source: string, message: string) => {
        await invokeNodePlugin('appendLog', { pluginId, level, source, message })
      },

      /**
       * 获取插件类型
       */
      getPluginType: async (pluginId: string) => {
        const nodeResult = await invokeNodePlugin('getPluginType', { pluginId })
        if (nodeResult) return { data: nodeResult }
        const plugin = pluginSandbox.get(pluginId)
        return { data: plugin?.pluginType || 'unknown' }
      },

      /**
       * 获取插件的配置 schema
       */
      getConfigSchema: async (pluginId: string) => {
        const nodeResult = await invokeNodePlugin('getConfigSchema', { pluginId })
        const nodeSchema = normalizePluginConfigSchema(nodeResult)
        if (Array.isArray(nodeSchema) ? nodeSchema.length > 0 : Object.keys(nodeSchema).length > 0) {
          return { data: nodeSchema }
        }
        const plugin = pluginSandbox.get(pluginId)
        return { data: normalizePluginConfigSchema(plugin?.configSchema) }
      },

      /**
       * 获取插件配置
       */
      getConfig: async (pluginId: string) => {
        const nodeResult = await invokeNodePlugin('getConfig', { pluginId })
        if (nodeResult && typeof nodeResult === 'object') {
          pluginConfigStore[pluginId] = nodeResult as Record<string, any>
          return { data: nodeResult }
        }
        const config = await getPluginConfigValue(pluginId)
        return { data: config }
      },

      /**
       * 保存插件配置
       */
      saveConfig: async (pluginId: string, config: Record<string, any>) => {
        await persistPluginConfigValue(pluginId, config || {})
        return { success: true }
      },

      /**
       * 测试连接
       */
      testConnection: async (pluginId: string) => {
        try {
          const result = await refreshFeiniuSession(pluginId)
          return await autoImportFeiniuAfterLogin(pluginId, result || { success: true })
        } catch (e: any) {
          return normalizePluginInstallFailure(e)
        }
      },

      /**
       * 获取插件歌单列表
       */
      getPlaylists: async (pluginId: string) => {
        try {
          const config = await getPluginConfigValue(pluginId)
          const result = await callPluginMethodNodeFirst(pluginId, 'getPlaylists', config)
          return { data: normalizePluginMethodResult(result) }
        } catch (e: any) {
          console.warn(`[tauri-bridge] 插件 ${pluginId} getPlaylists 失败:`, e)
          return { error: String(e?.message || e), data: [] }
        }
      },

      /**
       * 获取插件歌单中的歌曲
       */
      getPlaylistSongs: async (pluginId: string, playlistId: string) => {
        try {
          const config = await getPluginConfigValue(pluginId)
          const result = await callPluginMethodNodeFirst(pluginId, 'getPlaylistSongs', config, playlistId)
          return { data: result || { songs: [], total: 0 } }
        } catch (e: any) {
          console.warn(`[tauri-bridge] 插件 ${pluginId} getPlaylistSongs 失败:`, e)
          return { error: String(e?.message || e), data: { songs: [], total: 0 } }
        }
      },

      /**
       * 将插件歌单导入到本地
       */
      importToLocal: async (
        pluginId: string,
        playlistId: string,
        playlistName?: string,
      ) => {
        try {
          const imported = await importConfiguredServicePlaylist(pluginId, playlistId, playlistName)
          if (imported?.error) return imported
          return imported
        } catch (e: any) {
          return normalizePluginInstallFailure(e)
        }
      },

      /**
       * 获取插件提供的歌词
       */
      getServiceLyric: async (pluginId: string, songInfo: any) => {
        try {
          const config = await getPluginConfigValue(pluginId)
          const result = await callPluginMethodNodeFirst(pluginId, 'getLyric', config, songInfo)
          return { data: result || { lyric: '' } }
        } catch (e: any) {
          console.warn(`[tauri-bridge] 插件 ${pluginId} getLyric 失败:`, e)
          return { data: { lyric: '' } }
        }
      },

      syncFeiniuOnStartup: async () => {
        try {
          return await syncConfiguredFeiniuOnStartup()
        } catch (error: any) {
          console.warn('[tauri-bridge] 飞牛启动同步失败:', error)
          return { errors: [error?.message || '飞牛启动同步失败'] }
        }
      },

      onDeepLinkAdd: (cb: (payload: { url: string; type: 'lx' | 'cr'; targetPluginId?: string }) => void) =>
        onTauriEvent('plugin-add-link', (raw: any) => {
          const payload = parsePluginAddLinkPayload(raw)
          if (payload) cb(payload)
        }),
    },

    // ---- AI ----
    ai: {
      /** Read AI config from Pinia-persisted localStorage */
      _readConfig: (): Record<string, any> => {
        try {
          const raw = localStorage.getItem('localUserDetail')
          if (raw) {
            const parsed = JSON.parse(raw)
            const aiConfig = parsed?.aiConfig || parsed?.userInfo?.aiConfig
            if (aiConfig?.apiKey) {
              return {
                apiKey: aiConfig.apiKey,
                baseURL: aiConfig.baseURL || '',
                model: aiConfig.model || '',
                provider: aiConfig.provider || 'deepseek',
              }
            }
          }
        } catch {}
        return {}
      },

      ask: (prompt: string, config?: Record<string, any>) =>
        safeInvoke('ai_ask', {
          prompt,
          config: config || api.ai._readConfig(),
        }),

      askStream: (prompt: string, streamId: string, config?: Record<string, any>) =>
        safeInvoke('ai_ask_stream', {
          prompt,
          streamId,
          config: config || api.ai._readConfig(),
        }),

      recommendSongs: (songName: string, artist: string, context?: any, config?: Record<string, any>) =>
        safeInvoke('ai_recommend_songs', {
          songName,
          artist,
          context,
          config: config || api.ai._readConfig(),
        }),
      onStreamChunk: (cb: (data: any) => void) => onAiStreamEvent('ai-stream-chunk', cb),
      onStreamEnd: (cb: (data: any) => void) => onAiStreamEvent('ai-stream-end', cb),
      onStreamError: (cb: (data: any) => void) => onAiStreamEvent('ai-stream-error', cb),
      removeStreamListeners: () => {
        clearAiStreamListeners()
      },
    },

    // ---- App Flags (key-value storage, persisted to DB) ----
    appFlagSet: (key: string, value: string) =>
      safeInvoke('app_flag_set', { key, value }),
    appFlagGet: (key: string) =>
      safeInvoke<string | null>('app_flag_get', { key }),

    // ---- Settings Sync ----
    settings: {
      syncCloseToTray: (value: boolean) => {
        invokeNodeWindowLifecycle('setCloseToTray', { value }).catch(() => undefined)
        emit('settings:sync-close-to-tray', { value }).catch(console.warn)
      },
      getCloseToTray: async () => {
        const nodeState = await invokeNodeWindowLifecycle('getState') as any
        if (typeof nodeState?.data?.closeToTray === 'boolean') return nodeState.data.closeToTray
        return safeInvoke('settings_get_close_to_tray', undefined, true)
      },
      getNativeImpactSettings: () =>
        safeInvoke('settings_get_native_impact_settings', undefined, {
          closeToTray: true,
          macStatusBarLyricEnabled: false,
          directories: { cacheDir: '', downloadDir: '' },
          download: { maxConcurrent: 3 },
        }),
      setNativeImpactSettings: (settings: Record<string, any>) =>
        safeInvoke('settings_set_native_impact_settings', { settings }),
    },

    // ---- Music Cache ----
    musicCache: {
      getInfo: async () => {
        const [rustInfo, nodeInfo] = await Promise.all([
          safeInvoke('music_cache_get_info', undefined, {}),
          invokeNodeMusicCache('getInfo'),
        ])
        const normalizedRustInfo = normalizeMusicCacheInfo(rustInfo)
        const normalizedNodeInfo = normalizeMusicCacheInfo(nodeInfo || {})
        return normalizedNodeInfo.size > 0 || normalizedNodeInfo.count > 0 ? normalizedNodeInfo : normalizedRustInfo
      },
      clear: async () => {
        const [nodeResult] = await Promise.all([
          invokeNodeMusicCache('clear'),
          safeInvoke('music_cache_clear'),
        ])
        return nodeResult || { success: true, message: '缓存清除成功' }
      },
      getSize: async () => {
        const [rustSize, nodeSize] = await Promise.all([
          safeInvoke('music_cache_get_size', undefined, 0),
          invokeNodeMusicCache('getSize'),
        ])
        return Number(nodeSize || 0) > 0 ? nodeSize : rustSize
      },
      getLimit: async () => {
        return safeInvoke('music_cache_get_limit', undefined, { bytes: 5 * 1024 * 1024 * 1024, formatted: '5 GB' })
      },
      setLimit: async (bytes: number) => {
        const rustResult = await safeInvoke('music_cache_set_limit', { bytes })
        // 同步给 sidecar，让它按新上限执行 LRU 淘汰
        try {
          await invokeNodeMusicCache('setLimit', { bytes })
        } catch (error) {
          console.warn('[musicCache] 同步缓存上限到 sidecar 失败:', error)
        }
        return rustResult
      },
      touch: async (filePath: string) => {
        try {
          await invokeNodeMusicCache('touch', { path: filePath })
        } catch { /* touch 失败不影响播放 */ }
      },
      // 在线播放音频文件缓存：命中返回 file:// 本地文件（第二次听直接播本地）
      playbackGet: async (key: string) => {
        try {
          const res = await invokeNodeMusicCache('playback.get', { key })
          return res || { hit: false }
        } catch {
          return { hit: false }
        }
      },
      // 未命中时后台把在线歌曲音频落盘到缓存目录（fire-and-forget，调用方不 await 结果）
      playbackCache: async (payload: {
        key: string
        url: string
        headers?: Record<string, string>
        referrer?: string
        userAgent?: string
        name?: string
        artist?: string
        quality?: string
      }) => {
        try {
          await invokeNodeMusicCache('playback.cache', payload)
        } catch { /* 落盘失败不影响播放 */ }
      },
    },

    // ---- Cover Cache (封面缓存) ----
    // 封面代理(cover_proxy)的磁盘缓存，独立于"歌曲缓存"：走自己的 200MB 上限 + 30 天淘汰。
    // 纳入"存储管理"以便查看占用、手动清除。
    coverCache: {
      getInfo: async () =>
        safeInvoke('cover_cache_info', undefined, { size: 0, count: 0, maxBytes: 0 }),
      clear: async () => safeInvoke('cover_cache_clear', undefined, { success: false }),
    },

    // ---- URL Cache ----
    musicUrlCache: {
      get: async (key: string) => {
        const nodeResult = await invokeNodeMusicUrlCache('get', { key })
        if (nodeResult) return nodeResult
        return safeInvoke('music_url_cache_get', { key })
      },
      set: async (key: string, url: string) => {
        await invokeNodeMusicUrlCache('save', { key, url })
        return safeInvoke('music_url_cache_save', { key, url })
      },
      invalidate: async (songId: string) => {
        await invokeNodeMusicUrlCache('invalidate', { songId })
        return safeInvoke('music_url_cache_invalidate', { songId })
      },
      clear: async () => {
        await invokeNodeMusicUrlCache('clear')
        return safeInvoke('music_url_cache_clear')
      },
    },

    // ---- File ----
    file: {
      readFile: (path: string) => safeInvoke('fs_read_file', { path }),
    },

    // ---- Download ----
    download: {
      getTasks: async () => {
        const nodeTasks = await invokeNodeDownload('getTasks')
        return normalizeDownloadTaskList(nodeTasks || [])
      },
      pauseTask: async (taskId: string) => {
        return invokeNodeDownload('pauseTask', { taskId })
      },
      resumeTask: async (taskId: string) => {
        return invokeNodeDownload('resumeTask', { taskId })
      },
      cancelTask: async (taskId: string) => {
        return invokeNodeDownload('cancelTask', { taskId })
      },
      deleteTask: async (taskId: string, deleteFile = false) => {
        return invokeNodeDownload('deleteTask', { taskId, deleteFile })
      },
      pauseAllTasks: async () => {
        return invokeNodeDownload('pauseAllTasks')
      },
      resumeAllTasks: async () => {
        return invokeNodeDownload('resumeAllTasks')
      },
      retryTask: async (taskId: string) => {
        return invokeNodeDownload('retryTask', { taskId })
      },
      setMaxConcurrent: async (max: number) => {
        return invokeNodeDownload('setMaxConcurrent', { max })
      },
      setDownloadDir: async (dir: string) => {
        return invokeNodeDownload('setDownloadDir', { dir })
      },
      setCacheDir: async (dir: string) => {
        return invokeNodeDownload('setCacheDir', { dir })
      },
      getMaxConcurrent: async () => {
        const nodeResult = await invokeNodeDownload('getMaxConcurrent')
        if (typeof nodeResult === 'number') return nodeResult
        return 3
      },
      clearTasks: async (type: string) => {
        return invokeNodeDownload('clearTasks', { type })
      },
      validateFiles: async () => {
        const nodeTasks = await invokeNodeDownload('validateFiles')
        return normalizeDownloadTaskList(nodeTasks || [])
      },
      // 用 strict 变体：失败时不再静默返回 undefined（那样点图标会毫无反馈），
      // 而是回一个 {success:false,message} 让 UI 弹提示。
      openFileLocation: async (filePath: string) => {
        try {
          return await invokeNodeDownloadStrict('openFileLocation', { filePath })
        } catch (error: any) {
          return {
            success: false,
            message: String(error?.message || error || '打开文件位置失败')
          }
        }
      },
      // 下载完成后按"下载标签写入设置"真正写入封面/歌词/基础信息。
      // Node 下载引擎只落盘音频字节，标签写入统一走 Rust 侧 exiftool。
      finalizeMetadata: async (payload: any) =>
        safeInvoke('download_finalize_metadata', { args: payload }, null),

      onTaskAdded: (cb: (event: null, task: any) => void) => onElectronEvent('download:task-added', (event, task) => cb(event, normalizeDownloadTaskEvent(task))),
      onTaskProgress: (cb: (event: null, task: any) => void) => onElectronEvent('download:task-progress', (event, task) => cb(event, normalizeDownloadTaskEvent(task))),
      onTaskStatusChanged: (cb: (event: null, task: any) => void) => onElectronEvent('download:task-status-changed', (event, task) => cb(event, normalizeDownloadTaskEvent(task))),
      onTaskCompleted: (cb: (event: null, task: any) => void) => onElectronEvent('download:task-completed', (event, task) => cb(event, normalizeDownloadTaskEvent(task))),
      onTaskError: (cb: (event: null, task: any) => void) => onElectronEvent('download:task-error', (event, task) => cb(event, normalizeDownloadTaskEvent(task))),
      onTaskDeleted: (cb: (event: null, taskId: string) => void) => onElectronEvent('download:task-deleted', (event, taskId) => cb(event, String(taskId || ''))),
      onTasksReset: (cb: (event: null, tasks: any[]) => void) => onElectronEvent('download:tasks-reset', (event, tasks) => cb(event, normalizeDownloadTaskList(tasks))),
    },

    // ---- DLNA ----
    dlna: {
      startSearch: () => safeInvoke('dlna_start_search'),
      stopSearch: () => safeInvoke('dlna_stop_search'),
      getDevices: () => safeInvoke('dlna_get_devices', undefined, []),
      play: (url: string, location: string, title?: string) =>
        safeInvoke('dlna_play', { url, location, title }),
      pause: () => safeInvoke('dlna_pause'),
      resume: () => safeInvoke('dlna_resume'),
      stop: () => safeInvoke('dlna_stop'),
      seek: (seconds: number) => safeInvoke('dlna_seek', { seconds }),
      getPosition: () => safeInvoke('dlna_get_position', undefined, 0),
      getVolume: () => safeInvoke('dlna_get_volume', undefined, 100),
      setVolume: (volume: number) => safeInvoke('dlna_set_volume', { volume }),
      onSearchComplete: (cb: () => void) => onTauriEvent('dlna:search-complete', cb),
    },

    // ---- Song List ----
    songList: {
      create: async (name: string, description?: string, source?: string, meta?: any) => {
        const id = createLocalId('playlist')
        const result = await invokeIpc(
          'songlist_create_with_id',
          { hashId: id, name, description, source, meta },
          () => ({ id }),
          '创建歌单失败',
        )
        return result
      },
      getAll: () => invokeIpc('songlist_get_all', undefined, normalizeSongListRecords, '获取歌单列表失败'),
      getById: (hashId: string) =>
        invokeIpc('songlist_get_by_id', { hashId }, (value) => value ? normalizeSongListRecord(value) : null, '获取歌单信息失败'),
      delete: (hashId: string) => invokeIpc('songlist_delete', { hashId }, () => undefined, '删除歌单失败'),
      batchDelete: async (hashIds: string[]) => {
        const result = await invokeIpc('songlist_batch_delete', { hashIds }, () => ({
          success: true,
          succeeded: hashIds.length,
          failed: 0,
        }), '批量删除歌单失败')
        return result
      },
      edit: (hashId: string, updates: any) =>
        invokeIpc('songlist_edit', { hashId, updates }, () => undefined, '编辑歌单失败'),
      updateCover: (hashId: string, coverImgUrl: string) =>
        invokeIpc('songlist_update_cover', { hashId, coverImgUrl }, () => undefined, '更新封面失败'),
      search: (keyword: string, source?: string) =>
        invokeIpc('songlist_search', { keyword, source }, normalizeSongListRecords, '搜索歌单失败'),
      getStatistics: () => invokeIpc('songlist_get_statistics', undefined, (value) => value, '获取统计信息失败'),
      exists: (hashId: string) => invokeIpc('songlist_exists', { hashId }, Boolean, '检查歌单存在性失败'),
      addSongs: async (hashId: string, songs: any[]) => {
        const inputCount = Array.isArray(songs) ? songs.length : 0
        const safeSongs = Array.isArray(songs) ? toStoredSongs(songs) : []
        return invokeIpc(
          'songlist_add_songs',
          { hashId, songs: safeSongs },
          (value) => normalizeAddedSongsResult(value, inputCount),
          '添加歌曲失败',
        )
      },
      removeSong: (hashId: string, songmid: string | number, source?: string) =>
        invokeIpc('songlist_remove_song', { hashId, songmid: String(songmid), source }, Boolean, '移除歌曲失败'),
      removeSongs: async (hashId: string, songmids: (string | number)[]) => {
        const ids = toSongmidList(songmids)
        return invokeIpc(
          'songlist_remove_songs',
          { hashId, songmids: ids },
          (value) => {
            const count = Number(value ?? 0)
            const removedCount = Number.isFinite(count) ? Math.max(0, count) : 0
            return {
              succeeded: ids.slice(0, removedCount),
              failed: ids.slice(removedCount).map((id) => ({ id, reason: '未找到歌曲' })),
            }
          },
          '批量移除歌曲失败',
        )
      },
      clearSongs: (hashId: string) => invokeIpc('songlist_clear_songs', { hashId }, () => undefined, '清空歌单失败'),
      getSongs: (hashId: string) => invokeIpc('songlist_get_songs', { hashId }, (value) => Array.isArray(value) ? value : [], '获取歌曲列表失败'),
      getSongCount: (hashId: string) => invokeIpc('songlist_get_song_count', { hashId }, Number, '获取歌曲数量失败'),
      hasSong: (hashId: string, songmid: string | number, source?: string) =>
        invokeIpc('songlist_has_song', { hashId, songmid: String(songmid), source }, Boolean, '检查歌曲存在性失败'),
      getSong: (hashId: string, songmid: string | number) =>
        invokeIpc('songlist_get_song', { hashId, songmid: String(songmid) }, (value) => value || null, '获取歌曲信息失败'),
      searchSongs: (hashId: string, keyword: string) =>
        invokeIpc('songlist_search_songs', { hashId, keyword }, (value) => Array.isArray(value) ? value : [], '搜索歌曲失败'),
      getSongStatistics: (hashId: string) =>
        invokeIpc('songlist_get_song_statistics', { hashId }, (value) => value, '获取歌曲统计信息失败'),
      validateIntegrity: (hashId: string) =>
        invokeIpc('songlist_validate_integrity', { hashId }, (value) => ({
          ...value,
          valid: value?.valid !== false,
          isValid: value?.isValid ?? value?.valid !== false,
          issues: Array.isArray(value?.issues) ? value.issues : [],
          missingSongs: Array.isArray(value?.missingSongs) ? value.missingSongs : [],
        }), '验证数据完整性失败'),
      repairData: (hashId: string) =>
        invokeIpc('songlist_repair_data', { hashId }, (value) => ({
          ...value,
          repaired: !!value?.repaired,
          repairs: Array.isArray(value?.repairs) ? value.repairs : [],
          failed: Array.isArray(value?.failed) ? value.failed : [],
        }), '修复数据失败'),
      forceSave: (hashId: string) => invokeIpc('songlist_force_save', { hashId }, () => undefined, '强制保存失败'),
      reorderSongs: (hashId: string, songmids: (string | number)[]) => {
        const ids = toSongmidList(songmids)
        return invokeIpc('songlist_reorder_songs', { hashId, songmids: ids }, (value) => ({ updated: Number(value || 0) }), '重排歌单失败')
      },
      reorderPlaylists: (orderedIds: string[]) =>
        invokeIpc('songlist_reorder_playlists', { orderedIds }, (value) => ({ updated: Number(value || 0) }), '重排歌单失败'),
      moveSong: (hashId: string, songmid: string | number, toIndex: number) =>
        invokeIpc('songlist_move_song', { hashId, songmid: String(songmid), toIndex }, Boolean, '移动歌曲失败'),
      getFavoritesId: () => invokeIpc('songlist_get_favorites_id', undefined, (value) => value || null, '获取“我的喜欢”失败'),
      setFavoritesId: (id: string) => invokeIpc('songlist_set_favorites_id', { id }, () => undefined, '保存“我的喜欢”失败'),
    },

    getUserConfig: () => safeInvoke('get_user_config'),

    // ---- Hotkeys ----
    hotkeys: {
      get: async () => {
        const backendEntries = await safeInvoke<any[]>('hotkeys_get', undefined, [])
        const nodeResult = await invokeNodeSystem('hotkeys.get', { backendEntries }) as any
        if (nodeResult?.success && nodeResult.data) {
          writeHotkeyConfigCache(nodeResult.data)
          return nodeResult
        }
        const cached = readHotkeyConfigCache()
        const config = cached || hotkeyEntriesToConfig(Array.isArray(backendEntries) ? backendEntries : [])
        if (!cached) writeHotkeyConfigCache(config)
        return {
          success: true,
          data: config,
          status: { failedActions: [], actionErrors: {} },
        }
      },
      set: async (payload: any) => {
        const fallbackConfig: HotkeyConfigShape = {
          enabled: payload?.enabled !== false,
          bindings: { ...DEFAULT_HOTKEY_BINDINGS, ...(payload?.bindings || {}) },
        }
        const nodeResult = await invokeNodeSystem('hotkeys.set', fallbackConfig) as any
        if (nodeResult?.success) {
          writeHotkeyConfigCache(nodeResult.data)
          const nativeResult = await safeInvoke<any>('hotkeys_set', { payload: nodeResult.entries || hotkeyConfigToEntries(nodeResult.data) }, {})
          return {
            ...nodeResult,
            status: nativeResult?.status || nodeResult.status || { failedActions: [], actionErrors: {} },
          }
        }
        if (nodeResult?.success === false) {
          return nodeResult
        }
        writeHotkeyConfigCache(fallbackConfig)
        const nativeResult = await safeInvoke<any>('hotkeys_set', { payload: hotkeyConfigToEntries(fallbackConfig) }, {})
        return {
          success: true,
          data: fallbackConfig,
          status: nativeResult?.status || { failedActions: [], actionErrors: {} },
        }
      },
    },

    // ---- Auto Updater (state in Node sidecar, install delegated to Tauri updater shell) ----
    autoUpdater: {
      async getState() {
        const nodeResult = await invokeNodeAutoUpdate('getState') as any
        return nodeResult?.data || nodeResult || null
      },
      async checkForUpdates() {
        await recordAutoUpdateState('recordChecking')
        const result = await checkUpdate()
        lastCheckResult = result ?? null

        // 必须在写 recordCheckResult 之前读旧状态：recordCheckResult 会把 status
        // 改成 update-available，从而把 pending 覆盖掉，守卫就永远失效、
        // 每次后台检查（6 小时一轮）都重新下载整包。
        const prev = await invokeNodeAutoUpdate('getState') as any
        const prevVersion = String(prev?.data?.updateInfo?.name || '')
        const remoteVersion = String(result?.manifest?.version || '')
        const alreadyPending =
          prev?.data?.status === 'pending' && !!prevVersion && prevVersion === remoteVersion

        if (alreadyPending) {
          // 同一版本已下载待安装：保持 pending，不重复下载
          await recordAutoUpdateState('recordPending')
          return result
        }

        await recordAutoUpdateState('recordCheckResult', {
          shouldUpdate: Boolean(result?.shouldUpdate),
          manifest: result?.manifest ? normalizeUpdateManifest(result.manifest) : null,
        })
        // 只负责“检查 + 记录”，不下载、不重启：
        //   下载由前端对话框在“发现新版本”后触发（带进度条），
        //   安装（重启）由用户点“重启安装”触发，避免自动覆盖应用。
        return result
      },
      async downloadUpdate(mode?: 'differential' | 'full') {
        // 复用最近一次检查的 rid，不再重复 checkUpdate（避免二次“正在检查更新”与多余网络探测）。
        let result = lastCheckResult
        if (!result?.shouldUpdate) result = await checkUpdate()
        lastCheckResult = result ?? null

        await recordAutoUpdateState('recordDownloadStarted', { mode })
        if (result?.shouldUpdate && result.manifest) {
          await recordAutoUpdateState('recordCheckResult', {
            shouldUpdate: true,
            manifest: normalizeUpdateManifest(result.manifest),
          })
          // download_and_install 会下载并就地替换 .app；进度经 DOWNLOAD_PROGRESS 事件上报，
          // 完成时发 DOWNLOADED。这里不重启——重启交给用户点“重启安装”(quitAndInstall)。
          await (result.manifest as any).downloadAndInstall()
          await recordAutoUpdateState('recordPending')
        } else {
          await recordAutoUpdateState('recordCheckResult', { shouldUpdate: false })
        }
      },
      async quitAndInstall() {
        // 用户已确认安装。若尚未下载完成，先补下载；随后重启进程跑上新版本。
        const prev = await invokeNodeAutoUpdate('getState') as any
        const pending = prev?.data?.status === 'pending'
        if (!pending) {
          let result = lastCheckResult
          if (!result?.shouldUpdate) result = await checkUpdate()
          lastCheckResult = result ?? null
          if (result?.shouldUpdate && result.manifest) {
            await recordAutoUpdateState('recordCheckResult', {
              shouldUpdate: true,
              manifest: normalizeUpdateManifest(result.manifest),
            })
            await recordAutoUpdateState('recordDownloadStarted', { mode: 'full' })
            await (result.manifest as any).downloadAndInstall()
          }
        }
        // macOS 的安装是就地替换 .app 包，必须重启进程才能跑上新版本。
        try {
          await relaunchApp()
        } catch (error) {
          console.warn('[updater] 重启应用失败，请手动重启:', error)
        }
      },
      async recordEvent(event: any) {
        return await recordAutoUpdateState('recordEvent', event)
      },
      async recordProgress(progress: any) {
        return await recordAutoUpdateState('recordProgress', progress)
      },
      async recordError(error: any) {
        return await recordAutoUpdateState('recordError', { error: normalizeUpdaterError(error) })
      },
      getDownloadedPath: () => Promise.resolve(null),
      onCheckingForUpdate: (cb: () => void) =>
        onUpdaterStatus('CHECKING', () => cb()),
      onUpdateAvailable: (cb: (info?: any) => void) =>
        onUpdaterStatus('UPDATE_AVAILABLE', (event) => cb(normalizeUpdateManifest(event.data || {}))),
      onUpdateNotAvailable: (cb: () => void) =>
        onUpdaterStatus('UPTODATE', () => cb()),
      onDownloadProgress: (cb: (progress: any) => void) =>
        onUpdaterStatus('DOWNLOAD_PROGRESS', (event) => cb(normalizeUpdaterProgress(event.data || {}))),
      onUpdateDownloaded: (cb: () => void) =>
        onUpdaterStatus('DOWNLOADED', () => cb()),
      onError: (cb: (error: string) => void) =>
        onUpdaterStatus('ERROR', (event) => cb(normalizeUpdaterError(event.error || event.data || '更新失败').message)),
      onDownloadStarted: (cb: (updateInfo?: any) => void) =>
        onUpdaterStatus('DOWNLOAD_PROGRESS', () => cb()),
      onDifferentialFallback: () => () => undefined,
      removeAllListeners: () => {
        clearUpdaterListeners()
      },
    },

    // ---- Ping (song ended) ----
    ping: (cb: (...args: any[]) => void) => onTauriEvent('song-ended', cb),

    // ---- Ping Service ----
    pingService: {
      start: () => { emit('startPing').catch(console.warn) },
      stop: () => { emit('stopPing').catch(console.warn) },
    },

    // ---- Directory Settings ----
    directorySettings: {
      getDirectories: async () =>
        normalizeDirectorySettings(await safeInvoke('directory_settings_get_directories', undefined, {})),
      selectCacheDir: async () => {
        const result = await safeInvoke('directory_settings_select_cache_dir', undefined, null)
        return result || { success: false, message: '用户取消选择' }
      },
      selectDownloadDir: async () => {
        const result = await safeInvoke('directory_settings_select_download_dir', undefined, null)
        return result || { success: false, message: '用户取消选择' }
      },
      saveDirectories: async (dirs: any) => {
        const normalized = normalizeDirectorySettings(dirs)
        const result = await safeInvoke('directory_settings_save_directories', { directories: normalized })
        // 同步到 Node sidecar 下载服务：sidecar 才是实际执行下载的引擎，
        // 不推的话设置页改的下载目录只进 Rust DB，新下载仍写 appDataDir/downloads。
        if (result?.success !== false && normalized.downloadDir) {
          try {
            await invokeNodeDownload('setDownloadDir', { dir: normalized.downloadDir })
          } catch (error) {
            console.warn('[download] 同步下载目录到 sidecar 失败:', error)
          }
        }
        // 缓存目录也要同步：sidecar 的 isCache 任务写 state.cacheDir，
        // 不同步的话缓存文件写进默认 appDataDir/music-cache，设置页改的缓存目录不生效。
        if (result?.success !== false && normalized.cacheDir) {
          try {
            await invokeNodeDownload('setCacheDir', { dir: normalized.cacheDir })
          } catch (error) {
            console.warn('[download] 同步缓存目录到 sidecar 失败:', error)
          }
        }
        return result
      },
      resetDirectories: async () => {
        const result: any = await safeInvoke('directory_settings_reset_directories', undefined, { success: true })
        const normalizedResult = {
          ...(result || {}),
          success: result?.success !== false,
          directories: normalizeDirectorySettings(result?.directories || {}),
        }
        if (normalizedResult.success && normalizedResult.directories?.downloadDir) {
          try {
            await invokeNodeDownload('setDownloadDir', { dir: normalizedResult.directories.downloadDir })
          } catch (error) {
            console.warn('[download] 同步下载目录到 sidecar 失败:', error)
          }
        }
        return normalizedResult
      },
      openDirectory: (dirPath: string) => safeInvoke('directory_settings_open_directory', { dirPath }),
      getDirectorySize: async (dirPath: string) => {
        if (!dirPath) return { size: 0, formatted: '0 B' }
        return normalizeDirectorySize(
          await safeInvoke('directory_settings_get_directory_size', { dirPath }, 0),
        )
      },
    },

    // ---- Local Music ----
    localMusic: {
      selectDirs: () => safeInvoke('local_music_select_dirs'),
      scan: (dirs: string[]) => safeInvoke('local_music_scan', { dirs }),
      writeTags: (filePath: string, songInfo: any, tagWriteOptions: any) =>
        safeInvoke('local_music_write_tags', { filePath, songInfo, tagWriteOptions }),
      getDirs: () => safeInvoke('local_music_get_dirs'),
      setDirs: (dirs: string[]) => safeInvoke('local_music_set_dirs', { dirs }),
      getList: () => safeInvoke('local_music_get_list', undefined, []),
      getUrlById: async (id: string | number) =>
        normalizeLocalMusicUrlResult(await safeInvoke('local_music_get_url', { id })),
      clearIndex: () => safeInvoke('local_music_clear_index'),
      getCoverBase64: (trackId: string) => safeInvoke('local_music_get_cover', { trackId }, ''),
      getCoversBase64: (trackIds: string[]) => safeInvoke('local_music_get_covers', { trackIds }, {}),
      getTags: (songmid: string, includeLyrics = true) =>
        safeInvoke('local_music_get_tags', { songmid, includeLyrics }),
      getLyric: (songmid: string) => safeInvoke('local_music_get_lyric', { songmid }, ''),
      onScanProgress: (cb: (processed: number, total: number) => void) =>
        onTrackedTauriEvent<{ processed: number; total: number }>(
          'local-music:scan-progress',
          (d) => cb(d.processed, d.total),
          localMusicScanProgressListenerDisposers,
          'local music scan progress',
        ),
      onScanFinished: (cb: (res: any[]) => void) =>
        onTrackedTauriEvent('local-music:scan-finished', cb, localMusicScanFinishedListenerDisposers, 'local music scan finished'),
      removeScanProgress: () => {
        clearTrackedListeners(localMusicScanProgressListenerDisposers)
      },
      removeScanFinished: () => {
        clearTrackedListeners(localMusicScanFinishedListenerDisposers)
      },
      batchMatch: (songmids: string[]) => safeInvoke('local_music_batch_match', { songmids }),
      onBatchMatchProgress: (cb: (processed: number, total: number, matched: number) => void) =>
        onTrackedTauriEvent<{ processed: number; total: number; matched: number }>(
          'local-music:batch-match-progress',
          (d) => cb(d.processed, d.total, d.matched),
          localMusicBatchMatchListenerDisposers,
          'local music batch match progress',
        ),
      onBatchMatchFinished: (cb: (res: any) => void) =>
        onTrackedTauriEvent('local-music:batch-match-finished', cb, localMusicBatchMatchListenerDisposers, 'local music batch match finished'),
      removeBatchMatchListeners: () => {
        clearTrackedListeners(localMusicBatchMatchListenerDisposers)
      },
    },

    // ---- Plugin Notice ----
    pluginNotice: {
      onPluginNotice: (cb: (data: any) => any) => onTauriEvent('plugin-notice', async (raw: any) => {
        const notice = normalizeDialogNotice(raw)
        if (!notice) return
        const decision = await recordNotificationDecision({
          channel: 'plugin',
          severity: notice.dialogType,
          title: notice.title,
          body: notice.message,
          tag: notice.pluginId ? `plugin:${notice.pluginId}:${notice.dialogType}` : `plugin:${notice.title}`,
          pluginId: notice.pluginId,
          payload: notice,
          // Electron 会直接弹 updateAlert；更新弹窗不受 3 秒冷却压制
          force: notice.dialogType === 'update',
        })
        if (decision.show !== false) cb(notice)
      }),
      onPluginThrottle: (cb: (data: any) => void) => onTauriEvent('plugin-throttle', cb),
      onPluginDisabled: (cb: (data: any) => void) => onTauriEvent('plugin-disabled', cb),
    },

    // ---- Notification Policy ----
    notification: {
      record: async (payload: any) => recordNotificationDecision(normalizeNotificationPayload(payload)),
      getState: async () => {
        const nodeResult = await invokeNodeNotification('getState') as any
        return nodeResult?.data || nodeResult || null
      },
      setPolicy: async (policy: any) => invokeNodeNotification('setPolicy', policy),
      clearHistory: async () => invokeNodeNotification('clearHistory'),
      shouldShow: async (payload: any) => {
        const result = await recordNotificationDecision(normalizeNotificationPayload(payload))
        return result.show !== false
      },
    },

    // ---- System Audio ----
    systemAudio: {
      prepareCapture: () => safeInvoke('system_audio_prepare_capture'),
      getDefaultScreenSourceId: () => safeInvoke('system_audio_get_default_source_id'),
      getAllScreenSourceIds: () => safeInvoke('system_audio_get_all_source_ids', undefined, []),
    },

    podcast: {
      getLoginState: async () =>
        (await invokeNodeMusicSdk('podcast.getLoginState', {})) || { loggedIn: false },
      createQr: async () => (await invokeNodeMusicSdk('podcast.createQr', {})) || {},
      checkQr: async (key: string) =>
        (await invokeNodeMusicSdk('podcast.checkQr', { key })) || {},
      logout: async () => await invokeNodeMusicSdk('podcast.logout', {}),
      getCategories: async (forceRefresh = false) =>
        (await invokeNodeMusicSdk('podcast.getCategories', { forceRefresh })) || [],
      getCategoryPage: async (payload: Record<string, any>) =>
        (await invokeNodeMusicSdk('podcast.getCategoryPage', payload || {})) || {
          list: [],
          radios: [],
        },
      getCategoryTotal: async (payload: Record<string, any>) =>
        (await invokeNodeMusicSdk('podcast.getCategoryTotal', payload || {})) || { total: 0 },
      getHomeChannel: async (payload: Record<string, any>) =>
        (await invokeNodeMusicSdk('podcast.getHomeChannel', payload || {})) || {
          list: [],
          radios: [],
        },
      getRecommendations: async (limit = 20) =>
        (await invokeNodeMusicSdk('podcast.getHomeChannel', { limit })) || {
          list: [],
          radios: [],
        },
      search: async (payload: Record<string, any>) =>
        (await invokeNodeMusicSdk('podcast.search', payload || {})) || { list: [], total: 0 },
      getPrograms: async (payload: Record<string, any>) =>
        (await invokeNodeMusicSdk('podcast.getPrograms', payload || {})) || {
          list: [],
          total: 0,
        },
      getRadioDetail: async (radioId: string) =>
        await invokeNodeMusicSdk('podcast.getRadioDetail', { radioId }),
      getPlayUrl: async (payload: Record<string, any>) =>
        await invokeNodeMusicSdk('podcast.getPlayUrl', {
          song: payload?.song || payload,
          quality: payload?.quality,
        }),
      getProgramLyric: async (song: any) =>
        (await invokeNodeMusicSdk('podcast.getProgramLyric', { song })) || { lyric: '' },
    },

    permissions: {
      getPlatform: () => {
        const ua = navigator.userAgent.toLowerCase()
        if (ua.includes('mac')) return Promise.resolve('darwin')
        if (ua.includes('win')) return Promise.resolve('win32')
        return Promise.resolve('linux')
      },
      getMediaStatus: async (kind: 'microphone' | 'system-audio') => {
        if (kind !== 'microphone') return 'unknown'
        try {
          const status = await navigator.permissions.query({
            name: 'microphone' as PermissionName,
          })
          return status.state
        } catch {
          return 'unknown'
        }
      },
      prepareMediaCapture: () => Promise.resolve(true),
      requestMicrophone: async () => {
        try {
          const status = await navigator.permissions
            .query({ name: 'microphone' as PermissionName })
            .then((permission) => permission.state)
            .catch(() => 'prompt')
          if (status === 'denied') return false
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          stream.getTracks().forEach((track) => track.stop())
          return true
        } catch {
          return false
        }
      },
      openSettings: async (target: 'microphone' | 'system-audio' | 'files-and-folders') => {
        const ua = navigator.userAgent.toLowerCase()
        let url = ''
        if (ua.includes('mac')) {
          const pane =
            target === 'microphone'
              ? 'Privacy_Microphone'
              : target === 'system-audio'
                ? 'Privacy_ScreenCapture'
                : 'Privacy_FilesAndFolders'
          url = `x-apple.systempreferences:com.apple.preference.security?${pane}`
        } else if (ua.includes('win')) {
          const pane =
            target === 'microphone'
              ? 'privacy-microphone'
              : target === 'system-audio'
                ? 'privacy-screenrecording'
                : 'privacy-broadfilesystemaccess'
          url = `ms-settings:${pane}`
        }
        if (!url) return false
        await openUrl(url)
        return true
      },
      showGuide: async (target: 'microphone' | 'system-audio' | 'files-and-folders') => {
        const ua = navigator.userAgent.toLowerCase()
        let url = ''
        if (ua.includes('mac')) {
          const pane =
            target === 'microphone'
              ? 'Privacy_Microphone'
              : target === 'system-audio'
                ? 'Privacy_ScreenCapture'
                : 'Privacy_FilesAndFolders'
          url = `x-apple.systempreferences:com.apple.preference.security?${pane}`
        } else if (ua.includes('win')) {
          const pane =
            target === 'microphone'
              ? 'privacy-microphone'
              : target === 'system-audio'
                ? 'privacy-screenrecording'
                : 'privacy-broadfilesystemaccess'
          url = `ms-settings:${pane}`
        }
        if (!url) return false
        await openUrl(url)
        return true
      },
    },

    // ---- Dialog / System ----
    dialog: {
      openFile: (options?: any) => openFileDialog(options || {}),
    },
    system: {
      getFontList: () => safeInvoke<string[]>('get_font_list', undefined, []),
    },

    // ---- Share ----
    share: {
      getPluginCodeAndMd5: (pluginId: string) =>
        safeInvoke('service_share_get_plugin_code_and_md5', { pluginId }),
      onShareOpen: (cb: (p: { id: string }) => void) => onTauriEvent('share-open', cb),
      onPlaylistShareOpen: (cb: (p: { id: string }) => void) => onTauriEvent('playlist-share-open', cb),
      getPending: () => safeInvoke('get_pending_share_ids', undefined, []),
      getPendingPlaylistShares: () => safeInvoke('get_pending_playlist_share_ids', undefined, []),
    },

    // ---- Listen Together ----
    listenTogether: {
      onShareOpen: (cb: (p: { code: string }) => void) => onTauriEvent('lt-share-open', cb),
      getPendingCodes: () => safeInvoke('get_pending_lt_codes', undefined, []),
    },

    // ---- Clipboard ----
    clipboard: {
      readText: () => safeInvoke('clipboard_read_text'),
    },

    // ---- Thumbar (Windows) ----
    thumbar: {
      setState: (state: any) => { emit('thumbar:set-state', state).catch(console.warn) },
      setCover: (dataUrl: string | null) => { emit('thumbar:set-cover', { dataUrl }).catch(console.warn) },
      onToggleLike: (cb: () => void) => onTauriEvent('thumbar:toggle-like', cb),
    },

    // ---- App ----
    app: {
      setTitle: (title: string) => { appWindow.setTitle(title).catch(console.warn) },
      exit: (code = 0) => { exitApp(code).catch(console.warn) },
setProgress: (progress: number, options?: { paused?: boolean }) => {
        // Prefer the window command with local dedupe. The old emit path
        // crossed custom-protocol IPC twice for every progress tick.
        void applyWindowProgressBar(progress, options)
      },
      getWindowState: () => getWindowStatePayload(),
      getLifecycleState: async () => {
        const nodeState = await invokeNodeWindowLifecycle('getState') as any
        return nodeState?.data || nodeState || null
      },
      decideClose: async (payload?: any) => {
        const closeToTray = await api.settings.getCloseToTray().catch(() => true)
        const window = await getWindowStatePayload().catch(() => undefined)
        const nodeResult = await invokeNodeWindowLifecycle('decideClose', { closeToTray, window, ...(payload || {}) }) as any
        return nodeResult?.decision || { action: closeToTray ? 'hide-main-window' : 'exit-app', preventClose: true, reason: 'fallback' }
      },
      onWindowStateChanged: (cb: (state: AppWindowStatePayload) => void) => {
        const off = onTauriEvent<AppWindowStatePayload>('app-window-state-changed', cb)
        getWindowStatePayload().then(cb).catch(console.warn)
        return off
      },
      // 真实系统睡眠/唤醒（Rust 侧 NSWorkspace didWake 派发），区别于窗口可见性唤醒
      onSystemWake: (cb: () => void) => onTauriEvent('app-system-wake', cb),
      // 默认输出设备变化（Rust 侧 CoreAudio kAudioHardwarePropertyDefaultOutputDevice 派发）：
      // 耳机插拔 / 蓝牙连断 / 手动切换输出设备。比 WebView 的 devicechange 可靠。
      onAudioDeviceChanged: (cb: () => void) => onTauriEvent('app-audio-device-changed', cb),
    },

    // ---- Desktop Lyric Window ----
    desktopLyric: {
      toggle: (show: boolean) => safeInvoke('toggle_desktop_lyric', { show }),
      getOption: () => safeInvoke('get_desktop_lyric_option'),
      setOption: (option: any) => safeInvoke('set_desktop_lyric_option', { option }),
      isOpen: () => safeInvoke('lyric_window_get_open_state'),
      getWindowBounds: () => safeInvoke('get_window_bounds'),
      getAllWorkArea: () => safeInvoke('get_all_work_area'),
      getScreenSize: () => safeInvoke('get_screen_size'),
      setLyricLock: (isLock: boolean) => safeInvoke('set_desktop_lyric_lock', { isLock }),
      getLyricLockState: () => safeInvoke('get_lyric_lock_state'),
      getAppVersion: () => safeInvoke('get_app_version'),
      /** macOS 状态栏歌词开关 */
      setMacStatusBarLyric: (enabled: boolean) => safeInvoke('set_mac_status_bar_lyric', { enabled }),
      getMacStatusBarLyric: () => safeInvoke('get_mac_status_bar_lyric', undefined, false),
      onOptionChange: (cb: (opt: any) => void) => onTauriEvent('desktop-lyric-option-change', cb),
      onOpenChange: (cb: (open: boolean) => void) => onTauriEvent('desktop-lyric-open-change', cb),
    },

    // ---- Power Save Blocker ----
    powerSaveBlocker: {
      start: (reason?: string) => holdPowerSaveBlocker(reason),
      stop: (reason?: string) => releasePowerSaveBlocker(reason),
      getState: () => ({
        active: powerSaveBlockerNativeActive,
        reasons: Array.from(powerSaveBlockerReasons),
      }),
    },
  }

  /* ------------------------------------------------------------------ */
  /*  window.electron stub (for backward compat)                        */
  /* ------------------------------------------------------------------ */

  const electronStub = {
    process: {
      versions: {
        electron: 'tauri',
        chrome: navigator.userAgent.match(/Chrome\/(\S+)/)?.[1] || 'latest',
        node: 'tauri',
        tauri: '__TAURI__' in window ? '2.x' : 'unknown',
      },
    },
    ipcRenderer: {
      send: (channel: string, ...args: any[]) => {
        if (channel === 'change-desktop-lyric') {
          safeInvoke('toggle_desktop_lyric', { show: Boolean(args[0]) }).catch(console.warn)
          return
        }
        if (shouldDropNoiseEvent(channel)) return
        if (channel === 'set-desktop-lyric-option') {
          safeInvoke('set_desktop_lyric_option', { option: args[0] }).catch(console.warn)
          return
        }
        if (channel === 'set-desktop-lyric-font') {
          safeInvoke('set_desktop_lyric_option', {
            option: { fontFamily: String(args[0] || '') },
          }).catch(console.warn)
          return
        }
        if (channel === 'toogleDesktopLyricLock') {
          safeInvoke('set_desktop_lyric_lock', { isLock: Boolean(args[0]) }).catch(console.warn)
          return
        }
        if (channel === 'move-window') {
          const [x, y, width, height] = args.map((item) => Number(item))
          safeInvoke('move_desktop_lyric_window', { x, y, width, height }).catch(console.warn)
          return
        }
        if (channel === 'update-window-height') {
          safeInvoke('update_desktop_lyric_window_height', { height: Number(args[0]) }).catch(console.warn)
          return
        }
        if (channel === 'closeDesktopLyric') {
          safeInvoke('close_desktop_lyric_window').catch(console.warn)
          return
        }
        if (channel === 'lyric-window-ready') {
          safeInvoke('desktop_lyric_window_ready').catch(console.warn)
          return
        }
        if (channel === 'win-show') {
          safeInvoke('show_main_window').catch(console.warn)
          return
        }
        if (channel === 'send-main-event') {
          const [eventName, ...eventArgs] = args
          if (typeof eventName === 'string') {
            emit(eventName, eventArgs.length <= 1 ? eventArgs[0] : eventArgs).catch(console.warn)
          }
          return
        }
        emit(channel, args.length === 1 ? args[0] : args).catch(console.warn)
      },
      invoke: (channel: string, ...args: any[]) => {
        if (channel === 'service-plugin-initialize-system') {
          return api.plugins.initializeSystem()
        }
        if (channel === 'get-window-bounds') return safeInvoke('get_window_bounds')
        if (channel === 'get-cursor-position') return safeInvoke('get_cursor_position')
        if (channel === 'get-desktop-lyric-option') return safeInvoke('get_desktop_lyric_option')
        if (channel === 'get-all-work-area') return safeInvoke('get_all_work_area')
        if (channel === 'get-screen-size') return safeInvoke('get_screen_size')
        if (channel === 'get-lyric-lock-state') return safeInvoke('get_lyric_lock_state')
        if (channel === 'get-lyric-open-state') return safeInvoke('get_lyric_open_state')
        // Map Electron IPC channel to Tauri command
        const tauriCmd = mapInvokeChannel(channel)
        return safeInvoke(tauriCmd, packInvokeArgs(channel, tauriCmd, args))
      },
      on: (channel: string, listener: (...args: any[]) => void) =>
        onTrackedTauriEvent(
          channel,
          (payload) => listener(null, payload),
          getElectronIpcListenerDisposers(channel),
          `electron ipc ${channel}`,
        ),
      removeListener: (channel?: string) => {
        clearElectronIpcListeners(channel)
      },
      removeAllListeners: (channel?: string) => {
        clearElectronIpcListeners(channel)
      },
    },
  }

  if (!window.__shuxiaPluginAddLinkHandlerInstalled) {
    window.__shuxiaPluginAddLinkHandlerInstalled = true
    listen('plugin-add-link', (event) => {
      handlePluginAddLinkPayload(api, event.payload).catch((e) => {
        console.error('[tauri-bridge] 处理插件安装链接失败:', e)
      })
    }).catch(console.warn)
  }

  // Attach to window
  window.api = api
  window.electron = electronStub
}

createTauriBridge()

export default createTauriBridge
