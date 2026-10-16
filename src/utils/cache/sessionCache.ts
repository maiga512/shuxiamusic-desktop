type CacheEntry<T> = {
  value: T
  expiresAt: number
}

// localStorage 中持久化条目的结构。v 是 schema 版本：结构变化时升版本即可让旧数据整体失效。
type PersistedEntry<T> = {
  v: number
  expiresAt: number
  value: T
}

const MAX_SESSION_CACHE_ITEMS = 80
// 默认 TTL（分钟级）。发现/播客/歌单等慢变内容请在调用处改用 SESSION_TTL_MS 并传 persist=true。
const DEFAULT_TTL_MS = 10 * 60 * 1000
// 会话级 TTL：足够长，实际以「关 App 即清空内存」为准；localStorage 中 24 小时后过期。
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000

// 本次启动时间戳：模块在应用启动时被首次 import，初始化时机 ≈ 启动时刻。
// 用它区分「本会话拉过的缓存」和「上次启动遗留的持久化缓存」——
// 重启后第一次进页一律视为「需刷新」，先秒出缓存、后台静默更新（对齐"重启即刷新"）。
export const APP_LAUNCH_TS = Date.now()

const PERSIST_SCHEMA_VERSION = 1
const LS_PREFIX = `shuxia_sc_v${PERSIST_SCHEMA_VERSION}:`

const entries = new Map<string, CacheEntry<unknown>>()

const storageAvailable = (): boolean => {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null
  } catch {
    return false
  }
}

// 读 localStorage 中尚未过期的持久化条目；不存在 / 版本不符 / 已过期时返回 null 并清理失效项。
const readPersistedEntry = <T>(key: string): PersistedEntry<T> | null => {
  if (!storageAvailable()) return null
  const lsKey = LS_PREFIX + key
  try {
    const raw = localStorage.getItem(lsKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedEntry<T>
    if (!parsed || parsed.v !== PERSIST_SCHEMA_VERSION || typeof parsed.expiresAt !== 'number') {
      localStorage.removeItem(lsKey)
      return null
    }
    if (parsed.expiresAt <= Date.now()) {
      localStorage.removeItem(lsKey)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

// 写 localStorage；容量超限或序列化失败时静默降级为「仅内存缓存」，不影响功能。
const writePersisted = <T>(key: string, value: T, expiresAt: number): void => {
  if (!storageAvailable()) return
  try {
    const payload: PersistedEntry<T> = { v: PERSIST_SCHEMA_VERSION, expiresAt, value }
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(payload))
  } catch {
    // QuotaExceededError / 序列化失败：忽略，保持内存缓存可用。
  }
}

const pruneExpired = (now = Date.now()) => {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key)
  }
}

const touch = (key: string, entry: CacheEntry<unknown>) => {
  entries.delete(key)
  entries.set(key, entry)
}

const evictOldest = (keepKey?: string) => {
  while (entries.size > MAX_SESSION_CACHE_ITEMS) {
    const oldest = entries.keys().next().value
    if (oldest === undefined || oldest === keepKey) break
    entries.delete(oldest)
  }
}

export const getSessionCache = <T>(key: string): T | null => {
  const now = Date.now()
  const entry = entries.get(key)
  if (entry) {
    if (entry.expiresAt > now) {
      touch(key, entry)
      return entry.value as T
    }
    entries.delete(key)
  }
  // 内存未命中 → 回落 localStorage，实现「关 App 重启后列表也秒开」。
  const persisted = readPersistedEntry<T>(key)
  if (!persisted) return null
  const ttl = Math.max(1000, persisted.expiresAt - now)
  entries.delete(key)
  entries.set(key, { value: persisted.value, expiresAt: now + ttl })
  evictOldest(key)
  return persisted.value
}

export const setSessionCache = <T>(
  key: string,
  value: T,
  ttlMs = DEFAULT_TTL_MS,
  persist = false
): void => {
  const now = Date.now()
  pruneExpired(now)
  const expiresAt = now + Math.max(1000, ttlMs)
  entries.delete(key)
  entries.set(key, { value, expiresAt })
  evictOldest(key)
  if (persist) writePersisted(key, value, expiresAt)
}

export const deleteSessionCache = (prefix: string): void => {
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key)
  }
  if (storageAvailable()) {
    try {
      const toRemove: string[] = []
      for (let i = 0; i < localStorage.length; i += 1) {
        const lsKey = localStorage.key(i)
        if (
          lsKey &&
          lsKey.startsWith(LS_PREFIX) &&
          lsKey.slice(LS_PREFIX.length).startsWith(prefix)
        ) {
          toRemove.push(lsKey)
        }
      }
      for (const lsKey of toRemove) localStorage.removeItem(lsKey)
    } catch {
      // ignore
    }
  }
}
