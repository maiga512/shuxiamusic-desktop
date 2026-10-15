import { useSettingsStore } from '@renderer/store/Settings'
// 【新】统一实时同步总线：播客收藏改用它接收刷新通知
import { emitPodcastSync } from '@renderer/utils/sync/realtimeSyncBus'
import type {
  CloudSongDto,
  CloudSongList,
  CreateUserSongListDto,
  UpdateUserSongListDto
} from '@renderer/api/cloudSongList'
import type {
  ShuxiaFavoriteMutationResult,
  ShuxiaFavoriteSyncPage,
  ShuxiaPodcastFavorite,
  ShuxiaPodcastFavoriteMutationInput,
  ShuxiaPlaylistFavorite,
  ShuxiaPlaylistFavoriteMutationInput
} from '@shuxia/shared-contract'

export type NasSyncSession = {
  accessToken: string
  expiresAt: number
  user: {
    id: string
    username: string
    nickname?: string
    email?: string
  }
}

type RequestOptions = {
  method?: string
  token?: string
  body?: unknown
}

type NasSyncConfig = {
  enabled?: boolean
  syncMode?: NasSyncMode
  serverUrl?: string
  host?: string
  port?: number
  useHttps?: boolean
  accessToken?: string
  status?: 'connected' | 'disconnected'
  [key: string]: unknown
}

export type NasSyncMode = 'backup-to-cloud' | 'restore-from-cloud' | 'auto'

let cachedNasPluginId = ''

export type NasSyncServerParts = {
  host: string
  port: number
  useHttps: boolean
  path: string
}

export type NasPlaylistSongOperationResult = {
  operationId: string
  applied: boolean
  changed: boolean
  stale: boolean
  action: 'add' | 'remove'
  trackKey: string
  removedCount: number
  revision: number
  updatedAt: string
  winningOperationId?: string
  winningOccurredAtMs?: number
}

export const parseNasSyncServerUrl = (serverUrl?: string): NasSyncServerParts | null => {
  const raw = String(serverUrl || '').trim()
  if (!raw) return null
  try {
    const hasExplicitScheme = raw.startsWith('http://') || raw.startsWith('https://')
    const url = new URL(hasExplicitScheme ? raw : `http://${raw}`)
    const explicitPort = url.port ? Number(url.port) : 0
    const port = explicitPort || (hasExplicitScheme && url.protocol === 'https:' ? 443 : 80)
    const useHttps = hasExplicitScheme ? url.protocol === 'https:' : port === 443 || port === 11443
    return {
      host: url.hostname,
      port,
      useHttps,
      path: url.pathname.replace(/\/+$/, '')
    }
  } catch {
    return null
  }
}

export const buildNasSyncServerUrl = (config: NasSyncConfig = {}): string => {
  const rawHost = String(config.host || '').trim()
  if (rawHost) {
    if (/^https?:\/\//i.test(rawHost)) {
      const parsed = parseNasSyncServerUrl(rawHost)
      if (!parsed) return ''
      return `${parsed.useHttps ? 'https' : 'http'}://${parsed.host}${parsed.port ? `:${parsed.port}` : ''}${parsed.path}`
    }

    const [authority, ...pathParts] = rawHost.split('/')
    if (!authority) return ''
    const scheme = config.useHttps === true || Number(config.port) === 443 || Number(config.port) === 11443 ? 'https' : 'http'
    const port = Number(config.port) > 0 ? Number(config.port) : 31231
    const path = pathParts.length > 0 ? `/${pathParts.join('/').replace(/\/+$/, '')}` : ''
    return `${scheme}://${authority}:${port}${path}`
  }

  // 兼容旧版完整 serverUrl 配置。
  const parsed = parseNasSyncServerUrl(config.serverUrl)
  if (!parsed) return ''
  return `${parsed.useHttps ? 'https' : 'http'}://${parsed.host}${parsed.port ? `:${parsed.port}` : ''}${parsed.path}`
}

const findNasSyncPluginId = async () => {
  if (cachedNasPluginId) return cachedNasPluginId
  const plugins = await window.api.plugins.loadAllPlugins().catch(() => [])
  if (!Array.isArray(plugins)) return ''

  const plugin = plugins.find((item: any) => item?.pluginType === 'service' && item?.serviceRole === 'nas-sync')
  if (plugin?.pluginId) {
    cachedNasPluginId = plugin.pluginId
    return cachedNasPluginId
  }
  return ''
}

const getPluginNasConfig = async (): Promise<NasSyncConfig | null> => {
  const pluginId = await findNasSyncPluginId()
  if (!pluginId) return null
  const result = await window.api.plugins.getConfig(pluginId).catch(() => null)
  return result?.data || null
}

const getLegacyNasConfig = (): NasSyncConfig => {
  const settings = useSettingsStore().settings
  return {
    enabled: settings.nasSyncEnabled,
    serverUrl: settings.nasSyncServerUrl,
    accessToken: settings.nasSyncToken,
    status: settings.nasSyncStatus
  }
}

const getNasConfig = async () => {
  const pluginConfig = await getPluginNasConfig()
  return pluginConfig || getLegacyNasConfig()
}

export const getNasSyncMode = async (): Promise<NasSyncMode> => {
  const config = await getNasConfig()
  const mode = String(config.syncMode || 'auto')
  if (mode === 'backup-to-cloud' || mode === 'restore-from-cloud' || mode === 'auto') {
    return mode
  }
  return 'auto'
}

export const getNasSyncScope = async () => {
  const config = await getNasConfig()
  const serverUrl = buildNasSyncServerUrl(config)
  const userKey = String(config.userId || config.username || 'default')
  return `${serverUrl || 'local'}::${userKey}`
}

export const canUseNasSync = async () => {
  const config = await getNasConfig()
  return Boolean(config.enabled && buildNasSyncServerUrl(config) && config.accessToken)
}

export const getNasSyncLastRevision = () => {
  const raw = localStorage.getItem('shuxia_nas_sync_last_revision') || '0'
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

export const getScopedNasSyncLastRevision = async () => {
  const scope = await getNasSyncScope()
  const scopedRaw = localStorage.getItem(`shuxia_nas_sync_last_revision:${scope}`)
  const fallbackRaw = localStorage.getItem('shuxia_nas_sync_last_revision')
  const value = Number(scopedRaw || fallbackRaw || '0')
  return Number.isFinite(value) ? value : 0
}

export const setNasSyncLastRevision = (revision: number) => {
  if (!Number.isFinite(revision)) return
  localStorage.setItem('shuxia_nas_sync_last_revision', String(Math.max(0, Math.floor(revision))))
}

export const setScopedNasSyncLastRevision = async (revision: number) => {
  if (!Number.isFinite(revision)) return
  const normalized = String(Math.max(0, Math.floor(revision)))
  const scope = await getNasSyncScope()
  localStorage.setItem(`shuxia_nas_sync_last_revision:${scope}`, normalized)
  localStorage.setItem('shuxia_nas_sync_last_revision', normalized)
}

const unwrapNasResponse = async <T>(response: Response): Promise<T> => {
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.success === false) {
    if (response.status === 409 && body?.conflict && typeof body.conflict === 'object') {
      throw new NasSyncConflictError(
        String(body.error || '同步冲突，请先刷新最新数据'),
        body.conflict as NasSyncConflict,
      )
    }
    throw new Error(body?.error || 'NAS 同步服务请求失败：' + response.status)
  }
  if (body?.success === true && 'data' in body) {
    return body.data as T
  }
  return body as T
}

export type NasSyncConflict = {
  type: string
  entityType?: string
  baseRevision?: number
  currentRevision?: number
}

export class NasSyncConflictError extends Error {
  readonly conflict: NasSyncConflict

  constructor(message: string, conflict: NasSyncConflict) {
    super(message)
    this.name = 'NasSyncConflictError'
    this.conflict = conflict
  }
}

const normalizeNasBaseUrl = (value?: string) => String(value || '').trim().replace(/\/+$/, '')

const nasBaseUrlCandidates = (config: NasSyncConfig) => {
  const urls: string[] = []
  const push = (value?: string) => {
    const raw = normalizeNasBaseUrl(value)
    if (!raw) return
    const parsed = parseNasSyncServerUrl(raw)
    if (!parsed) return
    const url = `${parsed.useHttps ? 'https' : 'http'}://${parsed.host}${parsed.port ? `:${parsed.port}` : ''}${parsed.path}`
    if (!urls.includes(url)) urls.push(url)
  }
  push(config.serverUrl)
  push(buildNasSyncServerUrl(config))
  urls.sort((left, right) => {
    const score = (url: string) => (/192\.168\.|10\.|127\.0\.0\.1|172\.(1[6-9]|2\d|3[0-1])\./.test(url) ? 1 : 0)
    return score(right) - score(left)
  })
  return urls
}

const requestNas = async <T>(endpoint: string, options: RequestOptions = {}) => {
  const config = await getNasConfig()
  const baseUrls = nasBaseUrlCandidates(config)
  if (!baseUrls.length) throw new Error('请先填写 NAS 同步服务器地址')

  let lastError: unknown = null
  for (const baseUrl of baseUrls) {
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(options.token || config.accessToken
            ? { Authorization: `Bearer ${options.token || config.accessToken}` }
            : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      })
      return await unwrapNasResponse<T>(response)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'NAS 同步服务请求失败'))
}

const normalizePlaylistFavoritePage = (payload: unknown): ShuxiaFavoriteSyncPage<ShuxiaPlaylistFavorite> => {
  const data = payload as
    | ShuxiaPlaylistFavorite[]
    | {
        items?: ShuxiaPlaylistFavorite[]
        revision?: number
        updatedAt?: string
      }
  const items = Array.isArray(data) ? data : data.items || []
  return {
    items: items.filter((item) => item.playlistId),
    revision: Array.isArray(data) ? undefined : data.revision,
    updatedAt: Array.isArray(data) ? undefined : data.updatedAt
  }
}

const coverToString = (cover: string | File | undefined) => (typeof cover === 'string' ? cover : undefined)

const PODCAST_FAVORITES_STORAGE_KEY = 'shuxia_podcast_favorites'
const PODCAST_FAVORITE_PINS_STORAGE_KEY = 'shuxia_podcast_favorite_pins'
const PODCAST_FAVORITE_MUTATIONS_STORAGE_KEY = 'shuxia_podcast_favorite_mutations'

type PendingPodcastFavoriteMutation =
  | { operation: 'upsert'; key: string; input: ShuxiaPodcastFavoriteMutationInput }
  | { operation: 'delete'; key: string; source?: string; radioId: string; operationId: string; occurredAtMs?: number }
  | { operation: 'reorder'; key: '__order__'; orderedIds: string[]; baseRevision?: number; operationId: string }

const readPendingPodcastFavoriteMutations = (): PendingPodcastFavoriteMutation[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PODCAST_FAVORITE_MUTATIONS_STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => item?.key && item?.operation) : []
  } catch {
    return []
  }
}

const writePendingPodcastFavoriteMutations = (items: PendingPodcastFavoriteMutation[]) => {
  localStorage.setItem(PODCAST_FAVORITE_MUTATIONS_STORAGE_KEY, JSON.stringify(items))
}

const enqueuePodcastFavoriteMutation = (mutation: PendingPodcastFavoriteMutation) => {
  const pending = readPendingPodcastFavoriteMutations().filter((item) => item.key !== mutation.key)
  writePendingPodcastFavoriteMutations([...pending, mutation])
}

const removePodcastFavoriteMutation = (key: string) => {
  writePendingPodcastFavoriteMutations(readPendingPodcastFavoriteMutations().filter((item) => item.key !== key))
}

const readLocalPodcastFavorites = (): ShuxiaPodcastFavorite[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PODCAST_FAVORITES_STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => item?.radioId) : []
  } catch {
    return []
  }
}

const writeLocalPodcastFavorites = (items: ShuxiaPodcastFavorite[], notifyLocalChange = true) => {
  localStorage.setItem(PODCAST_FAVORITES_STORAGE_KEY, JSON.stringify(items))
  // 【新·现在用这个】统一实时同步总线：播客页(podcast.vue)已迁移到这里刷新
  emitPodcastSync('update', notifyLocalChange ? 'local' : 'remote')
  // 【旧·仍保留】radio.vue 等未迁移页面仍靠这个 window 事件刷新
  window.dispatchEvent(new Event('shuxia-podcast-favorites-updated'))
  if (notifyLocalChange) window.dispatchEvent(new Event('shuxia-nas-local-change'))
}

const podcastFavoriteKey = (source: string | undefined, radioId: string) => `${source || 'wy'}:${radioId}`

const readPodcastFavoritePins = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PODCAST_FAVORITE_PINS_STORAGE_KEY) || '[]')
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item || '').trim()).filter((item, index, items) => item && items.indexOf(item) === index)
      : []
  } catch {
    return []
  }
}

const writePodcastFavoritePins = (items: string[]) => {
  const keys = items.map((item) => String(item || '').trim()).filter((item, index, all) => item && all.indexOf(item) === index)
  localStorage.setItem(PODCAST_FAVORITE_PINS_STORAGE_KEY, JSON.stringify(keys))
}

const orderPodcastFavorites = (
  items: ShuxiaPodcastFavorite[],
  pinKeys = readPodcastFavoritePins()
): ShuxiaPodcastFavorite[] => {
  const pinIndex = new Map(pinKeys.map((key, index) => [key, index]))
  return [...items]
    .map((item, index) => ({
      item: {
        ...item,
        pinned: pinIndex.has(podcastFavoriteKey(item.source, item.radioId))
      },
      index
    }))
    .sort((left, right) => {
      if (left.item.pinned !== right.item.pinned) return left.item.pinned ? -1 : 1
      const leftPinIndex = pinIndex.get(podcastFavoriteKey(left.item.source, left.item.radioId))
      const rightPinIndex = pinIndex.get(podcastFavoriteKey(right.item.source, right.item.radioId))
      if (left.item.pinned && leftPinIndex != null && rightPinIndex != null) {
        return leftPinIndex - rightPinIndex
      }
      return left.index - right.index
    })
    .map(({ item }, index) => ({ ...item, position: index }))
}

const podcastFavoriteToMutation = (
  favorite: ShuxiaPodcastFavorite,
  position: number,
  pinned: boolean,
  operationId?: string
): ShuxiaPodcastFavoriteMutationInput => ({
  operationId,
  radioId: favorite.radioId,
  source: favorite.source,
  title: favorite.title,
  description: favorite.description,
  coverUrl: favorite.coverUrl,
  author: favorite.author,
  total: favorite.total,
  playCount: favorite.playCount,
  position,
  pinned,
  occurredAtMs: Date.now()
})

const normalizePodcastFavorite = (payload: any): ShuxiaPodcastFavorite | null => {
  const metadata = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}
  const entityId = String(payload?.entityId || '').trim()
  const radioIdRaw = String(payload?.radioId || metadata.radioId || entityId).trim()
  const radioId = radioIdRaw.includes(':') ? radioIdRaw.slice(radioIdRaw.indexOf(':') + 1) : radioIdRaw
  const title = String(payload?.title || payload?.name || metadata.title || '').trim() || radioId
  if (!radioId) return null
  return {
    id: String(payload?.id || podcastFavoriteKey(payload?.source, radioId)),
    radioId,
    source: payload?.source,
    title,
    description: payload?.description || payload?.describe || undefined,
    coverUrl: payload?.coverUrl || payload?.cover || undefined,
    author: payload?.author || metadata.author || undefined,
    total: Number(payload?.total ?? metadata.total) || undefined,
    playCount: String((payload?.playCount ?? metadata.playCount) || '') || undefined,
    pinned: Boolean(payload?.pinned ?? metadata.pinned),
    position: Number.isFinite(Number(payload?.position ?? metadata.position))
      ? Number(payload?.position ?? metadata.position)
      : undefined,
    createdAt: payload?.createdAt,
    updatedAt: payload?.updatedAt,
    deletedAt: payload?.deletedAt ?? null,
    revision: payload?.revision
  }
}

const normalizePodcastFavoritePage = (payload: unknown): ShuxiaFavoriteSyncPage<ShuxiaPodcastFavorite> => {
  const data = payload as { items?: unknown[]; revision?: number; updatedAt?: string } | unknown[]
  const rawItems = Array.isArray(data) ? data : data.items || []
  return {
    items: rawItems.map(normalizePodcastFavorite).filter((item): item is ShuxiaPodcastFavorite => Boolean(item)),
    revision: Array.isArray(data) ? undefined : data.revision,
    updatedAt: Array.isArray(data) ? undefined : data.updatedAt
  }
}



export type NasSyncedPlugin = {
  identityKey: string
  kind: 'music-source' | 'capability'
  name: string
  author: string
  version: string
  enabled: boolean
  disabledSources: string[]
  contentHash?: string
  role?: string
  config?: Record<string, unknown>
  position: number
  revision: number
  deletedAt?: string | null
  createdAt?: string
  updatedAt?: string
}

export type NasPluginOperationResult = {
  operationId: string
  applied: boolean
  changed: boolean
  stale: boolean
  action: 'upsert' | 'remove'
  identityKey: string
  plugin?: NasSyncedPlugin
  revision: number
  updatedAt: string
}

export const nasSyncAPI = {
  health: () => requestNas<{ status: string; service: string }>('/health', { token: '' }),
  me: () => requestNas<NasSyncSession['user']>('/me'),
  pair: (pairCode: string) => requestNas<NasSyncSession>('/auth/pair', { method: 'POST', token: '', body: { pairCode } }),
  registerDevice: async (deviceType = 'desktop') => {
    let deviceId = localStorage.getItem('shuxia_nas_sync_device_id') || ''
    if (!deviceId) {
      deviceId = `desktop-${crypto.randomUUID()}`
      localStorage.setItem('shuxia_nas_sync_device_id', deviceId)
    }
    const deviceName = `Mac ${navigator.platform || 'Desktop'}`
    return requestNas<{ success?: boolean; deviceId: string }>('/sync/register', {
      method: 'POST',
      body: { deviceId, deviceName, deviceType }
    })
  },
  updateDeviceRevision: async (revision: number) => {
    const deviceId = localStorage.getItem('shuxia_nas_sync_device_id') || ''
    if (!deviceId || !Number.isFinite(revision)) return null
    return requestNas<{ success?: boolean }>('/sync/device-revision', {
      method: 'POST',
      body: { deviceId, revision: Math.max(0, Math.floor(revision)) }
    })
  },
  sync: (sinceRevision: number) =>
    requestNas<{ revision: number; nextRevision: number; hasMore: boolean; requiresRefresh?: boolean; events: unknown[] }>(
      `/sync?sinceRevision=${sinceRevision}`
    ),
  waitForSync: (sinceRevision: number, timeoutMs = 8_000) =>
    requestNas<{ revision: number; nextRevision: number; hasMore: boolean; requiresRefresh?: boolean; events: unknown[] }>(
      `/sync/wait?sinceRevision=${sinceRevision}&timeout=${Math.max(0, Math.floor(timeoutMs))}`
    ),
  snapshot: () =>
    requestNas<{ revision: number; counts: { playlists: number; plugins: number; podcasts: number; favorites: number } }>(
      '/sync/snapshot'
    ),
  applyPlaylistSongOperation: (input: {
    operationId: string
    deviceId: string
    sequence: number
    occurredAtMs: number
    playlistId: string
    action: 'add' | 'remove'
    trackKey: string
    song?: CloudSongDto
  }) =>
    requestNas<NasPlaylistSongOperationResult>('/playlist-song-ops', {
      method: 'POST',
      body: input
    }),
  listPlugins: async (options: { includeDeleted?: boolean } = {}) => {
    const query = options.includeDeleted ? '?includeDeleted=true' : ''
    const payload = await requestNas<{ items?: NasSyncedPlugin[] } | NasSyncedPlugin[]>(`/plugins${query}`)
    return Array.isArray(payload) ? payload : payload.items || []
  },
  putPluginBlob: (script: string) =>
    requestNas<{ contentHash: string; byteSize: number }>('/plugin-blobs', {
      method: 'POST',
      body: { script }
    }),
  getPluginBlob: (contentHash: string) =>
    requestNas<{ contentHash: string; script: string; byteSize: number }>(
      `/plugin-blobs/${encodeURIComponent(contentHash)}`
    ),
  applyPluginOperation: (input: {
    operationId: string
    deviceId: string
    sequence: number
    occurredAtMs: number
    identityKey?: string
    action: 'upsert' | 'remove'
    kind: 'music-source' | 'capability'
    name?: string
    author?: string
    version?: string
    enabled?: boolean
    disabledSources?: string[]
    contentHash?: string
    role?: string
    config?: Record<string, unknown>
    position?: number
  }) =>
    requestNas<NasPluginOperationResult>('/plugin-ops', {
      method: 'POST',
      body: input
    })
  ,
  reorderFavorites: (entityType: string, orderedIds: string[], baseRevision?: number) =>
    requestNas<{ orderedIds: string[]; revision?: number }>('/favorite-reorder', {
      method: 'POST',
      body: { entityType, orderedIds, baseRevision }
    }),
  reorderPlugins: (orderedIds: string[], baseRevision?: number) =>
    requestNas<{ orderedIds: string[]; revision?: number }>('/plugin-reorder', {
      method: 'POST',
      body: { orderedIds, baseRevision }
    })
}

export type NasSyncStreamHandle = {
  close: () => void
  finished: Promise<boolean>
}

/**
 * Open the low-latency server event stream. The stream only carries a
 * revision wake-up; callers must still read/apply the normal revision events.
 */
export const openNasSyncStream = async (
  sinceRevision: number,
  onRevision: (revision: number) => void,
): Promise<NasSyncStreamHandle> => {
  const config = await getNasConfig()
  const baseUrl = nasBaseUrlCandidates(config)[0]
  if (!baseUrl || !config.accessToken) throw new Error('NAS 同步服务未配置')
  const controller = new AbortController()
  const response = await fetch(
    `${baseUrl}/sync/stream?sinceRevision=${Math.max(0, Math.floor(sinceRevision))}`,
    {
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${config.accessToken}`
      },
      signal: controller.signal
    },
  )
  if (!response.ok || !response.body) {
    throw new Error(`NAS 实时通道连接失败：${response.status}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let closedByCaller = false
  const consume = async () => {
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        buffer += decoder.decode(next.value, {stream: true})
        const frames = buffer.split(/\r?\n\r?\n/)
        buffer = frames.pop() || ''
        for (const frame of frames) {
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('')
          if (!data) continue
          try {
            const payload = JSON.parse(data)
            const revision = Number(payload?.revision)
            if (Number.isFinite(revision)) onRevision(revision)
          } catch {
            // Ignore malformed keep-alive frames; the revision cursor remains safe.
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
  const finished = consume()
  return {
    close: () => {
      closedByCaller = true
      controller.abort()
    },
    finished: finished.then(() => !closedByCaller)
  }
}

export const nasCloudSongListAPI = {
  getUserSongLists: () => requestNas<CloudSongList[]>('/user-songlist'),
  getSongListDetail: (id: string, sort: 'asc' | 'desc' = 'asc', limit?: number, pos?: number) => {
    const params = new URLSearchParams({ id, sort })
    if (typeof limit === 'number') params.set('limit', String(limit))
    if (typeof pos === 'number') params.set('pos', String(pos))
    return requestNas<{ list: CloudSongDto[]; total: number }>(`/user-songlist/list?${params.toString()}`)
  },
  createUserSongList: (data: CreateUserSongListDto) =>
    requestNas<{ id: string; updatedAt: string; revision?: number }>('/user-songlist', {
      method: 'POST',
      body: {
        localId: data.localId,
        name: data.name,
        describe: data.describe || '',
        cover: coverToString(data.cover),
        source: 'local',
        semanticType: (data as any).semanticType,
        position: (data as any).position ?? -1,
        songlist: data.songlist
      }
    }),
  updateUserSongList: (data: UpdateUserSongListDto) =>
    requestNas<{ id: string; updatedAt: string; revision?: number }>('/user-songlist', {
      method: 'PATCH',
      body: {
        listId: data.listId,
        localId: data.localId,
        name: data.name,
        describe: data.describe,
        cover: coverToString(data.cover),
        source: (data as any).source,
        semanticType: (data as any).semanticType,
        orderOnly: (data as any).orderOnly,
        position: (data as any).position ?? -1,
        songlist: data.songlist
      }
    }),
  deleteUserSongList: (id: string) =>
    requestNas('/user-songlist', {
      method: 'DELETE',
      body: { listId: id }
    }),
  addSongsToList: (id: string, songs: CloudSongDto[]) =>
    requestNas<{ updatedAt: string; revision?: number }>('/user-songlist/list', {
      method: 'PATCH',
      body: { id, songs }
    }),
  removeSongsFromList: (id: string, songmids: string[]) =>
    requestNas<{ updatedAt: string; revision?: number }>('/user-songlist/list', {
      method: 'DELETE',
      body: { id, songmids }
    }),
  reorderPlaylists: (orderedIds: string[], baseRevision?: number) =>
    requestNas<{ orderedIds: string[]; revision?: number }>('/playlist-reorder', {
      method: 'POST',
      body: { orderedIds, baseRevision }
  })
  ,
  reorderFavorites: (entityType: string, orderedIds: string[], baseRevision?: number) =>
    requestNas<{ orderedIds: string[]; revision?: number }>('/favorite-reorder', {
      method: 'POST',
      body: { entityType, orderedIds, baseRevision }
    })
}

export const nasPlaylistAPI = {
  list: () => requestNas<CloudSongList[]>('/playlists'),
  getSongs: (playlistId: string) =>
    requestNas<{ playlist?: any; list?: CloudSongDto[]; songs?: CloudSongDto[]; total?: number }>(
      `/playlists/${encodeURIComponent(playlistId)}/songs`
    ),
  upsert: (playlistId: string, data: UpdateUserSongListDto & { source?: string; semanticType?: string }) =>
    requestNas<{ id: string; updatedAt: string; revision?: number }>(
      `/playlists/${encodeURIComponent(playlistId)}`,
      {
        method: 'PATCH',
        body: {
          localId: data.localId,
          name: data.name,
          describe: data.describe,
          cover: coverToString(data.cover),
          source: data.source,
          semanticType: data.semanticType,
          orderOnly: data.orderOnly,
          position: data.position,
          songlist: data.songlist
        }
      }
    )
}

export const nasPodcastFavoriteAPI = {
  list: async () => normalizePodcastFavoritePage(await requestNas<unknown>('/favorites?entityType=podcast')),
  favorite: (input: ShuxiaPodcastFavoriteMutationInput) =>
    requestNas<ShuxiaFavoriteMutationResult>('/favorites', {
      method: 'POST',
      body: {
        entityType: 'podcast',
        entityId: podcastFavoriteKey(input.source, input.radioId),
        operationId: input.operationId,
        title: input.title,
        description: input.description,
        coverUrl: input.coverUrl,
        source: input.source,
        position: input.position,
        pinned: input.pinned,
        occurredAtMs: input.occurredAtMs,
        metadata: {
          radioId: input.radioId,
          author: input.author,
          total: input.total,
          playCount: input.playCount,
          position: input.position,
          pinned: Boolean(input.pinned),
          ...(Number(input.occurredAtMs) > 0 ? { occurredAtMs: input.occurredAtMs } : {})
        }
      }
    }),
  unfavorite: (source: string | undefined, radioId: string, operationId?: string, occurredAtMs?: number) =>
    requestNas<ShuxiaFavoriteMutationResult>(
      `/favorites/podcast/${encodeURIComponent(podcastFavoriteKey(source, radioId))}`,
      { method: 'DELETE', body: { operationId, occurredAtMs } }
    )
}

export const flushPendingPodcastFavoriteMutations = async () => {
  if (!(await canUseNasSync())) return
  const pending = readPendingPodcastFavoriteMutations()
  // 成员增删/更新先提交，排序最后提交，避免排序请求看到不完整的云端集合。
  const orderedMutations = [
    ...pending.filter((mutation) => mutation.operation !== 'reorder'),
    ...pending.filter((mutation) => mutation.operation === 'reorder')
  ]
  for (const mutation of orderedMutations) {
    if (mutation.operation === 'upsert') {
      await nasPodcastFavoriteAPI.favorite(mutation.input)
    } else if (mutation.operation === 'delete') {
      await nasPodcastFavoriteAPI.unfavorite(mutation.source, mutation.radioId, mutation.operationId, mutation.occurredAtMs)
    } else {
      try {
        await nasSyncAPI.reorderFavorites('podcast', mutation.orderedIds, mutation.baseRevision)
      } catch (error) {
        if (!(error instanceof NasSyncConflictError)) throw error
        const latest = (await nasPodcastFavoriteAPI.list()).items
          .sort((left, right) => (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER))
          .map((item) => podcastFavoriteKey(item.source, item.radioId))
        const latestSet = new Set(latest)
        const retry = [
          ...mutation.orderedIds.filter((id) => latestSet.has(id)),
          ...latest.filter((id) => !mutation.orderedIds.includes(id))
        ]
        if (retry.length === 0) throw error
        await nasSyncAPI.reorderFavorites(
          'podcast',
          retry,
          error.conflict.currentRevision ?? (await nasSyncAPI.snapshot()).revision
        )
      }
    }
    removePodcastFavoriteMutation(mutation.key)
  }
}

export const backupLocalPodcastFavoritesToCloud = async () => {
  if (!(await canUseNasSync())) return {uploaded: 0}
  const ordered = orderPodcastFavorites(readLocalPodcastFavorites(), readPodcastFavoritePins())

  for (const [index, favorite] of ordered.entries()) {
    const key = podcastFavoriteKey(favorite.source, favorite.radioId)
    const pending = readPendingPodcastFavoriteMutations().find((item) => item.key === key)
    const operationId = pending?.operation === 'upsert' ? pending.input.operationId : undefined
    const input = podcastFavoriteToMutation(favorite, index, Boolean(favorite.pinned), operationId || crypto.randomUUID())
    enqueuePodcastFavoriteMutation({operation: 'upsert', key, input})
    await nasPodcastFavoriteAPI.favorite(input)
    removePodcastFavoriteMutation(key)
  }

  return {uploaded: ordered.length}
}

export const listPodcastFavorites = async (): Promise<ShuxiaPodcastFavorite[]> => {
  const localItems = readLocalPodcastFavorites()
  const localPins = readPodcastFavoritePins()
  if (!(await canUseNasSync())) return orderPodcastFavorites(localItems, localPins)

  try {
    const pendingMutations = readPendingPodcastFavoriteMutations()
    const pendingDeleteKeys = new Set(
      pendingMutations.filter((mutation) => mutation.operation === 'delete').map((mutation) => mutation.key)
    )
    const remoteItems = (await nasPodcastFavoriteAPI.list()).items.filter(
      (item) => !pendingDeleteKeys.has(podcastFavoriteKey(item.source, item.radioId))
    )
    const pendingUpsertKeys = new Set(
      pendingMutations.filter((mutation) => mutation.operation === 'upsert').map((mutation) => mutation.key)
    )
    const pendingPinnedByKey = new Map(
      pendingMutations
        .filter((mutation) => mutation.operation === 'upsert')
        .map((mutation) => [mutation.key, Boolean(mutation.input.pinned)])
    )
    const pendingItems = localItems.filter((item) =>
      pendingUpsertKeys.has(podcastFavoriteKey(item.source, item.radioId))
    )
    const items = [
      ...pendingItems,
      ...remoteItems,
    ].filter((item, index, all) => {
      const key = podcastFavoriteKey(item.source, item.radioId)
      return all.findIndex((candidate) => podcastFavoriteKey(candidate.source, candidate.radioId) === key) === index
    })
    const remotePinnedKeys = remoteItems
      .filter((item) => item.pinned)
      .map((item) => podcastFavoriteKey(item.source, item.radioId))
    const mergedPins = [
      ...localPins.filter((key) => pendingPinnedByKey.get(key) === true),
      ...remotePinnedKeys.filter((key) => !pendingUpsertKeys.has(key)),
    ].filter((key, index, all) => key && all.indexOf(key) === index)
    const ordered = orderPodcastFavorites(items, mergedPins)
    writePodcastFavoritePins(mergedPins)
    localStorage.setItem(PODCAST_FAVORITES_STORAGE_KEY, JSON.stringify(ordered))
    return ordered
  } catch {
    return orderPodcastFavorites(localItems, localPins)
  }
}

export const replaceLocalPodcastFavoritesFromCloud = async (): Promise<ShuxiaPodcastFavorite[]> => {
  if (!(await canUseNasSync())) return readLocalPodcastFavorites()

  const pending = readPendingPodcastFavoriteMutations()
  const pendingDeleteKeys = new Set(pending.filter((item) => item.operation === 'delete').map((item) => item.key))
  const pendingUpsertKeys = new Set(pending.filter((item) => item.operation === 'upsert').map((item) => item.key))
  const remoteItems = (await nasPodcastFavoriteAPI.list()).items.filter(
    (item) => !pendingDeleteKeys.has(podcastFavoriteKey(item.source, item.radioId))
  )
  const remoteOrdered = [...remoteItems].sort((left, right) => {
    const pinnedDelta = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
    if (pinnedDelta !== 0) return pinnedDelta
    const leftPosition = typeof left.position === 'number' ? left.position : Number.MAX_SAFE_INTEGER
    const rightPosition = typeof right.position === 'number' ? right.position : Number.MAX_SAFE_INTEGER
    if (leftPosition !== rightPosition) return leftPosition - rightPosition
    return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
  })
  const remoteKeys = new Set(remoteOrdered.map((item) => podcastFavoriteKey(item.source, item.radioId)))
  // 云端没有的播客就是其他设备取消了。只保留本机还没上传成功的新收藏。
  const pendingLocalAdds = readLocalPodcastFavorites().filter((item) => {
    const key = podcastFavoriteKey(item.source, item.radioId)
    return pendingUpsertKeys.has(key) && !remoteKeys.has(key)
  })
  const ordered = [...pendingLocalAdds, ...remoteOrdered]
  const pins = ordered
    .filter((item) => item.pinned)
    .map((item) => podcastFavoriteKey(item.source, item.radioId))
  writePodcastFavoritePins(pins)
  writeLocalPodcastFavorites(ordered, false)
  return ordered
}

export const setPodcastFavoriteFromSyncEvent = (payload: unknown, deleted = false) => {
  const favorite = normalizePodcastFavorite(payload)
  if (!favorite) return
  const key = podcastFavoriteKey(favorite.source, favorite.radioId)
  const pins = readPodcastFavoritePins().filter((item) => item !== key)
  if (!deleted && favorite.pinned) {
    pins.unshift(key)
  }
  writePodcastFavoritePins(pins)
  const existing = readLocalPodcastFavorites().filter(
    (item) => podcastFavoriteKey(item.source, item.radioId) !== key
  )
  const items = deleted
    ? existing
    : [...existing, favorite].sort((left, right) => {
        const leftPosition = typeof left.position === 'number' && Number.isFinite(left.position)
          ? left.position
          : Number.MAX_SAFE_INTEGER
        const rightPosition = typeof right.position === 'number' && Number.isFinite(right.position)
          ? right.position
          : Number.MAX_SAFE_INTEGER
        if (leftPosition !== rightPosition) return leftPosition - rightPosition
        return 0
      })
  writeLocalPodcastFavorites(orderPodcastFavorites(items, pins), false)
}

export const favoritePodcast = async (input: ShuxiaPodcastFavoriteMutationInput) => {
  const pins = readPodcastFavoritePins()
  const currentItems = readLocalPodcastFavorites()
  const favorite: ShuxiaPodcastFavorite = {
    id: podcastFavoriteKey(input.source, input.radioId),
    ...input,
    pinned: false,
    position: 0,
    updatedAt: new Date().toISOString()
  }
  const key = podcastFavoriteKey(input.source, input.radioId)
  const existing = currentItems.filter(
    (item) => podcastFavoriteKey(item.source, item.radioId) !== key
  )
  const firstUnpinned = existing.findIndex(
    (item) => !pins.includes(podcastFavoriteKey(item.source, item.radioId))
  )
  const insertAt = firstUnpinned >= 0 ? firstUnpinned : existing.length
  const nextItems = orderPodcastFavorites(
    [
      ...existing.slice(0, insertAt),
      favorite,
      ...existing.slice(insertAt)
    ],
    pins
  )
  const mutationInput = podcastFavoriteToMutation(
    nextItems.find((item) => podcastFavoriteKey(item.source, item.radioId) === key) || favorite,
    nextItems.findIndex((item) => podcastFavoriteKey(item.source, item.radioId) === key),
    false,
    crypto.randomUUID()
  )
  writePodcastFavoritePins(pins)
  writeLocalPodcastFavorites(nextItems)
  enqueuePodcastFavoriteMutation({ operation: 'upsert', key, input: mutationInput })

  if (!(await canUseNasSync())) return { favorite, syncError: null }
  try {
    await nasPodcastFavoriteAPI.favorite(mutationInput)
    removePodcastFavoriteMutation(key)
    return { favorite, syncError: null }
  } catch (error) {
    return { favorite, syncError: error instanceof Error ? error : new Error('收藏同步失败') }
  }
}

export const unfavoritePodcast = async (source: string | undefined, radioId: string) => {
  const key = podcastFavoriteKey(source, radioId)
  const pins = readPodcastFavoritePins().filter((item) => item !== key)
  writePodcastFavoritePins(pins)
  writeLocalPodcastFavorites(
    orderPodcastFavorites(
      readLocalPodcastFavorites().filter(
        (item) => podcastFavoriteKey(item.source, item.radioId) !== key
      ),
      pins
    )
  )
  const occurredAtMs = Date.now()
  enqueuePodcastFavoriteMutation({ operation: 'delete', key, source, radioId, operationId: crypto.randomUUID(), occurredAtMs })

  if (!(await canUseNasSync())) return { syncError: null }
  try {
    const pending = readPendingPodcastFavoriteMutations().find((item) => item.key === key)
    await nasPodcastFavoriteAPI.unfavorite(
      source,
      radioId,
      pending?.operation === 'delete' ? pending.operationId : undefined,
      pending?.operation === 'delete' ? pending.occurredAtMs : occurredAtMs
    )
    removePodcastFavoriteMutation(key)
    return { syncError: null }
  } catch (error) {
    return { syncError: error instanceof Error ? error : new Error('取消收藏同步失败') }
  }
}

export const togglePodcastFavoritePinned = async (source: string | undefined, radioId: string) => {
  const key = podcastFavoriteKey(source, radioId)
  const items = await listPodcastFavorites()
  const favorite = items.find((item) => podcastFavoriteKey(item.source, item.radioId) === key)
  if (!favorite) return { items, syncError: new Error('未找到播客收藏') }

  const wasPinned = readPodcastFavoritePins().includes(key) || Boolean(favorite.pinned)
  const pins = wasPinned
    ? readPodcastFavoritePins().filter((item) => item !== key)
    : [key, ...readPodcastFavoritePins().filter((item) => item !== key)]
  const remaining = items.filter((item) => podcastFavoriteKey(item.source, item.radioId) !== key)
  let nextItems: ShuxiaPodcastFavorite[]
  if (wasPinned) {
    const firstUnpinned = remaining.findIndex(
      (item) => !pins.includes(podcastFavoriteKey(item.source, item.radioId))
    )
    const insertAt = firstUnpinned >= 0 ? firstUnpinned : remaining.length
    nextItems = [...remaining.slice(0, insertAt), favorite, ...remaining.slice(insertAt)]
  } else {
    nextItems = [favorite, ...remaining]
  }

  const ordered = orderPodcastFavorites(nextItems, pins)
  writePodcastFavoritePins(pins)
  writeLocalPodcastFavorites(ordered)
  enqueuePodcastFavoriteMutation({
    operation: 'reorder',
    key: '__order__',
    orderedIds: ordered.map((item) => podcastFavoriteKey(item.source, item.radioId)),
    operationId: crypto.randomUUID()
  })

  let syncError: Error | null = null
  ordered.forEach((item, index) => {
    const itemKey = podcastFavoriteKey(item.source, item.radioId)
    const pending = readPendingPodcastFavoriteMutations().find((entry) => entry.key === itemKey)
    const operationId = pending?.operation === 'upsert' ? pending.input.operationId : undefined
    const input = podcastFavoriteToMutation(item, index, pins.includes(itemKey), operationId || crypto.randomUUID())
    enqueuePodcastFavoriteMutation({ operation: 'upsert', key: itemKey, input })
  })

  if (await canUseNasSync()) {
    try {
      await flushPendingPodcastFavoriteMutations()
    } catch (error) {
      syncError = error instanceof Error ? error : new Error('播客置顶同步失败')
    }
  }

  return { items: ordered, syncError }
}

export const nasFavoriteAPI = {
  listPodcastFavorites: async () => ({ items: await listPodcastFavorites() }),
  listPlaylistFavorites: async () => normalizePlaylistFavoritePage(await requestNas<unknown>('/playlist-favorites')),
  favoritePlaylist: (input: ShuxiaPlaylistFavoriteMutationInput) =>
    requestNas<ShuxiaFavoriteMutationResult>('/playlist-favorites', { method: 'POST', body: input }),
  unfavoritePlaylist: (playlistId: string) =>
    requestNas<ShuxiaFavoriteMutationResult>('/playlist-favorites', {
      method: 'DELETE',
      body: { playlistId, occurredAtMs: Date.now() }
    })
}

export const getPreferredSongListAPI = async () => (await canUseNasSync() ? nasCloudSongListAPI : null)
export const getPreferredFavoriteAPI = async () => (await canUseNasSync() ? nasFavoriteAPI : null)
export const getAutoSyncSongListAPI = async () =>
  (await canUseNasSync()) && (await getNasSyncMode()) === 'auto' ? nasCloudSongListAPI : null
export const getAutoSyncFavoriteAPI = async () =>
  (await canUseNasSync()) && (await getNasSyncMode()) === 'auto' ? nasFavoriteAPI : null
