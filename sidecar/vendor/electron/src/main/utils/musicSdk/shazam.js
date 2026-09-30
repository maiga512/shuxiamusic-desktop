import { httpFetch } from '../request'

const LANGUAGE = 'zh-CN'
// Shazam returns empty matches for CN; Android deliberately uses US here.
const COUNTRY = 'US'

function uuid() {
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID().toUpperCase()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`.toUpperCase()
}

/** Request the same discovery/v5 endpoint as the Android client. */
export async function recognizeSignature(uri, sampleMs) {
  if (!uri) return null

  const url =
    `https://amp.shazam.com/discovery/v5/${LANGUAGE}/${COUNTRY}/android/-/tag/` +
    `${uuid()}/${uuid()}` +
    '?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3' +
    '&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3'
  const request = httpFetch(url, {
    method: 'POST',
    timeout: 15000,
    headers: {
      'Content-Type': 'application/json',
      'X-Shazam-Platform': 'IPHONE',
      'X-Shazam-AppVersion': '14.1.0',
      Accept: '*/*',
      'Accept-Language': LANGUAGE,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
    },
    data: {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      signature: { uri, samplems: Math.floor(sampleMs) },
      timestamp: Date.now(),
      context: {},
      geolocation: {}
    }
  })
  const { body } = await request.promise
  const track = body?.track
  if (!track?.title) return null
  return {
    title: String(track.title),
    artist: String(track.subtitle || ''),
    startTime:
      Number(body?.matches?.[0]?.offset || body?.track?.sections?.[0]?.metadata?.[0]?.text || 0) ||
      0
  }
}

export default { recognizeSignature }
