import { MessagePlugin } from 'tdesign-vue-next'
import { cloudSongListAPI } from '@renderer/api/cloudSongList'
import { getPreferredSongListAPI } from '@renderer/api/nasSync'
import songListAPI from '@renderer/api/songList'
import { getPersistentMeta } from '@renderer/utils/playlist/meta'
import { mapSongsToCloud } from '@renderer/utils/playlist/cloudList'
import { isBridgedPlaylist } from '@renderer/utils/playlist/bridgedPlaylist'
import { isBase64, base64ToFile } from '@renderer/utils/file'

export interface PlaylistInfo {
  id: string
  name: string
  description: string
  cover: string
  meta: any
}

type CloudSyncHelperOptions = {
  silent?: boolean
}

const getSongListSyncAPI = async () => (await getPreferredSongListAPI()) || cloudSongListAPI

const isMissingCloudPlaylistError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error || '')
  return /songlist .*not found|not found|不存在|404/i.test(message)
}

/**
 * Update local meta after cloud operation
 */
export async function syncLocalMetaWithCloudUpdate(
  localId: string,
  currentMeta: any,
  updatedAt: string,
  cloudId?: string
) {
  const meta = getPersistentMeta({
    ...currentMeta,
    ...(cloudId ? { cloudId } : {}),
    isSynced: true,
    cloudUpdatedAt: updatedAt,
    localUpdatedAt: updatedAt,
    cloudSyncPending: false,
    cloudSyncOperation: undefined,
    cloudSyncError: undefined,
    cloudSyncFailedAt: undefined
  })

  // Preserve playlistId if exists
  if (currentMeta?.playlistId) {
    meta.playlistId = currentMeta.playlistId
  }

  // Preserve isSynced flag if it was set (or should be set?)
  // Usually if we are syncing, it implies isSynced should be true.
  // But getPersistentMeta removes it.
  // We should rely on loadPlaylists to restore isSynced from cloudId match?
  // Or should we persist it? The original code didn't seem to persist isSynced.

  const res = await songListAPI.edit(localId, { meta })
  if (!res.success) {
    console.error('Failed to update local meta:', res.error)
  }

  return meta
}

const createCloudPlaylistFromLocal = async (playlist: PlaylistInfo, songs: any[], cover: string | File) => {
  const syncAPI = await getSongListSyncAPI()
  const res = await syncAPI.createUserSongList({
    localId: playlist.id,
    name: playlist.name,
    describe: playlist.description,
    cover,
    songlist: mapSongsToCloud(songs, true)
  })
  return res
}

/**
 * Upload local playlist to cloud (Create)
 */
export async function handleUploadToCloudHelper(
  playlist: PlaylistInfo,
  songs: any[],
  onSuccess?: () => void,
  options: CloudSyncHelperOptions = {}
) {
  if (isBridgedPlaylist(playlist, songs)) {
    if (!options.silent) MessagePlugin.info('飞牛音乐由插件直接读取 NAS，不参与多端同步')
    return playlist.meta
  }

  const loadingMsg = options.silent ? null : MessagePlugin.loading('正在上传到云端...', 0)
  try {
    const cover = isBase64(playlist.cover)
      ? base64ToFile(playlist.cover, 'cover.png')
      : playlist.cover

    const res = await createCloudPlaylistFromLocal(playlist, songs, cover)

    const updatedAt = res.updatedAt
    const cloudId = res.id

    const newMeta = await syncLocalMetaWithCloudUpdate(playlist.id, playlist.meta, updatedAt, cloudId)

    // Return updated meta including in-memory cloudUpdatedAt and isSynced
    const resultMeta = {
      ...playlist.meta,
      ...newMeta,
      cloudUpdatedAt: updatedAt,
      cloudId: cloudId,
      isSynced: true
    }

    loadingMsg?.then((inst) => inst.close())
    if (!options.silent) MessagePlugin.success('上传成功')

    if (onSuccess) onSuccess()

    return resultMeta
  } catch (e: any) {
    loadingMsg?.then((inst) => inst.close())
    console.error(e)
    if (!options.silent) MessagePlugin.error('上传失败: ' + (e.message || '未知错误'))
    throw e
  }
}

/**
 * Sync local playlist to cloud (Update)
 */
export async function handleSyncToCloudHelper(
  playlist: PlaylistInfo,
  songs: any[],
  onSuccess?: () => void,
  options: CloudSyncHelperOptions = {}
) {
  if (isBridgedPlaylist(playlist, songs)) {
    if (!options.silent) MessagePlugin.info('飞牛音乐由插件直接读取 NAS，不参与多端同步')
    return playlist.meta
  }

  const loadingMsg = options.silent ? null : MessagePlugin.loading('正在同步到云端...', 0)
  try {
    if (!playlist.meta?.cloudId) {
      throw new Error('未关联云端歌单')
    }

    const cover = isBase64(playlist.cover)
      ? base64ToFile(playlist.cover, 'cover.png')
      : playlist.cover

    const syncAPI = await getSongListSyncAPI()
    let cloudId = playlist.meta.cloudId
    let updateRes: any

    try {
      updateRes = await syncAPI.updateUserSongList({
        listId: cloudId,
        localId: playlist.id,
        name: playlist.name,
        describe: playlist.description,
        cover: cover,
        songlist: mapSongsToCloud(songs, true)
      })
    } catch (error) {
      if (!isMissingCloudPlaylistError(error)) throw error
      const created = await createCloudPlaylistFromLocal(playlist, songs, cover)
      cloudId = created.id
      updateRes = created
      if (!options.silent) MessagePlugin.warning('云端原歌单不存在，已用本地歌单重新建立同步副本')
    }

    loadingMsg?.then((inst) => inst.close())
    if (!options.silent) MessagePlugin.success('同步成功')

    const newTimestamp = updateRes?.updatedAt || new Date().toISOString()

    const newMeta = await syncLocalMetaWithCloudUpdate(playlist.id, playlist.meta, newTimestamp, cloudId)

    const resultMeta = {
      ...playlist.meta,
      ...newMeta,
      cloudId,
      cloudUpdatedAt: newTimestamp
    }

    if (onSuccess) onSuccess()

    return resultMeta
  } catch (e: any) {
    loadingMsg?.then((inst) => inst.close())
    console.error(e)
    if (!options.silent) MessagePlugin.error('同步失败: ' + (e.message || '未知错误'))
    throw e
  }
}
