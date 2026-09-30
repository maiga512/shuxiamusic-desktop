import { createHash, randomBytes } from 'crypto'
import { httpFetch } from '../../request'
import { eapi, weapi } from './utils/crypto'
import { formatPlayCount } from '../../index'

const NETEASE_WEB = 'https://music.163.com'
const NETEASE_API = 'https://interface.music.163.com'
const NETEASE_API3 = 'https://interface3.music.163.com'
const API_UA =
  'NeteaseMusic/9.1.65.240927161425(9001065);Dalvik/2.1.0 (Linux; U; Android 14; 23013RK75C Build/UKQ1.230804.001)'
const WEAPI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const WEB_UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152'
const ID_XOR_KEY = '3go8&$8*3*3h0k(2)2'

export const FALLBACK_CATEGORIES = [
  { id: 3, rawId: '3', name: '情感', subCategories: [] },
  { id: 2, rawId: '2', name: '音乐播客', subCategories: [] },
  { id: 10001, rawId: '10001', name: '有声书', subCategories: [] },
  { id: 8, rawId: '8', name: '脱口秀', subCategories: [] },
  { id: 2001, rawId: '2001', name: '创作翻唱', subCategories: [] },
  { id: 10002, rawId: '10002', name: '电音', subCategories: [] },
  { id: 11, rawId: '11', name: '知识', subCategories: [] },
  { id: 3001, rawId: '3001', name: '二次元', subCategories: [] },
  { id: 14, rawId: '14', name: '明星专区', subCategories: [] },
  { id: 6, rawId: '6', name: '生活', subCategories: [] },
  { id: 13, rawId: '13', name: '亲子', subCategories: [] },
  { id: 3087096, rawId: '3087096', name: '资讯', subCategories: [] },
  { id: 3088097, rawId: '3088097', name: '广播剧', subCategories: [] },
  { id: 3080097, rawId: '3080097', name: '故事', subCategories: [] },
  { id: 3080098, rawId: '3080098', name: '人文历史', subCategories: [] },
  { id: 3083097, rawId: '3083097', name: '娱乐', subCategories: [] },
  { id: 3088098, rawId: '3088098', name: '相声曲艺', subCategories: [] },
  { id: 3081098, rawId: '3081098', name: '其他', subCategories: [] },
  { id: 3148096, rawId: '3148096', name: '文学出版', subCategories: [] },
  { id: 20141111, rawId: '0020141111', name: '精品播客', subCategories: [] }
]

const cookieJar = new Map()
let persistedCookie = ''
let persistedNickname = ''
let persistedUserId = 0
let deviceId = ''
let categoryTreeCache = null
let anonymousToken = ''
let wnmcid = ''
let ntesNuid = ''

const firstNonBlank = (...values) =>
  values.find((value) => typeof value === 'string' && value.trim())?.trim() || ''

const randomHex = (length) =>
  randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length)
    .toUpperCase()

const ensureDeviceId = () => {
  if (!deviceId) deviceId = randomHex(52)
  return deviceId
}

const ensureNtesNuid = () => {
  if (!ntesNuid) ntesNuid = randomBytes(16).toString('hex')
  return ntesNuid
}

const ensureWnmcid = () => {
  if (wnmcid) return wnmcid
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let prefix = ''
  for (let i = 0; i < 6; i++) prefix += chars[Math.floor(Math.random() * chars.length)]
  wnmcid = `${prefix}.${Date.now().toString().slice(0, 10)}.01.0`
  return wnmcid
}

const cloudmusicDllEncodeId = (someId) => {
  let xored = ''
  for (let i = 0; i < someId.length; i++) {
    xored += String.fromCharCode(
      someId.charCodeAt(i) ^ ID_XOR_KEY.charCodeAt(i % ID_XOR_KEY.length)
    )
  }
  return createHash('md5').update(xored, 'utf8').digest('base64')
}

const extractCookieValue = (cookie, name) => {
  const hit = String(cookie || '')
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : ''
}

export const normalizeCookie = (rawCookie) => {
  const map = new Map()
  String(rawCookie || '')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.includes('='))
    .forEach((item) => {
      const name = item.slice(0, item.indexOf('=')).trim()
      const value = item.slice(item.indexOf('=') + 1).trim()
      if (name) map.set(name, value)
    })
  return [...map.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

const cookieStringFromJar = (...hosts) => {
  const map = new Map()
  hosts.forEach((host) => {
    const bucket = cookieJar.get(host) || new Map()
    bucket.forEach((value, name) => map.set(name, value))
  })
  return [...map.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

const saveSetCookie = (headers, host) => {
  const raw = headers?.['set-cookie'] || headers?.['Set-Cookie'] || []
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  if (!list.length) return ''
  const bucket = cookieJar.get(host) || new Map()
  list.forEach((line) => {
    const pair = String(line).split(';')[0]
    if (!pair.includes('=')) return
    const name = pair.slice(0, pair.indexOf('=')).trim()
    const value = pair.slice(pair.indexOf('=') + 1).trim()
    if (name) bucket.set(name, value)
  })
  cookieJar.set(host, bucket)
  return [...bucket.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

const extractCookiesFromHeaders = (headers) => {
  const raw = headers?.['set-cookie'] || headers?.['Set-Cookie'] || []
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  return list
    .map((line) => String(line).split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
}

export const hydrateLogin = (state = {}) => {
  persistedCookie = normalizeCookie(state.cookie || '')
  persistedNickname = state.nickname || ''
  persistedUserId = Number(state.userId || 0)
  deviceId = state.deviceId || deviceId || randomHex(52)
  ntesNuid =
    extractCookieValue(persistedCookie, '_ntes_nuid') || ntesNuid || randomBytes(16).toString('hex')
  wnmcid = extractCookieValue(persistedCookie, 'WNMCID') || wnmcid || ''
  anonymousToken = extractCookieValue(persistedCookie, 'MUSIC_A') || anonymousToken || ''
  cookieJar.clear()
  if (persistedCookie) {
    const bucket = new Map()
    persistedCookie.split(';').forEach((item) => {
      const text = item.trim()
      if (!text.includes('=')) return
      bucket.set(text.slice(0, text.indexOf('=')).trim(), text.slice(text.indexOf('=') + 1).trim())
    })
    cookieJar.set('music.163.com', new Map(bucket))
    cookieJar.set('interface.music.163.com', new Map(bucket))
  }
  return getLoginState()
}

export const getLoginState = () => ({
  loggedIn:
    persistedCookie.includes('MUSIC_U=') ||
    Boolean(persistedNickname) ||
    Number(persistedUserId) > 0,
  cookie: persistedCookie,
  nickname: persistedNickname,
  userId: persistedUserId,
  deviceId: deviceId || randomHex(52)
})

export const clearLogin = () => {
  persistedCookie = ''
  persistedNickname = ''
  persistedUserId = 0
  cookieJar.clear()
  categoryTreeCache = null
  return getLoginState()
}

const augmentCookie = (rawCookie, forApi = true) => {
  const cookies = new Map()
  normalizeCookie(rawCookie)
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.includes('='))
    .forEach((item) => {
      cookies.set(item.slice(0, item.indexOf('=')).trim(), item.slice(item.indexOf('=') + 1).trim())
    })
  const nowSeconds = String(Math.floor(Date.now() / 1000))
  const id = ensureDeviceId()
  const nuid = ensureNtesNuid()
  cookies.set('os', cookies.get('os') || (forApi ? 'android' : 'pc'))
  cookies.set('appver', cookies.get('appver') || (forApi ? '9.1.65.240927161425' : '3.1.17.204416'))
  cookies.set(
    'osver',
    cookies.get('osver') || (forApi ? '14' : 'Microsoft-Windows-10-Professional-build-19045-64bit')
  )
  cookies.set('channel', cookies.get('channel') || (forApi ? 'xiaomi' : 'netease'))
  cookies.set('deviceId', cookies.get('deviceId') || id)
  cookies.set('buildver', cookies.get('buildver') || nowSeconds)
  cookies.set('resolution', cookies.get('resolution') || '1920x1080')
  cookies.set('__remember_me', cookies.get('__remember_me') || 'true')
  cookies.set('ntes_kaola_ad', cookies.get('ntes_kaola_ad') || '1')
  cookies.set('_ntes_nuid', cookies.get('_ntes_nuid') || nuid)
  cookies.set('_ntes_nnid', cookies.get('_ntes_nnid') || `${nuid},${Date.now()}`)
  cookies.set('WNMCID', cookies.get('WNMCID') || ensureWnmcid())
  cookies.set('WEVNSM', cookies.get('WEVNSM') || '1.0.0')
  if (!cookies.get('MUSIC_U') && anonymousToken) {
    cookies.set('MUSIC_A', cookies.get('MUSIC_A') || anonymousToken)
  }
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

const requestCookie = (extra = '', { sessionOnly = false } = {}) =>
  augmentCookie([sessionOnly ? '' : persistedCookie, extra].filter(Boolean).join('; '), true)

const sessionCookie = (forApi = true) =>
  augmentCookie(cookieStringFromJar('music.163.com', 'interface.music.163.com'), forApi)

const parseMaybeJson = (body) => {
  if (body == null) return {}
  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch {
      return { message: body }
    }
  }
  return body
}

const buildApiHeader = (cookie, profile = 'android') => {
  const nowSeconds = String(Math.floor(Date.now() / 1000))
  const isPc = profile === 'pc'
  const header = {
    osver:
      extractCookieValue(cookie, 'osver') ||
      (isPc ? 'Microsoft-Windows-10-Professional-build-19045-64bit' : '14'),
    deviceId: extractCookieValue(cookie, 'deviceId') || ensureDeviceId(),
    os: extractCookieValue(cookie, 'os') || (isPc ? 'pc' : 'android'),
    appver:
      extractCookieValue(cookie, 'appver') || (isPc ? '3.1.17.204416' : '9.1.65.240927161425'),
    versioncode: extractCookieValue(cookie, 'versioncode') || '140',
    mobilename: extractCookieValue(cookie, 'mobilename') || '',
    buildver: extractCookieValue(cookie, 'buildver') || nowSeconds,
    resolution: extractCookieValue(cookie, 'resolution') || '1920x1080',
    __csrf: extractCookieValue(cookie, '__csrf') || '',
    channel: extractCookieValue(cookie, 'channel') || (isPc ? 'netease' : 'xiaomi'),
    requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`
  }
  const musicU = extractCookieValue(cookie, 'MUSIC_U')
  const musicA = extractCookieValue(cookie, 'MUSIC_A')
  if (musicU) header.MUSIC_U = musicU
  if (musicA) header.MUSIC_A = musicA
  return header
}

const postForm = async (
  url,
  form,
  { cookie = '', userAgent = API_UA, host = 'music.163.com' } = {}
) => {
  const res = await httpFetch(url, {
    method: 'post',
    headers: {
      'User-Agent': userAgent,
      origin: NETEASE_WEB,
      referer: `${NETEASE_WEB}/`,
      Accept: 'application/json, text/plain, */*',
      ...(cookie ? { Cookie: cookie } : {})
    },
    form
  }).promise
  saveSetCookie(res.headers, host)
  saveSetCookie(res.headers, 'interface.music.163.com')
  return { body: res.body || {}, headers: res.headers || {} }
}

const postEapi = async (
  path,
  payload = {},
  { cookie = persistedCookie, userAgent = API_UA, sessionOnly = false, profile = 'android' } = {}
) => {
  const normalized = sessionOnly
    ? augmentCookie(
        cookieStringFromJar('music.163.com', 'interface.music.163.com'),
        profile === 'android'
      )
    : requestCookie(cookie)
  const data = {
    ...payload,
    header: buildApiHeader(normalized, profile)
  }
  const encrypted = eapi(path, data)
  const url = `${NETEASE_API}/eapi/${String(path).replace(/^\/api\//, '')}`
  return postForm(url, encrypted, {
    cookie: normalized,
    userAgent,
    host: 'interface.music.163.com'
  })
}

const postWeapi = async (
  path,
  payload = {},
  { cookie = persistedCookie, userAgent = WEAPI_UA, sessionOnly = false } = {}
) => {
  const normalized = sessionOnly ? sessionCookie(false) : requestCookie(cookie)
  const url = `${NETEASE_WEB}/weapi/${String(path).replace(/^\/api\//, '')}?csrf_token=`
  return postForm(url, weapi(payload), { cookie: normalized, userAgent, host: 'music.163.com' })
}

const pickImage = (...values) => firstNonBlank(...values).replace(/\?param=\d+y\d+$/i, '')

const mapRadio = (item, categoryName = '') => {
  const radio = item?.baseInfo || item?.djRadio || item || {}
  const id = firstNonBlank(
    String(radio.id || ''),
    String(radio.radioId || ''),
    String(radio.djRadio?.id || '')
  )
  const name = firstNonBlank(radio.name, radio.radioName, radio.djRadio?.name)
  if (!id || !name) return null
  return {
    id,
    name,
    desc: firstNonBlank(radio.desc, radio.rcmdText, radio.description),
    img: pickImage(radio.picUrl, radio.picUrlStr, radio.coverUrl, radio.intervenePicUrl),
    author: radio.dj?.nickname || radio.dj?.userName || radio.creator?.nickname || '',
    total: Number(radio.programCount || 0),
    play_count: formatPlayCount(radio.playCount || radio.subCount || 0),
    playCount: Number(radio.playCount || radio.subCount || 0),
    category: firstNonBlank(radio.category, radio.categoryName, categoryName),
    secondCategory: firstNonBlank(radio.secondCategory, radio.secondCategoryName),
    lastProgramId: String(radio.lastProgramId || ''),
    replaceRadioId: String(radio.replaceRadioId || ''),
    source: 'wy'
  }
}

const parseRadios = (list, categoryName = '') =>
  (Array.isArray(list) ? list : []).map((item) => mapRadio(item, categoryName)).filter(Boolean)

const parseSearchBody = (body = {}) => {
  const result = body.result || body.data?.result || body['/api/cloudsearch/pc']?.result || {}
  const radios = result.djRadios || result.djRadiosResult?.djRadios || result.resources || []
  const total =
    result.djRadiosCount || result.djRadiosResult?.djRadiosCount || result.totalCount || 0
  return {
    list: parseRadios(radios),
    total: Number(total || 0)
  }
}

export const isPodcastProgram = (song = {}) =>
  Boolean(
    song?.contentType === 'radio-program' ||
      song?.programId ||
      song?.podcastProgramId ||
      String(song?.albumName || '').includes('电台节目')
  )

export const getCategoryTree = async (forceRefresh = false) => {
  if (!forceRefresh && categoryTreeCache?.length) return categoryTreeCache
  try {
    const { body } = await postEapi('/api/dj/radio/category/list', {})
    const list = body?.data?.parentCategoryVoList || body?.parentCategoryVoList || []
    const parsed = list
      .map((parent) => {
        const rawId = String(parent?.id || '').trim()
        const name = String(parent?.name || '').trim()
        if (!rawId || !name) return null
        const subCategories = (parent.subCategoryVO || [])
          .map((sub) => ({
            id: String(sub?.id || '').trim(),
            name: String(sub?.name || '').trim()
          }))
          .filter((sub) => sub.id && sub.name && sub.id !== '000')
        return {
          id: Number(rawId.replace(/^0+/, '')) || 0,
          rawId,
          name,
          subCategories
        }
      })
      .filter(Boolean)
    if (parsed.length) {
      categoryTreeCache = parsed
      return parsed
    }
  } catch (error) {
    console.warn('[podcast] category tree failed', error?.message || error)
  }
  return categoryTreeCache || FALLBACK_CATEGORIES
}

const resolveCategory = async (input = {}) => {
  const tree = await getCategoryTree()
  return (
    tree.find((item) => item.rawId && item.rawId === String(input.rawId || input.parentId || '')) ||
    tree.find((item) => item.id && item.id === Number(input.id)) ||
    tree.find((item) => item.name === input.name) ||
    input
  )
}

const toPlainCategory = (input = {}) => ({
  id: Number(input.id || 0),
  rawId: String(input.rawId || input.parentId || input.id || '').trim(),
  name: String(input.name || '').trim(),
  subCategories: Array.isArray(input.subCategories)
    ? input.subCategories
        .map((item) => ({
          id: String(item?.id || '').trim(),
          name: String(item?.name || '').trim()
        }))
        .filter((item) => item.id && item.name)
    : []
})

export const getCategoryPage = async ({
  category,
  parentId,
  name,
  secondName,
  page = 1,
  pageSize = 30
} = {}) => {
  const resolved = await resolveCategory(toPlainCategory(category || { rawId: parentId, name }))
  const parentRawId = String(resolved.rawId || resolved.id || parentId || '').trim()
  if (!parentRawId) {
    return {
      category: resolved,
      radios: [],
      secondCategories: (resolved.subCategories || []).map((item) => item.name),
      hasMore: false,
      page,
      pageSize
    }
  }
  const selectedSecond = String(secondName || '').trim()
  const subId = selectedSecond
    ? resolved.subCategories?.find((item) => item.name === selectedSecond)?.id ||
      resolved.subCategories?.find(
        (item) => item.name.includes(selectedSecond) || selectedSecond.includes(item.name)
      )?.id ||
      '000'
    : '000'
  const cursor = String(Math.max(0, page - 1) * pageSize)
  const { body } = await postEapi('/api/dj/radio/category/radio/list', {
    parentId: parentRawId,
    subId,
    cursor,
    limit: String(pageSize)
  })
  const data = body?.data || {}
  const radios = parseRadios(data.radioList || [], resolved.name || name || '')
  const pageObj = data.page || {}
  const hasMore = Object.prototype.hasOwnProperty.call(pageObj, 'more')
    ? Boolean(pageObj.more)
    : Number(data.count || data.total || pageObj.count || 0) > page * pageSize || radios.length >= pageSize
  return {
    category: resolved,
    radios,
    secondCategories: (resolved.subCategories || []).map((item) => item.name),
    hasMore,
    page,
    pageSize,
    subId,
    total: Number(data.count || data.total || pageObj.count || 0),
    dataSourceKind: selectedSecond ? 'official_category_sub' : 'official_category_all'
  }
}

/**
 * 网易云 dj/radio/category/radio/list 只返回 { size, cursor, more }，没有总数，
 * 所以完整分页条（1 2 3 … 最后一页 + 跳页）需要自己探出总量。
 * 做法：用小 limit 做「该 offset 还有数据吗」的指数上探 + 二分，最后在边界处
 * 拉一个大窗口数出尾部剩余条数。实测约 13 次请求、1~2 秒，结果稳定可复现。
 * 结果按 parentId+subId 缓存，避免翻页时重复探测。
 */
const categoryTotalCache = new Map()
const categoryTotalPending = new Map()
const TOTAL_PROBE_LIMIT = 60
const TOTAL_PROBE_TAIL_LIMIT = 500
const TOTAL_PROBE_MAX_OFFSET = 200000
const TOTAL_CACHE_TTL = 30 * 60 * 1000

const countRadiosAt = async (parentId, subId, cursor, limit) => {
  const { body } = await postEapi('/api/dj/radio/category/radio/list', {
    parentId: String(parentId),
    subId: String(subId),
    cursor: String(cursor),
    limit: String(limit)
  })
  return (body?.data?.radioList || []).length
}

const probeCategoryTotal = async (parentId, subId) => {
  let low = 0
  let high = 0
  let step = TOTAL_PROBE_LIMIT * 16

  while (step <= TOTAL_PROBE_MAX_OFFSET) {
    if ((await countRadiosAt(parentId, subId, step, TOTAL_PROBE_LIMIT)) > 0) {
      low = step
      step *= 2
    } else {
      high = step
      break
    }
  }
  if (!high) return 0

  while (low + TOTAL_PROBE_LIMIT < high) {
    const mid = Math.floor((low + high) / 2)
    if ((await countRadiosAt(parentId, subId, mid, TOTAL_PROBE_LIMIT)) > 0) low = mid
    else high = mid
  }

  const tail = await countRadiosAt(parentId, subId, low, TOTAL_PROBE_TAIL_LIMIT)
  return low + tail
}

export const getCategoryTotal = async ({ category, parentId, name, secondName } = {}) => {
  const resolved = await resolveCategory(toPlainCategory(category || { rawId: parentId, name }))
  const parentRawId = String(resolved.rawId || resolved.id || parentId || '').trim()
  if (!parentRawId) return { total: 0 }

  const selectedSecond = String(secondName || '').trim()
  const subId = selectedSecond
    ? resolved.subCategories?.find((item) => item.name === selectedSecond)?.id ||
      resolved.subCategories?.find(
        (item) => item.name.includes(selectedSecond) || selectedSecond.includes(item.name)
      )?.id ||
      '000'
    : '000'

  const cacheKey = `${parentRawId}:${subId}`
  const cached = categoryTotalCache.get(cacheKey)
  if (cached && Date.now() - cached.at < TOTAL_CACHE_TTL) {
    return { total: cached.total, cached: true }
  }
  if (categoryTotalPending.has(cacheKey)) {
    return { total: await categoryTotalPending.get(cacheKey) }
  }

  const task = (async () => {
    try {
      const total = await probeCategoryTotal(parentRawId, subId)
      categoryTotalCache.set(cacheKey, { total, at: Date.now() })
      return total
    } finally {
      categoryTotalPending.delete(cacheKey)
    }
  })()
  categoryTotalPending.set(cacheKey, task)
  return { total: await task }
}

export const searchRadios = async (keyword, page = 1, limit = 20) => {
  const params = {
    s: keyword,
    type: 1009,
    limit,
    total: page === 1,
    offset: Math.max(0, page - 1) * limit
  }
  const requesters = [
    () => postEapi('/api/cloudsearch/pc', params, { cookie: '', userAgent: API_UA }),
    () => postWeapi('/api/cloudsearch/get/web', params, { cookie: '', userAgent: WEAPI_UA }),
    () =>
      postForm(
        `${NETEASE_WEB}/api/search/get/web`,
        {
          s: keyword,
          type: '1009',
          limit: String(limit),
          offset: String(params.offset),
          total: String(page === 1)
        },
        { cookie: '', userAgent: WEB_UA }
      )
  ]
  let firstEmpty = null
  let lastError = null
  for (const requester of requesters) {
    try {
      const { body } = await requester()
      if (body?.code && body.code !== 200) throw new Error(body.message || '电台搜索失败')
      const parsed = parseSearchBody(body)
      if (parsed.list.length || parsed.total > 0) {
        return { ...parsed, page, limit, source: 'wy' }
      }
      firstEmpty ||= { ...parsed, page, limit, source: 'wy' }
    } catch (error) {
      lastError = error
    }
  }
  if (firstEmpty) return firstEmpty
  throw lastError || new Error('电台搜索失败')
}

const pickPublishTime = (program = {}) =>
  [
    program.publishTime,
    program.pubTime,
    program.scheduledPublishTime,
    program.schedulePublishTime,
    program.createTime,
    program.auditTime,
    program.mainSong?.publishTime
  ].find((value) => Number(value) > 0) || 0

const formatPublishDate = (value) => {
  const rawTimestamp = Number(value)
  if (!rawTimestamp) return ''
  const timestamp = rawTimestamp < 1000000000000 ? rawTimestamp * 1000 : rawTimestamp
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const formatPlayTime = (seconds) => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

const mapProgram = (program, radioFallback = {}) => {
  const mainSong = program.mainSong || {}
  const radio = program.radio || radioFallback || {}
  const duration = program.duration || mainSong.duration || mainSong.dt || 0
  const publishTime = pickPublishTime(program)
  const types = []
  const _types = {}
  const append = (type, file) => {
    if (!file) return
    types.push({ type })
    _types[type] = {}
  }
  append('flac', mainSong.sq)
  append('320k', mainSong.h)
  append('128k', mainSong.m || mainSong.l)
  if (!types.length) {
    types.push({ type: '128k' })
    _types['128k'] = {}
  }
  return {
    singer: radio.name || program.dj?.nickname || radio.dj?.nickname || '',
    name: program.name || mainSong.name || '',
    albumName: radio.name || '电台节目',
    albumId: radio.id || radioFallback.id || '',
    source: 'wy',
    interval: formatPlayTime(duration / 1000),
    songmid: mainSong.id || program.mainTrackId || program.mainSongId || program.id,
    img: pickImage(program.coverUrl, radio.picUrl, radio.picUrlStr, mainSong.al?.picUrl),
    lrc: null,
    otherSource: null,
    types: types.reverse(),
    _types,
    typeUrl: {},
    contentType: 'radio-program',
    programId: program.id,
    podcastProgramId: program.id,
    podcastMainSongId: mainSong.id || program.mainTrackId || program.mainSongId || '',
    radioId: radio.id || radioFallback.id || '',
    publishTime,
    publishDate: formatPublishDate(publishTime)
  }
}

export const getPrograms = async ({ radioId, page = 1, limit = 50, asc = false, radio } = {}) => {
  if (!radioId) return { list: [], total: 0, page, limit, source: 'wy' }
  const offset = Math.max(0, page - 1) * limit
  const res = await httpFetch(
    `${NETEASE_WEB}/api/dj/program/byradio?radioId=${encodeURIComponent(radioId)}&limit=${limit}&offset=${offset}&asc=${asc ? 'true' : 'false'}`,
    {
      headers: {
        'User-Agent': WEB_UA,
        referer: `${NETEASE_WEB}/`,
        origin: NETEASE_WEB,
        ...(persistedCookie ? { Cookie: requestCookie() } : {})
      }
    }
  ).promise
  const body = res.body || {}
  if (body.code && body.code !== 200) throw new Error(body.message || '获取电台节目失败')
  const programs = body.programs || body.data?.programs || []
  return {
    list: programs
      .filter((item) => item.mainSong || item.mainTrackId)
      .map((item) => mapProgram(item, radio)),
    total: body.count || programs.length,
    page,
    limit,
    source: 'wy'
  }
}

export const getRadioDetail = async (radioId) => {
  if (!radioId) return null
  try {
    const { body } = await postWeapi('/api/djradio/v2/get', { id: radioId })
    const data = body?.data || body?.djRadio || body
    return mapRadio(data)
  } catch (error) {
    console.warn('[podcast] radio detail failed', error?.message || error)
    return null
  }
}

export const loadHomeChannel = async ({
  officialCategoryNames = [],
  officialSecondNames = [],
  keywords = [],
  page = 1,
  limit = 12
} = {}) => {
  for (const name of officialCategoryNames) {
    const pageData = await getCategoryPage({
      name,
      secondName: officialSecondNames[0],
      page,
      pageSize: limit
    })
    if (pageData.radios.length) return pageData
  }
  for (const keyword of keywords) {
    if (!keyword) continue
    const result = await searchRadios(keyword, page, limit)
    if (result.list.length) {
      return {
        radios: result.list,
        secondCategories: [],
        hasMore: result.list.length + (page - 1) * limit < result.total,
        page,
        pageSize: limit
      }
    }
  }
  return { radios: [], secondCategories: [], hasMore: false, page, pageSize: limit }
}

const createQrUrl = (key, cookie = '') => {
  const base = `${NETEASE_WEB}/login?codekey=${encodeURIComponent(key)}`
  // NeteaseCloudMusicApi: web 平台附 chainId；桌面第三方默认 pc 不附 chainId 也能扫
  // 这里给 web 风格 chainId，兼容手机端扫码风控校验
  const device =
    extractCookieValue(cookie, 'sDeviceId') ||
    extractCookieValue(cookie, 'deviceId') ||
    ensureDeviceId()
  const chainId = `v1_${device}_web_login_${Date.now()}`
  return `${base}&chainId=${encodeURIComponent(chainId)}`
}

const parseUnikey = (body) => {
  const data = body?.data && typeof body.data === 'object' ? body.data : {}
  return firstNonBlank(data.unikey, body?.unikey, data.key, body?.key, body?.data)
}

const ensureAnonymousToken = async () => {
  if (anonymousToken) return anonymousToken
  try {
    const id = ensureDeviceId()
    const encodedId = Buffer.from(`${id} ${cloudmusicDllEncodeId(id)}`).toString('base64')
    const { body, headers } = await postWeapi(
      '/api/register/anonimous',
      { username: encodedId },
      { sessionOnly: true, userAgent: WEAPI_UA }
    )
    const parsed = parseMaybeJson(body)
    const cookie = normalizeCookie(
      [
        parsed?.cookie,
        extractCookiesFromHeaders(headers),
        cookieStringFromJar('music.163.com', 'interface.music.163.com')
      ]
        .filter(Boolean)
        .join('; ')
    )
    anonymousToken =
      extractCookieValue(cookie, 'MUSIC_A') ||
      firstNonBlank(parsed?.token, parsed?.data?.token) ||
      ''
    if (cookie) {
      const bucket = cookieJar.get('music.163.com') || new Map()
      cookie.split(';').forEach((item) => {
        const text = item.trim()
        if (!text.includes('=')) return
        bucket.set(
          text.slice(0, text.indexOf('=')).trim(),
          text.slice(text.indexOf('=') + 1).trim()
        )
      })
      cookieJar.set('music.163.com', bucket)
      cookieJar.set('interface.music.163.com', new Map(bucket))
    }
  } catch (error) {
    console.warn('[podcast] anonymous register failed', error?.message || error)
  }
  return anonymousToken
}

export const createQrLogin = async () => {
  // 对齐 NeteaseCloudMusicApi@4.32.0：
  // 1) 先匿名注册拿 MUSIC_A / device cookie
  // 2) eapi /api/login/qrcode/unikey  type=3
  // 3) QR 内容 = https://music.163.com/login?codekey={key}
  cookieJar.clear()
  ensureDeviceId()
  ensureNtesNuid()
  ensureWnmcid()
  await ensureAnonymousToken()

  let key = ''
  let lastError = null
  try {
    const { body } = await postEapi(
      '/api/login/qrcode/unikey',
      { type: 3 },
      { sessionOnly: true, userAgent: DESKTOP_UA, profile: 'pc' }
    )
    const parsed = parseMaybeJson(body)
    key = parseUnikey(parsed)
  } catch (error) {
    lastError = error
  }
  // 仅在 eapi 失败时再尝试 weapi type=1，避免混用导致风控
  if (!key) {
    try {
      const { body } = await postWeapi(
        '/api/login/qrcode/unikey',
        { type: 1 },
        { sessionOnly: true, userAgent: WEAPI_UA }
      )
      key = parseUnikey(parseMaybeJson(body))
    } catch (error) {
      lastError = error
    }
  }
  if (!key) throw new Error(lastError?.message || '网易云未返回二维码 key')
  const session = sessionCookie(false)
  return {
    key,
    qrUrl: createQrUrl(key, session),
    // 给前端展示用，方便排查
    mode: 'eapi-type3'
  }
}

const fetchAccount = async (cookie) => {
  try {
    const { body } = await postWeapi('/api/nuser/account/get', {}, { cookie, userAgent: WEAPI_UA })
    const account = body?.account || {}
    const profile = body?.profile || {}
    return {
      userId: Number(account.id || profile.userId || 0),
      nickname: profile.nickname || ''
    }
  } catch {
    return { userId: 0, nickname: '' }
  }
}

const QR_MESSAGES = {
  801: '等待扫码',
  802: '待确认登录',
  803: '授权成功',
  800: '二维码不存在或已过期'
}

const requestQrCheck = async (key) => {
  // NeteaseCloudMusicApi: 固定 type=3 + eapi
  return postEapi(
    '/api/login/qrcode/client/login',
    { key, type: 3 },
    { sessionOnly: true, userAgent: DESKTOP_UA, profile: 'pc' }
  )
}

export const checkQrLogin = async (key) => {
  let body = {}
  let headers = {}
  try {
    ;({ body, headers } = await requestQrCheck(key))
  } catch (error) {
    // 仅失败时 fallback weapi type=1
    try {
      ;({ body, headers } = await postWeapi(
        '/api/login/qrcode/client/login',
        { key, type: 1 },
        { sessionOnly: true, userAgent: WEAPI_UA }
      ))
    } catch (fallbackError) {
      return {
        code: -1,
        message: fallbackError?.message || error?.message || '扫码状态检查失败',
        cookie: '',
        nickname: '',
        userId: 0
      }
    }
  }
  body = parseMaybeJson(body)
  const code = Number(body?.code ?? -1)
  let message = firstNonBlank(body?.message, body?.msg, QR_MESSAGES[code], '网易云登录状态未知')
  // 风控文案原样透出，方便用户判断
  if (/环境异常|拦截|频繁|外挂|异常/.test(message)) {
    message = `${message}（这通常是网易云风控，不是二维码图本身坏了）`
  }
  const cookie = normalizeCookie(
    [
      body?.cookie,
      extractCookiesFromHeaders(headers),
      cookieStringFromJar('music.163.com', 'interface.music.163.com')
    ]
      .filter(Boolean)
      .join('; ')
  )
  let nickname = firstNonBlank(body?.nickname, body?.profile?.nickname)
  let userId = Number(body?.userId || body?.profile?.userId || body?.account?.id || 0)
  if (code === 803) {
    if (!cookie) {
      return { code, message: '网易云已授权，但没有返回 Cookie', cookie: '', nickname, userId }
    }
    if (cookie.includes('MUSIC_U=')) {
      const account = await fetchAccount(cookie)
      nickname = nickname || account.nickname
      userId = userId || account.userId
    }
    hydrateLogin({ cookie, nickname, userId, deviceId: ensureDeviceId() })
  }
  return { code, message, cookie, nickname, userId }
}

export const getOfficialPlayUrl = async (song, quality = 'exhigh') => {
  const songId = String(song?.podcastMainSongId || song?.songmid || '').trim()
  if (!songId) return { error: '官方播客缺少歌曲 ID' }
  const level =
    {
      standard: 'standard',
      '128k': 'standard',
      lossless: 'lossless',
      flac: 'lossless',
      hires: 'hires',
      master: 'hires',
      flac24bit: 'hires'
    }[String(quality || '').toLowerCase()] || 'exhigh'
  const encodeType = ['lossless', 'flac', 'hires', 'master', 'flac24bit'].includes(
    String(quality || '').toLowerCase()
  )
    ? 'flac'
    : 'aac'
  const { body } = await postForm(
    `${NETEASE_API3}/eapi/song/enhance/player/url/v1`,
    eapi('/api/song/enhance/player/url/v1', {
      ids: `[${songId}]`,
      level,
      encodeType
    }),
    { cookie: requestCookie(), userAgent: API_UA, host: 'interface3.music.163.com' }
  )
  const item = body?.data?.[0] || {}
  const url = String(item.url || '').trim()
  if (!url) return { error: body?.message || '网易云官方未返回播客播放地址' }
  return { url }
}

export const getProgramLyric = async (song) => {
  const programId = String(song?.podcastProgramId || song?.programId || '').trim()
  if (!programId) return ''
  try {
    const res = await httpFetch(
      `${NETEASE_WEB}/api/dj/program/detail?id=${encodeURIComponent(programId)}`,
      {
        headers: {
          'User-Agent': WEB_UA,
          referer: `${NETEASE_WEB}/`,
          ...(persistedCookie ? { Cookie: requestCookie() } : {})
        }
      }
    ).promise
    const program = res.body?.program || res.body?.data || {}
    const parsed = program.parsedLyric || program.lyric || ''
    if (typeof parsed === 'string' && parsed.trim()) return parsed
    const description = firstNonBlank(program.description, program.bdDescription)
    return description
  } catch {
    return ''
  }
}

export const getPersistedMeta = () => ({
  cookie: persistedCookie,
  nickname: persistedNickname,
  userId: persistedUserId,
  deviceId: deviceId || randomHex(52)
})

export default {
  getCategoryTree,
  getCategoryPage,
  getCategoryTotal,
  searchRadios,
  getPrograms,
  getRadioDetail,
  loadHomeChannel,
  createQrLogin,
  checkQrLogin,
  getOfficialPlayUrl,
  getProgramLyric,
  getLoginState,
  getPersistedMeta,
  hydrateLogin,
  clearLogin
}
