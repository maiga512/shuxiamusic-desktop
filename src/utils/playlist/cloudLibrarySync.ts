import { useAuthStore } from '@renderer/store'
import songListAPI from '@renderer/api/songList'
import {
  cloudSongListAPI,
  type CloudSongDto,
  type CloudSongList
} from '@renderer/api/cloudSongList'
import {
  canUseNasSync,
  nasCloudSongListAPI,
  nasSyncAPI,
  type NasPlaylistSongOperationResult
} from '@renderer/api/nasSync'
import { mapCloudSongToLocal, mapSongsToCloud } from '@renderer/utils/playlist/cloudList'
import { isBridgedPlaylist } from '@renderer/utils/playlist/bridgedPlaylist'
import { getPersistentMeta } from '@renderer/utils/playlist/meta'
import { emitFavoritesSync } from '@renderer/utils/sync/realtimeSyncBus'
import type { SongList, Songs } from '@common/types/songList'

export const FAVORITES_PLAYLIST_NAME = '我的喜欢'
const SONG_OPERATION_QUEUE_KEY = 'ceru_nas_playlist_song_operations'
const SONG_OPERATION_SEQUENCE_KEY = 'ceru_nas_playlist_song_operation_sequence'
const SONG_OPERATION_DEVICE_KEY = 'ceru_nas_playlist_song_operation_device'
const SONG_OPERATION_OCCURRED_AT_KEY = 'ceru_nas_playlist_song_operation_occurred_at'
const SONG_OPERATION_ACKNOWLEDGED_KEY = 'ceru_nas_playlist_song_operations_acknowledged'
const PLAYLIST_MUTATION_QUEUE_KEY = 'ceru_nas_playlist_mutations'
const ACKNOWLEDGED_OPERATION_TTL_MS = 30_000 // 30 seconds protection window
const RECENTLY_LOCAL_MODIFIED_KEY = 'ceru_nas_playlist_recently_local_modified'
const RECENTLY_LOCAL_MODIFIED_TTL_MS = 30_000 // 30 seconds local modification protection

type PendingPlaylistSongOperation = {
  operationId: string
  deviceId: string
  sequence: number
  occurredAtMs: number
  playlistId: string
  action: 'add' | 'remove'
  trackKey: string
  song?: CloudSongDto
  createdAt: string
}

type PendingPlaylistMutation = {
  operationId: string
  operation: 'upsert' | 'delete'
  localId: string
  cloudId?: string
  name?: string
  description?: string
  cover?: string
  createdAt: number
}

const readPendingPlaylistMutations = (): PendingPlaylistMutation[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLAYLIST_MUTATION_QUEUE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => item?.operationId && item?.operation && item?.localId) : []
  } catch {
    return []
  }
}

const writePendingPlaylistMutations = (items: PendingPlaylistMutation[]) => {
  localStorage.setItem(PLAYLIST_MUTATION_QUEUE_KEY, JSON.stringify(items))
}

const enqueuePlaylistMutation = (mutation: PendingPlaylistMutation) => {
  const pending = readPendingPlaylistMutations().filter((item) => item.localId !== mutation.localId)
  writePendingPlaylistMutations([...pending, mutation])
}

const removePlaylistMutation = (localId: string, operationId?: string) => {
  writePendingPlaylistMutations(
    readPendingPlaylistMutations().filter((item) => {
      if (item.localId !== localId) return true
      return operationId ? item.operationId !== operationId : false
    })
  )
}

export const flushPendingPlaylistMutations = async () => {
  if (!(await canUseNasSync())) return
  for (const mutation of readPendingPlaylistMutations()) {
    try {
      if (mutation.operation === 'delete') {
        if (mutation.cloudId) await nasCloudSongListAPI.deleteUserSongList(mutation.cloudId)
      } else {
        const local = await songListAPI.getById(mutation.localId)
        if (!local.success || !local.data) continue
        const cloudId = await ensureCloudPlaylistForLocal(local.data)
        if (!cloudId) continue
        await nasCloudSongListAPI.updateUserSongList({
          listId: cloudId,
          localId: local.data.id,
          name: local.data.name,
          describe: local.data.description || '',
          cover: local.data.coverImgUrl !== 'default-cover' ? local.data.coverImgUrl : undefined
        })
      }
      removePlaylistMutation(mutation.localId, mutation.operationId)
    } catch (error) {
      console.warn('[nas-sync] 歌单待办保留重试:', error)
    }
  }
}

let flushSongOperationsPromise: Promise<void> | null = null

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : '未知错误'

const canUseCloudLibrary = async () => {
  if (await canUseNasSync()) return true
  try {
    const authStore = useAuthStore()
    return Boolean(authStore.initialized && authStore.isAuthenticated)
  } catch {
    return false
  }
}

const getSongListSyncAPI = async () => (await canUseNasSync() ? nasCloudSongListAPI : cloudSongListAPI)

const isFavoritesSongList = (playlist: SongList) =>
  playlist.meta?.semantic === 'favorites' || playlist.name === FAVORITES_PLAYLIST_NAME

const canonicalSongSource = (song: { source?: string }) => {
  const raw = String(song.source || '').trim().toLowerCase()
  if (raw === 'wy' || raw.includes('网易') || raw.includes('netease')) return 'wy'
  if (raw === 'tx' || raw.includes('qq')) return 'tx'
  if (raw === 'kw' || raw.includes('酷我')) return 'kw'
  if (raw === 'kg' || raw.includes('酷狗')) return 'kg'
  if (raw === 'mg' || raw.includes('咪咕')) return 'mg'
  return raw || 'wy'
}

const normalizeTrackKey = (value: string) => {
  const raw = String(value || '').trim()
  const separator = raw.indexOf(':')
  if (separator <= 0) return raw
  const source = raw.slice(0, separator).toLowerCase()
  let id = raw.slice(separator + 1).trim()
  while (id.toLowerCase().startsWith(`${source}:`)) id = id.slice(source.length + 1).trim()
  return id ? `${source}:${id}` : ''
}

export const normalizeFavoriteSong = <T extends Record<string, any>>(song: T) => {
  const source = canonicalSongSource(song)
  let songmid = String(song.songmid || song.id || song.hash || '').trim()
  while (songmid.toLowerCase().startsWith(`${source}:`)) {
    songmid = songmid.slice(source.length + 1).trim()
  }
  return songmid ? ({ ...song, source, songmid } as T & { source: string; songmid: string }) : null
}

// 跨源身份匹配：同一首歌（歌名+歌手）的收藏记录可能挂在不同音源的 songmid 下
// （自动换源、不同设备同步、不同音源插件解析出的 id 不同）。精确 source:songmid
// 未命中时，按歌曲自身身份识别收藏记录，让"已喜欢"的展示不随播放源漂移。
const normalizeIdentityText = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')

export const findFavoriteSongByIdentity = (
  favoriteSongs: readonly any[] | null | undefined,
  song: any
): any | null => {
  const targetName = normalizeIdentityText(song?.name)
  const targetSinger = normalizeIdentityText(song?.singer)
  if (!targetName) return null
  for (const candidate of favoriteSongs || []) {
    const candName = normalizeIdentityText(candidate?.name)
    if (candName !== targetName) continue
    const candSinger = normalizeIdentityText(candidate?.singer)
    // 双方都有歌手时必须一致；任一侧缺歌手时仅按歌名匹配，避免同名歌误判
    if (targetSinger && candSinger && candSinger !== targetSinger) continue
    return candidate
  }
  return null
}

const songTrackKey = (song: {
  songmid?: string | number
  id?: string | number
  hash?: string | number
  source?: string
}) => {
  const normalized = normalizeFavoriteSong(song)
  return normalized ? `${normalized.source}:${normalized.songmid}` : ''
}

const isSongOperationAcknowledged = (result: NasPlaylistSongOperationResult) =>
  Boolean(result.operationId && !result.stale)

let remoteSongApplyGeneration = 0

/** 远端正在把歌曲写进本地库时，进行中的旧拉取不能再覆盖它。 */
export const beginRemoteSongApply = () => {
  remoteSongApplyGeneration += 1
  return remoteSongApplyGeneration
}

const readDeviceId = () => {
  const existing = localStorage.getItem(SONG_OPERATION_DEVICE_KEY)?.trim()
  if (existing) return existing
  const generated =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `desktop-${Date.now()}-${Math.random().toString(16).slice(2)}`
  localStorage.setItem(SONG_OPERATION_DEVICE_KEY, generated)
  return generated
}

const nextSongOperationSequence = () => {
  const current = Number(localStorage.getItem(SONG_OPERATION_SEQUENCE_KEY) || '0')
  const next = Math.max(Date.now(), Number.isSafeInteger(current) && current > 0 ? current + 1 : 1)
  localStorage.setItem(SONG_OPERATION_SEQUENCE_KEY, String(next))
  return next
}

const nextSongOperationOccurredAt = () => {
  const current = Number(localStorage.getItem(SONG_OPERATION_OCCURRED_AT_KEY) || '0')
  const next = Math.max(Date.now(), Number.isSafeInteger(current) ? current + 1 : 0)
  localStorage.setItem(SONG_OPERATION_OCCURRED_AT_KEY, String(next))
  return next
}

const readPendingPlaylistSongOperations = (): PendingPlaylistSongOperation[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SONG_OPERATION_QUEUE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (
        !item?.operationId ||
        !item?.deviceId ||
        !item?.playlistId ||
        (item?.action !== 'add' && item?.action !== 'remove') ||
        !item?.trackKey
      ) {
        return []
      }
      const parsedCreatedAt = Date.parse(String(item?.createdAt || ''))
      const occurredAtMs =
        Number.isSafeInteger(item?.occurredAtMs) && item?.occurredAtMs > 0
          ? item.occurredAtMs
          : Number.isFinite(parsedCreatedAt) && parsedCreatedAt > 0
            ? parsedCreatedAt
            : Date.now()
      return [{...item, occurredAtMs} as PendingPlaylistSongOperation]
    })
  } catch {
    return []
  }
}

const writePendingPlaylistSongOperations = (items: PendingPlaylistSongOperation[]) => {
  localStorage.setItem(SONG_OPERATION_QUEUE_KEY, JSON.stringify(items))
}

const enqueuePendingPlaylistSongOperation = (operation: PendingPlaylistSongOperation) => {
  writePendingPlaylistSongOperations([...readPendingPlaylistSongOperations(), operation])
}

const removePendingPlaylistSongOperations = (operationIds: Set<string>) => {
  if (operationIds.size === 0) return
  writePendingPlaylistSongOperations(
    readPendingPlaylistSongOperations().filter((item) => !operationIds.has(item.operationId))
  )
}

// --- Acknowledged operations protection ---
type AcknowledgedOperation = {
  trackKey: string
  action: 'add' | 'remove'
  acknowledgedAt: number
}

const readAcknowledgedOperations = (): AcknowledgedOperation[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SONG_OPERATION_ACKNOWLEDGED_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    const now = Date.now()
    return parsed.filter(
      (item) =>
        item?.trackKey &&
        (item?.action === 'add' || item?.action === 'remove') &&
        typeof item?.acknowledgedAt === 'number' &&
        now - item.acknowledgedAt < ACKNOWLEDGED_OPERATION_TTL_MS
    )
  } catch {
    return []
  }
}

const writeAcknowledgedOperations = (items: AcknowledgedOperation[]) => {
  localStorage.setItem(SONG_OPERATION_ACKNOWLEDGED_KEY, JSON.stringify(items))
}

const pushAcknowledgedOperation = (trackKey: string, action: 'add' | 'remove') => {
  if (!trackKey) return
  const existing = readAcknowledgedOperations()
  // Remove any stale entries for the same trackKey (the latest action wins)
  const filtered = existing.filter((item) => item.trackKey !== trackKey)
  filtered.push({ trackKey, action, acknowledgedAt: Date.now() })
  writeAcknowledgedOperations(filtered)
}

/** Returns trackKeys of recently-acknowledged 'add' operations still within the protection window. */
const getRecentlyAcknowledgedAdds = (): Set<string> => {
  const now = Date.now()
  return new Set(
    readAcknowledgedOperations()
      .filter((item) => item.action === 'add' && now - item.acknowledgedAt < ACKNOWLEDGED_OPERATION_TTL_MS)
      .map((item) => item.trackKey)
  )
}

/** Returns trackKeys of recently-acknowledged 'remove' operations still within the protection window. */
const getRecentlyAcknowledgedRemoves = (): Set<string> => {
  const now = Date.now()
  return new Set(
    readAcknowledgedOperations()
      .filter((item) => item.action === 'remove' && now - item.acknowledgedAt < ACKNOWLEDGED_OPERATION_TTL_MS)
      .map((item) => item.trackKey)
  )
}

// --- Recently locally modified protection ---
// Tracks songs that were modified locally (add/remove) but might not yet be
// in the pending queue or acknowledged queue. This closes the race window
// between local DB write and cloud sync enqueue.

type LocalModificationEntry = { trackKey: string; action: 'add' | 'remove'; at: number }

const readRecentlyLocalModified = (): LocalModificationEntry[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENTLY_LOCAL_MODIFIED_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    const now = Date.now()
    return parsed.filter(
      (item) =>
        item?.trackKey &&
        (item?.action === 'add' || item?.action === 'remove') &&
        typeof item?.at === 'number' &&
        now - item.at < RECENTLY_LOCAL_MODIFIED_TTL_MS
    )
  } catch {
    return []
  }
}

const writeRecentlyLocalModified = (items: LocalModificationEntry[]) => {
  localStorage.setItem(RECENTLY_LOCAL_MODIFIED_KEY, JSON.stringify(items))
}

/** Call this when a song is locally added or removed from favorites. */
export const pushRecentlyLocalModified = (trackKey: string, action: 'add' | 'remove') => {
  if (!trackKey) return
  const existing = readRecentlyLocalModified()
  const filtered = existing.filter((item) => item.trackKey !== trackKey)
  filtered.push({ trackKey, action, at: Date.now() })
  writeRecentlyLocalModified(filtered)
}

/** Returns trackKeys of songs recently added locally, still within the protection window. */
const getRecentlyLocalAddedKeys = (): Set<string> => {
  const now = Date.now()
  return new Set(
    readRecentlyLocalModified()
      .filter((item) => item.action === 'add' && now - item.at < RECENTLY_LOCAL_MODIFIED_TTL_MS)
      .map((item) => item.trackKey)
  )
}

/** Returns trackKeys of songs recently removed locally, still within the protection window. */
const getRecentlyLocalRemovedKeys = (): Set<string> => {
  const now = Date.now()
  return new Set(
    readRecentlyLocalModified()
      .filter((item) => item.action === 'remove' && now - item.at < RECENTLY_LOCAL_MODIFIED_TTL_MS)
      .map((item) => item.trackKey)
  )
}

const replacePendingPlaylistSongOperation = (
  previousOperationId: string,
  operation: PendingPlaylistSongOperation
) => {
  writePendingPlaylistSongOperations(
    readPendingPlaylistSongOperations().map((item) =>
      item.operationId === previousOperationId ? operation : item
    )
  )
}

export const flushPendingFavoriteSongOperations = async () => {
  if (flushSongOperationsPromise) return flushSongOperationsPromise
  flushSongOperationsPromise = (async () => {
    if (!(await canUseNasSync())) return
    while (true) {
      const pending = readPendingPlaylistSongOperations().sort(
        (left, right) =>
          left.occurredAtMs - right.occurredAtMs ||
          left.sequence - right.sequence ||
          left.operationId.localeCompare(right.operationId)
      )
      if (pending.length === 0) break
      let acknowledged = false
      let failed = false
      for (const operation of pending) {
        const normalizedOperation = {
          ...operation,
          trackKey: normalizeTrackKey(operation.trackKey)
        }
        let result: NasPlaylistSongOperationResult
        try {
          result = await nasSyncAPI.applyPlaylistSongOperation(normalizedOperation)
        } catch (error) {
          console.warn('[nas-sync] 收藏操作待重试:', error)
          failed = true
          break
        }
        if (result.stale) {
          const sequence = nextSongOperationSequence()
          const retryOperation: PendingPlaylistSongOperation = {
            ...normalizedOperation,
            operationId: `${operation.operationId}:retry:${sequence}`,
            sequence,
            occurredAtMs: Math.max(
              normalizedOperation.occurredAtMs,
              Number(result.winningOccurredAtMs || 0) + 1,
              Date.now()
            )
          }
          replacePendingPlaylistSongOperation(operation.operationId, retryOperation)
          try {
            result = await nasSyncAPI.applyPlaylistSongOperation(retryOperation)
          } catch (error) {
            console.warn('[nas-sync] 收藏操作升级重试失败:', error)
            failed = true
            break
          }
        }
        // 首次 stale 会以新序号重试；若仍 stale，说明另一设备已有更新操作，
        // 消费本地旧意图并由紧接着的远端事件/快照收敛。
        if (isSongOperationAcknowledged(result)) {
          pushAcknowledgedOperation(normalizedOperation.trackKey, normalizedOperation.action)
          removePendingPlaylistSongOperations(new Set([operation.operationId, result.operationId]))
          acknowledged = true
        } else if (result.stale) {
          removePendingPlaylistSongOperations(new Set([operation.operationId, result.operationId]))
        }
      }
      if (failed || !acknowledged) break
    }
  })().finally(() => {
    flushSongOperationsPromise = null
  })
  return flushSongOperationsPromise
}

const enqueueFavoriteSongOperations = async (
  playlist: SongList,
  action: 'add' | 'remove',
  songs: readonly CloudSongDto[],
  trackKeys?: readonly string[]
) => {
  const cloudId = await ensureCloudPlaylistForLocal(playlist)
  if (!cloudId) return null
  const deviceId = readDeviceId()
  const now = new Date().toISOString()

  for (const [index, song] of songs.entries()) {
    const trackKey = trackKeys?.[index] || songTrackKey(song)
    if (!trackKey) continue
    enqueuePendingPlaylistSongOperation({
      operationId:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `song-op-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
      deviceId,
      sequence: nextSongOperationSequence(),
      occurredAtMs: nextSongOperationOccurredAt(),
      playlistId: cloudId,
      action,
      trackKey,
      song: action === 'add' ? song : undefined,
      createdAt: now
    })
  }

  await flushPendingFavoriteSongOperations()
  return { id: cloudId, updatedAt: new Date().toISOString() }
}

const compactMeta = (meta: Record<string, any>) => {
  const next = { ...meta }
  Object.keys(next).forEach((key) => {
    if (next[key] === undefined || next[key] === '') delete next[key]
  })
  return next
}

const persistPlaylistMeta = async (localId: string, meta: Record<string, any>) => {
  const persistentMeta = compactMeta(getPersistentMeta(meta))
  const res = await songListAPI.edit(localId, { meta: persistentMeta })
  if (!res.success) {
    throw new Error(res.error || '保存歌单同步状态失败')
  }
  return persistentMeta
}

const findCloudMatch = (cloudLists: CloudSongList[], playlist: SongList) => {
  return cloudLists.find(
    (item) =>
      item.localId === playlist.id ||
      item.id === playlist.meta?.cloudId ||
      (playlist.name === FAVORITES_PLAYLIST_NAME && item.name === FAVORITES_PLAYLIST_NAME)
  )
}

const hasCloudPlaylist = (cloudLists: CloudSongList[], cloudId?: string) => {
  if (!cloudId) return false
  return cloudLists.some((item) => item.id === cloudId)
}

const createCloudPlaylist = async (playlist: SongList, songs: readonly Songs[] = []) => {
  const syncAPI = await getSongListSyncAPI()
  const res = await syncAPI.createUserSongList({
    localId: playlist.id,
    name: playlist.name,
    describe: playlist.description || '',
    cover: playlist.coverImgUrl && playlist.coverImgUrl !== 'default-cover' ? playlist.coverImgUrl : undefined,
    songlist: mapSongsToCloud(songs, true)
  })

  return {
    id: res.id,
    updatedAt: res.updatedAt
  }
}

export const markPlaylistCloudSyncFailed = async (
  playlist: Pick<SongList, 'id' | 'meta'>,
  operation: string,
  error: unknown
) => {
  try {
    await persistPlaylistMeta(playlist.id, {
      ...(playlist.meta || {}),
      cloudSyncPending: true,
      cloudSyncOperation: operation,
      cloudSyncError: getErrorMessage(error),
      cloudSyncFailedAt: new Date().toISOString()
    })
  } catch (metaError) {
    console.error('保存云同步失败状态失败:', metaError)
  }
}

export const markPlaylistCloudSyncOk = async (
  playlist: Pick<SongList, 'id' | 'meta'>,
  cloudId: string,
  updatedAt?: string
) => {
  return persistPlaylistMeta(playlist.id, {
    ...(playlist.meta || {}),
    cloudId,
    cloudSyncPending: false,
    cloudSyncOperation: undefined,
    cloudSyncError: undefined,
    cloudSyncFailedAt: undefined,
    localUpdatedAt: updatedAt || new Date().toISOString()
  })
}

export const ensureLocalFavoritesPlaylist = async (): Promise<string> => {
  const favApi = (window as any).api?.songList
  const favIdRes = await favApi?.getFavoritesId?.()
  let favoritesId: string | null = (favIdRes && favIdRes.data) || null

  if (favoritesId) {
    const existsRes = await songListAPI.exists(favoritesId)
    if (!existsRes.success || !existsRes.data) favoritesId = null
  }

  if (!favoritesId) {
    const searchRes = await songListAPI.search(FAVORITES_PLAYLIST_NAME, 'local')
    if (searchRes.success && Array.isArray(searchRes.data)) {
      const exact = searchRes.data.find(
        (playlist) => playlist.name === FAVORITES_PLAYLIST_NAME && playlist.source === 'local'
      )
      favoritesId = exact?.id || null
    }
  }

  if (!favoritesId) {
    const createRes = await songListAPI.create(FAVORITES_PLAYLIST_NAME, '', 'local', {
      semantic: 'favorites'
    })
    if (!createRes.success || !createRes.data?.id) {
      throw new Error(createRes.error || '创建“我的喜欢”失败')
    }
    favoritesId = createRes.data.id
  }

  await favApi?.setFavoritesId?.(favoritesId)
  return favoritesId!
}

export const ensureCloudPlaylistForLocal = async (playlist: SongList) => {
  if (!(await canUseCloudLibrary())) return null
  if (isBridgedPlaylist(playlist)) return null
  if (playlist.meta?.isCloudOnly) return playlist.meta?.cloudId || playlist.id

  try {
    const syncAPI = await getSongListSyncAPI()
    const [cloudLists, songsRes] = await Promise.all([
      syncAPI.getUserSongLists(),
      songListAPI.getSongs(playlist.id)
    ])
    const songs = songsRes.success ? [...(songsRes.data || [])] : []
    const safeCloudLists = Array.isArray(cloudLists) ? cloudLists : []
    const currentCloudId = playlist.meta?.cloudId ? String(playlist.meta.cloudId) : ''

    if (hasCloudPlaylist(safeCloudLists, currentCloudId)) {
      const existing = safeCloudLists.find((item) => item.id === currentCloudId)
      await markPlaylistCloudSyncOk(playlist, currentCloudId, existing?.updatedAt)
      return currentCloudId
    }

    const match = findCloudMatch(safeCloudLists, playlist)

    if (match) {
      await markPlaylistCloudSyncOk(playlist, match.id, match.updatedAt)
      return match.id
    }

    const created = await createCloudPlaylist(playlist, songs)
    await markPlaylistCloudSyncOk(playlist, created.id, created.updatedAt)
    return created.id
  } catch (error) {
    await markPlaylistCloudSyncFailed(playlist, 'bind', error)
    throw error
  }
}

export const ensureFavoritesCloudBinding = async () => {
  const localId = await ensureLocalFavoritesPlaylist()
  const playlistRes = await songListAPI.getById(localId)
  const playlist = playlistRes.data || ({
    id: localId,
    name: FAVORITES_PLAYLIST_NAME,
    description: '',
    coverImgUrl: 'default-cover',
    createTime: '',
    updateTime: '',
    source: 'local',
    meta: { semantic: 'favorites' }
  } as SongList)

  const cloudId = await ensureCloudPlaylistForLocal({
    ...playlist,
    name: FAVORITES_PLAYLIST_NAME,
    meta: {
      ...(playlist.meta || {}),
      semantic: 'favorites'
    }
  })

  return { localId, cloudId, playlist }
}

export const syncAddSongsToCloud = async (playlist: SongList, songs: readonly Songs[]) => {
  if (!(await canUseCloudLibrary())) return null
  const cloudSongs = mapSongsToCloud(songs) as CloudSongDto[]
  if (cloudSongs.length === 0) return null

  try {
    if (await canUseNasSync() && isFavoritesSongList(playlist)) {
      const result = await enqueueFavoriteSongOperations(playlist, 'add', cloudSongs)
      window.dispatchEvent(new Event('ceru-nas-local-change'))
      emitFavoritesSync('add', 'local', songs)
      return result
    }
    const cloudId = await ensureCloudPlaylistForLocal(playlist)
    if (!cloudId) return null
    const syncAPI = await getSongListSyncAPI()
    const res = await syncAPI.addSongsToList(cloudId, cloudSongs)
    await markPlaylistCloudSyncOk(playlist, cloudId, res.updatedAt)
    window.dispatchEvent(new Event('ceru-nas-local-change'))
    emitFavoritesSync('add', 'local', songs)
    return res
  } catch (error) {
    await markPlaylistCloudSyncFailed(playlist, 'addSongs', error)
    throw error
  }
}

export const syncRemoveSongsFromCloud = async (
  playlist: SongList,
  songmids: readonly (string | number)[],
  songs: readonly Songs[] = []
) => {
  if (!(await canUseCloudLibrary())) return null
  if (songmids.length === 0) return null

  try {
    if (await canUseNasSync() && isFavoritesSongList(playlist)) {
      const localSongsRes = songs.length === 0 ? await songListAPI.getSongs(playlist.id) : null
      const localSongs = songs.length > 0
        ? [...songs]
        : localSongsRes?.success && Array.isArray(localSongsRes.data)
          ? localSongsRes.data
          : []
      const trackKeys = songmids.map((songmid, index) => {
        const requestedSong = songs[index]
        if (requestedSong) return songTrackKey(requestedSong)
        const matched = localSongs.find((song) => String(song.songmid) === String(songmid))
        return matched ? songTrackKey(matched) : ''
      })
      if (trackKeys.every((key) => !key)) {
        await flushPendingFavoriteSongOperations()
        return null
      }
      const removeResult = await enqueueFavoriteSongOperations(
        playlist,
        'remove',
        songmids.map((songmid) => ({ songmid: String(songmid) }) as CloudSongDto),
        trackKeys
      )
      window.dispatchEvent(new Event('ceru-nas-local-change'))
      emitFavoritesSync('remove', 'local', songmids)
      return removeResult
    }
    const cloudId = await ensureCloudPlaylistForLocal(playlist)
    if (!cloudId) return null
    const syncAPI = await getSongListSyncAPI()
    const res = await syncAPI.removeSongsFromList(
      cloudId,
      songmids.map((id) => String(id))
    )
    await markPlaylistCloudSyncOk(playlist, cloudId, res.updatedAt)
    window.dispatchEvent(new Event('ceru-nas-local-change'))
    emitFavoritesSync('remove', 'local', songmids)
    return res
  } catch (error) {
    await markPlaylistCloudSyncFailed(playlist, 'removeSongs', error)
    throw error
  }
}

export const syncPlaylistSongsSnapshotToCloud = async (
  playlist: SongList,
  songs: readonly Songs[]
) => {
  if (!(await canUseCloudLibrary())) return null
  if (isBridgedPlaylist(playlist, songs)) return null

  try {
    if (isFavoritesSongList(playlist)) {
      await flushPendingFavoriteSongOperations()
    }
    const cloudId = await ensureCloudPlaylistForLocal(playlist)
    if (!cloudId) return null
    const syncAPI = await getSongListSyncAPI()
    const res = await syncAPI.updateUserSongList({
      listId: cloudId,
      localId: playlist.id,
      name: playlist.name,
      describe: playlist.description || '',
      cover:
        playlist.coverImgUrl && playlist.coverImgUrl !== 'default-cover'
          ? playlist.coverImgUrl
          : undefined,
      songlist: mapSongsToCloud(songs, true),
      orderOnly: isFavoritesSongList(playlist)
    })
    await markPlaylistCloudSyncOk(playlist, cloudId, res.updatedAt)
    return res
  } catch (error) {
    await markPlaylistCloudSyncFailed(playlist, 'replaceSongs', error)
    throw error
  }
}

export const syncPlaylistInfoToCloud = async (playlist: SongList) => {
  const useNas = await canUseNasSync()
  const operationId = `playlist-upsert-${playlist.id}-${Date.now()}`
  if (useNas) {
    enqueuePlaylistMutation({
      operationId,
      operation: 'upsert',
      localId: playlist.id,
      cloudId: playlist.meta?.cloudId,
      name: playlist.name,
      description: playlist.description || '',
      cover: playlist.coverImgUrl,
      createdAt: Date.now()
    })
  }
  if (!(await canUseCloudLibrary())) return null

  try {
    const cloudId = await ensureCloudPlaylistForLocal(playlist)
    if (!cloudId) return null
    const syncAPI = await getSongListSyncAPI()
    const res = await syncAPI.updateUserSongList({
      listId: cloudId,
      localId: playlist.id,
      name: playlist.name,
      describe: playlist.description || '',
      cover:
        playlist.coverImgUrl && playlist.coverImgUrl !== 'default-cover'
          ? playlist.coverImgUrl
          : undefined
    })
    await markPlaylistCloudSyncOk(playlist, cloudId, res.updatedAt)
    if (useNas) removePlaylistMutation(playlist.id, operationId)
    return res
  } catch (error) {
    await markPlaylistCloudSyncFailed(playlist, 'updateInfo', error)
    throw error
  }
}

export const syncDeletePlaylistFromCloud = async (playlist: SongList) => {
  if (isBridgedPlaylist(playlist)) return null
  const cloudId = playlist.meta?.cloudId || (playlist.meta?.isCloudOnly ? playlist.id : '')
  if (!cloudId) return null
  const operationId = `playlist-delete-${playlist.id}-${Date.now()}`
  const useNas = await canUseNasSync()
  if (useNas) {
    enqueuePlaylistMutation({
      operationId,
      operation: 'delete',
      localId: playlist.id,
      cloudId,
      createdAt: Date.now()
    })
  }
  if (!(await canUseCloudLibrary())) return null
  try {
    const syncAPI = await getSongListSyncAPI()
    const result = await syncAPI.deleteUserSongList(cloudId)
    if (useNas) removePlaylistMutation(playlist.id, operationId)
    return result
  } catch (error) {
    await markPlaylistCloudSyncFailed(playlist, 'delete', error)
    throw error
  }
}

const hasUsableSongCover = (value: unknown) => {
  const img = String(value || '').trim()
  return Boolean(img) && img !== 'default-cover' && img !== '/default-cover.png'
}

export const applyRemotePlaylistSongs = async (
  localId: string,
  remoteSongs: readonly any[],
  remotePlaylistId?: string
) => {
  const orderedRemote = [...remoteSongs].sort((left, right) => {
    const leftPos = Number(left?.pos ?? left?.position)
    const rightPos = Number(right?.pos ?? right?.position)
    const leftOk = Number.isFinite(leftPos)
    const rightOk = Number.isFinite(rightPos)
    if (leftOk && rightOk && leftPos !== rightPos) return leftPos - rightPos
    if (leftOk !== rightOk) return leftOk ? -1 : 1
    return 0
  })
  let songs = orderedRemote
    .map((song) => mapCloudSongToLocal(song) as Songs)
    .filter((song) => String(song?.songmid || '').trim())

  const localPlaylist = await songListAPI.getById(localId)
  const cloudId = remotePlaylistId || String(localPlaylist.data?.meta?.cloudId || '')
  const pending = cloudId
    ? readPendingPlaylistSongOperations()
        .filter((item) => item.playlistId === cloudId)
        .sort((left, right) => left.occurredAtMs - right.occurredAtMs || left.sequence - right.sequence)
    : []
  if (pending.length > 0) {
    const byTrackKey = new Map(songs.map((song) => [songTrackKey(song), song]))
    const pendingAdds: Songs[] = []
    for (const operation of pending) {
      const trackKey = normalizeTrackKey(operation.trackKey)
      if (operation.action === 'remove') byTrackKey.delete(trackKey)
      if (operation.action === 'add' && operation.song) {
        const mapped = mapCloudSongToLocal(operation.song) as Songs
        if (!byTrackKey.has(trackKey)) pendingAdds.push(mapped)
        byTrackKey.set(trackKey, mapped)
      }
    }
    // 保留云端权威顺序；本地尚未确认的新增只追加到末尾，直到事件流
    // 携带新的完整有序列表后再按云端位置收敛。
    songs = [...songs.filter((song) => byTrackKey.has(songTrackKey(song))), ...pendingAdds]
  }
  const localSongsRes = await songListAPI.getSongs(localId)
  const localSongs = localSongsRes.success && Array.isArray(localSongsRes.data) ? localSongsRes.data : []
  const localMap = new Map(localSongs.map((song) => [songTrackKey(song), song]))
  const remoteKeys = songs.map((song) => songTrackKey(song)).filter(Boolean)
  const remoteSet = new Set(remoteKeys)

  const shouldRemove = localSongs
    .filter((song) => !remoteSet.has(songTrackKey(song)))
    .filter((song) => {
      const key = songTrackKey(song)
      const pendingAdd = pending.some(
        (operation) => operation.action === 'add' && normalizeTrackKey(operation.trackKey) === key
      )
      if (pendingAdd) {
        songs = [...songs, song]
        return false
      }
      return true
    })
    .map((song) => songTrackKey(song))
  const shouldAdd = songs
    .filter((song) => !localMap.has(songTrackKey(song)))
    .filter((song) => {
      const key = songTrackKey(song)
      return !pending.some(
        (operation) => operation.action === 'remove' && normalizeTrackKey(operation.trackKey) === key
      )
    })
  const shouldRefreshCover = songs.filter((song) => {
    const local = localMap.get(songTrackKey(song))
    return Boolean(local) && !hasUsableSongCover(local?.img) && hasUsableSongCover(song.img)
  })

  if (shouldRemove.length > 0) {
    const removed = await songListAPI.removeSongs(localId, shouldRemove)
    if (!removed.success) throw new Error(removed.error || '删除远端歌曲到本地失败')
  }
  if (shouldRefreshCover.length > 0) {
    const removed = await songListAPI.removeSongs(localId, shouldRefreshCover.map((song) => songTrackKey(song)))
    if (!removed.success) throw new Error(removed.error || '刷新本地歌曲封面失败')
    const added = await songListAPI.addSongs(localId, shouldRefreshCover)
    if (!added.success) throw new Error(added.error || '写入本地歌曲封面失败')
  }
  if (shouldAdd.length > 0) {
    const added = await songListAPI.addSongs(localId, shouldAdd)
    if (!added.success) throw new Error(added.error || '添加远端歌曲到本地失败')
  }
  if (remoteKeys.length > 0) {
    await songListAPI.reorderSongs(
      localId,
      songs.map((song) => songTrackKey(song))
    )
  }

  return {
    added: shouldAdd.length,
    removed: shouldRemove.length,
    refreshed: shouldRefreshCover.length,
    total: songs.length
  }
}

export const pullFavoritesFromCloud = async () => {
  if (!(await canUseCloudLibrary())) return null
  const generation = remoteSongApplyGeneration
  await flushPendingFavoriteSongOperations()
  if (generation !== remoteSongApplyGeneration) return null

  const { localId, cloudId, playlist } = await ensureFavoritesCloudBinding()
  if (!cloudId) return null

  try {
    const syncAPI = await getSongListSyncAPI()
    const detail = await syncAPI.getSongListDetail(cloudId)
    const cloudSongs = Array.isArray(detail.list) ? detail.list : []
    if (generation !== remoteSongApplyGeneration) return null
    const result = await applyRemotePlaylistSongs(localId, cloudSongs)

    await markPlaylistCloudSyncOk(playlist, cloudId, new Date().toISOString())
    window.dispatchEvent(new Event('playlist-updated'))

    return {
      localId,
      cloudId,
      added: result.added,
      removed: result.removed,
      total: result.total
    }
  } catch (error) {
    await markPlaylistCloudSyncFailed(playlist, 'pullFavorites', error)
    throw error
  }
}
