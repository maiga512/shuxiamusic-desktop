import { canUseNasSync, nasSyncAPI, NasSyncConflictError, type NasSyncedPlugin } from '@renderer/api/nasSync'
import {
  capabilityIdentityKey,
  canonicalizeCapabilityConfig,
  musicSourceIdentityKey,
  pluginFingerprint,
  sameMusicSourcePlugin
} from '@renderer/utils/playlist/pluginIdentity'
// 【新】统一实时同步总线：插件页改用它接收刷新通知
import { emitPluginSync } from '@renderer/utils/sync/realtimeSyncBus'

const DISABLED_MUSIC_SOURCES_KEY = 'ceru_sync_disabled_music_sources'
const PLUGIN_SYNC_INITIALIZED_KEY = 'ceru_sync_plugins_initialized'
const DEVICE_ID_KEY = 'ceru_sync_device_id'
const SEQUENCE_KEY = 'ceru_sync_plugin_sequence'
const MAX_PLUGIN_SCRIPT_BYTES = 2 * 1024 * 1024
const PENDING_PLUGIN_UPSERTS_KEY = 'ceru_sync_pending_plugin_upserts'
const PENDING_PLUGIN_DELETES_KEY = 'ceru_sync_pending_plugin_deletes'
const PLUGIN_IDENTITY_ALIASES_KEY = 'ceru_sync_plugin_identity_aliases'

export type LocalSyncedPlugin = {
  identityKey: string
  kind: 'music-source' | 'capability'
  name: string
  author: string
  version: string
  enabled: boolean
  disabledSources: string[]
  contentHash?: string
  script?: string
  role?: string
  config?: Record<string, unknown>
  localPluginId?: string
  position?: number
}

let applyingRemotePlugins = false
let lastAppliedFingerprint = ''

const createId = () =>
  `plgop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`

const getDeviceId = () => {
  const existing = localStorage.getItem(DEVICE_ID_KEY)
  if (existing) return existing
  const created = `desktop_${crypto.randomUUID?.() || createId()}`
  localStorage.setItem(DEVICE_ID_KEY, created)
  return created
}

const nextSequence = () => {
  const current = Number(localStorage.getItem(SEQUENCE_KEY) || '0')
  const next = Number.isFinite(current) ? current + 1 : 1
  localStorage.setItem(SEQUENCE_KEY, String(next))
  return next
}

const parsePluginTimestampMs = (value?: string | null) => {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

const readDisabledMusicSources = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(DISABLED_MUSIC_SOURCES_KEY) || '[]')
    return new Set<string>(Array.isArray(parsed) ? parsed.map((item) => String(item)) : [])
  } catch {
    return new Set<string>()
  }
}

const writeDisabledMusicSources = (values: Set<string>) => {
  localStorage.setItem(DISABLED_MUSIC_SOURCES_KEY, JSON.stringify([...values]))
}

export const isApplyingRemotePlugins = () => applyingRemotePlugins

export const isPluginSyncInitialized = (scope: string) =>
  localStorage.getItem(`${PLUGIN_SYNC_INITIALIZED_KEY}:${scope}`) === '1'

export const markPluginSyncInitialized = (scope: string) => {
  localStorage.setItem(`${PLUGIN_SYNC_INITIALIZED_KEY}:${scope}`, '1')
}

const loadPluginList = async () => {
  const plugins = await window.api.plugins.loadAllPlugins().catch(() => [])
  return Array.isArray(plugins) ? plugins : []
}

const notifyPluginsUpdated = () => {
  // 【新·现在用这个】统一实时同步总线：插件页(plugins.vue)已迁移到这里刷新
  emitPluginSync('update', 'local')
  // 【旧·兼容保留】历史 window 事件；插件页已不再监听，仅防止别处遗留监听失效
  window.dispatchEvent(new Event('plugin-updated'))
}

const logPluginSync = async (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
  const plugins = await window.api.plugins.loadAllPlugins().catch(() => [])
  if (!Array.isArray(plugins)) return
  const plugin = plugins.find(
    (item: any) => item?.pluginType === 'service' && item?.serviceRole === 'nas-sync'
  )
  if (!plugin?.pluginId) return
  await window.api.plugins
    .appendPluginLog(plugin.pluginId, level, '多端同步', message)
    .catch(() => null)
}

const readPluginScript = async (pluginId: string, pluginName = '') => {
  try {
    const result = await window.api.plugins.getPluginCode(pluginId)
    if (result && 'code' in result && result.code) return String(result.code)
    const error = result && 'error' in result ? result.error : '无法读取插件源码'
    throw new Error(error)
  } catch (error: any) {
    await logPluginSync(
      `读取插件源码失败: ${pluginName || pluginId} ${error?.message || error}`,
      'warn'
    )
    return ''
  }
}

const sha256Hex = async (script: string) => {
  const bytes = new TextEncoder().encode(script)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

const readIdentityAliases = (): Record<string, string> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLUGIN_IDENTITY_ALIASES_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const rememberPluginIdentity = (pluginId: string, localKey: string, serverKey: string) => {
  const canonical = String(serverKey || '').trim()
  if (!canonical) return
  const aliases = readIdentityAliases()
  if (pluginId) aliases[`id:${pluginId}`] = canonical
  if (localKey) aliases[`local:${localKey}`] = canonical
  localStorage.setItem(PLUGIN_IDENTITY_ALIASES_KEY, JSON.stringify(aliases))
  const pending = readPendingPluginUpserts()
  const pendingAt = Math.max(pending.get(localKey) || 0, pending.get(canonical) || 0)
  if (pendingAt > 0) {
    pending.set(canonical, pendingAt)
    writePendingPluginUpserts(pending)
  }
}

const resolvePluginIdentity = (pluginId: string, localKey: string) => {
  const aliases = readIdentityAliases()
  return aliases[`id:${pluginId}`] || aliases[`local:${localKey}`] || localKey
}

export const collectLocalPlugins = async (): Promise<LocalSyncedPlugin[]> => {
  const plugins = await loadPluginList()
  const disabled = readDisabledMusicSources()
  const items: LocalSyncedPlugin[] = []

  for (const [position, plugin] of plugins.entries()) {
    const pluginType = plugin.pluginType || 'music-source'
    const serviceRole = String(plugin.serviceRole || '')
    if (pluginType === 'service' && serviceRole) {
      const configResult = await window.api.plugins.getConfig(plugin.pluginId).catch(() => null)
      const config = (configResult?.data || {}) as Record<string, unknown>
      const role = serviceRole === 'feiniu' || serviceRole === 'navidrome' || serviceRole === 'nas-sync'
        ? serviceRole
        : ''
      if (!role) continue
      items.push({
        identityKey: capabilityIdentityKey(role),
        kind: 'capability',
        name: plugin.pluginInfo?.name || role,
        author: plugin.pluginInfo?.author || '',
        version: plugin.pluginInfo?.version || '',
        enabled: true,
        disabledSources: [],
        role,
        config: canonicalizeCapabilityConfig(role, config),
        localPluginId: plugin.pluginId
        ,position
      })
      continue
    }

    if (pluginType !== 'music-source') continue
    const name = plugin.pluginInfo?.name || plugin.pluginName || ''
    const author = plugin.pluginInfo?.author || ''
    if (!name) continue
    const computedKey = musicSourceIdentityKey(name, author)
    const script = await readPluginScript(plugin.pluginId, name)
    if (!script) {
      await logPluginSync(`跳过上传音源插件（源码为空）: ${name}`, 'warn')
      continue
    }
    if (new TextEncoder().encode(script).byteLength > MAX_PLUGIN_SCRIPT_BYTES) {
      await logPluginSync(`跳过上传音源插件（超过2MB）: ${name}`, 'warn')
      continue
    }
    const contentHash = await sha256Hex(script)
    const identityKey = resolvePluginIdentity(plugin.pluginId, computedKey)
    items.push({
      identityKey,
      kind: 'music-source',
      name,
      author,
      version: plugin.pluginInfo?.version || '',
      enabled: !disabled.has(identityKey) && !disabled.has(computedKey),
      disabledSources: [],
      script,
      contentHash,
      localPluginId: plugin.pluginId,
      position
    })
  }

  return items
}

const uploadLocalPlugin = async (
  item: LocalSyncedPlugin,
  occurredAtMs = Date.now(),
  prune = false,
  position = 0
) => {
  if (item.kind === 'music-source') {
    if (!item.script) return null
    const uploaded = await nasSyncAPI.putPluginBlob(item.script)
    return nasSyncAPI.applyPluginOperation({
      operationId: createId(),
      deviceId: getDeviceId(),
      sequence: nextSequence(),
      occurredAtMs,
      identityKey: item.identityKey,
      action: 'upsert',
      kind: 'music-source',
      name: item.name,
      author: item.author,
      version: item.version,
      enabled: item.enabled,
      disabledSources: item.disabledSources,
      contentHash: uploaded.contentHash
      ,position
    })
  }
  return nasSyncAPI.applyPluginOperation({
    operationId: createId(),
    deviceId: getDeviceId(),
    sequence: nextSequence(),
    occurredAtMs,
    identityKey: item.identityKey,
    action: prune && !item.config ? 'remove' : 'upsert',
    kind: 'capability',
    name: item.name,
    author: item.author,
    version: item.version,
    enabled: true,
    role: item.role,
    config: item.config
    ,position
  })
}

const KNOWN_PLUGIN_KEYS = 'ceru_sync_known_plugin_keys'

const readKnownPluginKeys = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KNOWN_PLUGIN_KEYS) || '[]')
    return new Set<string>(Array.isArray(parsed) ? parsed.map((item) => String(item)) : [])
  } catch {
    return new Set<string>()
  }
}

const writeKnownPluginKeys = (keys: Set<string>) => {
  localStorage.setItem(KNOWN_PLUGIN_KEYS, JSON.stringify([...keys]))
}

export const backupLocalPluginsToCloud = async (pruneCloudExtras = false) => {
  if (applyingRemotePlugins) return {uploaded: 0, removed: 0}
  await dedupeLocalMusicSourcePlugins()
  let localItems = await collectLocalPlugins()
  const remoteItems = (await nasSyncAPI.listPlugins({includeDeleted: true}))
    .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
  const activeRemoteItems = remoteItems.filter((item) => !item.deletedAt)
  const remoteByKey = new Map(remoteItems.map((item) => [item.identityKey, item]))
  const activeRemoteByKey = new Map(activeRemoteItems.map((item) => [item.identityKey, item]))
  const knownKeys = readKnownPluginKeys()
  const pendingUpserts = readPendingPluginUpserts()
  let removed = 0

  const tombstones = remoteItems.filter((item) => item.deletedAt && item.kind === 'music-source')
  const localHashCounts = new Map<string, number>()
  for (const item of localItems) {
    if (!item.contentHash) continue
    localHashCounts.set(item.contentHash, (localHashCounts.get(item.contentHash) || 0) + 1)
  }
  const tombHashCounts = new Map<string, number>()
  for (const remote of tombstones) {
    if (!remote.contentHash) continue
    tombHashCounts.set(remote.contentHash, (tombHashCounts.get(remote.contentHash) || 0) + 1)
  }
  const sameDeletedPlugin = (item: LocalSyncedPlugin, remote: NasSyncedPlugin) =>
    sameMusicSourcePlugin(item, remote) || Boolean(
      item.contentHash &&
        item.contentHash === remote.contentHash &&
        localHashCounts.get(item.contentHash) === 1 &&
        tombHashCounts.get(item.contentHash) === 1
    )
  for (const item of localItems) {
    if (item.kind !== 'music-source') continue
    const computedKey = musicSourceIdentityKey(item.name, item.author)
    const activeMatch = activeRemoteItems.find((remote) => sameMusicSourcePlugin(item, remote))
    if (activeMatch) rememberPluginIdentity(item.localPluginId || '', computedKey, activeMatch.identityKey)
    const tombstone = tombstones
      .filter((remote) => sameDeletedPlugin(item, remote))
      .sort((left, right) => parsePluginTimestampMs(right.deletedAt) - parsePluginTimestampMs(left.deletedAt))[0]
    if (!tombstone) continue
    const pendingAt = Math.max(pendingUpserts.get(item.identityKey) || 0, pendingUpserts.get(computedKey) || 0)
    if (parsePluginTimestampMs(tombstone.deletedAt) <= pendingAt) continue
    if (item.localPluginId) await window.api.plugins.uninstallPlugin(item.localPluginId).catch(() => null)
    clearLocalPluginUpsert(item.identityKey)
    clearLocalPluginUpsert(computedKey)
    removed += 1
  }
  const activeHashCounts = new Map<string, number>()
  for (const remote of activeRemoteItems) {
    if (!remote.contentHash) continue
    activeHashCounts.set(remote.contentHash, (activeHashCounts.get(remote.contentHash) || 0) + 1)
  }
  for (const item of localItems) {
    if (item.kind !== 'music-source' || !item.contentHash) continue
    if (localHashCounts.get(item.contentHash) !== 1 || activeHashCounts.get(item.contentHash) !== 1) continue
    const remote = activeRemoteItems.find((candidate) => candidate.contentHash === item.contentHash)
    if (!remote) continue
    rememberPluginIdentity(item.localPluginId || '', musicSourceIdentityKey(item.name, item.author), remote.identityKey)
  }
  if (removed > 0) {
    notifyPluginsUpdated()
    localItems = await collectLocalPlugins()
  }

  const localKeys = new Set(localItems.map((item) => item.identityKey))
  let uploaded = 0
  for (const [position, item] of localItems.entries()) {
    const remote = activeRemoteByKey.get(item.identityKey)
    const computedKey = musicSourceIdentityKey(item.name, item.author)
    const pendingAt = pendingUpserts.get(item.identityKey) ?? pendingUpserts.get(computedKey)
    const blockingTombstone = tombstones.find((remoteItem) => sameDeletedPlugin(item, remoteItem))
    if (blockingTombstone && parsePluginTimestampMs(blockingTombstone.deletedAt) > (pendingAt || 0)) continue
    const pendingUpsert = pendingAt != null
    const fingerprint = pluginFingerprint({
      ...item,
      contentHash: item.kind === 'music-source' ? await sha256Hex(item.script || '') : undefined
    })
    const remoteFingerprint = remote ? pluginFingerprint(remote) : ''
    if (!pendingUpsert && fingerprint === remoteFingerprint) continue
    // 云端没有这份插件时才上传。更新的删除记录已经在上面卸掉，不能再传回去。
    await uploadLocalPlugin(item, pendingAt ?? Date.now(), false, position)
    clearLocalPluginUpsert(item.identityKey)
    clearLocalPluginUpsert(computedKey)
    uploaded += 1
  }
  for (const remote of activeRemoteItems) {
    if (localKeys.has(remote.identityKey)) continue
    if (remote.kind !== 'music-source') continue
    // 普通备份是合并，不是镜像；云端多出来的插件必须保留，避免其他设备的数据被清空。
    const shouldRemove = false
    if (!shouldRemove) continue
    await nasSyncAPI.applyPluginOperation({
      operationId: createId(),
      deviceId: getDeviceId(),
      sequence: nextSequence(),
      occurredAtMs: Date.now(),
      identityKey: remote.identityKey,
      action: 'remove',
      kind: remote.kind,
      role: remote.role
    })
    removed += 1
  }

  // 插件上传按条目发生，最后提交完整顺序。并发冲突时把云端新插件追加到
  // 本地排序之后再重试，避免一次拖动覆盖另一台设备刚添加的插件。
  const latestRemoteItems = (await nasSyncAPI.listPlugins({includeDeleted: false}))
    .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
  const localDesiredPluginIds = localItems
    .map((item) => latestRemoteItems.find((remote) => remote.identityKey === item.identityKey)?.identityKey || '')
    .filter(Boolean)
  const currentPluginIds = latestRemoteItems.map((item) => item.identityKey)
  const currentPluginSet = new Set(currentPluginIds)
  const desiredPluginIds = [
    ...localDesiredPluginIds.filter((id) => currentPluginSet.has(id)),
    ...currentPluginIds.filter((id) => !localDesiredPluginIds.includes(id))
  ]
  if (desiredPluginIds.length > 0) {
    const marker = await nasSyncAPI.snapshot()
    try {
      await nasSyncAPI.reorderPlugins(desiredPluginIds, marker.revision)
    } catch (error) {
      if (!(error instanceof NasSyncConflictError)) throw error
      const current = (await nasSyncAPI.listPlugins({includeDeleted: false}))
        .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
      const currentIds = current.map((item) => item.identityKey)
      const currentSet = new Set(currentIds)
      const retryIds = [
        ...desiredPluginIds.filter((id) => currentSet.has(id)),
        ...currentIds.filter((id) => !desiredPluginIds.includes(id))
      ]
      if (retryIds.length > 0) {
        await nasSyncAPI.reorderPlugins(
          retryIds,
          error.conflict.currentRevision ?? (await nasSyncAPI.snapshot()).revision
        )
      }
    }
  }
  const latestLocal = await collectLocalPlugins()
  const latestKeys = new Set(latestLocal.map((item) => item.identityKey))
  writeKnownPluginKeys(latestKeys)
  writePendingPluginUpserts(
    new Map([...readPendingPluginUpserts()].filter(([key]) => latestKeys.has(key)))
  )
  return {uploaded, removed}
}

const APPLIED_PLUGIN_HASHES_KEY = 'ceru_sync_applied_plugin_hashes'

const readPendingPluginUpserts = (): Map<string, number> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_PLUGIN_UPSERTS_KEY) || '{}')
    const pending = new Map<string, number>()
    if (Array.isArray(parsed)) {
      // 旧版本只保存了插件键，没有时间；按 0 处理，确保后来的云端删除优先。
      for (const value of parsed) {
        const key = String(value || '').trim()
        if (key) pending.set(key, 0)
      }
      return pending
    }
    if (parsed && typeof parsed === 'object') {
      for (const [rawKey, rawTime] of Object.entries(parsed)) {
        const key = String(rawKey || '').trim()
        const time = Number(rawTime)
        if (key) pending.set(key, Number.isFinite(time) && time > 0 ? time : 0)
      }
    }
    return pending
  } catch {
    return new Map<string, number>()
  }
}

const writePendingPluginUpserts = (pending: Map<string, number>) => {
  localStorage.setItem(PENDING_PLUGIN_UPSERTS_KEY, JSON.stringify(Object.fromEntries(pending)))
}

export const markLocalPluginUpsert = (identityKey: string, occurredAtMs = Date.now()) => {
  const key = String(identityKey || '').trim()
  if (!key) return
  const pending = readPendingPluginUpserts()
  pending.set(key, Number.isFinite(occurredAtMs) && occurredAtMs > 0 ? occurredAtMs : Date.now())
  writePendingPluginUpserts(pending)
}

export const pushLocalPluginNow = async (identityKey: string) => {
  const key = String(identityKey || '').trim()
  if (!key || applyingRemotePlugins || !(await canUseNasSync())) return
  const localItems = await collectLocalPlugins()
  const item = localItems.find((candidate) =>
    candidate.identityKey === key || musicSourceIdentityKey(candidate.name, candidate.author) === key
  )
  if (!item) return
  const pendingAt = readPendingPluginUpserts().get(item.identityKey)
    ?? readPendingPluginUpserts().get(key)
    ?? Date.now()
  const index = localItems.findIndex((candidate) => candidate.localPluginId === item.localPluginId)
  await uploadLocalPlugin(item, pendingAt, false, Math.max(0, index))
  clearLocalPluginUpsert(key)
  clearLocalPluginUpsert(item.identityKey)
  clearLocalPluginUpsert(musicSourceIdentityKey(item.name, item.author))
  notifyPluginsUpdated()
}

type PendingPluginDelete = {
  identityKey: string
  kind: 'music-source' | 'capability'
  role?: string
  operationId: string
  sequence: number
  occurredAtMs: number
}

const readPendingPluginDeletes = (): PendingPluginDelete[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_PLUGIN_DELETES_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => item?.identityKey && item?.kind) : []
  } catch {
    return []
  }
}

const writePendingPluginDeletes = (items: PendingPluginDelete[]) => {
  localStorage.setItem(PENDING_PLUGIN_DELETES_KEY, JSON.stringify(items))
}

export const flushPendingPluginDeletes = async () => {
  if (!(await canUseNasSync())) return
  for (const item of readPendingPluginDeletes()) {
    const result = await nasSyncAPI.applyPluginOperation({
      operationId: item.operationId,
      deviceId: getDeviceId(),
      sequence: item.sequence,
      occurredAtMs: item.occurredAtMs,
      identityKey: item.identityKey,
      action: 'remove',
      kind: item.kind,
      role: item.role
    })
    if (result.applied || result.stale) {
      writePendingPluginDeletes(readPendingPluginDeletes().filter((pending) => pending.identityKey !== item.identityKey))
    }
  }
}

export const flushPendingPluginUpserts = async () => {
  if (!(await canUseNasSync()) || applyingRemotePlugins) return
  const pending = readPendingPluginUpserts()
  if (pending.size === 0) return
  const localItems = await collectLocalPlugins()
  for (const [key, occurredAtMs] of pending) {
    const item = localItems.find((candidate) =>
      candidate.identityKey === key ||
      (candidate.kind === 'music-source' && musicSourceIdentityKey(candidate.name, candidate.author) === key)
    )
    if (!item) continue
    const position = localItems.findIndex((candidate) => candidate.identityKey === item.identityKey)
    const result = await uploadLocalPlugin(item, occurredAtMs || Date.now(), false, Math.max(0, position))
    if (result?.applied || result?.stale) {
      clearLocalPluginUpsert(key)
      clearLocalPluginUpsert(item.identityKey)
      if (item.kind === 'music-source') clearLocalPluginUpsert(musicSourceIdentityKey(item.name, item.author))
    }
  }
}

export const selectLocalMusicSourceForSync = async (selectedIdentityKey: string) => {
  const selected = String(selectedIdentityKey || '').trim()
  if (!selected || applyingRemotePlugins) return
  const localItems = (await collectLocalPlugins()).filter((item) => item.kind === 'music-source')
  const disabled = readDisabledMusicSources()
  for (const item of localItems) {
    if (item.identityKey === selected) disabled.delete(item.identityKey)
    else disabled.add(item.identityKey)
    markLocalPluginUpsert(item.identityKey)
  }
  writeDisabledMusicSources(disabled)
  window.dispatchEvent(new Event('ceru-nas-local-change'))
}

export const clearLocalPluginUpsert = (identityKey: string) => {
  const key = String(identityKey || '').trim()
  if (!key) return
  const pending = readPendingPluginUpserts()
  if (!pending.delete(key)) return
  writePendingPluginUpserts(pending)
}

export const removeLocalPluginFromCloud = async (
  identityKey: string,
  options?: {name?: string; author?: string; contentHash?: string; kind?: 'music-source' | 'capability'; role?: string}
) => {
  const key = String(identityKey || '').trim()
  if (!key) return
  const hint = {
    identityKey: key,
    name: options?.name || '',
    author: options?.author || '',
    contentHash: options?.contentHash || ''
  }
  let keys = [key]
  const kind = options?.kind || 'music-source'
  try {
    if (!(await canUseNasSync())) throw new Error('NAS sync unavailable')
    const active = kind === 'music-source'
      ? (await nasSyncAPI.listPlugins({includeDeleted: false})).filter(
          (item) => !item.deletedAt && item.kind === 'music-source'
        )
      : []
    const hashCounts = new Map<string, number>()
    for (const item of active) {
      if (!item.contentHash) continue
      hashCounts.set(item.contentHash, (hashCounts.get(item.contentHash) || 0) + 1)
    }
    const matched = active
      .filter(
        (item) =>
          sameMusicSourcePlugin(hint, item) ||
          Boolean(
            hint.contentHash &&
              hint.contentHash === item.contentHash &&
              hashCounts.get(hint.contentHash) === 1
          )
      )
      .map((item) => item.identityKey)
    if (matched.length > 0) keys = [...new Set(matched)]
  } catch {
    keys = [key]
  }
  const occurredAtMs = Date.now()
  for (const identityKey of keys) {
    const pending = readPendingPluginDeletes().filter((item) => item.identityKey !== identityKey)
    pending.push({
      identityKey,
      kind,
      role: options?.role,
      operationId: createId(),
      sequence: nextSequence(),
      occurredAtMs
    })
    writePendingPluginDeletes(pending)
    clearLocalPluginUpsert(identityKey)
  }
  window.dispatchEvent(new Event('ceru-nas-local-change'))
  await flushPendingPluginDeletes()
}

export const dedupeLocalMusicSourcePlugins = async () => {
  const plugins = await loadPluginList()
  const groups = new Map<string, any[]>()
  for (const plugin of plugins) {
    if ((plugin.pluginType || 'music-source') !== 'music-source') continue
    const name = plugin.pluginInfo?.name || plugin.pluginName || ''
    if (!name) continue
    const key = musicSourceIdentityKey(name, plugin.pluginInfo?.author || '')
    const group = groups.get(key) || []
    group.push(plugin)
    groups.set(key, group)
  }
  let removed = 0
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const ranked = [...group].sort((left, right) => {
      const leftTime = Date.parse(String(left.installedAt || '')) || 0
      const rightTime = Date.parse(String(right.installedAt || '')) || 0
      return rightTime - leftTime
    })
    for (const duplicate of ranked.slice(1)) {
      if (!duplicate.pluginId) continue
      const result = await window.api.plugins.uninstallPlugin(duplicate.pluginId).catch(() => null)
      if (result && typeof result === 'object' && 'error' in result) continue
      removed += 1
    }
  }
  return removed
}

const readAppliedPluginHashes = (): Record<string, string> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(APPLIED_PLUGIN_HASHES_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const rememberAppliedPluginHash = (identityKey: string, contentHash?: string) => {
  if (!identityKey || !contentHash) return
  const current = readAppliedPluginHashes()
  current[identityKey] = contentHash
  localStorage.setItem(APPLIED_PLUGIN_HASHES_KEY, JSON.stringify(current))
}

const forgetAppliedPluginHash = (identityKey: string) => {
  const current = readAppliedPluginHashes()
  if (!current[identityKey]) return
  delete current[identityKey]
  localStorage.setItem(APPLIED_PLUGIN_HASHES_KEY, JSON.stringify(current))
}

const applyMusicSourceFlags = (remote: NasSyncedPlugin) => {
  const disabled = readDisabledMusicSources()
  if (remote.enabled === false) disabled.add(remote.identityKey)
  else disabled.delete(remote.identityKey)
  writeDisabledMusicSources(disabled)
}

const applyMusicSourcePlugin = async (remote: NasSyncedPlugin, localItems: LocalSyncedPlugin[]) => {
  if (remote.deletedAt) {
    const sameHashCount = localItems.filter((item) => item.contentHash && item.contentHash === remote.contentHash).length
    const matches = localItems.filter((item) => item.kind === 'music-source' && (
      sameMusicSourcePlugin(item, remote) ||
      Boolean(remote.contentHash && item.contentHash === remote.contentHash && sameHashCount === 1)
    ))
    for (const existing of matches) {
      if (existing.localPluginId) await window.api.plugins.uninstallPlugin(existing.localPluginId).catch(() => null)
      clearLocalPluginUpsert(existing.identityKey)
      clearLocalPluginUpsert(musicSourceIdentityKey(existing.name, existing.author))
    }
    if (matches.length > 0) notifyPluginsUpdated()
    const disabled = readDisabledMusicSources()
    disabled.delete(remote.identityKey)
    writeDisabledMusicSources(disabled)
    forgetAppliedPluginHash(remote.identityKey)
    clearLocalPluginUpsert(remote.identityKey)
    return
  }

  const existing = localItems.find((item) => item.kind === 'music-source' && sameMusicSourcePlugin(item, remote))
  const localContentHash = existing?.contentHash || (existing?.script ? await sha256Hex(existing.script) : '')
  const localFingerprint = existing
    ? pluginFingerprint({
        ...existing,
        contentHash: localContentHash
      })
    : ''
  const remoteFingerprint = pluginFingerprint(remote)
  const appliedHash = readAppliedPluginHashes()[remote.identityKey] || ''
  const sameScript = Boolean(
    remote.contentHash &&
      (localContentHash === remote.contentHash || appliedHash === remote.contentHash)
  )
  if (existing && (localFingerprint === remoteFingerprint || sameScript)) {
    applyMusicSourceFlags(remote)
    rememberAppliedPluginHash(remote.identityKey, remote.contentHash)
    rememberPluginIdentity(
      existing.localPluginId || '',
      musicSourceIdentityKey(existing.name, existing.author),
      remote.identityKey
    )
    clearLocalPluginUpsert(remote.identityKey)
    return
  }

  let script = ''
  if (remote.contentHash) {
    const blob = await nasSyncAPI.getPluginBlob(remote.contentHash)
    script = blob.script || ''
  }
  if (!script || new TextEncoder().encode(script).byteLength > MAX_PLUGIN_SCRIPT_BYTES) {
    await logPluginSync(`跳过应用音源插件（源码无效）: ${remote.name || remote.identityKey}`, 'warn')
    return
  }
  const result = await window.api.plugins.addPlugin(
    script,
    `${remote.name || 'plugin'}.js`,
    existing?.localPluginId,
    {
      name: remote.name,
      version: remote.version,
      author: remote.author,
      forceReplace: true
    }
  )
  if (result && typeof result === 'object' && 'error' in result) {
    await logPluginSync(
      `应用音源插件失败: ${remote.name || remote.identityKey} ${result.error}`,
      'error'
    )
    return
  }
  applyMusicSourceFlags(remote)
  rememberAppliedPluginHash(remote.identityKey, remote.contentHash)
  const installed = (await collectLocalPlugins()).find((item) =>
    item.kind === 'music-source' && sameMusicSourcePlugin(
      {...item, identityKey: musicSourceIdentityKey(item.name, item.author)},
      remote
    )
  )
  if (installed) {
    rememberPluginIdentity(
      installed.localPluginId || '',
      musicSourceIdentityKey(installed.name, installed.author),
      remote.identityKey
    )
  }
  clearLocalPluginUpsert(remote.identityKey)
  notifyPluginsUpdated()
}

const applyCapabilityPlugin = async (remote: NasSyncedPlugin, localItems: LocalSyncedPlugin[]) => {
  const role = String(remote.role || remote.identityKey.replace(/^capability:/, ''))
  if (role !== 'feiniu' && role !== 'navidrome' && role !== 'nas-sync') return
  const existing = localItems.find((item) => item.identityKey === remote.identityKey)
  if (!existing?.localPluginId) return
  if (!remote.deletedAt && pluginFingerprint(existing) === pluginFingerprint(remote)) return
  const current = await window.api.plugins.getConfig(existing.localPluginId).catch(() => null)
  const currentConfig = (current?.data || {}) as Record<string, unknown>
  if (remote.deletedAt) {
    if (role === 'feiniu' || role === 'navidrome') {
      const next = {...currentConfig}
      delete next.host
      delete next.port
      delete next.username
      delete next.password
      delete next.accessCode
      delete next.serverUrl
      await window.api.plugins.saveConfig(existing.localPluginId, next)
    }
    return
  }
  const canonical = canonicalizeCapabilityConfig(role, {
    ...currentConfig,
    ...(remote.config || {})
  })
  if (role === 'nas-sync' && (currentConfig.accessToken || currentConfig.serverUrl)) {
    const next = {...currentConfig}
    if (canonical.pairCode) next.pairCode = canonical.pairCode
    await window.api.plugins.saveConfig(existing.localPluginId, next)
    return
  }
  const merged = {
    ...currentConfig,
    ...canonical
  }
  await window.api.plugins.saveConfig(existing.localPluginId, merged)
  if (role === 'feiniu') {
    await window.api.plugins.testConnection(existing.localPluginId).catch(() => null)
  }
}

export const applyRemotePluginEvent = async (payload: NasSyncedPlugin, deleted = false) => {
  if (payload.kind === 'music-source') {
    const pendingMap = readPendingPluginUpserts()
    const pendingAt = pendingMap.get(payload.identityKey)
      ?? pendingMap.get(musicSourceIdentityKey(payload.name, payload.author))
    if (pendingAt != null) {
      const deletedAt = parsePluginTimestampMs(payload.deletedAt || payload.updatedAt)
      if (!deleted || (deletedAt > 0 && pendingAt > deletedAt)) return
    }
  }
  applyingRemotePlugins = true
  try {
    const localItems = await collectLocalPlugins()
    const remote = {...payload, deletedAt: deleted ? payload.deletedAt || new Date().toISOString() : payload.deletedAt}
    lastAppliedFingerprint = pluginFingerprint(remote)
    if (remote.kind === 'music-source') await applyMusicSourcePlugin(remote, localItems)
    else await applyCapabilityPlugin(remote, localItems)
  } finally {
    applyingRemotePlugins = false
  }
}

export const restorePluginsFromCloud = async (fullMirror = false) => {
  applyingRemotePlugins = true
  try {
    const remoteItems = (await nasSyncAPI.listPlugins())
      .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
    const localItems = await collectLocalPlugins()
    for (const remote of remoteItems) {
      lastAppliedFingerprint = pluginFingerprint(remote)
      if (remote.kind === 'music-source') await applyMusicSourcePlugin(remote, localItems)
      else await applyCapabilityPlugin(remote, localItems)
    }
    const latestForOrder = await collectLocalPlugins()
    const localIdByKey = new Map(latestForOrder.map((item) => [item.identityKey, item.localPluginId]))
    const orderedLocalIds = remoteItems
      .map((item) => localIdByKey.get(item.identityKey))
      .filter((id): id is string => Boolean(id))
    if (orderedLocalIds.length > 0) await window.api.plugins.reorderPlugins(orderedLocalIds)
    if (fullMirror) {
      // fullMirror 只允许在云端确有有效插件时执行；且只删本地确认不在云端的插件
      const activeRemoteKeys = new Set(remoteItems.filter((item) => !item.deletedAt).map((item) => item.identityKey))
      if (activeRemoteKeys.size > 0) {
        for (const local of localItems) {
          if (activeRemoteKeys.has(local.identityKey) || local.kind !== 'music-source' || !local.localPluginId) continue
          await window.api.plugins.uninstallPlugin(local.localPluginId).catch(() => null)
          clearLocalPluginUpsert(local.identityKey)
          notifyPluginsUpdated()
        }
      }
    }
    const latestLocal = await collectLocalPlugins()
    writeKnownPluginKeys(new Set(latestLocal.map((item) => item.identityKey)))
  } finally {
    applyingRemotePlugins = false
  }
}

export const unionPluginsWithCloud = async () => {
  await backupLocalPluginsToCloud(false)
  await restorePluginsFromCloud(false)
  const latestLocal = await collectLocalPlugins()
  writeKnownPluginKeys(new Set(latestLocal.map((item) => item.identityKey)))
}

export const shouldSkipLocalPluginUpload = (item: LocalSyncedPlugin) =>
  lastAppliedFingerprint === pluginFingerprint(item)
