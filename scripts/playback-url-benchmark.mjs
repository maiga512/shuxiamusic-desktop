import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { service: pluginService } = await import('../sidecar/services/plugins/index.mjs')
const { service: musicSdkService } = await import('../sidecar/services/musicSdk/index.mjs')
const { service: downloadService } = await import('../sidecar/services/download/index.mjs')

const APP_DATA = path.join(os.homedir(), 'Library/Application Support/com.cerumusic.tauri')
const DB_PATH = path.join(APP_DATA, 'ceru-music.db')
const PLUGIN_ID = '9bef7105cb614607b755df9039aab4a0'
const FEINIU_ID = '9ff4f5f82ce44ce7a565b845eef51a80'

const firstText = (...items) => {
  for (const item of items) {
    if (typeof item === 'string' && item.trim()) return item.trim()
    if (typeof item === 'number' && Number.isFinite(item)) return String(item)
  }
  return ''
}

const extractUrl = (input) => {
  if (typeof input === 'string') return input.trim()
  if (!input || typeof input !== 'object') return ''
  const value = input
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
    value.body?.musicUrl
  ]
  const url = candidates.find((item) => typeof item === 'string' && item.trim())
  return typeof url === 'string' ? url.trim() : ''
}

const isPlayableUrl = (input) => {
  const url = extractUrl(input)
  if (!url) return false
  if (/^(none|null|undefined|error)(\?|$)/i.test(url)) return false
  return /^(?:https?:|blob:|file:|asset:|tauri:|\/\/)/i.test(url)
}

const timed = async (label, fn) => {
  const started = performance.now()
  try {
    const value = await fn()
    return {
      label,
      ok: true,
      ms: Math.round(performance.now() - started),
      value
    }
  } catch (error) {
    return {
      label,
      ok: false,
      ms: Math.round(performance.now() - started),
      error: error?.message || String(error)
    }
  }
}

const probeUrl = async (url, timeoutMs = 1200, headers = {}) => {
  if (!isPlayableUrl(url)) return { ok: false, reason: 'not-playable-url' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-2047', ...headers },
      signal: controller.signal,
      redirect: 'follow'
    })
    const contentType = String(response.headers.get('content-type') || '').toLowerCase()
    const looksLikeAudio =
      !contentType ||
      contentType.includes('audio') ||
      contentType.includes('octet-stream') ||
      contentType.includes('mpegurl') ||
      contentType.includes('application/x-mpegurl')
    return {
      ok: response.ok || response.status === 206,
      status: response.status,
      contentType,
      looksLikeAudio
    }
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) }
  } finally {
    clearTimeout(timer)
  }
}

const loadSongByMid = (db, songmid) => {
  const row = db
    .prepare('select data from playlist_songs where songmid = ? limit 1')
    .get(String(songmid))
  return row?.data ? JSON.parse(row.data) : null
}

const rendererCacheKey = (song, quality) => {
  const songMid = String(song?.songmid || song?.hash || `${song?.name || ''}_${song?.singer || ''}`)
  return `${song.source}_${songMid}_${quality}`
}

const invokeMusicUrl = async (pluginId, song, quality) => {
  const pluginConfig = await pluginService.getConfig({ pluginId }).catch(() => ({}))
  const songInfo = pluginConfig ? { ...song, _serviceConfig: pluginConfig } : song
  return await pluginService.invoke({
    pluginId,
    method: 'musicUrl',
    args: [song.source, songInfo, quality],
    timeoutMs: 30000
  })
}

const db = new DatabaseSync(DB_PATH, { readOnly: true })
const kwSong = loadSongByMid(db, '316696')
const wySong = loadSongByMid(db, '448749148')
const feiniuSong = loadSongByMid(db, 'feiniu_f37c9f445b6f48c1804da67307de215f')
db.close()

const report = {
  at: new Date().toISOString(),
  songs: {
    kw: kwSong && { name: kwSong.name, singer: kwSong.singer, songmid: kwSong.songmid, source: kwSong.source },
    wy: wySong && { name: wySong.name, singer: wySong.singer, songmid: wySong.songmid, source: wySong.source },
    feiniu: feiniuSong && {
      name: feiniuSong.name,
      singer: feiniuSong.singer,
      songmid: feiniuSong.songmid,
      source: feiniuSong.source
    }
  },
  stages: []
}

report.stages.push(
  await timed('plugin.initialize.selected', async () => {
    await pluginService.invoke({ pluginId: PLUGIN_ID, method: 'pluginInfo', args: [], timeoutMs: 8000 }).catch(() => null)
    await pluginService.invoke({ pluginId: FEINIU_ID, method: 'pluginInfo', args: [], timeoutMs: 8000 }).catch(() => null)
    return true
  })
)

// wy_448749148 is a live renderer cache hit (~90 min old, within 6h TTL).
// Do not call the sponsored plugin musicUrl for this song: it reports "音乐 ID 不存在".
// kw_316696 is the same-source miss sample because its 6h URL cache has expired.
const wyCacheLookup = await timed('url-cache.lookup.wy.cached', async () => {
  const key = rendererCacheKey(wySong, '320k')
  const url = await downloadService.urlCacheGet({ key })
  return { key, hit: Boolean(url), url }
})
report.stages.push({
  ...wyCacheLookup,
  value: wyCacheLookup.ok
    ? { key: wyCacheLookup.value.key, hit: wyCacheLookup.value.hit, url: wyCacheLookup.value.url ? String(wyCacheLookup.value.url).slice(0, 90) : null }
    : undefined,
  error: wyCacheLookup.error
})

if (wyCacheLookup.ok && wyCacheLookup.value.url) {
  const cachedUrl = String(wyCacheLookup.value.url)
  report.stages.push(await timed('cache-hit.syntax-only.wy', async () => isPlayableUrl(cachedUrl)))
  report.stages.push(await timed('cache-hit.verifyPlayableUrl.wy', async () => probeUrl(cachedUrl, 1200)))
}

const kwCacheLookup = await timed('url-cache.lookup.kw.expired', async () => {
  const key = rendererCacheKey(kwSong, '320k')
  const url = await downloadService.urlCacheGet({ key })
  return { key, hit: Boolean(url), url: url ? String(url).slice(0, 90) : null }
})
report.stages.push(kwCacheLookup)

const kwCold = await timed('plugin.musicUrl.kw.same-source-miss.cold', async () => {
  const raw = await invokeMusicUrl(PLUGIN_ID, kwSong, '320k')
  const url = extractUrl(raw)
  if (!isPlayableUrl(url)) throw new Error(`kw url unusable: ${JSON.stringify(raw)?.slice(0, 180)}`)
  return { url: url.slice(0, 120) }
})
report.stages.push(kwCold)

const kwWarm = await timed('plugin.musicUrl.kw.same-source-miss.warm', async () => {
  const raw = await invokeMusicUrl(PLUGIN_ID, kwSong, '320k')
  const url = extractUrl(raw)
  if (!isPlayableUrl(url)) throw new Error('kw warm url unusable')
  return { url: url.slice(0, 120) }
})
report.stages.push(kwWarm)

const crossSearch = await timed('cross-source.search.kw->tx', async () => {
  const keyword = `${kwSong.name} ${kwSong.singer}`.trim()
  const res = await musicSdkService.request({
    api: 'search',
    args: { source: 'tx', keyword, page: 1, limit: 12 }
  })
  const list = Array.isArray(res?.list) ? res.list : Array.isArray(res) ? res : []
  const first = list[0]
  return {
    keyword,
    count: list.length,
    first: first ? { name: first.name, singer: first.singer, songmid: first.songmid, source: 'tx' } : null
  }
})
report.stages.push(crossSearch)

if (crossSearch.ok && crossSearch.value.first) {
  const candidate = { ...crossSearch.value.first, source: 'tx' }
  const crossUrl = await timed('cross-source.musicUrl.tx', async () => {
    const raw = await invokeMusicUrl(PLUGIN_ID, candidate, '320k')
    const url = extractUrl(raw)
    if (!isPlayableUrl(url)) throw new Error(`tx candidate url unusable: ${JSON.stringify(raw)?.slice(0, 180)}`)
    return { url: url.slice(0, 120) }
  })
  report.stages.push(crossUrl)
}

const feiniuDirect = await timed('feiniu.direct-url.syntax', async () => {
  const url = extractUrl(feiniuSong)
  return { hasUrl: Boolean(url), playable: isPlayableUrl(url), skippedBecauseServicePlugin: Boolean(feiniuSong?._servicePluginId) }
})
report.stages.push(feiniuDirect)

const feiniuCold = await timed('plugin.musicUrl.feiniu.cold', async () => {
  const raw = await invokeMusicUrl(FEINIU_ID, feiniuSong, '128k')
  const url = extractUrl(raw)
  if (!isPlayableUrl(url)) throw new Error(`feiniu url unusable: ${JSON.stringify(raw)?.slice(0, 180)}`)
  return { url, headers: raw?.headers || {} }
})
report.stages.push({
  ...feiniuCold,
  value: feiniuCold.ok
    ? { url: String(feiniuCold.value.url).slice(0, 160), headerKeys: Object.keys(feiniuCold.value.headers || {}) }
    : undefined,
  error: feiniuCold.error
})

if (feiniuCold.ok) {
  report.stages.push(await timed('feiniu.probe.without-headers', async () => probeUrl(feiniuCold.value.url, 1200)))
  report.stages.push(
    await timed('feiniu.probe.with-plugin-headers', async () =>
      probeUrl(feiniuCold.value.url, 1200, feiniuCold.value.headers || {})
    )
  )
}

report.stages.push(
  await timed('plugin.musicUrl.feiniu.warm', async () => {
    const raw = await invokeMusicUrl(FEINIU_ID, feiniuSong, '128k')
    const url = extractUrl(raw)
    if (!isPlayableUrl(url)) throw new Error('feiniu warm url unusable')
    return { url: url.slice(0, 160) }
  })
)

console.log(JSON.stringify(report, null, 2))
process.exit(0)
