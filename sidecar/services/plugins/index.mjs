import convertEventDrivenPlugin from './converter-event-driven.mjs'
import convertMusicFreePlugin, { looksLikeMusicFreePlugin, isConvertedMusicFreePlugin } from './converter-musicfree.mjs'
import { sendPluginDisabled, sendPluginNotice, sendPluginThrottle } from './pluginNotice.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { Worker } from 'node:worker_threads'

const APP_IDENTIFIER = 'com.cerumusic.tauri'
const MAX_LOG_LINES = 500
const SOURCE_NAME_MAP = {
  kw: '酷我音乐',
  kg: '酷狗音乐',
  tx: 'QQ音乐',
  wy: '网易云音乐',
  mg: '咪咕音乐'
}
const SOURCE_ALIAS_MAP = { qq: 'tx' }

const firstText = (...items) => {
  for (const item of items) {
    if (typeof item === 'string' && item.trim()) return item.trim()
    if (typeof item === 'number' && Number.isFinite(item)) return String(item)
  }
  return ''
}

const normalizeSourceKey = (input) => {
  const key = String(input || '').trim()
  return SOURCE_ALIAS_MAP[key] || key
}

const normalizeQualitys = (input, fallback = ['128k', '320k']) => {
  if (Array.isArray(input)) return input.map((item) => String(item)).filter(Boolean)
  const qualitys = input?.qualitys || input?.qualities || input?.quality || input?.types
  if (Array.isArray(qualitys)) return qualitys.map((item) => String(item)).filter(Boolean)
  return fallback
}

const normalizePluginSources = (input) => {
  const explicitRaw = input?.supportedSources || input?.sources
  if (!explicitRaw) return {}

  const result = {}
  const sourceKeyByName = Object.fromEntries(Object.entries(SOURCE_NAME_MAP).map(([key, name]) => [name, key]))
  const pushSource = (sourceKey, sourceInfo) => {
    const key = normalizeSourceKey(
      sourceKey ||
      sourceInfo?.id ||
      sourceInfo?.source ||
      sourceInfo?.key ||
      sourceKeyByName[sourceInfo?.name] ||
      ''
    )
    if (!key) return
    result[key] = {
      ...(sourceInfo && typeof sourceInfo === 'object' && !Array.isArray(sourceInfo) ? sourceInfo : {}),
      name: sourceInfo?.name || SOURCE_NAME_MAP[key] || key.toUpperCase(),
      type: sourceInfo?.type || 'music',
      qualitys: normalizeQualitys(sourceInfo)
    }
  }

  if (Array.isArray(explicitRaw)) {
    explicitRaw.forEach((item) => {
      if (typeof item === 'string') {
        const key = normalizeSourceKey(item)
        pushSource(key, { name: SOURCE_NAME_MAP[key] || key.toUpperCase() })
        return
      }
      pushSource(item?.id || item?.source || item?.key || sourceKeyByName[item?.name], item)
    })
    return result
  }

  if (typeof explicitRaw === 'object') {
    for (const [key, value] of Object.entries(explicitRaw)) {
      const sourceKey = normalizeSourceKey(key)
      if (Array.isArray(value)) {
        pushSource(sourceKey, { name: SOURCE_NAME_MAP[sourceKey] || sourceKey.toUpperCase(), qualitys: value })
      } else if (typeof value === 'string') {
        pushSource(sourceKey, { name: value })
      } else {
        pushSource(sourceKey, value)
      }
    }
  }

  return result
}

const normalizePluginId = (input) => {
  const normalized = String(input || '')
    .trim()
    .replace(/\.js$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || `plugin_${Date.now()}`
}

const createPluginId = () => crypto.randomUUID().replace(/-/g, '')

const getDefaultAppDataDir = () => {
  if (process.env.CERU_APP_DATA_DIR) return process.env.CERU_APP_DATA_DIR
  if (process.env.CERU_TAURI_APP_DATA_DIR) return process.env.CERU_TAURI_APP_DATA_DIR
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_IDENTIFIER)
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_IDENTIFIER)
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), APP_IDENTIFIER)
}

const appDataDir = getDefaultAppDataDir()
const pluginsDir = path.join(appDataDir, 'plugins')
const configDir = path.join(pluginsDir, 'config')
const logsDir = path.join(pluginsDir, 'logs')
const registryPath = path.join(pluginsDir, 'registry.json')

const ensureDirs = async () => {
  await fs.mkdir(pluginsDir, { recursive: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(logsDir, { recursive: true })
}

const readJson = async (filePath, fallback) => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tempPath, filePath)
}

const readRegistry = async () => {
  const registry = await readJson(registryPath, [])
  return Array.isArray(registry) ? registry : []
}

const writeRegistry = async (registry) => writeJson(registryPath, registry)

const parseMetaComment = (code, name, fallback) => {
  const match = code.match(new RegExp(`@${name}\\s+(.+)`, 'i'))
  return match ? match[1].trim() : fallback
}

const extractBalancedLiteral = (code, start) => {
  const open = code[start]
  const close = open === '[' ? ']' : open === '{' ? '}' : ''
  if (!close) return null
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = start; index < code.length; index += 1) {
    const char = code[index]
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return code.slice(start, index + 1)
    }
  }
  return null
}

const extractAssignedValue = (code, names, shapes = ['object']) => {
  const text = String(code || '')
  for (const name of names) {
    const starters = [
      new RegExp(`(?:module\\.exports\\.)?${name}\\s*=\\s*([\\[\\{])`),
      new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*([\\[\\{])`)
    ]
    for (const starter of starters) {
      const match = starter.exec(text)
      if (!match) continue
      const open = match[1]
      if ((open === '[' && !shapes.includes('array')) || (open === '{' && !shapes.includes('object'))) continue
      const literal = extractBalancedLiteral(text, match.index + match[0].length - 1)
      if (!literal) continue
      try {
        return Function(`"use strict"; return (${literal})`)()
      } catch {}
    }
  }
  return null
}

const extractAssignedObject = (code, names) => extractAssignedValue(code, names, ['object'])
const extractAssignedArray = (code, names) => extractAssignedValue(code, names, ['array'])

const extractAssignedString = (code, names, fallback = '') => {
  for (const name of names) {
    const match = code.match(new RegExp(`(?:module\\.exports\\.)?${name}\\s*=\\s*['\"]([^'\"]+)['\"]`))
    if (match) return match[1]
    const declared = code.match(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*['\"]([^'\"]+)['\"]`))
    if (declared) return declared[1]
  }
  return fallback
}

const inspectPluginCode = (code, fallbackName = 'unknown') => {
  const text = String(code || '')
  const pluginInfo = extractAssignedObject(text, ['pluginInfo']) || {
    name: parseMetaComment(text, 'name', fallbackName),
    version: parseMetaComment(text, 'version', '1.0.0'),
    author: parseMetaComment(text, 'author', 'Unknown'),
    description: parseMetaComment(text, 'description', '')
  }
  const serviceRole =
    extractAssignedString(text, ['serviceRole']) ||
    text.match(/serviceRole\s*:\s*['"]([^'"]+)['"]/)?.[1] ||
    ''
  const pluginType = extractAssignedString(
    text,
    ['pluginType'],
    serviceRole || text.toLowerCase().includes('getplaylists') ? 'service' : 'music-source',
  )
  const assignedSources = extractAssignedObject(text, ['supportedSources', 'sources'])
  const convertedSources = extractConvertedPluginSources(text)
  const sources = assignedSources && Object.keys(assignedSources).length
    ? assignedSources
    : convertedSources
  const configSchema = extractAssignedArray(text, ['configSchema']) || extractAssignedObject(text, ['configSchema']) || []

  return {
    pluginInfo: {
      name: firstText(pluginInfo.name, fallbackName),
      version: firstText(pluginInfo.version, '1.0.0'),
      author: firstText(pluginInfo.author, 'Unknown'),
      description: firstText(pluginInfo.description)
    },
    pluginType,
    serviceRole,
    supportedSources: normalizePluginSources({ supportedSources: sources }),
    configSchema: Array.isArray(configSchema) || (configSchema && typeof configSchema === 'object')
      ? configSchema
      : []
  }
}

const assertPluginCode = (code, type) => {
  const text = String(code || '')
  if (!text.trim()) throw new Error('插件内容为空')
  if (looksLikeHtmlDocument(text)) {
    throw new Error('插件格式校验失败：下载到了 HTML 页面，不是可执行的音源脚本')
  }
  if (type === 'lx' && !looksLikeLxPluginCode(text)) {
    throw new Error('洛雪插件格式校验失败：代码有可能不是标准的洛雪插件')
  }
  if (type === 'cr' && !text.toLowerCase().includes('cerumusic')) {
    throw new Error('澜音插件格式校验失败：代码有可能不是澜音格式插件')
  }
}

const isConvertedLxPluginCode = (code) => {
  const text = String(code || '')
  return text.includes('由 CeruMusic 插件转换器转换') ||
    (text.includes('const originalPluginCode') && text.includes('pluginInfo'))
}

const looksLikeHtmlDocument = (code) => {
  const text = String(code || '').trim()
  if (/^<!doctype html/i.test(text) || /^<html[\s>]/i.test(text)) return true
  if (isConvertedLxPluginCode(text)) {
    const original = extractConvertedLxOriginalCode(text)
    if (original) {
      const originalText = String(original).trim()
      return /^<!doctype html/i.test(originalText) || /^<html[\s>]/i.test(originalText)
    }
  }
  return false
}

const decodePluginDetectionText = (code) =>
  String(code || '')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))

const looksLikeLxPluginCode = (code) => {
  const raw = String(code || '')
  if (looksLikeHtmlDocument(raw)) return false
  if (raw.toLowerCase().includes('lx')) return true
  return decodePluginDetectionText(raw).toLowerCase().includes('lx')
}

const DEFAULT_CONVERTED_SOURCES = {
  kw: { name: '酷我音乐', type: 'music', qualitys: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'] },
  kg: { name: '酷狗音乐', type: 'music', qualitys: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'] },
  tx: { name: 'QQ音乐', type: 'music', qualitys: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'] },
  wy: { name: '网易云音乐', type: 'music', qualitys: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'] },
  mg: { name: '咪咕音乐', type: 'music', qualitys: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'] }
}

const extractConvertedLxOriginalCode = (code) => {
  const text = String(code || '')
  const marker = 'const originalPluginCode = '
  const start = text.indexOf(marker)
  if (start < 0) return null
  const valueStart = start + marker.length
  if (text[valueStart] !== '"') return null
  let escaped = false
  for (let index = valueStart + 1; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      try {
        const parsed = JSON.parse(text.slice(valueStart, index + 1))
        return typeof parsed === 'string' && parsed.trim() ? parsed : null
      } catch {
        return null
      }
    }
  }
  return null
}

const extractMusicQualitySources = (code) => {
  const text = String(code || '')
  const qualityMatch = text.match(/const\s+MUSIC_QUALITY\s*=\s*JSON\.parse\(([^)]+)\)/)
  if (!qualityMatch) return null
  try {
    let qualityStr = qualityMatch[1].trim()
    if ((qualityStr.startsWith("'") && qualityStr.endsWith("'")) || (qualityStr.startsWith('"') && qualityStr.endsWith('"'))) {
      qualityStr = qualityStr.slice(1, -1)
    }
    const qualityData = JSON.parse(qualityStr)
    if (!qualityData || typeof qualityData !== 'object') return null
    const extracted = {}
    for (const [sourceId, qualitys] of Object.entries(qualityData)) {
      extracted[sourceId] = {
        name: SOURCE_NAME_MAP[sourceId] || `${String(sourceId || '').toUpperCase()}音乐`,
        type: 'music',
        qualitys: Array.isArray(qualitys) ? qualitys : ['128k', '320k']
      }
    }
    return Object.keys(extracted).length ? extracted : null
  } catch {
    return null
  }
}

const extractConvertedPluginSources = (code) => {
  const text = String(code || '')
  if (!isConvertedLxPluginCode(text) && !text.includes('const originalPluginCode')) return null
  const original = extractConvertedLxOriginalCode(text)
  return extractMusicQualitySources(original || text) || DEFAULT_CONVERTED_SOURCES
}


const preparePluginCode = (pluginCode, type) => {
  const code = String(pluginCode || '')
  if (!code.trim()) throw new Error('插件内容为空')
  if (looksLikeHtmlDocument(code)) {
    throw new Error('插件格式校验失败：下载到了 HTML 页面，不是可执行的音源脚本')
  }
  if (isConvertedMusicFreePlugin(code)) return code
  if (type === 'mf') {
    if (!looksLikeMusicFreePlugin(code)) {
      throw new Error('MusicFree 插件格式校验失败：代码有可能不是标准的 MusicFree 插件')
    }
    return convertMusicFreePlugin(code)
  }
  if (type === 'cr') {
    if (!code.toLowerCase().includes('cerumusic')) {
      throw new Error('澜音插件格式校验失败：代码有可能不是澜音格式插件')
    }
    return code
  }
  if (type === 'lx') {
    if (!looksLikeLxPluginCode(code)) {
      throw new Error('洛雪插件格式校验失败：代码有可能不是标准的洛雪插件')
    }
    if (isConvertedLxPluginCode(code)) {
      const original = extractConvertedLxOriginalCode(code)
      return original ? convertEventDrivenPlugin(original) : code
    }
    return convertEventDrivenPlugin(code)
  }
  if (isConvertedLxPluginCode(code)) {
    const original = extractConvertedLxOriginalCode(code)
    if (original) return convertEventDrivenPlugin(original)
  }
  if (!isConvertedLxPluginCode(code) && looksLikeLxPluginCode(code) && !/\bmodule\.exports\s*=/.test(code)) {
    return convertEventDrivenPlugin(code)
  }
  if (looksLikeMusicFreePlugin(code)) {
    return convertMusicFreePlugin(code)
  }
  return code
}

const persistPreparedPluginCode = async (pluginId, code) => {
  if (looksLikeHtmlDocument(code)) return false
  const current = await fs.readFile(pluginPath(pluginId), 'utf8').catch(() => '')
  if (current === code) return false
  await fs.writeFile(pluginPath(pluginId), String(code), 'utf8')
  return true
}

const pluginFileName = (pluginId) => `${pluginId}.js`
const pluginPath = (pluginId) => path.join(pluginsDir, pluginFileName(pluginId))
const configPath = (pluginId) => path.join(configDir, `${pluginId}.json`)
const logPath = (pluginId) => path.join(logsDir, `${pluginId}.txt`)

const toElectronPluginResult = (entry) => ({
  pluginId: entry.pluginId,
  pluginName: entry.pluginName || entry.pluginInfo?.name || entry.pluginId,
  id: entry.pluginId,
  name: entry.pluginInfo?.name || entry.pluginName || entry.pluginId,
  pluginInfo: entry.pluginInfo || {
    name: entry.pluginName || entry.pluginId,
    version: '',
    author: '',
    description: ''
  },
  pluginType: entry.pluginType || 'music-source',
  serviceRole: entry.serviceRole,
  supportedSources: entry.supportedSources || {},
  configSchema: Array.isArray(entry.configSchema) || (entry.configSchema && typeof entry.configSchema === 'object')
    ? entry.configSchema
    : [],
  disabled: Boolean(entry.disabled),
  installedAt: entry.installedAt
})

let pluginEntriesCache = null
let pluginEntriesInFlight = null
let pluginEntriesGeneration = 0

const schemaSize = (schema) => {
  if (Array.isArray(schema)) return schema.length
  if (schema && typeof schema === 'object') return Object.keys(schema).length
  return 0
}

const commitPluginEntriesCache = (updater) => {
  pluginEntriesGeneration += 1
  pluginEntriesInFlight = null
  if (Array.isArray(pluginEntriesCache)) {
    pluginEntriesCache = updater(pluginEntriesCache)
  } else {
    pluginEntriesCache = null
  }
}

const inspectPluginFile = async (pluginId) => {
  const code = await fs.readFile(pluginPath(pluginId), 'utf8').catch(() => '')
  if (!code) return null
  return inspectPluginCode(code, pluginId)
}

const invalidatePluginEntries = () => {
  pluginEntriesCache = null
  pluginEntriesInFlight = null
  pluginEntriesGeneration += 1
}

const loadPluginEntriesUncached = async () => {
  const generation = pluginEntriesGeneration
  await ensureDirs()
  const registry = await readRegistry()
  const byId = new Map(registry.map((entry) => [entry.pluginId, entry]))
  const files = await fs.readdir(pluginsDir, { withFileTypes: true }).catch(() => [])
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.js')) continue
    const pluginId = normalizePluginId(file.name)
    const code = await fs.readFile(path.join(pluginsDir, file.name), 'utf8').catch(() => '')
    if (!code) continue
    if (looksLikeHtmlDocument(code)) {
      const existing = byId.get(pluginId)
      if (existing) {
        existing.pluginType = 'invalid'
        existing.supportedSources = {}
        existing.serviceRole = ''
      }
      continue
    }
    const inspected = inspectPluginCode(code, pluginId)
    const existing = byId.get(pluginId)
    if (existing) {
      if (inspected.pluginType) existing.pluginType = inspected.pluginType
      if (inspected.serviceRole) existing.serviceRole = inspected.serviceRole
      if (schemaSize(inspected.configSchema) > schemaSize(existing.configSchema)) {
        existing.configSchema = inspected.configSchema
      }
      if (schemaSize(inspected.supportedSources) > schemaSize(existing.supportedSources)) {
        existing.supportedSources = inspected.supportedSources
      }
      if (inspected.pluginInfo?.name) existing.pluginInfo = inspected.pluginInfo
      continue
    }
    byId.set(pluginId, {
      pluginId,
      pluginName: inspected.pluginInfo.name || pluginId,
      ...inspected,
      disabled: false,
      installedAt: new Date().toISOString()
    })
  }
  const entries = Array.from(byId.values()).map(toElectronPluginResult)
  if (generation !== pluginEntriesGeneration) {
    return Array.isArray(pluginEntriesCache) ? pluginEntriesCache : entries
  }
  await writeRegistry(entries.map((entry) => ({
    pluginId: entry.pluginId,
    pluginName: entry.pluginName,
    pluginInfo: entry.pluginInfo,
    pluginType: entry.pluginType,
    serviceRole: entry.serviceRole,
    supportedSources: entry.supportedSources || {},
    configSchema: Array.isArray(entry.configSchema) || (entry.configSchema && typeof entry.configSchema === 'object')
      ? entry.configSchema
      : [],
    disabled: Boolean(entry.disabled),
    installedAt: entry.installedAt || new Date().toISOString()
  })))
  return entries
}

const loadPluginEntries = async () => {
  const generation = pluginEntriesGeneration
  if (pluginEntriesCache) return pluginEntriesCache
  if (pluginEntriesInFlight) {
    const entries = await pluginEntriesInFlight
    if (generation === pluginEntriesGeneration) return pluginEntriesCache || entries
    return await loadPluginEntries()
  }

  const requestGeneration = pluginEntriesGeneration
  const request = loadPluginEntriesUncached()
    .then((entries) => {
      if (requestGeneration === pluginEntriesGeneration) pluginEntriesCache = entries
      return entries
    })
    .finally(() => {
      if (pluginEntriesInFlight === request) pluginEntriesInFlight = null
    })
  pluginEntriesInFlight = request
  const entries = await request
  if (requestGeneration !== pluginEntriesGeneration) return await loadPluginEntries()
  return pluginEntriesCache || entries
}

const upsertEntry = async (entry) => {
  const registry = await readRegistry()
  const next = registry.filter((item) => item.pluginId !== entry.pluginId)
  next.push(entry)
  await writeRegistry(next)
  commitPluginEntriesCache((entries) => {
    const nextEntries = entries.filter((item) => item.pluginId !== entry.pluginId)
    nextEntries.push(toElectronPluginResult(entry))
    return nextEntries
  })
}

const installFromCode = async ({ pluginCode, pluginName, targetPluginId, type } = {}) => {
  await ensureDirs()
  assertPluginCode(pluginCode, type)
  const preparedCode = preparePluginCode(pluginCode, type)
  const inspected = inspectPluginCode(preparedCode, pluginName || targetPluginId || 'unknown')
  const entries = await loadPluginEntries()
  const sameName = entries.find((entry) =>
    entry.pluginInfo?.name === inspected.pluginInfo.name &&
    String(entry.pluginInfo?.author || '') === String(inspected.pluginInfo?.author || '')
  )
  if (!targetPluginId && sameName?.pluginInfo?.version === inspected.pluginInfo.version) {
    throw new Error(`插件 "${inspected.pluginInfo.name} v${inspected.pluginInfo.version}" 已存在，不能重复添加`)
  }

  const pluginId = normalizePluginId(targetPluginId || sameName?.pluginId || createPluginId())
  const entry = {
    pluginId,
    pluginName: inspected.pluginInfo.name || pluginName || pluginId,
    pluginInfo: inspected.pluginInfo,
    pluginType: inspected.pluginType,
    serviceRole: inspected.serviceRole,
    supportedSources: inspected.supportedSources,
    configSchema: inspected.configSchema,
    disabled: false,
    installedAt: new Date().toISOString()
  }

  await fs.writeFile(pluginPath(pluginId), String(preparedCode), 'utf8')
  unloadWorkerRuntime(pluginId)
  await upsertEntry(entry)
  await appendLog(pluginId, 'info', `插件 ${entry.pluginInfo.name} 已安装`)
  return toElectronPluginResult(entry)
}

const downloadText = async (url) => {
  if (!url || typeof url !== 'string') throw new Error('无效的URL地址')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'CeruMusic/1.0' }
    })
    if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`)
    const text = await response.text()
    if (!text.trim()) throw new Error('下载的文件内容为空')
    return text
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('在线插件下载超时')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const appendLog = async (pluginId, level, message) => {
  await ensureDirs()
  const entry = { t: Date.now(), l: level, m: String(message || '') }
  await fs.appendFile(logPath(pluginId), `${JSON.stringify(entry)}\n`, 'utf8').catch(() => {})
}

const getLog = async (pluginId) => {
  await ensureDirs()
  let content = ''
  try {
    content = await fs.readFile(logPath(pluginId), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length > MAX_LOG_LINES) {
    const tail = lines.slice(-MAX_LOG_LINES)
    fs.writeFile(logPath(pluginId), `${tail.join('\n')}\n`, 'utf8').catch(() => {})
    return tail
  }
  return lines
}

const workerRuntimeCache = new Map()
const workerRuntimeInFlight = new Map()
const PLUGIN_INVOKE_TIMEOUT_MS = 30000
const PLUGIN_INIT_TIMEOUT_MS = 5000
const PLUGIN_WORKER_INIT_TIMEOUT_MS = 8000
const PLUGIN_HEARTBEAT_TIMEOUT_MS = 15000
const PLUGIN_WORKER_IDLE_UNLOAD_MS = 25000
const workerIdleTimers = new Map()
const pinnedWorkerIds = new Set()
const pluginWorkerPath = new URL('./pluginWorker.mjs', import.meta.url)

const safeClone = (value) => {
  if (value == null) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

const serializeLogArg = (value) => {
  if (value == null) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Error) return value.message
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

const parseResponseBody = async (response) => {
  const contentType = response.headers.get('content-type') || ''
  try {
    if (contentType.includes('application/json')) return await response.json()
    // Audio/binary streams are only fetched so plugins can observe redirects
    // and auth headers. Never materialize the full body into the worker.
    if (isBinaryMediaContentType(contentType)) return null
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  } catch (error) {
    return { error: 'Parse failed', message: error?.message, statusCode: response.status }
  }
}

const isBinaryMediaContentType = (contentType = '') => {
  const value = String(contentType || '').toLowerCase()
  return (
    value.includes('audio/') ||
    value.includes('video/') ||
    value.includes('octet-stream') ||
    value.includes('application/ogg') ||
    value.includes('binary/')
  )
}

const normalizeRequestBody = (body) => {
  if (body == null) return undefined
  if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) return body
  if (body instanceof URLSearchParams) return body
  if (Buffer.isBuffer(body)) return body
  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

const buildCryptoApi = () => ({
  aesEncrypt(data, mode, key, iv) {
    const algorithm = String(mode || '').toLowerCase().includes('ecb') ? 'aes-128-ecb' : 'aes-128-cbc'
    const cipher = crypto.createCipheriv(
      algorithm,
      Buffer.isBuffer(key) ? key : Buffer.from(key || ''),
      algorithm.endsWith('ecb') ? null : Buffer.isBuffer(iv) ? iv : Buffer.from(iv || '')
    )
    const input = Buffer.isBuffer(data) ? data : typeof data === 'string' ? Buffer.from(data) : Buffer.from(JSON.stringify(data))
    return Buffer.concat([cipher.update(input), cipher.final()])
  },
  md5(value) {
    return crypto.createHash('md5').update(value).digest('hex')
  },
  sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex')
  },
  randomBytes(size) {
    return crypto.randomBytes(Math.max(0, Number(size) || 0))
  },
  rsaEncrypt(data, key) {
    return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(data))).toString('base64')
  }
})

const buildCerumusicApi = (pluginId, entry) => {
  const throttles = new Map()
  const isThrottled = () => {
    const now = Date.now()
    for (const [id, item] of throttles) {
      if (now < item.until) return item.reason
      throttles.delete(id)
    }
    return null
  }

  const request = async (url, optionsOrCallback, callback) => {
    let options = {}
    let cb = callback
    if (typeof optionsOrCallback === 'function') {
      cb = optionsOrCallback
    } else if (optionsOrCallback) {
      options = optionsOrCallback
    }

    const run = async () => {
      const throttleReason = isThrottled()
      if (throttleReason) {
        return { body: { error: 'throttled', message: throttleReason, url }, statusCode: 429, headers: {} }
      }

      const timeout = Math.max(1, Number(options.timeout || 10000))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout > 1000 ? timeout : timeout * 1000)
      try {
        const response = await fetch(url, {
          method: options.method || 'GET',
          headers: options.headers || undefined,
          body: normalizeRequestBody(options.body),
          signal: controller.signal
        })
        const headers = {}
        response.headers.forEach((value, key) => {
          headers[key] = value
        })
        const contentType = headers['content-type'] || headers['Content-Type'] || ''
        const finalUrl = response.url || url
        // Match Electron: always expose response.url so service plugins
        // (especially Feiniu stream) can return the redirected playable URL.
        if (isBinaryMediaContentType(contentType)) {
          try { response.body?.cancel?.() } catch {}
          return { body: null, statusCode: response.status, headers, url: finalUrl }
        }
        return {
          body: await parseResponseBody(response),
          statusCode: response.status,
          headers,
          url: finalUrl,
        }
      } catch (error) {
        return {
          body: { error: error?.name || 'RequestError', message: error?.message || String(error), url },
          statusCode: error?.name === 'AbortError' ? 408 : 500,
          headers: {}
        }
      } finally {
        clearTimeout(timer)
      }
    }

    if (cb) {
      run().then((result) => cb(null, result)).catch((error) => cb(error, undefined))
      return undefined
    }
    return await run()
  }

  const cryptoApi = buildCryptoApi()
  const logger = {}
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    logger[level] = (...args) => {
      appendLog(pluginId, level === 'log' ? 'info' : level, args.map(serializeLogArg).join(' ')).catch(() => {})
    }
  }

  return {
    env: 'nodejs',
    version: '1.0.4',
    request,
    http: request,
    logger,
    log: logger,
    NoticeCenter(type, data) {
      appendLog(pluginId, 'info', `[notice:${type}] ${JSON.stringify(data ?? {})}`).catch(() => {})
      const pluginName = entry?.pluginName || entry?.pluginInfo?.name
      return sendPluginNotice(
        {
          type,
          data,
          currentVersion: entry?.pluginInfo?.version,
          pluginId
        },
        pluginName,
        { pluginId, pluginName, currentVersion: entry?.pluginInfo?.version }
      )
    },
    stopRequests(reason, durationMs = 30000) {
      const duration = Math.max(0, Number(durationMs) || 30000)
      throttles.set(`throttle_${Date.now()}_${Math.random()}`, {
        reason: String(reason || ''),
        until: Date.now() + duration
      })
      sendPluginThrottle(pluginId, reason, duration)
    },
    config: {
      async get() {
        return await readJson(configPath(pluginId), {})
      },
      async set(config) {
        await writeJson(configPath(pluginId), config || {})
        return true
      },
      async save(config) {
        await writeJson(configPath(pluginId), config || {})
        return true
      }
    },
    storage: {
      async get(key, fallback = null) {
        const data = await readJson(configPath(`${pluginId}.storage`), {})
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback
      },
      async set(key, value) {
        const file = configPath(`${pluginId}.storage`)
        const data = await readJson(file, {})
        data[key] = value
        await writeJson(file, data)
        return true
      },
      async remove(key) {
        const file = configPath(`${pluginId}.storage`)
        const data = await readJson(file, {})
        delete data[key]
        await writeJson(file, data)
        return true
      }
    },
    cache: {
      async get(key, fallback = null) {
        const data = await readJson(configPath(`${pluginId}.cache`), {})
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback
      },
      async set(key, value) {
        const file = configPath(`${pluginId}.cache`)
        const data = await readJson(file, {})
        data[key] = value
        await writeJson(file, data)
        return true
      },
      async remove(key) {
        const file = configPath(`${pluginId}.cache`)
        const data = await readJson(file, {})
        delete data[key]
        await writeJson(file, data)
        return true
      }
    },
    utils: {
      buffer: {
        from: (data, encoding) => Buffer.from(data, encoding),
        bufToString: (buffer, encoding = 'utf8') => Buffer.from(buffer).toString(encoding)
      },
      crypto: cryptoApi
    }
  }
}

const buildConsoleProxy = (pluginId) => {
  const proxy = {}
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    proxy[level] = (...args) => {
      const normalizedLevel = level === 'log' || level === 'trace' ? 'info' : level
      appendLog(pluginId, normalizedLevel, args.map(serializeLogArg).join(' ')).catch(() => {})
    }
  }
  proxy.group = proxy.log
  proxy.groupCollapsed = proxy.log
  proxy.groupEnd = () => {}
  return proxy
}

class PluginWorkerRuntime {
  constructor(pluginId, entry, code) {
    this.pluginId = pluginId
    this.entry = entry
    this.code = code
    this.pending = new Map()
    this.lastHeartbeat = Date.now()
    this.lastUsedAt = Date.now()
    this.worker = new Worker(pluginWorkerPath, { type: 'module' })
    this.worker.on('message', (message) => this.handleMessage(message))
    this.worker.on('error', (error) => this.rejectAll(error))
    this.worker.on('exit', (code) => {
      if (code !== 0) this.rejectAll(new Error(`插件 ${this.pluginId} worker 已退出: ${code}`))
    })
  }

  handleMessage(message) {
    if (message?.type === 'heartbeat') {
      this.lastHeartbeat = Date.now()
      return
    }
    if (message?.type === 'log') {
      appendLog(this.pluginId, message.level === 'log' ? 'info' : message.level || 'info', (message.args || []).map(serializeLogArg).join(' ')).catch(() => {})
      return
    }
    if (message?.type === 'notice') {
      appendLog(this.pluginId, 'info', `[notice:${message.noticeType}] ${JSON.stringify(message.data ?? {})}`).catch(() => {})
      const pluginName = this.entry?.pluginName || this.entry?.pluginInfo?.name
      sendPluginNotice(
        {
          type: message.noticeType,
          data: message.data,
          currentVersion: this.entry?.pluginInfo?.version,
          pluginId: this.pluginId
        },
        pluginName,
        {
          pluginId: this.pluginId,
          pluginName,
          currentVersion: this.entry?.pluginInfo?.version
        }
      )
      return
    }
    if (message?.type === 'throttle') {
      appendLog(this.pluginId, 'warn', `[throttle] ${message.reason || ''}`).catch(() => {})
      sendPluginThrottle(this.pluginId, message.reason, message.duration)
      return
    }
    if (message?.type === 'host-request') {
      this.handleHostRequest(message).catch((error) => {
        this.worker.postMessage({ type: 'host-response', id: message.id, ok: false, error: error?.message || String(error) })
      })
      return
    }
    if (!message?.id) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.type === 'init-ok') {
      pending.resolve(message.meta)
      return
    }
    if (message.type === 'result') {
      pending.resolve(message.data)
      return
    }
    if (message.type === 'disposed') {
      pending.resolve(true)
      return
    }
    if (message.type === 'error') {
      const error = new Error(message.error?.message || '插件 worker 执行失败')
      error.name = message.error?.name || 'PluginMethodError'
      error.pluginMethod = message.error?.method || message.method
      error.isPluginMethodError = true
      pending.reject(error)
    }
  }

  async handleHostRequest(message) {
    const payload = message.payload || {}
    let result
    switch (message.method) {
      case 'config.get':
        result = await readJson(configPath(this.pluginId), {})
        break
      case 'config.set':
        await writeJson(configPath(this.pluginId), payload.config || {})
        result = true
        break
      case 'storage.get': {
        const data = await readJson(configPath(`${this.pluginId}.storage`), {})
        result = Object.prototype.hasOwnProperty.call(data, payload.key) ? data[payload.key] : payload.fallback ?? null
        break
      }
      case 'storage.set': {
        const file = configPath(`${this.pluginId}.storage`)
        const data = await readJson(file, {})
        data[payload.key] = payload.value
        await writeJson(file, data)
        result = true
        break
      }
      case 'storage.remove': {
        const file = configPath(`${this.pluginId}.storage`)
        const data = await readJson(file, {})
        delete data[payload.key]
        await writeJson(file, data)
        result = true
        break
      }
      case 'cache.get': {
        const data = await readJson(configPath(`${this.pluginId}.cache`), {})
        result = Object.prototype.hasOwnProperty.call(data, payload.key) ? data[payload.key] : payload.fallback ?? null
        break
      }
      case 'cache.set': {
        const file = configPath(`${this.pluginId}.cache`)
        const data = await readJson(file, {})
        data[payload.key] = payload.value
        await writeJson(file, data)
        result = true
        break
      }
      case 'cache.remove': {
        const file = configPath(`${this.pluginId}.cache`)
        const data = await readJson(file, {})
        delete data[payload.key]
        await writeJson(file, data)
        result = true
        break
      }
      default:
        throw new Error(`Unsupported plugin host method: ${message.method}`)
    }
    this.worker.postMessage({ type: 'host-response', id: message.id, ok: true, result })
  }

  request(message, timeoutMs) {
    const id = `${message.type}_${Date.now()}_${Math.random().toString(16).slice(2)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`插件 ${this.pluginId} worker ${message.type} 超时`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.postMessage({ ...message, id })
    })
  }

  async init() {
    const meta = await this.request({ type: 'init', pluginCode: this.code, pluginId: this.pluginId }, PLUGIN_WORKER_INIT_TIMEOUT_MS)
    await persistRuntimePluginMeta(this.pluginId, meta)
    await appendLog(this.pluginId, 'info', `插件 ${this.entry.pluginName || this.pluginId} 已加载到 Node worker`)
    return meta
  }

  async invoke(method, args, timeoutMs) {
    if (Date.now() - this.lastHeartbeat > PLUGIN_HEARTBEAT_TIMEOUT_MS) {
      const error = new Error(`插件 ${this.pluginId} worker 心跳超时`)
      error.pluginLifecycleFailure = true
      throw error
    }
    this.lastUsedAt = Date.now()
    return await this.request({ type: 'invoke', method, args }, timeoutMs)
  }

  async dispose() {
    try {
      await this.request({ type: 'dispose' }, 1000)
    } catch {}
    this.worker.terminate().catch(() => {})
    this.rejectAll(new Error(`插件 ${this.pluginId} worker 已销毁`))
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}


const persistRuntimePluginMeta = async (pluginId, meta) => {
  const sources = normalizePluginSources({ supportedSources: meta?.sources || meta?.supportedSources })
  if (schemaSize(sources) === 0) return false
  const registry = await readRegistry()
  let changed = false
  const next = registry.map((entry) => {
    if (entry.pluginId !== pluginId) return entry
    if (schemaSize(sources) <= schemaSize(entry.supportedSources)) return entry
    changed = true
    return { ...entry, supportedSources: sources }
  })
  if (!changed) return false
  await writeRegistry(next)
  if (Array.isArray(pluginEntriesCache)) {
    pluginEntriesCache = pluginEntriesCache.map((entry) => (
      entry.pluginId === pluginId ? { ...entry, supportedSources: sources } : entry
    ))
  }
  return true
}

const createWorkerRuntime = async (pluginId) => {
  await ensureDirs()
  const entries = await loadPluginEntries()
  const entry = entries.find((item) => item.pluginId === pluginId)
  if (!entry) throw new Error(`插件 ${pluginId} 未安装`)
  if (entry.disabled) throw new Error(`插件 ${pluginId} 已禁用`)
  const rawCode = await fs.readFile(pluginPath(pluginId), 'utf8')
  if (looksLikeHtmlDocument(rawCode)) {
    throw new Error(`插件 ${entry.pluginName || pluginId} 不是可执行的音源脚本`)
  }
  const code = preparePluginCode(rawCode)
  if (code !== rawCode) {
    await persistPreparedPluginCode(pluginId, code)
    await appendLog(pluginId, 'info', `已按 Electron 流程转换并落盘洛雪插件 ${entry.pluginName || pluginId}`)
  }
  const runtime = new PluginWorkerRuntime(pluginId, entry, code)
  await runtime.init()
  workerRuntimeCache.set(pluginId, runtime)
  return runtime
}

const getWorkerRuntime = async (pluginId) => {
  const id = normalizePluginId(pluginId)
  if (!id) throw new Error('插件ID不能为空')
  const cached = workerRuntimeCache.get(id)
  if (cached) {
    touchWorkerRuntime(id)
    return cached
  }
  const pending = workerRuntimeInFlight.get(id)
  if (pending) return await pending
  const request = createWorkerRuntime(id).finally(() => {
    if (workerRuntimeInFlight.get(id) === request) workerRuntimeInFlight.delete(id)
  })
  workerRuntimeInFlight.set(id, request)
  const runtime = await request
  touchWorkerRuntime(id)
  return runtime
}

const unloadWorkerRuntime = (pluginId) => {
  const id = normalizePluginId(pluginId)
  clearWorkerIdleTimer(id)
  const runtime = workerRuntimeCache.get(id)
  workerRuntimeCache.delete(id)
  workerRuntimeInFlight.delete(id)
  runtime?.dispose()
}

const pinWorkerRuntime = async (pluginId) => {
  const id = normalizePluginId(pluginId)
  if (!id) return false
  pinnedWorkerIds.add(id)
  clearWorkerIdleTimer(id)
  return true
}

const unpinWorkerRuntime = (pluginId) => {
  const id = normalizePluginId(pluginId)
  if (!id) return false
  pinnedWorkerIds.delete(id)
  const runtime = workerRuntimeCache.get(id)
  if (runtime) touchWorkerRuntime(id)
  return true
}

const clearWorkerIdleTimer = (pluginId) => {
  const timer = workerIdleTimers.get(pluginId)
  if (timer) {
    clearTimeout(timer)
    workerIdleTimers.delete(pluginId)
  }
}

const touchWorkerRuntime = (pluginId) => {
  const id = normalizePluginId(pluginId)
  const runtime = workerRuntimeCache.get(id)
  if (!runtime) return
  runtime.lastUsedAt = Date.now()
  clearWorkerIdleTimer(id)
  if (pinnedWorkerIds.has(id)) return
  workerIdleTimers.set(
    id,
    setTimeout(() => {
      workerIdleTimers.delete(id)
      const current = workerRuntimeCache.get(id)
      if (!current) return
      if (current.pending.size > 0) {
        touchWorkerRuntime(id)
        return
      }
      if (Date.now() - (current.lastUsedAt || 0) < PLUGIN_WORKER_IDLE_UNLOAD_MS) {
        touchWorkerRuntime(id)
        return
      }
      unloadWorkerRuntime(id)
    }, PLUGIN_WORKER_IDLE_UNLOAD_MS)
  )
}

let pluginSystemInitializationPromise = null

const initializePluginSystem = async () => {
  await ensureDirs()
  const registry = await readRegistry()
  if (Array.isArray(registry) && registry.length > 0) {
    pluginEntriesCache = registry.map(toElectronPluginResult)
    return true
  }
  await loadPluginEntries()
  return true
}

const invokePlugin = async (payload = {}) => {
  const pluginId = normalizePluginId(payload.pluginId || payload.id)
  const method = String(payload.method || '').trim()
  if (!pluginId) throw new Error('插件ID不能为空')
  if (!method) throw new Error('插件方法不能为空')

  const args = Array.isArray(payload.args) ? payload.args : []
  const timeoutMs = Math.max(1, Number(payload.timeoutMs || payload.timeout || PLUGIN_INVOKE_TIMEOUT_MS))

  try {
    const workerRuntime = await getWorkerRuntime(pluginId)
    const result = safeClone(await workerRuntime.invoke(method, args, timeoutMs))
    touchWorkerRuntime(pluginId)
    return result
  } catch (workerError) {
    // Electron keeps the plugin worker alive for normal API/auth/business
    // failures and does not replay the same request in a second runtime. A
    // timed-out request may also finish later, so preserve the worker unless
    // its lifecycle has actually failed.
    await appendLog(pluginId, 'error', `${method}: ${workerError?.message || String(workerError)}`)
    const message = String(workerError?.message || workerError || '')
    const lifecycleFailure =
      workerError?.pluginLifecycleFailure === true ||
      message.includes('worker 已退出') ||
      message.includes('worker 心跳超时') ||
      message.includes('worker 已销毁')
    if (lifecycleFailure) {
      unloadWorkerRuntime(pluginId)
      try {
        const workerRuntime = await getWorkerRuntime(pluginId)
        const result = safeClone(await workerRuntime.invoke(method, args, timeoutMs))
        touchWorkerRuntime(pluginId)
        return result
      } catch (retryError) {
        await appendLog(pluginId, 'error', `${method}: 重建 worker 后仍失败: ${retryError?.message || String(retryError)}`)
        throw retryError
      }
    }
    throw workerError
  }
}

export const service = {
  async health() {
    await ensureDirs()
    return {
      ok: true,
      appDataDir,
      pluginsDir,
      configDir,
      logsDir
    }
  },

  async initializeSystem() {
    if (!pluginSystemInitializationPromise) {
      pluginSystemInitializationPromise = initializePluginSystem().catch((error) => {
        pluginSystemInitializationPromise = null
        throw error
      })
    }
    return await pluginSystemInitializationPromise
  },

  async loadAll() {
    return await loadPluginEntries()
  },

  async reloadAll() {
    invalidatePluginEntries()
    return await loadPluginEntries()
  },

  async reorder(payload = {}) {
    const orderedIds = Array.isArray(payload.orderedIds)
      ? payload.orderedIds.map((value) => String(value || '').trim()).filter(Boolean)
      : []
    if (new Set(orderedIds).size !== orderedIds.length) throw new Error('插件顺序不能包含重复 ID')
    const registry = await readRegistry()
    const byId = new Map(registry.map((entry) => [entry.pluginId, entry]))
    const ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean)
    const seen = new Set(ordered.map((entry) => entry.pluginId))
    const next = [...ordered, ...registry.filter((entry) => !seen.has(entry.pluginId))]
    await writeRegistry(next)
    commitPluginEntriesCache((entries) => {
      const cachedById = new Map(entries.map((entry) => [entry.pluginId, entry]))
      const cachedOrdered = orderedIds.map((id) => cachedById.get(id)).filter(Boolean)
      const cachedSeen = new Set(cachedOrdered.map((entry) => entry.pluginId))
      return [...cachedOrdered, ...entries.filter((entry) => !cachedSeen.has(entry.pluginId))]
    })
    return { success: true, orderedIds: next.map((entry) => entry.pluginId) }
  },

  async installFromCode(payload) {
    return await installFromCode(payload)
  },

  async addPlugin(payload) {
    return await installFromCode(payload)
  },

  async downloadAndAdd(payload = {}) {
    const code = await downloadText(payload.url)
    const urlName = String(payload.url || '').split('/').pop()?.split('?')[0]?.replace(/\.js$/i, '') || undefined
    return await installFromCode({
      pluginCode: code,
      pluginName: urlName,
      targetPluginId: payload.targetPluginId,
      type: payload.type
    })
  },

  async uninstall(payload = {}) {
    const pluginId = normalizePluginId(payload.pluginId || payload.id)
    if (!pluginId) throw new Error('插件ID不能为空')
    await fs.rm(pluginPath(pluginId), { force: true }).catch(() => {})
    await fs.rm(configPath(pluginId), { force: true }).catch(() => {})
    unloadWorkerRuntime(pluginId)
    pinnedWorkerIds.delete(pluginId)
    const registry = await readRegistry()
    await writeRegistry(registry.filter((entry) => entry.pluginId !== pluginId))
    commitPluginEntriesCache((entries) => entries.filter((entry) => entry.pluginId !== pluginId))
    await appendLog(pluginId, 'info', '插件已卸载')
    return { success: true, message: '插件卸载成功' }
  },

  async getConfig(payload = {}) {
    return await readJson(configPath(normalizePluginId(payload.pluginId)), {})
  },

  async getPluginCode(payload = {}) {
    const pluginId = normalizePluginId(payload.pluginId || payload.id)
    if (!pluginId) throw new Error('插件ID不能为空')
    return await fs.readFile(pluginPath(pluginId), 'utf8')
  },

  async saveConfig(payload = {}) {
    const pluginId = normalizePluginId(payload.pluginId)
    await writeJson(configPath(pluginId), payload.config || {})
    await appendLog(pluginId, 'info', '插件配置已保存')
    return { success: true }
  },

  async getConfigSchema(payload = {}) {
    const pluginId = normalizePluginId(payload.pluginId)
    const entries = await loadPluginEntries()
    const entry = entries.find((item) => item.pluginId === pluginId)
    const schema = entry?.configSchema || entry?.pluginInfo?.configSchema || []
    if (schemaSize(schema) > 0) return schema
    const inspected = await inspectPluginFile(pluginId)
    return inspected?.configSchema || []
  },

  async getPluginType(payload = {}) {
    const pluginId = normalizePluginId(payload.pluginId)
    const entries = await loadPluginEntries()
    const entry = entries.find((item) => item.pluginId === pluginId)
    return entry?.pluginType || 'unknown'
  },

  async getServiceRole(payload = {}) {
    const pluginId = normalizePluginId(payload.pluginId)
    const entries = await loadPluginEntries()
    const entry = entries.find((item) => item.pluginId === pluginId)
    if (entry?.serviceRole) return entry.serviceRole
    const inspected = await inspectPluginFile(pluginId)
    return inspected?.serviceRole || ''
  },

  async appendLog(payload = {}) {
    const pluginId = normalizePluginId(payload.pluginId)
    const level = payload.level || 'info'
    const source = payload.source || ''
    const message = payload.message || ''
    const fullMessage = source ? `[${source}] ${message}` : message
    await appendLog(pluginId, level, fullMessage)
    return { success: true }
  },

  async getLog(payload = {}) {
    return await getLog(normalizePluginId(payload.pluginId))
  },

  async invoke(payload = {}) {
    return await invokePlugin(payload)
  },

  async pin(payload = {}) {
    return await pinWorkerRuntime(payload.pluginId || payload.id)
  },

  async unpin(payload = {}) {
    return unpinWorkerRuntime(payload.pluginId || payload.id)
  },

  async notice(payload = {}) {
    return {
      type: payload.type || 'info',
      data: payload.data || {},
      timestamp: Date.now(),
      pluginId: payload.pluginId,
      pluginName: payload.pluginName
    }
  }
}
