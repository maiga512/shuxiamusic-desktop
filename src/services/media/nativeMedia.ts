import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { formatMusicInfo } from '@common/utils/format'
import { useSettingsStore } from '@renderer/store/Settings'
import type { SongList } from '@renderer/types/audio'
import { requestMusicPluginAdapter } from '@renderer/tauri-bridge'
import { getPreferredPlaybackQuality } from '@renderer/utils/audio/qualityAvailability'

export type NativeMediaProvider = 'local' | 'direct' | 'js-plugin' | 'sidecar-native' | 'song' | 'default'
export type CommentFetchType = 'hot' | 'latest'

export interface PlaybackUrlRequest {
  song: SongList | Record<string, any>
  quality?: string
  isCache?: boolean
  pluginId?: string | null
  allowNativeFallback?: boolean
}

export interface PlaybackUrlResult {
  url: string
  source: string
  quality: string
  actualQuality?: string
  headers?: Record<string, string>
  referrer?: string
  userAgent?: string
  provider: NativeMediaProvider
  pluginId?: string
  error?: string
  raw?: any
}

export interface CoverResult {
  url: string
  source: string
  provider: NativeMediaProvider
  raw?: any
}

export interface LyricRequest {
  source?: string
  songInfo: SongList | Record<string, any>
  pluginId?: string | null
  grepLyricInfo?: boolean
  useStrictMode?: boolean
}

export interface LyricResult {
  source: string
  lyric: string
  crlyric: string
  tlyric: string
  rlyric: string
  provider: NativeMediaProvider
  raw?: any
}

export interface NativeDownloadTaskRequest {
  source?: string
  songInfo?: SongList | Record<string, any>
  song?: SongList | Record<string, any>
  quality: string
  pluginId?: string | null
  tagWriteOptions?: Record<string, any>
  isCache?: boolean
}

export interface DownloadableQualityResult {
  ok: boolean
  source: string
  quality: string
  actualQuality?: string
  provider?: NativeMediaProvider
  url?: string
  error?: string
}

export interface NativeComment {
  id: number | string
  text: string
  time: number
  timeStr: string
  location: string
  userName: string
  avatar: string
  userId: number | string
  likedCount: number
  images: string[]
  reply: NativeComment[]
}

export interface CommentResponse {
  source: string
  comments: NativeComment[]
  total: number
  page: number
  limit: number
  maxPage: number
}

const SOURCE_ALIAS_MAP: Record<string, string> = {
  qq: 'tx'
}

function normalizeSource(input?: string | null): string {
  const key = String(input || '').trim()
  return SOURCE_ALIAS_MAP[key] || key
}

function firstText(...items: any[]): string {
  for (const item of items) {
    if (typeof item === 'string' && item.trim()) return item.trim()
    if (typeof item === 'number' && Number.isFinite(item)) return String(item)
  }
  return ''
}

function normalizeLocalMusicUrl(input: any): string {
  const rawUrl = typeof input === 'string' ? input : input?.url
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return ''
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

function extractUrl(input: any): string {
  if (typeof input === 'string') return input.trim()
  return firstText(
    input?.url,
    input?.data?.url,
    input?.body,
    input?.data?.body,
    input?.musicUrl,
    input?.playUrl,
    input?.src,
    input?.location
  )
}

function extractHeaders(input: any): Record<string, string> {
  const raw = input?.headers || input?.header || input?.data?.headers || input?.data?.header || input?.urlInfo?.headers || input?.data?.urlInfo?.headers
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw)
      .map(([key, value]) => [String(key).trim(), firstText(value)] as const)
      .filter(([key, value]) => key && value)
  )
}

function extractReferrer(input: any): string {
  return firstText(
    input?.referrer,
    input?.referer,
    input?.headers?.Referer,
    input?.headers?.referer,
    input?.data?.referrer,
    input?.data?.referer,
    input?.data?.headers?.Referer,
    input?.data?.headers?.referer,
    input?.urlInfo?.referrer,
    input?.urlInfo?.referer
  )
}

function extractUserAgent(input: any): string {
  return firstText(
    input?.userAgent,
    input?.user_agent,
    input?.headers?.['User-Agent'],
    input?.headers?.['user-agent'],
    input?.data?.userAgent,
    input?.data?.user_agent,
    input?.data?.headers?.['User-Agent'],
    input?.data?.headers?.['user-agent'],
    input?.urlInfo?.userAgent,
    input?.urlInfo?.user_agent
  )
}

function isRestrictedPlaybackText(input: unknown): boolean {
  const text = String(input || '').toLowerCase()
  return [
    '当前歌曲仅在酷我',
    '最新版手机',
    '手机 app',
    '手机app',
    '手机端',
    'app播放',
    'app 播放'
  ].some((item) => text.includes(item.toLowerCase()))
}

function isUsablePlaybackUrl(input: unknown): input is string {
  return typeof input === 'string' && input.trim().length > 0 && !input.includes('error') && !isRestrictedPlaybackText(input)
}

function enrichSongMediaRequest(song: any, playback: PlaybackUrlResult): void {
  if (!song || typeof song !== 'object') return
  ;(song as any).__nativeMedia = {
    url: playback.url,
    headers: playback.headers || {},
    referrer: playback.referrer || '',
    userAgent: playback.userAgent || '',
    provider: playback.provider,
    source: playback.source,
    quality: playback.actualQuality || playback.quality,
    raw: playback.raw
  }
}

function extractSongCover(song: any): string {
  return firstText(
    song?.img,
    song?.picUrl,
    song?.pic_url,
    song?.coverImg,
    song?.coverImgUrl,
    song?.cover,
    song?.artwork,
    song?.image,
    song?.pic,
    song?.album?.picUrl,
    song?.album?.cover,
    song?.album?.coverImgUrl
  )
}

function emptyComments(source: string, page: number, limit: number): CommentResponse {
  return {
    source,
    comments: [],
    total: 0,
    page,
    limit,
    maxPage: 0
  }
}

function normalizeCommentItem(input: any): NativeComment {
  const item = input && typeof input === 'object' ? input : {}
  const user = item.user || item.owner || item.creator || {}
  const rawTime = Number(item.time ?? item.timestamp ?? item.timeStamp ?? item.createdAt ?? item.pubTime ?? 0)
  const time = Number.isFinite(rawTime) ? rawTime : 0
  const timeMs = time > 0 && time < 1000000000000 ? time * 1000 : time
  const images = item.images || item.pics || item.picUrls || item.pic || item.Pic || item.mpic
  const imageList = Array.isArray(images) ? images : images ? [images] : []
  const replyList = item.reply || item.replies || item.beReplied || item.subComments || item.SubComments || []
  return {
    id: firstText(item.id, item.commentId, item.commentid, item.CmId, item.SeqNo, `${Date.now()}_${Math.random()}`),
    text: firstText(item.text, item.content, item.msg, item.commentContent, item.Content),
    time,
    timeStr: firstText(item.timeStr, item.time_str, item.date) || (timeMs ? new Date(timeMs).toLocaleDateString() : ''),
    location: firstText(item.location, item.ipLocation?.location, item.ipLocation, item.Location),
    userName: firstText(item.userName, item.nickname, item.nick, item.Nick, user.nickname, user.name),
    avatar: firstText(item.avatar, item.avatarUrl, item.avatarurl, item.Avatar, user.avatarUrl, user.avatar),
    userId: firstText(item.userId, item.user_id, item.uid, item.uin, item.EncryptUin, user.userId, user.id),
    likedCount: Number(item.likedCount ?? item.likeCount ?? item.liked_count ?? item.praisenum ?? item.PraiseNum ?? 0),
    images: imageList.map((image: any) => firstText(image?.url, image)).filter(Boolean),
    reply: Array.isArray(replyList) ? replyList.map(normalizeCommentItem) : []
  }
}

function pickArray(...items: any[]): any[] {
  for (const item of items) {
    if (Array.isArray(item) && item.length > 0) return item
  }
  for (const item of items) {
    if (Array.isArray(item)) return item
  }
  return []
}

function normalizeComments(input: any, source: string, page: number, fallbackLimit: number): CommentResponse {
  const raw = input?.success && input?.data !== undefined ? input.data : input
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw
  const list = pickArray(
    data?.comments,
    data?.hotComments,
    data?.hot_comments,
    data?.commentList,
    data?.list,
    data?.result?.comments,
    data?.result?.hotComments
  )
  const comments = Array.isArray(list) ? list.map(normalizeCommentItem) : []
  const total = Number(data?.total ?? data?.totalCount ?? data?.commentTotal ?? data?.count ?? comments.length)
  const limit = Number(data?.limit ?? data?.pageSize ?? fallbackLimit)
  const resolvedPage = Number(data?.page ?? data?.pageNo ?? page)
  const maxPage = Number(data?.maxPage ?? (Math.ceil((Number.isFinite(total) ? total : comments.length) / Math.max(1, limit)) || 1))
  return {
    source: firstText(data?.source, raw?.source, source),
    comments,
    total: Number.isFinite(total) ? total : comments.length,
    page: Number.isFinite(resolvedPage) ? resolvedPage : page,
    limit: Number.isFinite(limit) ? limit : fallbackLimit,
    maxPage: Number.isFinite(maxPage) ? maxPage : 1
  }
}

function normalizeLyricData(input: any, source: string, provider: NativeMediaProvider): LyricResult {
  const raw = input?.success && input?.data !== undefined ? input.data : input
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw
  if (typeof raw === 'string') {
    return { source, lyric: raw, crlyric: '', tlyric: '', rlyric: '', provider, raw: input }
  }
  if (!data || typeof data !== 'object') {
    return { source, lyric: '', crlyric: '', tlyric: '', rlyric: '', provider, raw: input }
  }
  const lrc = data.lrc
  const yrc = data.yrc || data.ylyric
  const qrc = data.qrc
  const klyric = data.klyric
  const tlyric = data.tlyric || data.tlrc || data.trans || data.translation || data.transLyric
  const rlyric = data.rlyric || data.romalrc || data.romaLyric || data.romanLyric
  return {
    source: firstText(data.source, raw?.source, source),
    lyric: firstText(data.lyric, typeof lrc === 'string' ? lrc : lrc?.lyric, data.lrcText, data.lrc),
    crlyric: firstText(
      data.crlyric,
      data.cr_lyric,
      typeof yrc === 'string' ? yrc : yrc?.lyric,
      typeof qrc === 'string' ? qrc : qrc?.lyric,
      typeof klyric === 'string' ? klyric : klyric?.lyric
    ),
    tlyric: firstText(typeof tlyric === 'string' ? tlyric : tlyric?.lyric, data.tlyricText),
    rlyric: firstText(typeof rlyric === 'string' ? rlyric : rlyric?.lyric, data.rlyricText),
    provider,
    raw: input
  }
}

function hasLyricText(input: LyricResult): boolean {
  return Boolean(input.lyric || input.crlyric || input.tlyric || input.rlyric)
}

export function canFetchComments(source?: string | null): boolean {
  const normalized = normalizeSource(source)
  return Boolean(normalized && normalized !== 'local')
}

export async function resolvePlaybackUrl(request: PlaybackUrlRequest): Promise<PlaybackUrlResult> {
  const song = request.song || {}
  const source = normalizeSource(firstText((song as any).source, (song as any).platform))
  const quality = request.quality || getPreferredPlaybackQuality(source)

  if (source === 'kw') {
    const pluginId = String(request.pluginId || '').trim()
    let pluginResult: any
    if (pluginId) {
      pluginResult = await requestMusicPluginAdapter('getMusicUrl', {
        pluginId,
        source,
        songInfo: song,
        quality,
        isCache: request.isCache
      }).catch((error) => ({ error: String(error?.message || error) }))
    } else {
      pluginResult = await requestMusicPluginAdapter('getMusicUrl', {
        source,
        songInfo: song,
        quality,
        isCache: request.isCache
      }).catch((error) => ({ error: String(error?.message || error) }))
    }

    const pluginUrl = extractUrl(pluginResult)
    if (isUsablePlaybackUrl(pluginUrl)) {
      const result: PlaybackUrlResult = {
        url: pluginUrl,
        source,
        quality,
        actualQuality: firstText(pluginResult?.quality, pluginResult?.data?.quality, quality),
        headers: extractHeaders(pluginResult),
        referrer: extractReferrer(pluginResult),
        userAgent: extractUserAgent(pluginResult),
        provider: 'js-plugin',
        pluginId,
        raw: pluginResult
      }
      enrichSongMediaRequest(song, result)
      return result
    }

    return {
      url: '',
      source,
      quality,
      actualQuality: quality,
      provider: 'js-plugin',
      pluginId,
      error: '酷我未返回真实可播放链接，已阻止播放限制提示音频',
      raw: pluginResult
    }
  }

  if (source === 'local') {
    const id = (song as any).songmid
    const url = normalizeLocalMusicUrl(await invoke('local_music_get_url', { id }))
    if (!url) return { url: '', source, quality, actualQuality: quality, provider: 'local', error: '本地歌曲URL获取失败' }
    const result: PlaybackUrlResult = { url, source, quality, actualQuality: quality, provider: 'local' }
    enrichSongMediaRequest(song, result)
    return result
  }

  const media = (song as any).__nativeMedia && typeof (song as any).__nativeMedia === 'object'
    ? (song as any).__nativeMedia
    : null
  const nativeMediaUrl = extractUrl(media)
  if (isUsablePlaybackUrl(nativeMediaUrl)) {
    const result: PlaybackUrlResult = {
      url: nativeMediaUrl,
      source,
      quality,
      actualQuality: firstText(media?.actualQuality, media?.quality, quality),
      headers: extractHeaders(media),
      referrer: extractReferrer(media),
      userAgent: extractUserAgent(media),
      provider: firstText(media?.provider) as NativeMediaProvider || 'song',
      raw: media
    }
    enrichSongMediaRequest(song, result)
    return result
  }

  const directUrl = firstText((song as any).url)
  if (directUrl) {
    if (!isUsablePlaybackUrl(directUrl)) {
      return { url: '', source, quality, actualQuality: quality, provider: 'direct', error: '歌曲自带链接不可播放' }
    }
    const result: PlaybackUrlResult = {
      url: directUrl,
      source,
      quality,
      actualQuality: quality,
      headers: extractHeaders(song),
      referrer: extractReferrer(song),
      userAgent: extractUserAgent(song),
      provider: 'direct'
    }
    enrichSongMediaRequest(song, result)
    return result
  }

  const pluginId = String(request.pluginId || '').trim()
  let pluginResult: any
  if (pluginId) {
    pluginResult = await requestMusicPluginAdapter('getMusicUrl', {
      pluginId,
      source,
      songInfo: song,
      quality,
      isCache: request.isCache
    }).catch((error) => ({ error: String(error?.message || error) }))
    const pluginUrl = extractUrl(pluginResult)
    if (isUsablePlaybackUrl(pluginUrl)) {
      const result: PlaybackUrlResult = {
        url: pluginUrl,
        source,
        quality,
        actualQuality: firstText(pluginResult?.quality, pluginResult?.data?.quality, quality),
        headers: extractHeaders(pluginResult),
        referrer: extractReferrer(pluginResult),
        userAgent: extractUserAgent(pluginResult),
        provider: 'js-plugin',
        pluginId,
        raw: pluginResult
      }
      enrichSongMediaRequest(song, result)
      return result
    }
  }

  if (!pluginId) {
    pluginResult = await requestMusicPluginAdapter('getMusicUrl', {
      source,
      songInfo: song,
      quality,
      isCache: request.isCache
    }).catch((error) => ({ error: String(error?.message || error) }))
    const pluginUrl = extractUrl(pluginResult)
    if (isUsablePlaybackUrl(pluginUrl)) {
      const result: PlaybackUrlResult = {
        url: pluginUrl,
        source,
        quality,
        actualQuality: firstText(pluginResult?.quality, pluginResult?.data?.quality, quality),
        headers: extractHeaders(pluginResult),
        referrer: extractReferrer(pluginResult),
        userAgent: extractUserAgent(pluginResult),
        provider: 'js-plugin',
        raw: pluginResult
      }
      enrichSongMediaRequest(song, result)
      return result
    }
  }

  if (request.allowNativeFallback) {
    const nativeResult: any = await invoke('node_sidecar_request', {
      method: 'music.sdk.request',
      payload: {
        api: 'getMusicUrl',
        args: { source, songInfo: song, quality, isCache: request.isCache }
      }
    }).catch((error) => ({ error: String(error?.message || error) }))
    const nativeUrl = extractUrl(nativeResult)
    if (isUsablePlaybackUrl(nativeUrl)) {
      const result: PlaybackUrlResult = {
        url: nativeUrl,
        source,
        quality,
        actualQuality: firstText(nativeResult?.actualQuality, nativeResult?.quality, nativeResult?.data?.quality, quality),
        headers: extractHeaders(nativeResult),
        referrer: extractReferrer(nativeResult),
        userAgent: extractUserAgent(nativeResult),
        provider: 'sidecar-native',
        raw: nativeResult
      }
      enrichSongMediaRequest(song, result)
      return result
    }
    if (nativeResult?.error) return { url: '', source, quality, actualQuality: quality, provider: 'sidecar-native', error: String(nativeResult.error), raw: nativeResult }
  }

  return { url: '', source, quality, actualQuality: quality, provider: 'js-plugin', pluginId, error: '当前插件未返回可播放链接', raw: pluginResult }
}

export async function resolveCover(song: SongList | Record<string, any>, pluginId?: string | null): Promise<CoverResult> {
  const source = normalizeSource(firstText((song as any)?.source, (song as any)?.platform))
  const directCover = extractSongCover(song)
  if (directCover) return { url: directCover, source, provider: 'song' }

  if (source === 'local' && (song as any)?.hasCover && (song as any)?.songmid) {
    const cover = await invoke<string>('local_music_get_cover', { trackId: String((song as any).songmid) }).catch(() => '')
    if (cover) return { url: cover, source, provider: 'local' }
  }

  const preferredPluginId = String(pluginId || '').trim()
  const pluginResult = await requestMusicPluginAdapter('getPic', {
    ...(preferredPluginId ? { pluginId: preferredPluginId } : {}),
    source,
    songInfo: song
  }).catch(() => undefined)
  const pluginCover = extractUrl(pluginResult)
  if (pluginCover) return { url: pluginCover, source, provider: 'js-plugin', raw: pluginResult }

  const nativeCover = await invoke('node_sidecar_request', {
    method: 'music.sdk.request',
    payload: {
      api: 'getPic',
      args: {
        source,
        songInfo: song
      }
    }
  }).catch(() => '')
  const resolvedCover = extractUrl(nativeCover)
  if (resolvedCover) return { url: resolvedCover, source, provider: 'sidecar-native', raw: nativeCover }

  return { url: '', source, provider: 'default', raw: pluginResult }
}

export async function resolveLyric(request: LyricRequest): Promise<LyricResult> {
  const songInfo = request.songInfo || {}
  const source = normalizeSource(firstText(request.source, (songInfo as any).source, (songInfo as any).platform, 'wy'))

  if (source === 'local') {
    const existing = firstText((songInfo as any).lrc, (songInfo as any).lyric)
    if (existing) return { source, lyric: existing, crlyric: '', tlyric: '', rlyric: '', provider: 'song' }

    const text = await invoke<string | null>('local_music_get_lyric', {
      songmid: String((songInfo as any).songmid || '')
    }).catch(() => '')
    return { source, lyric: text || '', crlyric: '', tlyric: '', rlyric: '', provider: 'local' }
  }

  const directLyric = normalizeLyricData(songInfo, source, 'song')
  if (hasLyricText(directLyric)) return directLyric

  const servicePluginId = firstText((songInfo as any)._servicePluginId)
  if (servicePluginId && (window as any).api?.plugins?.getServiceLyric) {
    const serviceLyric = await (window as any).api.plugins
      .getServiceLyric(servicePluginId, songInfo)
      .catch(() => null)
    const normalized = normalizeLyricData(serviceLyric, source, 'js-plugin')
    if (hasLyricText(normalized)) return normalized
  }

  const preferredPluginId = String(request.pluginId || '').trim()
  const pluginLyric = await requestMusicPluginAdapter('getLyric', {
    ...(preferredPluginId ? { pluginId: preferredPluginId } : {}),
    source,
    songInfo,
    grepLyricInfo: request.grepLyricInfo,
    useStrictMode: request.useStrictMode
  }).catch(() => null)
  const normalizedPluginLyric = normalizeLyricData(pluginLyric, source, 'js-plugin')
  if (hasLyricText(normalizedPluginLyric)) return normalizedPluginLyric

  const nativeLyric = await invoke('node_sidecar_request', {
    method: 'music.sdk.request',
    payload: {
      api: 'getLyric',
      args: {
        source,
        songInfo,
        grepLyricInfo: request.grepLyricInfo,
        useStrictMode: request.useStrictMode
      }
    }
  }).catch(() => '')
  return normalizeLyricData(nativeLyric, source, 'sidecar-native')
}

export async function checkDownloadableQuality(request: NativeDownloadTaskRequest): Promise<DownloadableQualityResult> {
  const songInfo = { ...(request.songInfo || request.song || {}) }
  const source = normalizeSource(firstText(request.source, (songInfo as any).source, (songInfo as any).platform, 'wy'))
  const quality = request.quality || getPreferredPlaybackQuality(source)
  const pluginId = String(request.pluginId || '').trim()

  try {
    const playback = await resolvePlaybackUrl({
      song: songInfo,
      quality,
      pluginId,
      isCache: request.isCache,
      allowNativeFallback: false
    })

    if (isUsablePlaybackUrl(playback.url)) {
      return {
        ok: true,
        source,
        quality,
        actualQuality: playback.actualQuality || playback.quality || quality,
        provider: playback.provider,
        url: playback.url
      }
    }

    return {
      ok: false,
      source,
      quality,
      actualQuality: quality,
      provider: playback.provider,
      error: playback.error || '无法获取该音质下载链接'
    }
  } catch (error: any) {
    return {
      ok: false,
      source,
      quality,
      actualQuality: quality,
      error: String(error?.message || error || '下载音质校验失败')
    }
  }
}

export async function enqueueDownloadTask(request: NativeDownloadTaskRequest): Promise<any> {
  const songInfo = { ...(request.songInfo || request.song || {}) }
  const source = normalizeSource(firstText(request.source, (songInfo as any).source, (songInfo as any).platform, 'wy'))
  const quality = request.quality || getPreferredPlaybackQuality(source)
  const pluginId = String(request.pluginId || '').trim()

  const playback = await resolvePlaybackUrl({
    song: songInfo,
    quality,
    pluginId,
    isCache: request.isCache,
    allowNativeFallback: false
  })

  let downloadSource: PlaybackUrlResult = playback
  if (!isUsablePlaybackUrl(downloadSource.url)) {
    throw new Error(playback.error || '无法获取歌曲下载链接')
  }

  const actualQuality = downloadSource.actualQuality || downloadSource.quality || quality
  const cover = await resolveCover(songInfo, pluginId).catch(() => ({ url: '', source, provider: 'default' as NativeMediaProvider }))
  const lyric = await resolveLyric({ source, songInfo, pluginId }).catch(() => null)
  const lyricText = firstText(lyric?.lyric, lyric?.crlyric)
  const songInfoForDownload = {
    ...songInfo,
    source,
    img: firstText((songInfo as any).img, cover.url),
    lrc: firstText((songInfo as any).lrc, lyricText),
    __nativeMedia: {
      url: downloadSource.url,
      headers: downloadSource.headers || {},
      referrer: downloadSource.referrer || '',
      userAgent: downloadSource.userAgent || '',
      provider: downloadSource.provider,
      source: downloadSource.source,
      quality: actualQuality
    },
    typeUrl: {
      ...((songInfo as any).typeUrl || {}),
      [actualQuality]: downloadSource.url
    }
  }

  const result = await invoke('node_sidecar_request', {
    method: 'download.addTask',
    payload: {
      source,
      quality: actualQuality,
      requestedQuality: quality,
      songInfo: songInfoForDownload,
      tagWriteOptions: request.tagWriteOptions || {},
      pluginId: pluginId || undefined,
      isCache: Boolean(request.isCache),
      url: downloadSource.url
    }
  })

  return result
}

export async function enqueueDownloadTasks(tasks: NativeDownloadTaskRequest[]): Promise<any> {
  const results: any[] = []
  const errors: string[] = []

  for (const task of tasks) {
    try {
      results.push(await enqueueDownloadTask(task))
    } catch (error: any) {
      const song = task.songInfo || {}
      errors.push(`${firstText((song as any).name, (song as any).songName, '未知歌曲')}: ${error?.message || error}`)
    }
  }

  return {
    success: errors.length === 0,
    added: results.length,
    results,
    errors,
    message: errors.length === 0
      ? `已添加 ${results.length} 首歌曲到下载队列`
      : `已添加 ${results.length} 首，${errors.length} 首失败`
  }
}

export async function fetchComments(request: {
  source?: string
  songInfo: SongList | Record<string, any>
  pluginId?: string | null
  page?: number
  limit?: number
  type?: CommentFetchType
}): Promise<CommentResponse> {
  const songInfo = request.songInfo || {}
  const source = normalizeSource(firstText(request.source, (songInfo as any).source, (songInfo as any).platform, 'wy'))
  const page = Math.max(1, Number(request.page || 1))
  const limit = Math.max(1, Number(request.limit || (request.type === 'hot' ? 100 : 20)))
  const type = request.type || 'hot'

  if (!canFetchComments(source) || !(songInfo as any).songmid) {
    return emptyComments(source, page, limit)
  }

  const preferredPluginId = String(request.pluginId || '').trim()
  if (preferredPluginId) {
    const apiName = type === 'hot' ? 'getHotComment' : 'getComment'
    const pluginResult = await requestMusicPluginAdapter(apiName, {
      pluginId: preferredPluginId,
      source,
      songInfo,
      page,
      limit,
      type
    }).catch(() => null)
    const normalized = normalizeComments(pluginResult, source, page, limit)
    if (normalized.comments.length > 0 || normalized.total > 0) return normalized
  }

  const result = await invoke('music_get_comments', {
    args: {
      source,
      songInfo,
      page,
      limit,
      type
    }
  }).catch(() => null)

  return normalizeComments(result, source, page, limit)
}
