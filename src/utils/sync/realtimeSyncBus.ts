/**
 * 统一实时同步事件总线
 * 所有同步相关事件（本地操作和远端同步）都通过这里分发
 * UI 组件只需监听这个总线，不用分别监听各种 window 事件
 */

export type SyncEntityType = 'favorites' | 'playlist' | 'podcast' | 'plugin' | 'any'
export type SyncChangeType = 'add' | 'remove' | 'update' | 'reorder'

export interface SyncEvent {
  entity: SyncEntityType
  change: SyncChangeType
  source: 'local' | 'remote'
  data?: any
  timestamp: number
}

type SyncEventHandler = (event: SyncEvent) => void

const listeners = new Map<SyncEntityType, Set<SyncEventHandler>>()

const getListeners = (entity: SyncEntityType): Set<SyncEventHandler> => {
  if (!listeners.has(entity)) listeners.set(entity, new Set())
  return listeners.get(entity)!
}

/**
 * 发射同步事件
 */
export const emitSyncEvent = (event: SyncEvent): void => {
  const entityListeners = getListeners(event.entity)
  const anyListeners = getListeners('any')
  for (const handler of entityListeners) {
    try { handler(event) } catch (e) { console.warn('[realtime-sync] handler error:', e) }
  }
  for (const handler of anyListeners) {
    try { handler(event) } catch (e) { console.warn('[realtime-sync] any handler error:', e) }
  }
}

/**
 * 监听同步事件
 * @param entity 实体类型，'any' 监听所有类型
 * @param handler 事件处理器
 * @returns 取消监听函数
 */
export const onSyncEvent = (entity: SyncEntityType, handler: SyncEventHandler): (() => void) => {
  const set = getListeners(entity)
  set.add(handler)
  return () => { set.delete(handler) }
}

/**
 * 便捷方法：发射收藏歌曲事件
 */
export const emitFavoritesSync = (change: SyncChangeType, source: 'local' | 'remote', data?: any) => {
  emitSyncEvent({ entity: 'favorites', change, source, data, timestamp: Date.now() })
}

/**
 * 便捷方法：发射歌单事件
 */
export const emitPlaylistSync = (change: SyncChangeType, source: 'local' | 'remote', data?: any) => {
  emitSyncEvent({ entity: 'playlist', change, source, data, timestamp: Date.now() })
}

/**
 * 便捷方法：发射播客收藏事件
 */
export const emitPodcastSync = (change: SyncChangeType, source: 'local' | 'remote', data?: any) => {
  emitSyncEvent({ entity: 'podcast', change, source, data, timestamp: Date.now() })
}

/**
 * 便捷方法：发射插件事件
 */
export const emitPluginSync = (change: SyncChangeType, source: 'local' | 'remote', data?: any) => {
  emitSyncEvent({ entity: 'plugin', change, source, data, timestamp: Date.now() })
}
