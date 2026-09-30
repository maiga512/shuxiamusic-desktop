const DEFAULT_LIST_COVER = '/default-cover.png'

function isLocalCoverProxyUrl(url: string): boolean {
  return /https?:\/\/(127\.0\.0\.1|localhost):\d+\/cover\//i.test(url)
}

function isSkippableCoverUrl(url: string): boolean {
  return (
    !url ||
    url === 'default-cover' ||
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    url.startsWith('file:') ||
    url.startsWith('/')
  )
}

function snapCoverEdge(edge: number): number {
  const requested = Math.round(Number(edge) || 0)
  if (requested <= 0) return 384
  if (requested <= 96) return 96
  if (requested <= 128) return 128
  if (requested <= 160) return 150
  if (requested <= 220) return 240
  if (requested <= 280) return 256
  if (requested <= 360) return 300
  if (requested <= 450) return 400
  return 500
}

function replaceQueryParam(url: string, key: string, value: string): string {
  const hashIndex = url.indexOf('#')
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url
  const queryIndex = withoutHash.indexOf('?')
  const base = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash
  const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : ''
  const parts = query
    ? query.split('&').filter((part) => part && !part.toLowerCase().startsWith(`${key.toLowerCase()}=`))
    : []
  parts.push(`${key}=${value}`)
  return `${base}?${parts.join('&')}${hash}`
}

export function rewritePublicCoverUrl(url?: string | null, edge = 384): string {
  const raw = String(url || '').trim()
  if (isSkippableCoverUrl(raw) || isLocalCoverProxyUrl(raw)) return raw

  const size = snapCoverEdge(edge)

  if (/music\.126\.net/i.test(raw)) {
    return replaceQueryParam(raw, 'param', `${size}y${size}`)
  }

  if (/y\.gtimg\.cn/i.test(raw) && /T00\dR\d+x\d+/i.test(raw)) {
    const qqSize = size <= 180 ? 150 : size <= 420 ? 300 : 500
    return raw.replace(/(T00\d)R\d+x\d+/i, `$1R${qqSize}x${qqSize}`)
  }

  if (raw.includes('{size}')) {
    return raw.replaceAll('{size}', String(size))
  }

  if (/kugou\.com/i.test(raw) && /\/(?:\d{2,4})\//.test(raw)) {
    return raw.replace(/\/(\d{2,4})\//, `/${size}/`)
  }

  if (/kuwo\.cn/i.test(raw)) {
    let next = raw.replace(/([?&](?:pictype|size)=)\d+/gi, `$1${size}`)
    next = next.replace(/(\d{2,4})x\1/g, `${size}x${size}`)
    return next
  }

  return raw
}

export function listCoverUrl(url?: string | null, edge = 384): string {
  const raw = String(url || '').trim()
  if (!raw || raw === 'default-cover') return DEFAULT_LIST_COVER

  const imagesApi = (window as any)?.api?.images as
    | {
        wrapThumbUrlSync?: (value: string) => string
      }
    | undefined

  let next = rewritePublicCoverUrl(raw, edge)
  if (typeof imagesApi?.wrapThumbUrlSync === 'function') {
    const thumb = imagesApi.wrapThumbUrlSync(next)
    if (typeof thumb === 'string' && thumb) next = thumb
  }

  if (!isLocalCoverProxyUrl(next) || /[?&]edge=/.test(next)) return next
  const safeEdge = Math.min(512, Math.max(32, Math.round(edge)))
  return `${next}${next.includes('?') ? '&' : '?'}edge=${safeEdge}`
}
