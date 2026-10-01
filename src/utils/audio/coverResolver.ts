import type { SongList } from '@renderer/types/audio'
import { LocalUserDetailStore } from '@renderer/store/LocalUserDetail'
import { parseInterval, strSim } from './audioHelpers'

const SEARCHABLE_SOURCE_ORDER = ['wy', 'tx', 'kg', 'kw', 'mg', 'bd', 'git']
const NON_SEARCHABLE_SOURCES = new Set(['local', 'share', 'all'])
const NAME_MATCH_MIN = 0.86
const SINGER_MATCH_MIN = 0.72
const COVER_CACHE_MAX = 40  // 从 96 降低到 40
const coverCache = new Map<string, string | null>()
const pending = new Map<string, Promise<string | null>>()
const PENDING_CACHE_MAX = 20  // 限制并发请求缓存

// 监听激进内存清理事件
if (typeof window !== 'undefined') {
  window.addEventListener('memory:aggressive-cleanup', () => {
    const coverCount = coverCache.size
    const pendingCount = pending.size
    coverCache.clear()
    pending.clear()
    console.log(`[coverResolver] 激进清理: 清空 ${coverCount} 个封面缓存, ${pendingCount} 个待处理请求`)
  })
}

const rememberCover = (cacheKey: string, img: string | null) => {
  if (coverCache.has(cacheKey)) coverCache.delete(cacheKey)
  coverCache.set(cacheKey, img)
  while (coverCache.size > COVER_CACHE_MAX) {
    const oldest = coverCache.keys().next().value
    if (oldest === undefined) break
    coverCache.delete(oldest)
  }
}

const normalize = (value?: string | number | null): string =>
  String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim()

const uniq = <T>(items: T[]): T[] => [...new Set(items)]

const textOf = (song: Partial<SongList>, keys: string[]): string => {
  for (const key of keys) {
    const value = String((song as any)?.[key] || '').trim()
    if (value) return value
  }
  return ''
}

const songName = (song: Partial<SongList>): string => textOf(song, ['name', 'title'])
const songSinger = (song: Partial<SongList>): string => textOf(song, ['singer', 'artist'])
const songAlbum = (song: Partial<SongList>): string => textOf(song, ['albumName', 'album'])

const getCacheKey = (song: Partial<SongList>): string => {
  const source = normalize((song as any)._servicePluginId || song.source)
  const id = normalize((song as any).songmid || (song as any).hash || (song as any).id)
  if (source && id) return `${source}::${id}`
  return `meta::${normalize(songName(song))}::${normalize(songSinger(song))}::${normalize(songAlbum(song))}`
}

const hasUsableCover = (img?: string | null): img is string => {
  if (!img || typeof img !== 'string') return false
  const value = img.trim()
  if (!value) return false
  if (/^(https?:|data:image\/|blob:|file:)/i.test(value)) return true
  return false
}

const extractCoverUrl = (value: any): string => {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  return String(
    value.url ||
      value.body ||
      value.data?.url ||
      value.data?.body ||
      value.picUrl ||
      value.pic_url ||
      value.cover ||
      value.img ||
      ''
  ).trim()
}

const isSearchableMusicSource = (source?: string): source is string => {
  const value = String(source || '').trim()
  if (!value || NON_SEARCHABLE_SOURCES.has(value)) return false
  return SEARCHABLE_SOURCE_ORDER.includes(value)
}

const getSearchSources = (originalSource?: string, userInfo?: any): string[] => {
  const supportedSources = userInfo?.supportedSources || {}
  const qualityMap = userInfo?.sourceQualityMap || {}
  const configuredSources = uniq([...Object.keys(supportedSources), ...Object.keys(qualityMap)]).filter(
    isSearchableMusicSource
  )
  const sources = configuredSources.length > 0 ? configuredSources : SEARCHABLE_SOURCE_ORDER
  const original = isSearchableMusicSource(originalSource) ? originalSource : ''
  const rest = sources.filter((source) => source !== original)
  return original ? [original, ...rest] : rest
}

const getSearchKeywords = (song: Partial<SongList>): string[] => {
  const name = songName(song)
  const singer = songSinger(song)
  const album = songAlbum(song)
  if (!name || !singer) return []
  return uniq([`${name} ${singer}`.trim(), album ? `${name} ${singer} ${album}`.trim() : ''].filter(Boolean))
}

const getMatchScores = (candidate: any, original: Partial<SongList>) => {
  const nameScore = strSim(songName(candidate), songName(original))
  const singerScore = strSim(songSinger(candidate), songSinger(original))
  return { nameScore, singerScore }
}

const isSameSongCover = (candidate: any, original: Partial<SongList>): boolean => {
  const { nameScore, singerScore } = getMatchScores(candidate, original)
  return nameScore >= NAME_MATCH_MIN && singerScore >= SINGER_MATCH_MIN
}

const scoreCandidate = (candidate: any, original: Partial<SongList>): number => {
  const { nameScore, singerScore } = getMatchScores(candidate, original)
  let score = nameScore * 0.65 + singerScore * 0.35
  const album = songAlbum(original)
  if (album) score += strSim(songAlbum(candidate), album) * 0.05

  const originalDuration = parseInterval(String(original.interval || ''))
  const candidateDuration = parseInterval(String(candidate?.interval || ''))
  if (originalDuration > 0 && candidateDuration > 0) {
    const diff = Math.abs(originalDuration - candidateDuration)
    if (diff <= 8) score += 0.2
    else if (diff > 45) score -= 0.35
  }

  return score
}

async function resolveOwnCover(song: Partial<SongList>, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null
  const source = String((song as any)._servicePluginId || song.source || '').trim()
  if (!source || NON_SEARCHABLE_SOURCES.has(source)) return null
  try {
    const result = await (window as any).api.music.requestSdk('getPic', {
      source,
      songInfo: song
    })
    const cover = extractCoverUrl(result)
    return hasUsableCover(cover) ? cover : null
  } catch {
    return null
  }
}

export async function resolveSongCover(
  song: Partial<SongList>,
  options: { signal?: AbortSignal; userInfo?: any; skipGetPic?: boolean } = {}
): Promise<string | null> {
  if (hasUsableCover(song.img)) return song.img
  if (!songName(song) || !songSinger(song)) return null

  const cacheKey = getCacheKey(song)
  if (coverCache.has(cacheKey)) return coverCache.get(cacheKey) || null
  const existing = pending.get(cacheKey)
  if (existing) return existing

  const task = (async () => {
    if (!options.skipGetPic) {
      const ownCover = await resolveOwnCover(song, options.signal)
      if (ownCover) {
        rememberCover(cacheKey, ownCover)
        return ownCover
      }
    }
    if (options.signal?.aborted) return null

    const sources = getSearchSources(song.source, options.userInfo || LocalUserDetailStore().userInfo)
    const keywords = getSearchKeywords(song)
    if (!sources.length || !keywords.length) {
      rememberCover(cacheKey, null)
      return null
    }

    const requests = sources.flatMap((source) =>
      keywords.map(async (keyword) => {
        if (options.signal?.aborted) return []
        try {
          const res = await (window as any).api.music.requestSdk('search', {
            source,
            keyword,
            page: 1,
            limit: 20
          })
          return (res?.list || []).map((item: any) => ({ ...item, source }))
        } catch {
          return []
        }
      })
    )

    const results = (await Promise.all(requests)).flat()
    if (options.signal?.aborted) return null

    const matched = results
      .filter((item) => hasUsableCover(item?.img) && isSameSongCover(item, song))
      .map((item) => ({ item, score: scoreCandidate(item, song) }))
      .sort((a, b) => b.score - a.score)

    const img = matched[0]?.item?.img || null
    rememberCover(cacheKey, img)
    return img
  })()

  pending.set(cacheKey, task)
  // 限制 pending 缓存大小，防止内存泄漏
  if (pending.size > PENDING_CACHE_MAX) {
    const oldestPending = pending.keys().next().value
    if (oldestPending) pending.delete(oldestPending)
  }
  try {
    return await task
  } finally {
    pending.delete(cacheKey)
  }
}
