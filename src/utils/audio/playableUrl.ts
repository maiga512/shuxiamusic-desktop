export const extractPlayableUrl = (input: unknown): string => {
  if (typeof input === 'string') return input.trim()
  if (!input || typeof input !== 'object') return ''

  const value = input as Record<string, any>
  const candidates = [
    value.url,
    value.location,
    value.playUrl,
    value.musicUrl,
    value.data?.url,
    value.data?.location,
    value.data?.playUrl,
    value.data?.musicUrl,
    value.body?.url,
    value.body?.location,
    value.body?.playUrl,
    value.body?.musicUrl,
    Array.isArray(value.data) ? value.data[0]?.url : undefined,
    Array.isArray(value.body) ? value.body[0]?.url : undefined,
    Array.isArray(value.result) ? value.result[0]?.url : undefined
  ]

  const url = candidates.find((item) => typeof item === 'string' && item.trim())
  return typeof url === 'string' ? url.trim() : ''
}

/**
 * 聚合音源在拿不到真实直链时会返回 CDN 根地址（例如
 * `https://aqqmusic.tc.qq.com/`）。这类地址 scheme 合法但没有任何路径，
 * `mpv loadfile` 会返回 success 却什么都不播，于是坏地址被当成成功结果写进
 * 缓存，后续既不换音质也不换源。必须在这里判死，让调用方继续降级。
 */
const hasResolvableMediaPath = (url: string): boolean => {
  if (url.startsWith('//')) return hasResolvableMediaPath(`https:${url}`)
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:' || parsed.protocol === 'asset:' || parsed.protocol === 'tauri:') {
      return parsed.pathname.replace(/\/+$/, '').length > 0
    }
    const path = parsed.pathname.replace(/^\/+/, '')
    return path.length > 0
  } catch {
    return false
  }
}

export const isPlayableUrl = (input: unknown): input is string => {
  const url = extractPlayableUrl(input)
  if (!url) return false
  if (/^(none|null|undefined|error)(\?|$)/i.test(url)) return false
  if (/[?&](?:error|errmsg|message)=/i.test(url) && !/^https?:\/\//i.test(url)) return false
  if (!/^(?:https?:|blob:|file:|asset:|tauri:|\/\/)/i.test(url)) return false
  return hasResolvableMediaPath(url)
}
