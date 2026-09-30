import { toRaw } from 'vue'
import { LocalUserDetailStore } from '@renderer/store/LocalUserDetail'
import type { SongList } from '@renderer/types/audio'
import { buildQualityFormats, compareQuality, normalizeQualityType, normalizeTypes } from '@common/utils/quality'
import { isPlayableUrl } from '@renderer/utils/audio/playableUrl'

export type QualityFormat = { type: string; size?: string }
export type VerifiedDownloadSource = {
  url: string
  headers?: Record<string, string>
  referrer?: string
  userAgent?: string
  actualQuality?: string
}

const availabilityCache = new Map<string, boolean>()
const downloadabilityCache = new Map<string, boolean>()
const verifiedDownloadSourceCache = new Map<string, VerifiedDownloadSource>()

const songIdentity = (song: any): string =>
  String(song.songmid || song.hash || `${song.name || ''}_${song.singer || ''}`)

const cacheKey = (song: any, quality: string): string =>
  `${song.source || ''}:${songIdentity(song)}:${quality}`

const uniqQualityTypes = (items: unknown[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const type = normalizeQualityType(item)
    if (!type || seen.has(type)) continue
    seen.add(type)
    result.push(type)
  }
  return result
}

export const getPluginSourceQualitys = (source?: string, userInfo?: any): string[] => {
  const info = userInfo || LocalUserDetailStore().userInfo
  const key = String(source || '')
  const qualitys = info?.supportedSources?.[key]?.qualitys
  return Array.isArray(qualitys) ? uniqQualityTypes(qualitys) : []
}

export const getPreferredPlaybackQuality = (source?: string, userInfo?: any): string => {
  const info = userInfo || LocalUserDetailStore().userInfo
  const key = String(source || '')
  return (
    normalizeQualityType((info?.sourceQualityMap || {})[key]) ||
    normalizeQualityType(info?.selectQuality) ||
    '320k'
  )
}

export const getPlaybackQualityCandidates = (
  song: any,
  preferredQuality?: string,
  userInfo?: any
): string[] => {
  const preferred = normalizeQualityType(preferredQuality) || getPreferredPlaybackQuality(song?.source, userInfo)
  const pluginQualitys = getPluginSourceQualitys(song?.source, userInfo)
  const songTypes = normalizeTypes(song?.types)
  const pool = uniqQualityTypes([preferred, ...pluginQualitys, ...songTypes, '128k'])
  const rest = pool.filter((item) => item !== preferred).sort(compareQuality)
  const candidates = preferred ? [preferred, ...rest] : rest
  // 对齐安卓 songDeclaresQuality：歌曲声明了 types 时，未声明的档位不发请求，
  // 逐级降档只在声明过的档位内进行；未声明任何档位时才放开全量探测。
  if (songTypes.length > 0) {
    const declared = new Set(songTypes)
    const filtered = candidates.filter((item) => declared.has(item))
    if (filtered.length > 0) return filtered
    // 首选音质未声明：从声明档位里挑最接近首选的（优先不超过首选的最高档，
    // 没有更低档则取最低档），再按逐级降档顺序补上其余声明档位。
    // compareQuality 返回负数表示 a 优于 b，所以 sort(compareQuality) 才是
    // 从高档到低档；反过来会把"最高档"取成"最低档"。
    const declaredDesc = songTypes.slice().sort(compareQuality)
    const atOrBelow = declaredDesc.filter((item) => compareQuality(item, preferred) >= 0)
    const first = atOrBelow[0] || declaredDesc[declaredDesc.length - 1]
    return [first, ...declaredDesc.filter((item) => item !== first)]
  }
  return candidates
}

export const getDeclaredQualityFormats = (song: any, userInfo?: any): QualityFormat[] => {
  if (!song?.source) return []
  const pluginQualitys = getPluginSourceQualitys(song.source, userInfo)
  const songTypes = Array.isArray(song?.types) && song.types.length > 0 ? song.types : []
  const sourceTypes = pluginQualitys.length > 0 ? pluginQualitys : songTypes.length > 0 ? songTypes : ['128k']
  const typeSizes = song?._types && typeof song._types === 'object' ? song._types : {}
  const seen = new Set<string>()
  return buildQualityFormats(
    sourceTypes.map((item: any) => {
      const type = normalizeQualityType(item)
      const size =
        typeof item?.size === 'string'
          ? item.size
          : typeof typeSizes?.[type]?.size === 'string'
            ? typeSizes[type].size
            : undefined
      return { type, size }
    })
  )
    .filter((item) => {
      if (!item.type || seen.has(item.type)) return false
      seen.add(item.type)
      return true
    })
    .sort((a, b) => compareQuality(a.type, b.type))
}

export const isQualityPlayable = async (song: SongList | any, quality: string): Promise<boolean> => {
  if (!song || !quality) return false
  if (song.source === 'local') return false
  if (song.url && typeof song.url === 'string') return true

  const key = cacheKey(song, quality)
  if (availabilityCache.has(key)) return availabilityCache.get(key) === true

  try {
    const localUserStore = LocalUserDetailStore()
    const urlData = await window.api.music.requestSdk('getMusicUrl', {
      pluginId: localUserStore.userSource.pluginId,
      source: song.source,
      songInfo: toRaw(song) as any,
      quality,
      isCache: false
    })

    const ok = isPlayableUrl(urlData)
    availabilityCache.set(key, ok)
    return ok
  } catch {
    availabilityCache.set(key, false)
    return false
  }
}

export const isQualityDownloadable = async (song: SongList | any, quality: string): Promise<boolean> => {
  if (!song || !quality) return false
  if (song.source === 'local') return false
  if (song.url && typeof song.url === 'string') return true

  const key = cacheKey(song, quality)
  if (downloadabilityCache.has(key)) return downloadabilityCache.get(key) === true

  try {
    const localUserStore = LocalUserDetailStore()
    const result = await window.api.music.requestSdk('checkDownloadable', {
      pluginId: localUserStore.userSource.pluginId,
      source: song.source,
      songInfo: toRaw(song) as any,
      quality,
      isCache: false
    })

    const ok = result?.ok === undefined
      ? await isQualityPlayable(song, quality)
      : !!result.ok
    downloadabilityCache.set(key, ok)
    if (ok && typeof result?.url === 'string' && result.url) {
      verifiedDownloadSourceCache.set(key, {
        url: result.url,
        headers: result.headers || {},
        referrer: result.referrer || '',
        userAgent: result.userAgent || '',
        actualQuality: result.actualQuality || quality
      })
    } else {
      verifiedDownloadSourceCache.delete(key)
    }
    return ok
  } catch {
    const ok = await isQualityPlayable(song, quality)
    downloadabilityCache.set(key, ok)
    if (!ok) verifiedDownloadSourceCache.delete(key)
    return ok
  }
}

export const getVerifiedDownloadSource = (
  song: SongList | any,
  quality: string
): VerifiedDownloadSource | null => {
  if (!song || !quality) return null
  return verifiedDownloadSourceCache.get(cacheKey(song, quality)) || null
}

export const getDownloadableQualityFormats = async (song: SongList | any): Promise<QualityFormat[]> => {
  const declared = getDeclaredQualityFormats(song)
  if (declared.length === 0) return []

  const checked = await Promise.all(
    declared.map(async (quality) => ({
      quality,
      ok: await isQualityDownloadable(song, quality.type)
    }))
  )

  return checked
    .filter((item) => item.ok)
    .map((item) => item.quality)
    .sort((a, b) => compareQuality(a.type, b.type))
}

export const getVerifiedQualityFormats = async (song: SongList | any): Promise<QualityFormat[]> => {
  const declared = getDeclaredQualityFormats(song)
  if (declared.length === 0) return []

  const checked = await Promise.all(
    declared.map(async (quality) => ({
      quality,
      ok: await isQualityPlayable(song, quality.type)
    }))
  )

  return checked
    .filter((item) => item.ok)
    .map((item) => item.quality)
    .sort((a, b) => compareQuality(a.type, b.type))
}
