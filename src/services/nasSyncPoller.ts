import songListAPI from '@renderer/api/songList'
import {
  backupLocalPodcastFavoritesToCloud,
  canUseNasSync,
  flushPendingPodcastFavoriteMutations,
  getNasSyncMode,
  getNasSyncScope,
  getScopedNasSyncLastRevision,
  nasCloudSongListAPI,
  nasPlaylistAPI,
  nasSyncAPI,
  NasSyncConflictError,
  replaceLocalPodcastFavoritesFromCloud,
  setPodcastFavoriteFromSyncEvent,
  setScopedNasSyncLastRevision
} from '@renderer/api/nasSync'
import { openNasSyncStream, type NasSyncStreamHandle } from '@renderer/api/nasSync'
import {
  isBridgedPlaylist,
  isBridgedRemotePlaylist,
  isLocalBridgedMirror,
  isStaleBridgedCloudCopy
} from '@renderer/utils/playlist/bridgedPlaylist'
import { mapCloudSongToLocal, mapSongsToCloud } from '@renderer/utils/playlist/cloudList'
import {
  FAVORITES_PLAYLIST_NAME,
  applyRemotePlaylistSongs,
  beginRemoteSongApply,
  ensureLocalFavoritesPlaylist,
  flushPendingFavoriteSongOperations,
  flushPendingPlaylistMutations,
  markPlaylistCloudSyncOk
} from '@renderer/utils/playlist/cloudLibrarySync'
import {
  applyRemotePluginEvent,
  backupLocalPluginsToCloud,
  flushPendingPluginDeletes,
  flushPendingPluginUpserts,
  isPluginSyncInitialized,
  markPluginSyncInitialized,
  restorePluginsFromCloud
} from '@renderer/utils/playlist/pluginSync'
import {
  emitFavoritesSync,
  emitPlaylistSync,
  emitPodcastSync,
  emitPluginSync
} from '@renderer/utils/sync/realtimeSyncBus'
import type { SongList, Songs } from '@common/types/songList'

const LONG_POLL_TIMEOUT_MS = 8_000
const LONG_POLL_RETRY_MS = 250
const EMPTY_POLL_FLOOR_MS = 2_000
const CONFIG_NOT_READY_RETRY_MS = 2_000
// 入站长轮询遇到错误时的重试间隔。之前是 120s/300s，一旦出一次错，
// 本机就会几分钟不再拉取，导致其他设备（安卓）的新收藏迟迟收不到。
// 改成秒级快速重试，保证入站延迟始终在秒级。
const ERROR_BACKOFF_MS = 5_000
const OFFLINE_POLL_RETRY_MS = 15_000
// 仅用于「离线」日志的节流，避免刷屏；与上面的轮询重试间隔解耦。
const OFFLINE_BACKOFF_MS = 300_000
const LOCAL_CHANGE_DEBOUNCE_MS = 750
const NAS_SYNC_SERVICE_NAME = 'NAS 多端同步'

let timer: number | null = null
let localBackupTimer: number | null = null
let running = false
let stopped = true
let applyingRemoteEvents = false
// 页面事件监听不能在远端事件尚未落库时再次拉取云端并冲刷本地 outbox。
// 否则取消收藏可能先被删除，随后又被旧快照/旧待办写回。
export const isNasSyncApplyingRemoteEvents = () => applyingRemoteEvents
let initialSyncRunning = false
let suppressLocalChangeEventsUntil = 0
let syncServerOffline = false
let lastOfflineLogAt = 0
let cachedNasSyncPluginId: string | null = null
let streamHandle: NasSyncStreamHandle | null = null
let streamStarting = false
let streamRetryTimer: number | null = null
let streamRetryAttempt = 0
let nasSyncPluginLookupAt = 0
let deviceRegistered = false
let deviceRegistrationPromise: Promise<void> | null = null
const NAS_SYNC_PLUGIN_CACHE_MS = 60_000

type NasSyncEvent = {
  revision?: number
  entityType?: string
  entityId?: string
  action?: string
  payload?: any
  createdAt?: string
  deletedAt?: string | null
}

type NasSyncSnapshot = {
  revision: number
  nextRevision?: number
  hasMore?: boolean
  requiresRefresh?: boolean
  events?: unknown[]
}

const clearTimer = () => {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
}

const clearLocalBackupTimer = () => {
  if (localBackupTimer !== null) {
    window.clearTimeout(localBackupTimer)
    localBackupTimer = null
  }
}

const suppressLocalChangeEvents = () => {
  suppressLocalChangeEventsUntil = Date.now() + LOCAL_CHANGE_DEBOUNCE_MS
}

const getNextInterval = (hadEvents = false, elapsedMs = 0) => {
  if (hadEvents) return LONG_POLL_RETRY_MS
  return Math.max(LONG_POLL_RETRY_MS, EMPTY_POLL_FLOOR_MS - elapsedMs)
}

const scheduleNext = (delay = getNextInterval()) => {
  clearTimer()
  if (stopped) return
  timer = window.setTimeout(() => {
    void pollNasSync()
  }, delay)
}

const ensureRealtimeStream = async () => {
  if (stopped || streamHandle || streamStarting || !(await canUseNasSync())) return
  if (streamRetryTimer !== null) {
    window.clearTimeout(streamRetryTimer)
    streamRetryTimer = null
  }
  streamStarting = true
  try {
    await ensureDeviceRegistered()
    const cursor = await getScopedNasSyncLastRevision()
    const handle = await openNasSyncStream(cursor, () => {
      // The stream is only a wake-up. The normal poll path applies events and
      // advances the cursor atomically after successful local application.
      scheduleNext(0)
    })
    streamHandle = handle
    void handle.finished.then((unexpectedEnd) => {
      if (streamHandle !== handle) return
      streamHandle = null
      if (stopped) return
      streamRetryAttempt = unexpectedEnd ? 0 : Math.min(streamRetryAttempt + 1, 6)
      const delay = unexpectedEnd ? 1_000 : Math.min(30_000, 1_000 * 2 ** (streamRetryAttempt - 1))
      scheduleNext(0)
      streamRetryTimer = window.setTimeout(() => {
        streamRetryTimer = null
        void ensureRealtimeStream()
      }, delay)
    })
  } catch {
    deviceRegistered = false
    streamHandle = null
    if (!stopped) {
      streamRetryAttempt = Math.min(streamRetryAttempt + 1, 6)
      const delay = Math.min(30_000, 1_000 * 2 ** (streamRetryAttempt - 1))
      streamRetryTimer = window.setTimeout(() => {
        streamRetryTimer = null
        void ensureRealtimeStream()
      }, delay)
    }
  } finally {
    streamStarting = false
  }
}

const notifySyncEvents = (events: unknown[], revision: number) => {
  suppressLocalChangeEvents()
  window.dispatchEvent(
    new CustomEvent('ceru-nas-sync-events', {
      detail: { events, revision }
    })
  )
  window.dispatchEvent(new CustomEvent('playlist-updated', { detail: { remote: true } }))
}

const summarizeNasSyncEvent = (event: NasSyncEvent) => {
  const payload = event.payload || {}
  const revisionText = typeof event.revision === 'number' ? `#${event.revision}` : '-'

  if (event.entityType === 'playlist') {
    const playlistName = payload.title || payload.name || event.entityId || '未命名歌单'
    if (event.action === 'delete') {
      return `[同步事件 ${revisionText}] 歌单已删除: ${playlistName}`
    }
    return `[同步事件 ${revisionText}] 歌单已更新: ${playlistName}`
  }

  if (event.entityType === 'playlistSongs') {
    const playlistId = payload.playlistId || event.entityId || '未知歌单'
    if (event.action === 'delete') {
      const removedCount = Array.isArray(payload.songIds) ? payload.songIds.length : 0
      return `[同步事件 ${revisionText}] 歌单歌曲已减少: ${playlistId}，删除 ${removedCount} 首`
    }
    if (event.action === 'upsert') {
      const addedCount = Array.isArray(payload.songs) ? payload.songs.length : 0
      return `[同步事件 ${revisionText}] 歌单歌曲已变更: ${playlistId}，同步 ${addedCount} 首`
    }
  }

  if (event.entityType === 'favorite') {
    const isPodcast = payload.entityType === 'podcast'
    const label = isPodcast ? '播客收藏' : '收藏歌单'
    if (event.action === 'delete') {
      return `[同步事件 ${revisionText}] ${label}已取消收藏`
    }
    return `[同步事件 ${revisionText}] ${label}已同步`
  }

  if (event.entityType === 'plugin') {
    const label = payload.kind === 'capability' ? `能力 ${payload.role || payload.identityKey || ''}` : `插件 ${payload.name || payload.identityKey || ''}`
    if (event.action === 'delete') {
      return `[同步事件 ${revisionText}] ${label}已删除`
    }
    return `[同步事件 ${revisionText}] ${label}已同步`
  }

  return `[同步事件 ${revisionText}] ${event.entityType || 'unknown'}:${event.action || 'unknown'}`
}

const resolveNasSyncPluginId = async () => {
  const now = Date.now()
  if (cachedNasSyncPluginId && now - nasSyncPluginLookupAt < NAS_SYNC_PLUGIN_CACHE_MS) {
    return cachedNasSyncPluginId
  }
  const plugins = await window.api.plugins.loadAllPlugins().catch(() => [])
  if (!Array.isArray(plugins)) return null
  const plugin = plugins.find(
    (item: any) => item?.pluginType === 'service' && item?.serviceRole === 'nas-sync'
  )
  cachedNasSyncPluginId = plugin?.pluginId || null
  nasSyncPluginLookupAt = now
  return cachedNasSyncPluginId
}

const appendNasSyncLogs = async (events: unknown[]) => {
  const pluginId = await resolveNasSyncPluginId()
  if (!pluginId) return
  for (const rawEvent of events) {
    const event = rawEvent as NasSyncEvent
    const message = summarizeNasSyncEvent(event)
    await window.api.plugins
      .appendPluginLog(pluginId, 'info', NAS_SYNC_SERVICE_NAME, message)
      .catch(() => {})
  }
}

const appendNasSyncLog = async (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
  const pluginId = await resolveNasSyncPluginId()
  if (!pluginId) return
  await window.api.plugins
    .appendPluginLog(pluginId, level, NAS_SYNC_SERVICE_NAME, message)
    .catch(() => {})
}

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : '未知错误'

const markNasSyncOffline = async (error: unknown) => {
  const now = Date.now()
  if (!syncServerOffline || now - lastOfflineLogAt > OFFLINE_BACKOFF_MS) {
    syncServerOffline = true
    lastOfflineLogAt = now
    await appendNasSyncLog(`[同步服务离线] ${getErrorMessage(error)}，已暂停前台提示，稍后后台重试`, 'warn')
  }
}

const markNasSyncOnline = async () => {
  if (!syncServerOffline) return
  syncServerOffline = false
  await appendNasSyncLog('[同步服务恢复] 连接成功，正在同步变更')
}

const ensureDeviceRegistered = async () => {
  if (deviceRegistered) return
  if (!deviceRegistrationPromise) {
    deviceRegistrationPromise = (async () => {
      await nasSyncAPI.registerDevice('desktop')
      deviceRegistered = true
      await appendNasSyncLog('[设备注册] Mac 已连接同步服务，开始消费服务器事件')
    })().finally(() => {
      deviceRegistrationPromise = null
    })
  }
  await deviceRegistrationPromise
}

const getLocalPlaylistByRemoteId = async (remoteId: string, localId?: string) => {
  if (localId) {
    const byLocalId = await songListAPI.getById(localId)
    if (byLocalId.success && byLocalId.data) return byLocalId.data
  }

  const all = await songListAPI.getAll()
  const playlists = all.success && Array.isArray(all.data) ? all.data : []
  return (
    playlists.find((playlist) => playlist.meta?.cloudId === remoteId) ||
    playlists.find((playlist) => playlist.id === localId)
  )
}

const createOrUpdateLocalPlaylist = async (remotePlaylist: any) => {
  const remoteId = String(remotePlaylist.id || remotePlaylist.playlistId || '')
  if (!remoteId) return null

  const localId = remotePlaylist.localId ? String(remotePlaylist.localId) : undefined
  const existing = await getLocalPlaylistByRemoteId(remoteId, localId)
  const name = remotePlaylist.name || remotePlaylist.title || '未命名歌单'
  const description = remotePlaylist.description || remotePlaylist.describe || ''
  const coverImgUrl = remotePlaylist.coverImgUrl || remotePlaylist.coverUrl || remotePlaylist.cover || 'default-cover'
  const source = (remotePlaylist.source || 'local') as SongList['source']
  const semanticType = remotePlaylist.semanticType || remotePlaylist.semantic || remotePlaylist.meta?.semantic
  const meta = {
    ...(existing?.meta || {}),
    cloudId: remoteId,
    localUpdatedAt: remotePlaylist.updatedAt || new Date().toISOString(),
    ...(semanticType ? { semantic: semanticType } : {})
  }

  if (existing) {
    await songListAPI.edit(existing.id, {
      name,
      description,
      coverImgUrl,
      source,
      meta
    })
    return { ...existing, name, description, coverImgUrl, source, meta }
  }

  const created = await songListAPI.create(name, description, source, meta)
  if (!created.success || !created.data?.id) {
    throw new Error(created.error || '创建本地歌单失败')
  }
  if (coverImgUrl && coverImgUrl !== 'default-cover') {
    await songListAPI.updateCover(created.data.id, coverImgUrl).catch(() => null)
  }
  return {
    id: created.data.id,
    name,
    description,
    coverImgUrl,
    createTime: new Date().toISOString(),
    updateTime: new Date().toISOString(),
    source,
    meta
  } as SongList
}

const replaceLocalPlaylistSongs = async (
  localId: string,
  remoteSongs: readonly any[],
  remotePlaylistId?: string
) => {
  await applyRemotePlaylistSongs(localId, remoteSongs, remotePlaylistId)
}

const clearPlaylistCloudBinding = async (playlist: SongList) => {
  const meta = { ...(playlist.meta || {}) }
  delete meta.cloudId
  delete meta.cloudUpdatedAt
  delete meta.cloudSyncPending
  delete meta.cloudSyncOperation
  delete meta.cloudSyncError
  delete meta.cloudSyncFailedAt
  delete meta.isCloudOnly
  await songListAPI.edit(playlist.id, { meta })
}

const discardStaleBridgedCloudCopy = async (remoteId: string, localId?: string) => {
  const existing = await getLocalPlaylistByRemoteId(remoteId, localId)
  if (!existing) return
  if (isLocalBridgedMirror(existing)) {
    await clearPlaylistCloudBinding(existing)
    return
  }
  await songListAPI.delete(existing.id)
}

const applyRemoteEvent = async (event: NasSyncEvent) => {
  const payload = event.payload || {}

  if (event.action === 'reorder' && event.entityType === 'playlist') {
    const orderedIds = Array.isArray(payload.orderedIds) ? payload.orderedIds.map(String) : []
    if (orderedIds.length === 0) return
    const localRes = await songListAPI.getAll()
    const localPlaylists = localRes.success && Array.isArray(localRes.data) ? localRes.data : []
    const byCloudId = new Map(localPlaylists.map((playlist) => [String(playlist.meta?.cloudId || ''), playlist]))
    const ordered = orderedIds.map((id) => byCloudId.get(id))
    // 重排必须是完整快照。缺少任意一个本地绑定时拒绝写入，等待下一次完整同步。
    if (
      ordered.length !== localPlaylists.filter((playlist) => playlist.meta?.cloudId).length ||
      ordered.some((playlist) => !playlist)
    ) {
      throw new Error('本地歌单不完整，暂不确认云端排序事件')
    }
    const orderedLocalIds = ordered.map((playlist) => playlist!.id)
    suppressLocalChangeEvents()
    const result = await songListAPI.reorderPlaylists(orderedLocalIds)
    if (!result.success) throw new Error('本地歌单排序应用失败: ' + (result.error || '未知错误'))
    window.dispatchEvent(new CustomEvent('playlist-updated', { detail: { remote: true } }))
    emitPlaylistSync('reorder', 'remote', payload)
    return
  }

  if (event.entityType === 'playlist') {
    const remoteId = String(payload.id || event.entityId || '')
    if (!remoteId) return

    if (isBridgedRemotePlaylist(payload)) {
      if (event.action === 'delete') {
        await discardStaleBridgedCloudCopy(remoteId, payload.localId)
      }
      window.dispatchEvent(new CustomEvent('playlist-updated', { detail: { remote: true } }))
      emitPlaylistSync('update', 'remote', payload)
      return
    }

    const existing = await getLocalPlaylistByRemoteId(remoteId, payload.localId)
    if (event.action === 'delete') {
      if (existing) {
        if (isLocalBridgedMirror(existing)) {
          await clearPlaylistCloudBinding(existing)
        } else {
          await songListAPI.delete(existing.id)
        }
      }
      window.dispatchEvent(new CustomEvent('playlist-updated', { detail: { remote: true } }))
      emitPlaylistSync('remove', 'remote', payload)
      return
    }

    const playlist = await createOrUpdateLocalPlaylist(payload)
    if (!playlist?.id) return
    window.dispatchEvent(new CustomEvent('playlist-updated', { detail: { remote: true } }))
    const detail = await nasPlaylistAPI.getSongs(remoteId).catch(() => null)
    if (!detail) throw new Error('读取云端歌单失败，保留本地数据')
    const songs = detail.songs || detail.list
    if (!Array.isArray(songs)) throw new Error('云端歌单响应缺少歌曲列表')
    await replaceLocalPlaylistSongs(playlist.id, songs, remoteId)
    window.dispatchEvent(new Event('playlist-updated'))
    emitPlaylistSync(event.action === 'delete' ? 'remove' : 'update', 'remote', payload)
    return
  }

  if (event.entityType === 'playlistSongs') {
    beginRemoteSongApply()
    const remoteId = String(payload.playlistId || event.entityId || '')
    if (!remoteId) return
    let existing: SongList | undefined = await getLocalPlaylistByRemoteId(remoteId)
    // “我的喜欢”可能在本地已经创建，但首次云端绑定尚未把 cloudId
    // 写回本地。单曲收藏事件仍然必须落到这张系统歌单，不能因为缺少
    // cloudId 就被静默跳过。
    if (!existing) {
      const allLocal = await songListAPI.getAll()
      const localPlaylists = allLocal.success && Array.isArray(allLocal.data) ? allLocal.data : []
      existing = localPlaylists.find(
        (playlist) =>
          playlist.meta?.semantic === 'favorites' || playlist.name === FAVORITES_PLAYLIST_NAME
      )
    }
    if (!existing) {
      const remoteLists = await nasPlaylistAPI.list().catch(() => [])
      const remote = Array.isArray(remoteLists)
        ? remoteLists.find((item: any) => String(item.id || item.playlistId || '') === remoteId)
        : null
      if (remote) existing = ((await createOrUpdateLocalPlaylist(remote)) as SongList | null) || undefined
    }
    if (!existing) return
    const favoritesList =
      existing.meta?.semantic === 'favorites' || existing.name === FAVORITES_PLAYLIST_NAME
    if (event.action === 'delete' && Array.isArray(payload.songIds) && payload.songIds.length > 0) {
      await songListAPI.removeSongs(existing.id, payload.songIds.map(String))
      window.dispatchEvent(new CustomEvent('playlist-updated', { detail: { remote: true } }))
      if (favoritesList) {
        window.dispatchEvent(new Event('ceru-favorites-updated'))
        emitFavoritesSync('update', 'remote', payload)
      }
    } else if (event.action === 'upsert' && Array.isArray(payload.songs) && payload.songs.length > 0) {
      const immediate = payload.songs
        .map((song) => mapCloudSongToLocal(song) as Songs)
        .filter((song) => String(song?.songmid || '').trim())
      if (immediate.length > 0) {
        await songListAPI.addSongs(existing.id, immediate)
        window.dispatchEvent(new CustomEvent('playlist-updated', { detail: { remote: true } }))
        if (favoritesList) {
          window.dispatchEvent(new Event('ceru-favorites-updated'))
          emitFavoritesSync('update', 'remote', payload)
        }
      }
    }
    // 这一条先显示。完整列表只负责把顺序对齐，不能挡住当前页。
    const detail = await nasPlaylistAPI.getSongs(remoteId).catch(() => null)
    const fetched = detail?.songs || detail?.list
    if (!Array.isArray(fetched)) {
      window.dispatchEvent(new CustomEvent('playlist-updated', { detail: { remote: true } }))
      if (favoritesList) {
        window.dispatchEvent(new Event('ceru-favorites-updated'))
        emitFavoritesSync('update', 'remote', payload)
      }
      return
    }
    let songs = [...fetched]
    if (event.action === 'delete' && Array.isArray(payload.songIds)) {
      const removed = new Set(payload.songIds.map((id) => String(id)))
      songs = songs.filter((song) => {
        const raw = song as { trackKey?: string; id?: string; songmid?: string; source?: string }
        const key = String(raw.trackKey || raw.id || (raw.source && raw.songmid ? `${raw.source}:${raw.songmid}` : raw.songmid || ''))
        return key && !removed.has(key)
      })
    } else if (event.action === 'upsert' && Array.isArray(payload.songs)) {
      const songKey = (song: { trackKey?: string; id?: string; songmid?: string; source?: string }) =>
        String(song.trackKey || song.id || (song.source && song.songmid ? `${song.source}:${song.songmid}` : song.songmid || ''))
      const seen = new Set(songs.map((song) => songKey(song as { trackKey?: string; id?: string; songmid?: string; source?: string })))
      for (const song of payload.songs as Array<{ trackKey?: string; id?: string; songmid?: string; source?: string }>) {
        const key = songKey(song)
        if (key && !seen.has(key)) songs.unshift(song as (typeof songs)[number])
      }
    }
    await replaceLocalPlaylistSongs(existing.id, songs, remoteId)
    const isFavorites =
      existing.meta?.semantic === 'favorites' || existing.name === FAVORITES_PLAYLIST_NAME
    if (isFavorites) {
      // 单曲收藏走 playlist-song-ops，服务端发布的事件类型仍是
      // playlistSongs。明确广播收藏事件，让已打开的“我的喜欢”页面立即重读。
      window.dispatchEvent(new Event('ceru-favorites-updated'))
      emitFavoritesSync('update', 'remote', payload)
    }
    window.dispatchEvent(new CustomEvent('playlist-updated', { detail: { remote: true } }))
    emitPlaylistSync('update', 'remote', payload)
    return
  }

  if (event.entityType === 'plugin') {
    if (event.action === 'reorder') {
      await restorePluginsFromCloud(false)
      emitPluginSync('reorder', 'remote', payload)
      return
    }
    await applyRemotePluginEvent(payload, event.action === 'delete')
    window.dispatchEvent(new Event('plugin-updated'))
    emitPluginSync(event.action === 'delete' ? 'remove' : 'update', 'remote', payload)
    return
  }

  // 播客排序事件只携带完整 orderedIds，不是单条收藏记录。重新读取服务端
  // 的完整列表，才能同时恢复 pinned 和 position，避免把排序事件当成空收藏。
  if (event.entityType === 'favorite' && event.action === 'reorder' && payload.entityType === 'podcast') {
    await replaceLocalPodcastFavoritesFromCloud()
    window.dispatchEvent(new Event('ceru-podcast-favorites-updated'))
    emitPodcastSync('reorder', 'remote', payload)
    return
  }

  if (event.entityType === 'favorite' && payload.entityType === 'podcast') {
    await replaceLocalPodcastFavoritesFromCloud()
    setPodcastFavoriteFromSyncEvent(payload, event.action === 'delete')
    window.dispatchEvent(new Event('ceru-podcast-favorites-updated'))
    emitPodcastSync(event.action === 'delete' ? 'remove' : 'update', 'remote', payload)
    return
  }

  // 收藏歌单要变成 Mac 本地歌单里的一张歌单，不能只刷新页面。
  if (event.entityType === 'favorite' && payload.entityType === 'playlist') {
    const remoteId = String(payload.playlistId || payload.entityId || '')
    const semantic = String(payload.semanticType || payload.semantic || '')
    const name = String(payload.title || payload.name || '')
    const favoritesRelation = semantic === 'favorites' || name === FAVORITES_PLAYLIST_NAME
    if (event.action === 'delete') {
      if (remoteId && !favoritesRelation) {
        const existing = await getLocalPlaylistByRemoteId(remoteId, payload.localId)
        if (existing && !isLocalBridgedMirror(existing)) await songListAPI.delete(existing.id)
      }
      window.dispatchEvent(new CustomEvent('playlist-updated', { detail: { remote: true } }))
      emitPlaylistSync('remove', 'remote', payload)
      return
    }
    if (remoteId && !favoritesRelation && !isBridgedRemotePlaylist(payload)) {
      const detail = await nasPlaylistAPI.getSongs(remoteId).catch(() => null)
      const remotePlaylist = detail?.playlist || {}
      const playlist = await createOrUpdateLocalPlaylist({
        ...payload,
        ...remotePlaylist,
        id: remotePlaylist.id || remotePlaylist.playlistId || remoteId,
        name: remotePlaylist.name || payload.title || payload.name || '未命名歌单',
        description: remotePlaylist.description || remotePlaylist.describe || payload.description || '',
        coverUrl: remotePlaylist.coverUrl || remotePlaylist.cover || payload.coverUrl || payload.cover,
        localId: remotePlaylist.localId || payload.localId
      })
      const songs = detail?.songs || detail?.list
      if (playlist?.id && Array.isArray(songs)) {
        await replaceLocalPlaylistSongs(playlist.id, songs, remoteId)
      }
    }
    window.dispatchEvent(new CustomEvent('playlist-updated', { detail: { remote: true } }))
    emitPlaylistSync('update', 'remote', payload)
  }
}

const applyRemoteEvents = async (events: unknown[]) => {
  if (!Array.isArray(events) || events.length === 0) return
  applyingRemoteEvents = true
  try {
    for (const rawEvent of events) {
      await applyRemoteEvent(rawEvent as NasSyncEvent)
    }
  } finally {
    applyingRemoteEvents = false
  }
}

const uploadPlaylistSnapshot = async (playlist: SongList, positionIndex?: number) => {
  if (playlist.meta?.isCloudOnly) return null
  const songsRes = await songListAPI.getSongs(playlist.id)
  const songs = songsRes.success && Array.isArray(songsRes.data) ? songsRes.data : []
  if (isBridgedPlaylist(playlist, songs)) return null
  const isFavorites = playlist.meta?.semantic === 'favorites' || playlist.name === FAVORITES_PLAYLIST_NAME
  const semanticType = isFavorites ? 'favorites' : playlist.meta?.semantic
  let remoteId = playlist.meta?.cloudId

  if (!remoteId) {
    const remotePlaylists = await nasPlaylistAPI.list().catch(() => [])
    const matched = Array.isArray(remotePlaylists)
      ? remotePlaylists.find(
          (item: any) =>
            item.localId === playlist.id ||
            (semanticType === 'favorites' &&
              (item.semanticType === 'favorites' || item.name === playlist.name))
        )
      : null
    remoteId = matched?.id
  }

  if (remoteId) {
    let shouldSeedSongs = false
    let shouldSyncFavoriteOrder = false
    if (isFavorites) {
      await flushPendingFavoriteSongOperations()
      const detail = await nasPlaylistAPI.getSongs(remoteId).catch(() => null)
      if (!detail) throw new Error('读取云端歌单失败，跳过本地快照覆盖')
      const remoteSongs = detail.songs || detail.list
      if (!Array.isArray(remoteSongs)) throw new Error('云端歌单响应缺少歌曲列表')
      shouldSeedSongs = remoteSongs.length === 0 && songs.length > 0
      const localCloudSongs = mapSongsToCloud(songs, true)
      const key = (song: any) => `${String(song?.source || '').trim().toLowerCase()}:${String(song?.songmid || song?.id || '').trim()}`
      shouldSyncFavoriteOrder =
        !shouldSeedSongs &&
        remoteSongs.map(key).sort().join('\n') === localCloudSongs.map(key).sort().join('\n')
    }
    const result = await nasPlaylistAPI.upsert(remoteId, {
      listId: remoteId,
      localId: playlist.id,
      name: playlist.name,
      describe: playlist.description || '',
      cover: playlist.coverImgUrl && playlist.coverImgUrl !== 'default-cover' ? playlist.coverImgUrl : undefined,
      source: playlist.source,
      semanticType,
      position: typeof positionIndex === 'number' ? positionIndex : -1,
      orderOnly: shouldSyncFavoriteOrder,
      songlist: !isFavorites || shouldSeedSongs || shouldSyncFavoriteOrder ? mapSongsToCloud(songs, true) : undefined
    })
    await markPlaylistCloudSyncOk(playlist, remoteId, result.updatedAt)
    return result
  }

  const result = await nasCloudSongListAPI.createUserSongList({
    localId: playlist.id,
    name: playlist.name,
    describe: playlist.description || '',
    cover: playlist.coverImgUrl && playlist.coverImgUrl !== 'default-cover' ? playlist.coverImgUrl : undefined,
    semanticType,
    position: typeof positionIndex === 'number' ? positionIndex : -1,
    songlist: mapSongsToCloud(songs, true)
  } as any)
  await markPlaylistCloudSyncOk(playlist, result.id, result.updatedAt)
  return result
}

const mergeOrderedIdsForRetry = (desiredIds: string[], currentIds: string[]) => {
  const current = [...new Set(currentIds.map(String).filter(Boolean))]
  const currentSet = new Set(current)
  const desired = desiredIds.map(String).filter((id) => currentSet.has(id))
  const desiredSet = new Set(desired)
  return [...desired, ...current.filter((id) => !desiredSet.has(id))]
}

const reorderPlaylistsWithRetry = async (desiredIds: string[]) => {
  const normalized = [...new Set(desiredIds.map(String).filter(Boolean))]
  if (normalized.length === 0) return null
  const marker = await nasSyncAPI.snapshot()
  try {
    return await nasCloudSongListAPI.reorderPlaylists(normalized, marker.revision)
  } catch (error) {
    if (!(error instanceof NasSyncConflictError)) throw error
    const latest = await nasPlaylistAPI.list()
    const currentIds = latest.map((item: any) => String(item.id || item.playlistId || '')).filter(Boolean)
    const retryIds = mergeOrderedIdsForRetry(normalized, currentIds)
    if (retryIds.length === 0) throw error
    return await nasCloudSongListAPI.reorderPlaylists(
      retryIds,
      error.conflict.currentRevision ?? (await nasSyncAPI.snapshot()).revision
    )
  }
}

const getLocalPlaylistByName = async (name: string) => {
  const all = await songListAPI.getAll()
  const playlists = all.success && Array.isArray(all.data) ? all.data : []
  return playlists.find((playlist) => playlist.name === name)
}

const restoreRemotePlaylistToLocal = async (remotePlaylist: any) => {
  const remoteId = String(remotePlaylist.id || remotePlaylist.playlistId || '')
  if (!remoteId) return null

  // 详情是完整快照的一部分。读取失败时中止，不能用空数组覆盖本地数据。
  const detail = await nasPlaylistAPI.getSongs(remoteId)
  const songs = detail.songs || detail.list
  if (!Array.isArray(songs)) throw new Error(`云端歌单 ${remoteId} 响应缺少完整歌曲列表`)
  const localId = remotePlaylist.localId ? String(remotePlaylist.localId) : undefined
  const name = remotePlaylist.name || remotePlaylist.title || '未命名歌单'
  const existing =
    (await getLocalPlaylistByRemoteId(remoteId, localId)) || (await getLocalPlaylistByName(name))

  if (existing) {
    await songListAPI.edit(existing.id, {
      name,
      description: remotePlaylist.description || remotePlaylist.describe || existing.description || '',
      coverImgUrl:
        remotePlaylist.coverImgUrl || remotePlaylist.coverUrl || remotePlaylist.cover || existing.coverImgUrl,
      source: existing.source,
      meta: {
        ...(existing.meta || {}),
        cloudId: remoteId,
        localUpdatedAt: remotePlaylist.updatedAt || new Date().toISOString(),
        ...(remotePlaylist.semanticType ? { semantic: remotePlaylist.semanticType } : {})
      }
    })
    await replaceLocalPlaylistSongs(existing.id, songs)
    return existing.id
  }

  const created = await createOrUpdateLocalPlaylist(remotePlaylist)
  if (created?.id) {
    await replaceLocalPlaylistSongs(created.id, songs)
  }
  return created?.id || null
}

const backupLocalLibraryToCloud = async (reason: string) => {
  await flushPendingPodcastFavoriteMutations()
  const podcastResult = await backupLocalPodcastFavoritesToCloud()
  const pluginResult = await backupLocalPluginsToCloud(false)
  const localRes = await songListAPI.getAll()
  const playlists = localRes.success && Array.isArray(localRes.data) ? localRes.data : []
  let uploaded = 0

  for (const [index, playlist] of playlists.entries()) {
    const result = await uploadPlaylistSnapshot(playlist, index)
    if (result) uploaded += 1
  }

  // position 写入是逐歌单操作，最后再提交一次完整顺序，保证不同设备看到的
  // 歌单列表一致。冲突时保留云端刚新增的歌单，并自动重放本地排序意图。
  const latestPlaylists = await nasPlaylistAPI.list()
  const localOrderedIds = playlists
    .map((playlist) => {
      const cloudId = String(playlist.meta?.cloudId || '')
      return latestPlaylists.find((item: any) =>
        String(item.id || item.playlistId || '') === cloudId || String(item.localId || '') === String(playlist.id)
      )
    })
    .map((item: any) => String(item?.id || item?.playlistId || ''))
    .filter(Boolean)
  if (localOrderedIds.length > 0) {
    const currentCloudIds = latestPlaylists
      .map((item: any) => String(item.id || item.playlistId || ''))
      .filter(Boolean)
    await reorderPlaylistsWithRetry(mergeOrderedIdsForRetry(localOrderedIds, currentCloudIds))
  }

  // Backup is one-way. Do not consume the remote event stream here: a device
  // in backup mode has not applied those events, so advancing its cursor would
  // make a later switch to auto-sync skip them permanently.
  const result = await nasSyncAPI.snapshot()
  await appendNasSyncLog(
    `[备份到云端] ${reason}，已上传 ${uploaded} 个本地歌单、${podcastResult.uploaded} 个播客收藏、${pluginResult.uploaded} 个插件/能力`
  )
  return { uploaded, podcastUploaded: podcastResult.uploaded, pluginsUploaded: pluginResult.uploaded, revision: result.revision }
}

const restoreCloudLibraryToLocal = async (reason: string, snapshotRevision?: number, attempt = 0) => {
  const marker = typeof snapshotRevision === 'number' ? null : await nasSyncAPI.snapshot()
  const targetRevision = snapshotRevision ?? marker?.revision
  const remotePlaylists = await nasPlaylistAPI.list()
  const cloudPlaylistCount = Array.isArray(remotePlaylists) ? remotePlaylists.length : 0
  let restored = 0
  // Keep the cloud order separately from the set used for membership checks.
  // The order must be persisted after the restore, not only reflected in the UI.
  const restoredLocalIds: string[] = []
  const restoredCloudIds = new Set<string>()
  let removedBridgedCopies = 0

  for (const playlist of Array.isArray(remotePlaylists) ? remotePlaylists : []) {
    if (isBridgedRemotePlaylist(playlist)) {
      const remoteId = String(playlist?.id || '')
      if (remoteId) {
        const existing = await getLocalPlaylistByRemoteId(remoteId, playlist.localId)
        if (existing) {
          if (isLocalBridgedMirror(existing)) {
            await clearPlaylistCloudBinding(existing)
          } else {
            await songListAPI.delete(existing.id)
            removedBridgedCopies += 1
          }
        }
      }
      continue
    }

    const localId = await restoreRemotePlaylistToLocal(playlist)
    if (localId && !restoredLocalIds.includes(localId)) restoredLocalIds.push(localId)
    const cloudId = String(playlist?.id || '')
    if (cloudId) restoredCloudIds.add(cloudId)
    restored += 1
  }

  // 恢复改为合并语义：绝不删除本地独有歌单。
  // 规范要求“普通恢复不能删本地独有数据”，且“云端为空不能清空本地”。
  // 旧实现按云端快照镜像删除本地歌单——云端为空或数据少时会把本地清光。
  // 仍保留：飞牛云端副本(stale bridged copy)的清理。
  const localRes = await songListAPI.getAll()
  const localPlaylists = localRes.success && Array.isArray(localRes.data) ? localRes.data : []
  const localIds = new Set(localPlaylists.map((playlist) => playlist.id))
  const orderedLocalIds = [
    ...restoredLocalIds.filter((id) => localIds.has(id)),
    ...localPlaylists.map((playlist) => playlist.id).filter((id) => !restoredLocalIds.includes(id))
  ]
  if (orderedLocalIds.length === localPlaylists.length && orderedLocalIds.length > 1) {
    const reorderResult = await songListAPI.reorderPlaylists(orderedLocalIds)
    if (!reorderResult.success) {
      throw new Error(`本地歌单顺序保存失败: ${reorderResult.error || '未知错误'}`)
    }
  }
  let removed = 0
  if (cloudPlaylistCount === 0) {
    await appendNasSyncLog(`[从云端恢复] 云端歌单为空，已跳过镜像删除（空云端保护，本地 ${localPlaylists.length} 个歌单未动）`)
  }
  for (const local of localPlaylists) {
    if (isLocalBridgedMirror(local)) {
      if (local.meta?.cloudId) await clearPlaylistCloudBinding(local)
      continue
    }
    if (isStaleBridgedCloudCopy(local)) {
      await songListAPI.delete(local.id)
      removedBridgedCopies += 1
      continue
    }
    // 本地独有歌单一律保留
  }

  const podcastItems = await replaceLocalPodcastFavoritesFromCloud()
  // 插件恢复改为合并语义：只下载云端有、本地没有的插件，绝不镜像删除本地独有插件。
  // fullMirror 曾在一次“从云端恢复”里把本地 16 个插件删得只剩云端有的几个。
  await restorePluginsFromCloud(false)
  // Reading playlist details, plugins and podcasts is not atomic with the
  // marker request. If another device changed data while we were reading,
  // replay the snapshot once more so the cursor cannot jump over that change.
  const completedMarker = await nasSyncAPI.snapshot()
  if (
    typeof targetRevision === 'number' &&
    completedMarker.revision !== targetRevision &&
    attempt < 2
  ) {
    return restoreCloudLibraryToLocal(reason, completedMarker.revision, attempt + 1)
  }
  if (typeof targetRevision === 'number' && completedMarker.revision !== targetRevision) {
    throw new Error(`完整快照持续变化，暂不提交同步游标（start=${targetRevision} end=${completedMarker.revision}）`)
  }
  const completedRevision = completedMarker.revision
  if (typeof completedRevision === 'number') {
    await setScopedNasSyncLastRevision(completedRevision)
    await nasSyncAPI.updateDeviceRevision(completedRevision)
  }
  await appendNasSyncLog(
    `[从云端恢复] ${reason}，已镜像 ${restored} 个云端歌单，删除 ${removed} 个本地独有歌单，清理 ${removedBridgedCopies} 个飞牛云端副本，恢复 ${podcastItems.length} 个播客收藏`
  )
  suppressLocalChangeEvents()
    window.dispatchEvent(new CustomEvent('playlist-updated', { detail: { remote: true } }))
  window.dispatchEvent(new Event('ceru-podcast-favorites-updated'))
  return { restored, removed, removedBridgedCopies, podcasts: podcastItems.length, revision: completedRevision }
}

const runAutoSync = async (reason: string) => {
  await flushPendingFavoriteSongOperations()
  await flushPendingPlaylistMutations()
  await flushPendingPodcastFavoriteMutations()
  await cleanupStaleBridgedCloudCopies()
  const scope = await getNasSyncScope()
  const sinceRevision = await getScopedNasSyncLastRevision()
  const isInitialSync = sinceRevision <= 0
  let cursor = sinceRevision
  let revision = sinceRevision
  let hasMore = false

  // A new device has no trustworthy cursor. It must first read a consistent
  // cloud snapshot and merge it with local data before uploading anything.
  // Otherwise cloud-only items never reach the new device, while local-only
  // items can be mistaken for deletions by later incremental syncs.
  if (isInitialSync) {
    const marker = await nasSyncAPI.snapshot()
    await restoreCloudLibraryToLocal('auto/initial-merge', marker.revision)
    // 初次 AUTO 只合并云端快照并发送明确的本地待办操作。
    // 不能把当前本地完整列表当作用户意图上传，否则新设备上的
    // 插件/歌单数量差异会覆盖云端，或把云端已删除项目重新复活。
    await flushPendingFavoriteSongOperations()
    await flushPendingPlaylistMutations()
    await flushPendingPodcastFavoriteMutations()
    await flushPendingPluginDeletes()
    await flushPendingPluginUpserts()
    const completedMarker = await nasSyncAPI.snapshot()
    cursor = completedMarker.revision
    revision = completedMarker.revision
    await setScopedNasSyncLastRevision(cursor)
    await nasSyncAPI.updateDeviceRevision(cursor)
  }

  do {
    const remoteSnapshot = await nasSyncAPI.sync(cursor)
    if (remoteSnapshot.requiresRefresh) {
      const marker = await nasSyncAPI.snapshot()
      await restoreCloudLibraryToLocal('auto/requiresRefresh', marker.revision)
      cursor = marker.revision
      hasMore = false
      continue
    }
    revision = remoteSnapshot.revision
    if (Array.isArray(remoteSnapshot.events) && remoteSnapshot.events.length > 0) {
      await appendNasSyncLogs(remoteSnapshot.events).catch((error) => {
        console.warn('[nas-sync] 写入事件日志失败，继续应用事件:', error)
      })
      await applyRemoteEvents(remoteSnapshot.events)
    }
    const next =
      typeof remoteSnapshot.nextRevision === 'number'
        ? remoteSnapshot.nextRevision
        : typeof remoteSnapshot.revision === 'number'
          ? remoteSnapshot.revision
          : cursor
    if (remoteSnapshot.hasMore && next <= cursor) throw new Error('同步游标未推进')
    cursor = next
    await setScopedNasSyncLastRevision(cursor)
    await nasSyncAPI.updateDeviceRevision(cursor)
    hasMore = remoteSnapshot.hasMore
  } while (hasMore)
  // 日常自动同步只消费服务器事件和明确的本地 outbox。
  // 不能在每次轮询结束时按本地当前列表做整库备份，否则远端刚删除的
  // 歌曲/歌单可能被旧本地快照重新创建。首次合并仍在上面的初始化流程
  // 中处理；插件的增删/更新由 pluginSync 的明确操作路径提交。
  if (!isPluginSyncInitialized(scope)) {
    // 初始化只建立本地已知集合标记；插件增删/更新已经由明确 outbox
    // 发送，不能在这里调用 unionPluginsWithCloud() 做隐式整库备份。
    const localPlugins = await window.api.plugins.loadAllPlugins().catch(() => [])
    if (Array.isArray(localPlugins)) {
      markPluginSyncInitialized(scope)
    }
  }
  await appendNasSyncLog(`[自动同步] ${reason}，已同步服务器事件`)
  return { revision }
}

const cleanupStaleBridgedCloudCopies = async () => {
  const localRes = await songListAPI.getAll()
  const playlists = localRes.success && Array.isArray(localRes.data) ? localRes.data : []
  for (const playlist of playlists) {
    if (isLocalBridgedMirror(playlist)) {
      if (playlist.meta?.cloudId) await clearPlaylistCloudBinding(playlist)
      continue
    }
    if (isStaleBridgedCloudCopy(playlist)) {
      await songListAPI.delete(playlist.id)
    }
  }
}

export const runNasSyncNow = async (reason = 'manual') => {
  if (initialSyncRunning || applyingRemoteEvents || running) return null
  if (!(await canUseNasSync())) return null

  initialSyncRunning = true
  try {
    await ensureDeviceRegistered()
    const mode = await getNasSyncMode()
    if (mode === 'backup-to-cloud') return await backupLocalLibraryToCloud(reason)
    if (mode === 'restore-from-cloud') return await restoreCloudLibraryToLocal(reason)
    const result = await runAutoSync(reason)
    await markNasSyncOnline()
    return result
  } catch (error) {
    const conflict = error && typeof error === 'object' && 'conflict' in error
      ? (error as { conflict?: { type?: string; baseRevision?: number; currentRevision?: number } }).conflict
      : null
    const message = error instanceof Error ? error.message : String(error)
    const suffix = conflict
      ? '，冲突=' + String(conflict.type || 'unknown') + '，客户端版本=' + String(conflict.baseRevision ?? '?') + '，服务端版本=' + String(conflict.currentRevision ?? '?')
      : ''
    await appendNasSyncLog('[首轮同步失败] ' + message + suffix, 'error')
    await markNasSyncOffline(error)
    throw error
  } finally {
    initialSyncRunning = false
  }
}

const pollNasSync = async () => {
  if (stopped || running) return
  running = true
  try {
    if (!(await canUseNasSync())) {
      // The plugin sidecar and its config can become ready a few seconds after Vue mounts.
      // A five-minute retry here made realtime sync appear disabled after every cold start.
      scheduleNext(CONFIG_NOT_READY_RETRY_MS)
      return
    }
    // 轮询是自动同步的主路径，不能依赖用户手动点击“同步”来注册设备。
    // 注册成功后服务端才会维护设备心跳和 revision 游标。
    await ensureDeviceRegistered()
    void ensureRealtimeStream()

    const mode = await getNasSyncMode()
    if (mode !== 'auto') {
      scheduleNext()
      return
    }

    // 待办上传失败不能中断本轮入站长轮询。否则一条卡住的上传（例如某次收藏
    // 操作被服务端拒绝）会让 pollNasSync 抛错并进入退避，导致本机长时间收不到
    // 其他设备（安卓）推来的变更——这正是「Mac 收得慢、发得快」不对称的根因。
    for (const flushOutbox of [
      flushPendingFavoriteSongOperations,
      flushPendingPlaylistMutations,
      flushPendingPodcastFavoriteMutations,
      flushPendingPluginDeletes,
      flushPendingPluginUpserts
    ]) {
      try {
        await flushOutbox()
      } catch (error) {
        console.warn('[nas-sync] 待办上传失败，本轮仍继续入站同步:', error)
      }
    }
    const sinceRevision = await getScopedNasSyncLastRevision()
    const startedAt = Date.now()
    let result = !syncServerOffline
      ? await nasSyncAPI.waitForSync(sinceRevision, LONG_POLL_TIMEOUT_MS)
      : await nasSyncAPI.sync(sinceRevision)
    await markNasSyncOnline()
    const appliedRevision =
      typeof result.nextRevision === 'number'
        ? result.nextRevision
        : typeof result.revision === 'number'
          ? result.revision
          : sinceRevision

    const hadEvents = Array.isArray(result.events) && result.events.length > 0
    if (result.requiresRefresh) {
      const marker = await nasSyncAPI.snapshot()
      await restoreCloudLibraryToLocal('poll/requiresRefresh', marker.revision)
      await setScopedNasSyncLastRevision(marker.revision)
      await nasSyncAPI.updateDeviceRevision(marker.revision)
      scheduleNext(LONG_POLL_RETRY_MS)
      return
    }
    if (hadEvents) {
      await appendNasSyncLogs(result.events).catch((error) => {
        console.warn('[nas-sync] 写入事件日志失败，继续应用事件:', error)
      })
      await applyRemoteEvents(result.events)
      notifySyncEvents(result.events, appliedRevision)
    }
    await setScopedNasSyncLastRevision(appliedRevision)
    await nasSyncAPI.updateDeviceRevision(appliedRevision)
    if (result.hasMore) {
      scheduleNext(LONG_POLL_RETRY_MS)
      return
    }

    scheduleNext(getNextInterval(hadEvents, Date.now() - startedAt))
  } catch (error) {
    deviceRegistered = false
    console.warn('[nas-sync] poll failed:', error)
    await markNasSyncOffline(error)
    scheduleNext(syncServerOffline ? OFFLINE_POLL_RETRY_MS : ERROR_BACKOFF_MS)
  } finally {
    running = false
  }
}

const reschedule = () => {
  if (stopped) return
  scheduleNext()
}

const flushLocalNasSyncBackup = async () => {
  localBackupTimer = null
  if (stopped || initialSyncRunning || applyingRemoteEvents) {
    scheduleLocalNasSyncBackup()
    return
  }
  if (running) {
    // 长轮询占着 running 时，插件增删不能再等下一轮。先把待上报插件直接发出去。
    try {
      await flushPendingPluginDeletes()
      await flushPendingPluginUpserts()
      await flushPendingPodcastFavoriteMutations()
      await flushPendingFavoriteSongOperations()
      await flushPendingPlaylistMutations()
    } catch (error) {
      console.warn('[nas-sync] plugin fast path failed:', error)
      scheduleLocalNasSyncBackup()
    }
    return
  }

  try {
    const mode = await getNasSyncMode()
    if (mode === 'restore-from-cloud') return
    await flushPendingPluginDeletes()
    await flushPendingPluginUpserts()
    await flushPendingPodcastFavoriteMutations()
    await runNasSyncNow('local-change')
  } catch (error) {
    console.warn('[nas-sync] local backup failed:', error)
    await markNasSyncOffline(error)
    // Keep the durable local outboxes alive when the triggering request fails.
    scheduleLocalNasSyncBackup()
  }
}

const scheduleLocalNasSyncBackup = () => {
  if (stopped) return
  clearLocalBackupTimer()
  localBackupTimer = window.setTimeout(() => {
    void flushLocalNasSyncBackup()
  }, LOCAL_CHANGE_DEBOUNCE_MS)
}

const handleLocalPlaylistChanged = () => {
  if (Date.now() < suppressLocalChangeEventsUntil) return
  if (applyingRemoteEvents || initialSyncRunning) return
  scheduleLocalNasSyncBackup()
}

export const startNasSyncPoller = () => {
  if (!stopped) return
  stopped = false
  window.addEventListener('ceru-window-state-change', reschedule)
  window.addEventListener('ceru-nas-local-change', handleLocalPlaylistChanged)
  document.addEventListener('visibilitychange', reschedule)
  scheduleNext(0)
  void ensureRealtimeStream()
}

export const stopNasSyncPoller = () => {
  stopped = true
  clearTimer()
  clearLocalBackupTimer()
  streamHandle?.close()
  streamHandle = null
  if (streamRetryTimer !== null) {
    window.clearTimeout(streamRetryTimer)
    streamRetryTimer = null
  }
  streamRetryAttempt = 0
  window.removeEventListener('ceru-window-state-change', reschedule)
  window.removeEventListener('ceru-nas-local-change', handleLocalPlaylistChanged)
  document.removeEventListener('visibilitychange', reschedule)
}
