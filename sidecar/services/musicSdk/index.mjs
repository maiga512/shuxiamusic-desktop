import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import axios from 'axios'
import { service as pluginService } from '../plugins/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pathExistsSync = (target) => {
  try {
    return fsSync.existsSync(target)
  } catch {
    return false
  }
}

const resolveProjectRoot = () => {
  const candidates = [
    path.resolve(__dirname, '../../../../..'), // target/debug/sidecar/services/musicSdk -> repo root
    path.resolve(__dirname, '../../..'), // sidecar/services/musicSdk -> repo root
    process.cwd(),
  ]
  for (const candidate of candidates) {
    const vendorPodcast = path.join(
      candidate,
      'sidecar/vendor/electron/src/main/utils/musicSdk/wy/podcastOfficial.js'
    )
    // Prefer the real repo vendor copy, not the stale tree nested under target/debug.
    if (
      pathExistsSync(vendorPodcast) &&
      pathExistsSync(path.join(candidate, 'package.json')) &&
      !candidate.includes(`${path.sep}target${path.sep}`)
    ) {
      return candidate
    }
  }
  for (const candidate of candidates) {
    if (pathExistsSync(path.join(candidate, 'sidecar/vendor/electron/src/main/utils/musicSdk'))) {
      return candidate
    }
  }
  return candidates[0]
}
const projectRoot = resolveProjectRoot()
const APP_IDENTIFIER = 'com.shuxiamusic.tauri'
const electronRoot =
  process.env.CERU_ELECTRON_ROOT || path.join(projectRoot, 'sidecar/vendor/electron')
const electronSrcRoot = path.join(electronRoot, 'src')
const electronMainUtilsRoot = path.join(electronSrcRoot, 'main/utils')
const electronMusicSdkRoot = path.join(electronMainUtilsRoot, 'musicSdk')
const runtimeVersion = '2026-09-18-sidecar-esm-1'

const resolveDefaultAppDataRoot = () => {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_IDENTIFIER)
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      APP_IDENTIFIER
    )
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    APP_IDENTIFIER
  )
}

const appDataRoot =
  process.env.CERU_APP_DATA_DIR ||
  process.env.CERU_TAURI_APP_DATA_DIR ||
  resolveDefaultAppDataRoot()

// Packaged resources are often read-only. Prefer writable app-data for the
// generated musicSdk runtime, and keep the repo-local path for development.
const packagedRuntimeRoot = path.join(appDataRoot, 'sidecar-runtime', 'musicSdk')
const devRuntimeRoot = path.join(projectRoot, '.sidecar-runtime', 'musicSdk')
const runtimeRoot =
  process.env.CERU_MUSICSDK_RUNTIME_ROOT ||
  ((process.env.CERU_APP_DATA_DIR || process.env.CERU_TAURI_APP_DATA_DIR)
    ? packagedRuntimeRoot
    : devRuntimeRoot)
const runtimeMarkerPath = path.join(runtimeRoot, '.runtime-version')
const podcastAuthPath = path.join(appDataRoot, 'podcast-auth.json')

if (!globalThis.self) globalThis.self = globalThis
if (!globalThis.location) globalThis.location = { href: 'file://sidecar/' }
if (!globalThis.window) globalThis.window = globalThis
if (!globalThis.document) {
  globalThis.document = {
    body: { appendChild() {}, removeChild() {} },
    createElement() {
      return { style: {}, contentWindow: globalThis }
    }
  }
}

let runtimeReady
let musicSdkModule
let podcastAuthLoaded = false

const readPodcastAuth = async () => {
  try {
    return JSON.parse(await fs.readFile(podcastAuthPath, 'utf8'))
  } catch {
    return {}
  }
}

const writePodcastAuth = async (state = {}) => {
  await fs.mkdir(appDataRoot, { recursive: true })
  await fs.writeFile(podcastAuthPath, JSON.stringify(state, null, 2), 'utf8')
}

const firstText = (...items) => {
  for (const item of items) {
    if (typeof item === 'string' && item.trim()) return item.trim()
    if (typeof item === 'number' && Number.isFinite(item)) return String(item)
  }
  return ''
}

const isPodcastProgram = (song = {}) =>
  Boolean(
    song?.contentType === 'radio-program' ||
      song?.programId ||
      song?.podcastProgramId
  )

const importLinePattern = /(import\s+(?:[^'";]+?\s+from\s+)?['"])([^'"#][^'"]*)(['"])/g
const exportLinePattern = /(export\s+(?:[^'";]+?\s+from\s+)?['"])([^'"#][^'"]*)(['"])/g

const normalizeSpecifier = (specifier) => {
  if (specifier.startsWith('@common/')) {
    return `../common/${specifier.slice('@common/'.length)}.js`
  }
  if (specifier === '../../index' || specifier === '../index') return '../../index.js'
  if (specifier === '../utils') return '../utils.js'
  if (specifier === '../../utils') return '../../utils.js'
  if (specifier === '../../../request') return '../../../request.js'
  if (specifier === '../../request') return '../../request.js'
  if (specifier === '../../message') return '../../message.js'
  if (specifier === '../../../../common/utils/lyricUtils/kg') {
    return '../../../../common/utils/lyricUtils/kg.js'
  }
  if (!specifier.startsWith('.')) return specifier
  if (/\.(mjs|cjs|js|json|node)$/i.test(specifier)) return specifier
  return `${specifier}.js`
}

const rewriteImports = (content) =>
  content
    .replace(importLinePattern, (_, prefix, specifier, suffix) => `${prefix}${normalizeSpecifier(specifier)}${suffix}`)
    .replace(exportLinePattern, (_, prefix, specifier, suffix) => `${prefix}${normalizeSpecifier(specifier)}${suffix}`)

const stripTypeScript = (content) =>
  content
    .replace(/interface\s+\w+\s*\{[\s\S]*?\}\n/g, '')
    .replace(/\s+as\s+const/g, '')
    .replace(/\s+as\s+keyof\s+typeof\s+\w+/g, '')
    .replace(/:\s*\([^)]*\)\s*=>\s*void/g, '')
    .replace(/:\s*string\s*\|\s*null/g, '')
    .replace(/:\s*Promise<[^>]+>/g, '')
    .replace(/:\s*Buffer/g, '')
    .replace(/:\s*string/g, '')
    .replace(/:\s*number/g, '')
    .replace(/:\s*boolean/g, '')
    .replace(/:\s*any/g, '')
    .replace(/:\s*void/g, '')
    .replace(/:\s*Record<[^>]+>/g, '')
    .replace(/<T extends [^>]+>/g, '')
    .replace(/<T>/g, '')
    .replace(/ as any\[\]/g, '')
    .replace(/ as any/g, '')
    .replace(/ as Promise<[^>]+>/g, '')

const copyDirectory = async (source, target) => {
  await fs.mkdir(target, { recursive: true })
  const entries = await fs.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath)
      continue
    }
    if (!entry.isFile()) continue
    if (!/\.(js|ts)$/i.test(entry.name)) continue
    if (entry.name === 'api-source-info.ts') continue

    const parsed = path.parse(targetPath)
    const finalTargetPath = path.join(parsed.dir, `${parsed.name}.js`)
    let content = await fs.readFile(sourcePath, 'utf8')
    if (entry.name.endsWith('.ts')) content = stripTypeScript(content)
    await fs.writeFile(finalTargetPath, rewriteImports(content), 'utf8')
  }
}

const writeRuntimeSupportFiles = async () => {
  await fs.mkdir(path.join(runtimeRoot, 'main/utils'), { recursive: true })
  await fs.mkdir(path.join(runtimeRoot, 'main/utils/musicSdk/common/utils'), { recursive: true })
  await fs.mkdir(path.join(runtimeRoot, 'main/common/utils/lyricUtils'), { recursive: true })
  await fs.mkdir(path.join(runtimeRoot, 'main/common/utils'), { recursive: true })
  await fs.mkdir(path.join(runtimeRoot, 'common/utils/lyricUtils'), { recursive: true })

  await fs.writeFile(
    path.join(runtimeRoot, 'package.json'),
    JSON.stringify({ type: 'module', private: true }, null, 2),
    'utf8'
  )

  await fs.writeFile(
    path.join(runtimeRoot, 'main/utils/message.js'),
    "export const requestMsg = (...args) => console.warn('[musicSdk message]', ...args)\n",
    'utf8'
  )

  await fs.writeFile(
    path.join(runtimeRoot, 'main/common/utils/common.js'),
    `export const getRandom = (min, max) => Math.floor(Math.random() * (max - min)) + min
export const sizeFormate = (size) => {
  if (!size) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const number = Math.floor(Math.log(size) / Math.log(1024))
  return \`\${(size / Math.pow(1024, Math.floor(number))).toFixed(2)} \${units[number]}\`
}
const numFix = (n) => (n < 10 ? \`0\${n}\` : n.toString())
export const dateFormat = (_date, format = 'Y-M-D h:m:s') => {
  let date = _date
  if (!date) return ''
  if (typeof date === 'string' && !date.includes('T')) date = date.split('.')[0].replace(/-/g, '/')
  if (typeof date === 'string' || typeof date === 'number') date = new Date(date)
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  return format.replace('Y', date.getFullYear().toString()).replace('M', numFix(date.getMonth() + 1)).replace('D', numFix(date.getDate())).replace('h', numFix(date.getHours())).replace('m', numFix(date.getMinutes())).replace('s', numFix(date.getSeconds()))
}
export const formatPlayTime = (time) => {
  const m = Math.trunc((Number(time) || 0) / 60)
  const s = Math.trunc((Number(time) || 0) % 60)
  return m === 0 && s === 0 ? '--/--' : numFix(m) + ':' + numFix(s)
}
export const formatPlayTime2 = (time) => {
  const m = Math.trunc((Number(time) || 0) / 60)
  const s = Math.trunc((Number(time) || 0) % 60)
  return numFix(m) + ':' + numFix(s)
}
export const isUrl = (value) => /https?:\/\//.test(value || '')
export const parseUrlParams = (str) => Object.fromEntries(String(str || '').split('&').filter(Boolean).map((item) => item.split('=')))
export const filterFileName = (name) => String(name || '').replace(/[\\/:*?#"<>|]/g, '')
export const similar = (a = '', b = '') => (a && b && a === b ? 1 : 0)
export const encodePath = (path) => encodeURI(String(path || '').replaceAll('\\\\', '/'))
export const arrPush = (list, newList) => (list.push(...newList), list)
export const arrUnshift = (list, newList) => (list.unshift(...newList), list)
export const arrPushByPosition = (list, newList, position) => (list.splice(position, 0, ...newList), list)
export const arrShuffle = (array) => array.sort(() => Math.random() - 0.5)
export function formatNumberToChineseSimple(num) {
  let number = typeof num === 'string' ? parseFloat(num) : num
  if (Number.isNaN(number)) return '0'
  const isNegative = number < 0
  number = Math.abs(number)
  if (number >= 100000000) return (isNegative ? '-' : '') + parseFloat((number / 100000000).toFixed(1)).toString() + '亿'
  if (number >= 10000) return (isNegative ? '-' : '') + parseFloat((number / 10000).toFixed(1)).toString() + '万'
  return (isNegative ? '-' : '') + Math.round(number).toString()
}
export function formatMinutesFlexible(minutes) {
  const value = Number(minutes)
  if (!Number.isFinite(value)) return '0分钟'
  if (Math.abs(value) < 3000) return \`\${Math.round(value)}分钟\`
  if (Math.abs(value) < 14400) return \`\${(value / 60).toFixed(1)}小时\`
  if (Math.abs(value) < 200000) return \`\${Math.round(value / 60)}小时\`
  return \`\${parseFloat((value / 60 / 10000).toFixed(1)).toString()}万小时\`
}
`,
    'utf8'
  )

  await fs.writeFile(
    path.join(runtimeRoot, 'main/common/utils/nodejs.js'),
    "export * from './common.js'\n",
    'utf8'
  )

  await fs.writeFile(
    path.join(runtimeRoot, 'main/utils/index.js'),
    `export * from '../common/utils/nodejs.js'
export * from '../common/utils/common.js'
export const formatPlayCount = (num) => {
  const value = Number(num) || 0
  if (value > 100000000) return \`\${Math.trunc(value / 10000000) / 10}亿\`
  if (value > 10000) return \`\${Math.trunc(value / 1000) / 10}万\`
  return String(value)
}
export const dateFormat2 = (time) => {
  const differ = Math.trunc((Date.now() - Number(time || 0)) / 1000)
  if (differ < 60) return \`\${differ}秒前\`
  if (differ < 3600) return \`\${Math.trunc(differ / 60)}分钟前\`
  if (differ < 86400) return \`\${Math.trunc(differ / 3600)}小时前\`
  return new Date(time).toLocaleString()
}
export const deduplicationList = (list) => {
  const ids = new Set()
  return (list || []).filter((item) => {
    if (ids.has(item.id)) return false
    ids.add(item.id)
    return true
  })
}
export const decodeName = (str = '') => String(str || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
`,
    'utf8'
  )

  await fs.writeFile(
    path.join(runtimeRoot, 'main/utils/utils.js'),
    "export * from './index.js'\n",
    'utf8'
  )

  const kgLyricSource = await fs.readFile(
    path.join(electronSrcRoot, 'common/utils/lyricUtils/kg.js'),
    'utf8'
  )
  const kgLyricTarget = rewriteImports(kgLyricSource)
  await fs.writeFile(
    path.join(runtimeRoot, 'main/common/utils/lyricUtils/kg.js'),
    kgLyricTarget,
    'utf8'
  )

  await fs.writeFile(
    path.join(runtimeRoot, 'common/utils/lyricUtils/kg.js'),
    kgLyricTarget,
    'utf8'
  )

  const lyricUtilSource = await fs.readFile(
    path.join(electronSrcRoot, 'common/utils/lyricUtils/util.ts'),
    'utf8'
  )
  const lyricUtilTarget = rewriteImports(stripTypeScript(lyricUtilSource))
  await fs.writeFile(
    path.join(runtimeRoot, 'main/common/utils/lyricUtils/util.js'),
    lyricUtilTarget,
    'utf8'
  )
  await fs.writeFile(
    path.join(runtimeRoot, 'common/utils/lyricUtils/util.js'),
    lyricUtilTarget,
    'utf8'
  )

  await fs.copyFile(
    path.join(runtimeRoot, 'main/common/utils/common.js'),
    path.join(runtimeRoot, 'main/utils/musicSdk/common/utils/common.js')
  )

  await fs.writeFile(
    path.join(runtimeRoot, 'main/utils/musicSdk/wy/utils.js'),
    "export * from './utils/index.js'\n",
    'utf8'
  )
  await fs.writeFile(
    path.join(runtimeRoot, 'main/utils/musicSdk/tx/utils.js'),
    "export * from './utils/index.js'\n",
    'utf8'
  )
  await fs.writeFile(
    path.join(runtimeRoot, 'main/utils/musicSdk/mg/utils.js'),
    "export * from './utils/index.js'\n",
    'utf8'
  )

  const requestSource = await fs.readFile(path.join(electronMainUtilsRoot, 'request.js'), 'utf8')
  await fs.writeFile(
    path.join(runtimeRoot, 'main/utils/request.js'),
    rewriteImports(requestSource).replace("import { HttpsProxyAgent, HttpProxyAgent } from 'hpagent'", ''),
    'utf8'
  )
}

const pathExists = async (target) => {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

const resolveSidecarDependencyRoots = () => {
  const roots = [
    path.join(projectRoot, 'packaging', 'sidecar-runtime', 'node_modules'),
    path.join(projectRoot, 'node_modules'),
    path.join(appDataRoot, 'sidecar-runtime', 'node_modules'),
  ]
  const nodePath = String(process.env.NODE_PATH || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
  return [...roots, ...nodePath]
}

// ESM ignores NODE_PATH. App-data musicSdk runtime therefore needs real
// node_modules next to it, otherwise discover/podcast pages come back empty.
const ensureRuntimeDependencies = async () => {
  const requiredPackages = ['axios', 'iconv-lite']
  const targetRoot = path.join(path.dirname(runtimeRoot), 'node_modules')
  await fs.mkdir(targetRoot, { recursive: true })
  for (const packageName of requiredPackages) {
    const targetPackage = path.join(targetRoot, packageName)
    if (await pathExists(targetPackage)) continue
    let copied = false
    for (const root of resolveSidecarDependencyRoots()) {
      const sourcePackage = path.join(root, packageName)
      if (!(await pathExists(sourcePackage))) continue
      await fs.cp(sourcePackage, targetPackage, { recursive: true, force: true })
      copied = true
      break
    }
    if (!copied) {
      throw new Error(`musicSdk runtime 缺少依赖: ${packageName}`)
    }
  }
}

const prepareRuntime = async () => {
  await fs.rm(runtimeRoot, { recursive: true, force: true })
  await copyDirectory(electronMusicSdkRoot, path.join(runtimeRoot, 'main/utils/musicSdk'))
  await writeRuntimeSupportFiles()
  await ensureRuntimeDependencies()
  await fs.writeFile(runtimeMarkerPath, runtimeVersion, 'utf8')
}

const ensureRuntime = async () => {
  if (!runtimeReady) {
    runtimeReady = (async () => {
      try {
        const currentVersion = await fs.readFile(runtimeMarkerPath, 'utf8')
        if (currentVersion === runtimeVersion) {
          await ensureRuntimeDependencies()
          return
        }
      } catch {}
      await prepareRuntime()
    })()
  }
  await runtimeReady
}

const getMusicSdk = async () => {
  await ensureRuntime()
  if (!musicSdkModule) {
    const moduleUrl = pathToFileURL(path.join(runtimeRoot, 'main/utils/musicSdk/index.js')).href
    try {
      musicSdkModule = await import(`${moduleUrl}?t=${Date.now()}`)
    } catch (error) {
      // A previous crashed rebuild can leave a half-written runtime. Rebuild once.
      musicSdkModule = null
      runtimeReady = null
      await prepareRuntime()
      runtimeReady = Promise.resolve()
      musicSdkModule = await import(`${moduleUrl}?t=${Date.now()}`)
    }
    const podcastApi = musicSdkModule.default?.wy?.podcastOfficial
    // hydrateLogin used to be a named-only export; keep a fallback for older runtimes.
    const hydrateLogin =
      podcastApi?.hydrateLogin ||
      podcastApi?.default?.hydrateLogin ||
      null
    if (typeof hydrateLogin === 'function' && !podcastAuthLoaded) {
      podcastAuthLoaded = true
      hydrateLogin(await readPodcastAuth())
    }
  }
  return musicSdkModule.default
}

const getSourceApi = async (source = 'wy') => {
  const musicSdk = await getMusicSdk()
  if (source === 'all') return musicSdk.aggregate
  const api = musicSdk[source]
  if (!api) throw new Error(`未知音源: ${source}`)
  return api
}

const pickLyric = (res, { source, grepLyricInfo = false, useStrictMode = true, useFormat = null } = {}) => {
  if (!res) return null
  if (useFormat !== null) {
    if (source === 'tx') return res.lyric || res.lrc || null
    const cr = res.crlyric || res.cr_lyric || null
    const std = res.lyric || res.lrc || null
    return useFormat === 'word-by-word' ? cr || std || null : std || cr || null
  }
  if (!grepLyricInfo) return res

  const keys = ['作曲', '作词', '编曲', '制作人', '专辑', '时间', '时长', '发行', 'OP', 'SP', '词', '曲', '吉他', '贝斯', '录音', '混音', '出品', '演唱', '和声', '弦乐', '企划', '录音室', '鼓', '弦', '弦乐部分']
  const regex = new RegExp(`^.*(${keys.map((key) => `.*${key.split('').join('.*')}.*`).join('|')})[:：]\\s*(.+)(\\n)*$`, 'gm')
  const pureLyric = (lyric) => lyric.filter((line) => {
    const raw = line.replace(/\[.*]/g, '')
    return !raw.includes(':') && !raw.includes('：')
  })
  return Object.fromEntries(
    Object.entries(res).map(([key, value]) => [
      key,
      useStrictMode ? pureLyric(String(value || '').split('\n')).join('\n') : String(value || '').replace(regex, '')
    ])
  )
}

const callSourceMethod = async (source, apiName, args) => {
  if (apiName === 'getPic' && args?.songInfo?._servicePluginId) {
    const pluginId = String(args.songInfo._servicePluginId || '')
    const imageUrl = String(args.songInfo.img || args.songInfo.cover || '').trim()
    if (!pluginId || !/^https?:\/\//i.test(imageUrl)) return ''

    try {
      const config = await pluginService.getConfig({ pluginId })
      const media = await pluginService.invoke({
        pluginId,
        method: 'musicUrl',
        args: [
          source,
          {
            ...args.songInfo,
            _serviceConfig: config,
          },
        ],
        timeoutMs: 15000,
      })
      const response = await fetch(imageUrl, {
        headers: {
          ...(media?.headers || {}),
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      })
      if (!response.ok) return ''
      const contentType = String(response.headers.get('content-type') || '').toLowerCase()
      if (!contentType.startsWith('image/')) return ''
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) return ''
      return `data:${contentType};base64,${buffer.toString('base64')}`
    } catch {
      return ''
    }
  }

  const api = await getSourceApi(source)

  if (source === 'all') {
    switch (apiName) {
      case 'search':
        return await api.search(args.keyword, args.page ?? 1, args.limit ?? 30)
      case 'tipSearch':
        return await api.tipSearch(args.keyword)
      case 'searchPlaylist':
        return await api.searchPlaylist(args.keyword, args.page ?? 1, args.limit ?? 30)
      case 'getPlaylistTags':
        return await api.getPlaylistTags()
      case 'getCategoryPlaylists':
        return await api.getCategoryPlaylists({
          sortId: args.sortId,
          tagId: args.tagId ?? '',
          page: args.page ?? 1,
          limit: args.limit
        })
      case 'getLeaderboards':
        return await api.getLeaderboards()
      default:
        break
    }
  }

  switch (apiName) {
    case 'search':
      return await api.musicSearch.search(args.keyword, args.page ?? 1, args.limit ?? 30)
    case 'tipSearch':
      if (!api.tipSearch?.search) return []
      return await api.tipSearch.search(args.keyword)
    case 'searchPlaylist':
      return await api.songList.search(args.keyword, args.page ?? 1, args.limit ?? 30)
    case 'getHotSonglist':
      return await api.songList.getList(api.songList.sortList?.[0]?.id, '', 1)
    case 'getPlaylistTags':
      return await api.songList.getTags()
    case 'getCategoryPlaylists': {
      const sortId = args.sortId ?? api.songList.sortList?.[0]?.id
      const tagId = args.tagId ?? ''
      const page = args.page ?? 1
      const limit = args.limit ?? api.songList.limit_list
      const res = source === 'wy'
        ? await api.songList.getList(sortId, tagId, page, limit)
        : await api.songList.getList(sortId, tagId, page)
      return { category: { id: tagId || 'hot', name: tagId || '热门' }, ...res }
    }
    case 'getPlaylistDetail':
    case 'getListSongs':
      if (source === 'kg' && /https?:\/\//.test(args.id)) return await api.songList.getUserListDetail(args.id, args.page)
      return await api.songList.getListDetail(args.id, args.page)
    case 'parsePlaylistId':
      return await api.songList.handleParseId(args.url)
    case 'getLeaderboardDetail':
    case 'getToplistDetail':
      if (!api.leaderboard?.getList) return { list: [], total: 0 }
      return await api.leaderboard.getList(args.id, args.page)
    case 'getLeaderboards':
    case 'getToplist': {
      if (!api.leaderboard?.getBoards) return []
      const res = await api.leaderboard.getBoards()
      return res.list ?? res
    }
    case 'getHotComment':
      return await api.comment.getHotComment(args.songInfo, args.page ?? 1, args.limit ?? 100)
    case 'getComment':
    case 'getCommentList':
      return await api.comment.getComment(args.songInfo, args.page ?? 1, args.limit ?? 20)
    case 'getPic':
      return await api.getPic(args.songInfo)
    case 'getMusicUrl': {
      const requestQuality = firstText(args.quality, args.preferBit, args.bit, args.requestedQuality, '128k')
      if (source === 'wy' && api.podcastOfficial && isPodcastProgram(args.songInfo)) {
        const raw = await api.podcastOfficial.getOfficialPlayUrl(args.songInfo, requestQuality)
        if (raw?.error) return raw
        const url = firstText(raw?.url, raw?.playUrl, raw?.musicUrl, raw)
        return {
          ...(raw && typeof raw === 'object' ? raw : {}),
          url,
          source,
          quality: requestQuality,
          actualQuality: firstText(raw?.actualQuality, raw?.quality, requestQuality),
        }
      }
      if (typeof api.getMusicUrl === 'function') {
        const raw = await api.getMusicUrl(args.songInfo, requestQuality)
        if (typeof raw === 'string') {
          return {
            url: raw,
            source,
            quality: requestQuality,
            actualQuality: requestQuality,
            data: raw,
          }
        }
        if (raw && typeof raw === 'object') {
          const url = firstText(
            raw.url,
            raw.playUrl,
            raw.musicUrl,
            raw.download_url,
            raw.downloadUrl,
            raw.src,
            raw.location,
          )
          return {
            ...raw,
            source: firstText(raw.source, source),
            quality: firstText(raw.quality, requestQuality),
            actualQuality: firstText(raw.actualQuality, raw.quality, requestQuality),
            url,
          }
        }
      }
      const fallbackUrl = firstText(
        args.songInfo?.typeUrl?.[requestQuality],
        args.songInfo?.__nativeMedia?.url,
        args.songInfo?.url,
      )
      return {
        url: fallbackUrl,
        source,
        quality: requestQuality,
        actualQuality: requestQuality,
        data: fallbackUrl,
      }
    }
    case 'getLyric': {
      const res = await api.getLyric(args.songInfo).promise
      return pickLyric(res, { source, ...args })
    }
    case 'recognize':
      if (source === 'wy' && api.recognize) return await api.recognize.recognize(args.fp, args.duration)
      return []
    case 'podcast.getLoginState':
      if (!api.podcastOfficial) return { loggedIn: false }
      return api.podcastOfficial.getLoginState()
    case 'podcast.createQr':
      if (!api.podcastOfficial) return {}
      return await api.podcastOfficial.createQrLogin()
    case 'podcast.checkQr':
      if (!api.podcastOfficial) return {}
      {
        const result = await api.podcastOfficial.checkQrLogin(args.key)
        if (result?.code === 803 && String(result.cookie || '').includes('MUSIC_U=')) {
          await writePodcastAuth({
            cookie: result.cookie,
            nickname: result.nickname || '',
            userId: Number(result.userId || 0),
            deviceId: api.podcastOfficial.getLoginState()?.deviceId || ''
          })
        }
        return {
          ...result,
          login: api.podcastOfficial.getLoginState(),
        }
      }
    case 'podcast.logout':
      if (!api.podcastOfficial) return { loggedIn: false }
      {
        const result = api.podcastOfficial.clearLogin()
        await writePodcastAuth({})
        return result
      }
    case 'podcast.getCategories':
      if (!api.podcastOfficial) return []
      return await api.podcastOfficial.getCategoryTree(Boolean(args.forceRefresh))
    case 'podcast.getCategoryPage':
      if (!api.podcastOfficial) return { radios: [], list: [] }
      return await api.podcastOfficial.getCategoryPage(args)
    case 'podcast.getCategoryTotal':
      if (!api.podcastOfficial) return { total: 0 }
      return await api.podcastOfficial.getCategoryTotal(args)
    case 'podcast.getHomeChannel':
      if (!api.podcastOfficial) return { radios: [], list: [] }
      return await api.podcastOfficial.loadHomeChannel(args)
    case 'podcast.search':
      if (!api.podcastOfficial) return { list: [], total: 0 }
      return await api.podcastOfficial.searchRadios(
        String(args.keyword || '').trim(),
        Number(args.page || 1),
        Number(args.limit || 20),
      )
    case 'podcast.getPrograms':
      if (!api.podcastOfficial) return { list: [], total: 0 }
      return await api.podcastOfficial.getPrograms(args)
    case 'podcast.getRadioDetail':
      if (!api.podcastOfficial) return null
      return await api.podcastOfficial.getRadioDetail(args.radioId)
    case 'podcast.getPlayUrl':
      if (!api.podcastOfficial) return null
      return await api.podcastOfficial.getOfficialPlayUrl(args.song || args, args.quality)
    case 'podcast.getProgramLyric':
      if (!api.podcastOfficial) return { lyric: '' }
      return await api.podcastOfficial.getProgramLyric(args.song || args)
    case 'getAlbumList':
      return await api.singer.getAlbumList(args.songInfo.albumId, args.page ?? 1, args.limit ?? 10)
    default:
      throw new Error(`未知的方法: ${apiName}`)
  }
}

export const request = async ({ api, args = {} } = {}) => {
  if (!api) throw new Error('缺少 music sdk api')
  const source = args.source || args.songInfo?.source || 'wy'
  if (!source) throw new Error('请配置音源')
  return await callSourceMethod(source, api, args)
}

export const probeDownloadUrl = async ({ url } = {}) => {
  const target = String(url || '').trim()
  if (!target || target.includes('error')) {
    return { ok: false, size: 0, reason: '无有效下载链接' }
  }
  if (target.startsWith('file://')) return { ok: true, size: 1 }

  try {
    const response = await axios.get(target, {
      responseType: 'stream',
      timeout: 12000,
      headers: { Range: 'bytes=0-2047' },
      validateStatus: (status) => (status >= 200 && status < 300) || status === 206,
    })
    const contentType = String(response.headers?.['content-type'] || '').toLowerCase()
    const contentLength = Number.parseInt(String(response.headers?.['content-length'] || '0'), 10) || 0
    let bytes = 0
    await new Promise((resolve, reject) => {
      response.data.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 0) {
          response.data.destroy()
          resolve()
        }
      })
      response.data.on('end', () => resolve())
      response.data.on('error', reject)
      response.data.on('close', () => resolve())
    })

    const looksLikeAudio =
      !contentType ||
      contentType.includes('audio') ||
      contentType.includes('octet-stream') ||
      contentType.includes('application/x-mpegurl')
    if (bytes <= 0) return { ok: false, size: 0, reason: '下载响应为空' }
    if (!looksLikeAudio) {
      return { ok: false, size: contentLength || bytes, reason: '下载响应不是音频文件' }
    }
    return { ok: true, size: contentLength || bytes }
  } catch (error) {
    return {
      ok: false,
      size: 0,
      reason: error?.message || String(error) || '下载探测失败',
    }
  }
}

export const service = {
  request,
  probeDownloadUrl,
  async health() {
    await ensureRuntime()
    return {
      ok: true,
      service: 'music.sdk',
      electronRoot,
      runtimeRoot
    }
  }
}
