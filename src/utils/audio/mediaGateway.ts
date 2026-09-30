import { toRaw } from 'vue'
import type { SongList } from '@renderer/types/audio'
import { getSongRealUrl } from '@renderer/utils/playlist/playlistManager'
import { getCandidateSongs } from './audioHelpers'
import {
  getCandidateIdentitySnapshot,
  isSameSongCandidate,
  type CandidateIdentitySnapshot
} from './candidateIdentity'

type MediaProxyRequest = {
  url: string
  headers?: Record<string, string>
  referrer?: string
  userAgent?: string
}

type ValidatedMedia = {
  source: string
  rawUrl: string
  playableUrl: string
  playbackSong: SongList
  sourceSong: SongList
  requestedQuality: string
  actualQuality: string
  identity: CandidateIdentitySnapshot | null
  fromCache: boolean
}

type MediaGatewayCache = {
  get: (song: SongList, quality: string) => Promise<string | null>
  set: (song: SongList, quality: string, url: string) => Promise<void>
  invalidate: (song: SongList, quality: string) => Promise<void>
}

type MediaGatewayOptions = {
  targetSong: SongList
  userInfo: any
  getQuality: (song: SongList) => string
  cache: MediaGatewayCache
  normalizeSongForPlayback: (song: any) => SongList
  toDisplayedPlaybackSong: (target: SongList, resolvedSong: SongList, url: string) => SongList
  isUsablePlaybackUrl: (input: unknown) => input is string
  skipSources?: Set<string>
  probeTimeoutMs?: number
  sourceTimeoutMs?: number
  candidateSearchTimeoutMs?: number
  maxCandidateAttempts?: number
  activeProbe?: boolean
  requireProxy?: boolean
  allowCandidateSources?: boolean
}

type ValidationCacheEntry = {
  request: MediaProxyRequest
  source: string
  expiresAt: number
}

const VALIDATION_CACHE_TTL_MS = 10 * 60 * 1000
const DEFAULT_PROBE_TIMEOUT_MS = 3500
const DEFAULT_SOURCE_TIMEOUT_MS = 3500
const DEFAULT_CANDIDATE_SEARCH_TIMEOUT_MS = 3500
const DEFAULT_MAX_CANDIDATE_ATTEMPTS = 3
const validationCache = new Map<string, ValidationCacheEntry>()
const VALIDATION_CACHE_MAX = 80

const rememberValidation = (key: string, entry: ValidationCacheEntry) => {
  if (validationCache.has(key)) validationCache.delete(key)
  validationCache.set(key, entry)
  while (validationCache.size > VALIDATION_CACHE_MAX) {
    const oldest = validationCache.keys().next().value
    if (oldest === undefined) break
    validationCache.delete(oldest)
  }
}

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: number | null = null
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(`${label} 超时 ${timeoutMs}ms`)), timeoutMs)
    })
  ]).finally(() => {
    if (timer !== null) window.clearTimeout(timer)
  })
}

const firstText = (...items: any[]): string => {
  for (const item of items) {
    if (typeof item === 'string' && item.trim()) return item.trim()
    if (typeof item === 'number' && Number.isFinite(item)) return String(item)
  }
  return ''
}

const normalizeHeaders = (headers: any): Record<string, string> => {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {}
  return Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [String(key).trim(), firstText(value)] as const)
      .filter(([key, value]) => key && value)
  )
}

const getMediaRequest = (song: SongList, fallbackUrl: string): MediaProxyRequest => {
  const media = (song as any).__nativeMedia && typeof (song as any).__nativeMedia === 'object'
    ? (song as any).__nativeMedia
    : {}
  const headers = normalizeHeaders(media.headers || media.header)
  return {
    url: firstText(media.url, fallbackUrl),
    headers,
    referrer: firstText(media.referrer, media.referer, headers.Referer, headers.referer),
    userAgent: firstText(
      media.userAgent,
      media.user_agent,
      headers['User-Agent'],
      headers['user-agent']
    )
  }
}

const shouldUseProxy = (url: string): boolean => {
  if (!/^https?:\/\//i.test(url)) return false
  return !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)
}

const toStreamProxyUrl = async (request: MediaProxyRequest, requireProxy = false): Promise<string> => {
  const url = request.url.trim()
  if (!requireProxy || !shouldUseProxy(url)) return url
  const proxyUrl = await (window as any).api?.nativeAudio?.getAnalyserUrl?.(request)
  if (typeof proxyUrl !== 'string' || !proxyUrl.trim()) {
    throw new Error('本地音频流代理未返回可播放地址')
  }
  return proxyUrl.trim()
}

const buildValidationKey = (
  pluginId: string,
  song: SongList,
  quality: string,
  rawUrl: string
): string => {
  const songKey = firstText(song.source, 'unknown') + ':' + firstText(song.songmid, song.hash, song.name)
  return `${pluginId}:${songKey}:${quality}:${rawUrl}`
}

const withResolvedQuality = (song: SongList, quality: string): SongList => {
  return {
    ...(toRaw(song) as SongList),
    __resolvedQuality: quality
  } as SongList
}

const probePlayableUrl = async (request: MediaProxyRequest, playableUrl: string, timeoutMs: number): Promise<void> => {
  const mpv = (window as any).api?.mpv
  if (!mpv?.probe) {
    throw new Error('mpv probe 不可用')
  }
  await mpv.probe({
    ...request,
    url: playableUrl,
    timeoutMs
  })
}

const buildValidatedMedia = (
  options: MediaGatewayOptions,
  sourceSong: SongList,
  source: string,
  rawUrl: string,
  playableUrl: string,
  quality: string,
  fromCache: boolean
): ValidatedMedia => {
  const normalizedSourceSong = options.normalizeSongForPlayback(sourceSong)
  const actualQuality = firstText((sourceSong as any).__nativeMedia?.quality, (sourceSong as any).__actualQuality, quality)
  const identity = (sourceSong as any).__candidateIdentity || getCandidateIdentitySnapshot(sourceSong, options.targetSong)
  return {
    source,
    rawUrl,
    playableUrl,
    sourceSong: normalizedSourceSong,
    requestedQuality: quality,
    actualQuality,
    identity,
    playbackSong: options.toDisplayedPlaybackSong(
      options.targetSong,
      {
        ...normalizedSourceSong,
        __resolvedQuality: quality,
        __candidateIdentity: identity
      } as SongList,
      rawUrl
    ),
    fromCache
  }
}

const tryValidatedCache = async (
  options: MediaGatewayOptions,
  sourceSong: SongList,
  rawUrl: string,
  quality: string
): Promise<ValidatedMedia | null> => {
  const pluginId = firstText(options.userInfo?.pluginId, 'builtin')
  const key = buildValidationKey(pluginId, sourceSong, quality, rawUrl)
  const cached = validationCache.get(key)
  if (!cached || cached.expiresAt <= Date.now()) {
    validationCache.delete(key)
    return null
  }

  const playableUrl = await toStreamProxyUrl(cached.request, options.requireProxy === true)
  if (options.activeProbe === true) {
    await probePlayableUrl(cached.request, playableUrl, options.probeTimeoutMs || DEFAULT_PROBE_TIMEOUT_MS)
  }
  return buildValidatedMedia(options, sourceSong, cached.source, rawUrl, playableUrl, quality, true)
}

const validateSourceUrl = async (
  options: MediaGatewayOptions,
  sourceSong: SongList,
  rawUrl: string,
  quality: string
): Promise<ValidatedMedia> => {
  const cached = await tryValidatedCache(options, sourceSong, rawUrl, quality)
  if (cached) return cached

  const request = getMediaRequest(sourceSong, rawUrl)
  const playableUrl = await toStreamProxyUrl(request, options.requireProxy === true)
  if (options.activeProbe === true) {
    await probePlayableUrl(request, playableUrl, options.probeTimeoutMs || DEFAULT_PROBE_TIMEOUT_MS)
  }

  const source = firstText((sourceSong as any).__nativeMedia?.source, sourceSong.source)
  const pluginId = firstText(options.userInfo?.pluginId, 'builtin')
  rememberValidation(buildValidationKey(pluginId, sourceSong, quality, rawUrl), {
    request,
    source,
    expiresAt: Date.now() + VALIDATION_CACHE_TTL_MS
  })

  return buildValidatedMedia(options, sourceSong, source, rawUrl, playableUrl, quality, false)
}

const resolveOneSourceInner = async (
  options: MediaGatewayOptions,
  sourceSong: SongList
): Promise<ValidatedMedia | null> => {
  const quality = options.getQuality(sourceSong)
  const qualitySong = withResolvedQuality(sourceSong, quality)
  const cachedUrl = await options.cache.get(sourceSong, quality)
  if (options.isUsablePlaybackUrl(cachedUrl)) {
    try {
      console.info('[Ceru Media Gateway] quality cache hit', {
        source: sourceSong.source,
        quality,
        songmid: sourceSong.songmid
      })
      return await validateSourceUrl(options, qualitySong, cachedUrl, quality)
    } catch (error) {
      console.warn('[Ceru Media Gateway] quality cache rejected', {
        source: sourceSong.source,
        quality,
        reason: error instanceof Error ? error.message : String(error || 'unknown')
      })
      await options.cache.invalidate(sourceSong, quality)
    }
  }

  try {
    console.info('[Ceru Media Gateway] quality resolve start', {
      source: sourceSong.source,
      quality,
      songmid: sourceSong.songmid
    })
    const rawUrl = await withTimeout(
      getSongRealUrl(toRaw(qualitySong) as SongList),
      options.sourceTimeoutMs || DEFAULT_SOURCE_TIMEOUT_MS,
      `源解析 ${firstText(sourceSong.source, 'unknown')} ${quality}`
    )
    if (!options.isUsablePlaybackUrl(rawUrl)) {
      console.warn('[Ceru Media Gateway] quality resolve unusable', {
        source: sourceSong.source,
        quality,
        rawUrl
      })
      return null
    }
    const validated = await validateSourceUrl(options, qualitySong, rawUrl, quality)
    await options.cache.set(sourceSong, quality, rawUrl)
    return validated
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error || 'unknown')
    console.warn('[Ceru Media Gateway] quality resolve failed', {
      source: sourceSong.source,
      quality,
      reason
    })
    ;(options as any).__lastFailureReason = reason
    await options.cache.invalidate(sourceSong, quality)
    return null
  }
}

const resolveOneSource = async (
  options: MediaGatewayOptions,
  sourceSong: SongList
): Promise<ValidatedMedia | null> => {
  const source = firstText(sourceSong.source, 'unknown')
  const startedAt = performance.now()
  const sourceTimeoutMs = options.sourceTimeoutMs || DEFAULT_SOURCE_TIMEOUT_MS
  const timeoutMs = sourceTimeoutMs + 300
  try {
    const result = await withTimeout(resolveOneSourceInner(options, sourceSong), timeoutMs, `媒体候选 ${source}`)
    console.info('[Ceru Media Gateway] source attempt', {
      source,
      ok: Boolean(result),
      elapsedMs: Math.round(performance.now() - startedAt)
    })
    return result
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error || 'unknown')
    console.warn('[Ceru Media Gateway] source attempt failed', {
      source,
      elapsedMs: Math.round(performance.now() - startedAt),
      reason
    })
    ;(options as any).__lastFailureReason = reason
    await options.cache.invalidate(sourceSong, options.getQuality(sourceSong))
    return null
  }
}

export const resolveMediaGateway = async (options: MediaGatewayOptions): Promise<ValidatedMedia> => {
  const targetSource = firstText(options.targetSong.source)
  if (!targetSource) {
    throw new Error('歌曲来源丢失，无法请求插件播放链接')
  }

  let primaryFailureReason = ''
  if (!options.skipSources?.has(targetSource)) {
    const current = await resolveOneSource(options, options.targetSong)
    if (current) return current
    primaryFailureReason = firstText((options as any).__lastFailureReason)
  }

  if (!options.allowCandidateSources) {
    throw new Error(primaryFailureReason || '当前歌曲来源未返回可播放链接')
  }

  const candidates = await withTimeout(
    getCandidateSongs(options.targetSong, options.userInfo, {
      sourceTimeoutMs: Math.min(options.candidateSearchTimeoutMs || DEFAULT_CANDIDATE_SEARCH_TIMEOUT_MS, 1200)
    }),
    options.candidateSearchTimeoutMs || DEFAULT_CANDIDATE_SEARCH_TIMEOUT_MS,
    '候选源搜索'
  ).catch((error) => {
    console.warn('[Ceru Media Gateway] candidate search failed', {
      elapsedMs: options.candidateSearchTimeoutMs || DEFAULT_CANDIDATE_SEARCH_TIMEOUT_MS,
      reason: error instanceof Error ? error.message : String(error || 'unknown')
    })
    return [] as SongList[]
  })

  const maxAttempts = options.maxCandidateAttempts || DEFAULT_MAX_CANDIDATE_ATTEMPTS
  for (const candidate of (candidates || []).slice(0, maxAttempts)) {
    const sourceSong = options.normalizeSongForPlayback(candidate)
    if (options.skipSources?.has(sourceSong.source)) continue
    if (!isSameSongCandidate(sourceSong, options.targetSong)) {
      console.warn('[Ceru Media Gateway] candidate identity rejected before resolve', {
        source: sourceSong.source,
        name: sourceSong.name,
        singer: sourceSong.singer,
        target: `${options.targetSong.name} - ${options.targetSong.singer}`
      })
      continue
    }
    const resolved = await resolveOneSource(options, sourceSong)
    if (resolved) return resolved
  }

  const lastFailureReason = firstText(primaryFailureReason, (options as any).__lastFailureReason)
  throw new Error(lastFailureReason || 'Ceru Media Gateway 未找到验证可播的媒体流')
}

export const invalidateGatewayValidation = (
  pluginId: string,
  song: SongList,
  quality: string,
  rawUrl: string
): void => {
  validationCache.delete(buildValidationKey(firstText(pluginId, 'builtin'), song, quality, rawUrl))
}
