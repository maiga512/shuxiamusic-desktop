const BRIDGED_PROVIDER_KEYS = new Set(['feiniu', '飞牛音乐', 'fnos'])
const BRIDGED_STABLE_ID_PREFIXES = ['provider:feiniu:', 'provider:飞牛音乐:', 'provider:fnos:']

const normalizeIdentifier = (value: unknown) =>
  String(value || '')
    .trim()
    .normalize('NFKC')
    .toLowerCase()

const isBridgedProvider = (value: unknown) => BRIDGED_PROVIDER_KEYS.has(normalizeIdentifier(value))
const isBridgedTitle = (value: unknown) => {
  const normalized = normalizeIdentifier(value)
  return normalized.includes('飞牛') || normalized.includes('fnos') || BRIDGED_PROVIDER_KEYS.has(normalized)
}

const isBridgedIdentifier = (value: unknown) => {
  const normalized = normalizeIdentifier(value)
  if (!normalized) return false
  if (BRIDGED_PROVIDER_KEYS.has(normalized)) return true
  return BRIDGED_STABLE_ID_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

const hasOnlyBridgedSongs = (songs: readonly any[]) =>
  songs.length > 0 && songs.every((song) => isBridgedProvider(song?.source || song?.provider || song?.lxSourceKey))

/**
 * Feiniu playlists are local mirrors of a library that every client can read directly.
 * They must not be uploaded to nas-sync-server or recreated from a cloud copy.
 */
export const isBridgedPlaylist = (playlist: any, songs?: readonly any[]) => {
  const source = playlist?.source || playlist?.meta?.source
  const provider = playlist?.meta?.provider || playlist?.provider
  if (isBridgedProvider(source) || isBridgedProvider(provider)) return true
  if (isBridgedTitle(playlist?.name || playlist?.title)) return true

  const identifiers = [
    playlist?.stableId,
    playlist?.remotePlaylistId,
    playlist?.sourcePlaylistId,
    playlist?.localId,
    playlist?.meta?.stableId,
    playlist?.meta?.providerId,
    playlist?.meta?.remotePlaylistId
  ]
  if (identifiers.some(isBridgedIdentifier)) return true

  return hasOnlyBridgedSongs(Array.isArray(songs) ? songs : playlist?.songs || [])
}

export const isBridgedRemotePlaylist = (playlist: any) =>
  isBridgedPlaylist(playlist) || isBridgedIdentifier(playlist?.localId)

export const isLocalBridgedMirror = (playlist: any) => {
  if (playlist?.meta?.isCloudOnly) return false
  if (isBridgedProvider(playlist?.source || playlist?.meta?.source)) return true
  if (isBridgedProvider(playlist?.provider || playlist?.meta?.provider)) return true
  if (isBridgedIdentifier(playlist?.stableId || playlist?.remotePlaylistId)) return true
  return hasOnlyBridgedSongs(Array.isArray(playlist?.songs) ? playlist.songs : [])
}

export const isStaleBridgedCloudCopy = (playlist: any) =>
  isBridgedPlaylist(playlist) && Boolean(playlist?.meta?.cloudId) && !isLocalBridgedMirror(playlist)
