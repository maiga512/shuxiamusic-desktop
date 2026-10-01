/**
 * 内存管理工具 - 状态感知的缓存清理，防止内存泄漏
 */

import { clearAmbientBackdropCache } from './color/bakedAmbientBackdrop'
import { deleteSessionCache } from './cache/sessionCache'

const MEMORY_CHECK_INTERVAL_MS = 3 * 60 * 1000 // 每 3 分钟检查一次
const IDLE_AGGRESSIVE_CLEAR_MS = 2 * 60 * 1000 // 空闲 2 分钟后激进清理
const PAUSED_MODERATE_CLEAR_MS = 5 * 60 * 1000 // 暂停 5 分钟后中度清理
const PLAYING_GENTLE_CLEAR_MS = 10 * 60 * 1000 // 播放中 10 分钟后温和清理

let lastClearTime = Date.now()
let lastPlaybackTime = Date.now()
let lastPauseTime = 0
let memoryCheckTimer: number | null = null
let currentPlayState: 'idle' | 'playing' | 'paused' = 'idle'

/**
 * 更新播放状态（由 App.vue 或 ControlAudio 调用）
 */
export function updatePlaybackState(state: 'idle' | 'playing' | 'paused') {
  const now = Date.now()
  const prev = currentPlayState
  currentPlayState = state
  
  if (state === 'playing') {
    lastPlaybackTime = now
  } else if (state === 'paused') {
    lastPauseTime = now
  }
  
  if (prev !== state) {
    console.log(`[MemoryManager] 播放状态变化: ${prev} → ${state}`)
  }
}

/**
 * 获取当前空闲时长
 */
function getIdleDuration(): number {
  const now = Date.now()
  if (currentPlayState === 'playing') return 0
  if (currentPlayState === 'paused') return now - lastPauseTime
  return now - Math.max(lastPlaybackTime, lastPauseTime)
}

/**
 * 清理过期缓存 - 根据播放状态分级清理
 */
export function clearExpiredCaches(aggressive = false) {
  const now = Date.now()
  const idleDuration = getIdleDuration()
  
  console.log(`[MemoryManager] 开始清理缓存 - 状态: ${currentPlayState}, 空闲: ${Math.round(idleDuration / 1000)}秒, 激进: ${aggressive}`)
  
  // 1. 总是清理会话缓存（最轻量）
  deleteSessionCache('discover:')
  deleteSessionCache('podcast:page:')
  deleteSessionCache('podcast:block:')
  
  // 2. 暂停或空闲时清理背景图缓存
  if (currentPlayState !== 'playing' || aggressive) {
    clearAmbientBackdropCache()
  }
  
  // 3. 激进模式：通知各模块清理内部缓存
  if (aggressive || idleDuration > IDLE_AGGRESSIVE_CLEAR_MS) {
    // 触发全局清理事件
    window.dispatchEvent(new CustomEvent('memory:aggressive-cleanup'))
    console.log('[MemoryManager] 已触发激进清理')
  }
  
  lastClearTime = now
}

/**
 * 内存检查循环
 */
function memoryCheckLoop() {
  const now = Date.now()
  const elapsed = now - lastClearTime
  const idleDuration = getIdleDuration()
  
  // 根据状态决定清理策略
  let shouldClear = false
  let aggressive = false
  
  if (currentPlayState === 'idle' && idleDuration > IDLE_AGGRESSIVE_CLEAR_MS) {
    shouldClear = true
    aggressive = true
  } else if (currentPlayState === 'paused' && elapsed > PAUSED_MODERATE_CLEAR_MS) {
    shouldClear = true
    aggressive = false
  } else if (currentPlayState === 'playing' && elapsed > PLAYING_GENTLE_CLEAR_MS) {
    shouldClear = true
    aggressive = false
  }
  
  if (shouldClear) {
    clearExpiredCaches(aggressive)
  }
}

/**
 * 启动内存监控
 */
export function startMemoryMonitoring() {
  if (memoryCheckTimer) return
  
  memoryCheckTimer = window.setInterval(memoryCheckLoop, MEMORY_CHECK_INTERVAL_MS)
  
  console.log('[MemoryManager] 内存监控已启动（状态感知模式）')
}

/**
 * 停止内存监控
 */
export function stopMemoryMonitoring() {
  if (memoryCheckTimer) {
    clearInterval(memoryCheckTimer)
    memoryCheckTimer = null
    console.log('[MemoryManager] 内存监控已停止')
  }
}

/**
 * 手动触发内存清理
 */
export function forceMemoryCleanup() {
  clearExpiredCaches(true)
  
  // 强制垃圾回收（如果可用）
  if (typeof (window as any).gc === 'function') {
    (window as any).gc()
    console.log('[MemoryManager] 已触发垃圾回收')
  }
}
