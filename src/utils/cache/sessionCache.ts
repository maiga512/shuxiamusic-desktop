type CacheEntry<T> = {
  value: T
  expiresAt: number
}

const MAX_SESSION_CACHE_ITEMS = 40  // 从 80 降低到 40，减少会话缓存
const entries = new Map<string, CacheEntry<unknown>>()

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
  const entry = entries.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    entries.delete(key)
    return null
  }
  touch(key, entry)
  return entry.value as T
}

export const setSessionCache = <T>(key: string, value: T, ttlMs = 10 * 60 * 1000): void => {
  const now = Date.now()
  pruneExpired(now)
  entries.delete(key)
  entries.set(key, {
    value,
    expiresAt: now + Math.max(1000, ttlMs)
  })
  evictOldest(key)
}

export const deleteSessionCache = (prefix: string): void => {
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key)
  }
}
