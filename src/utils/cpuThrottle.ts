/**
 * CPU 节流工具 - 根据播放状态和窗口可见性智能停止高 CPU 消耗操作
 */

import { isAppWindowVisible } from './appWindowState'
import { isPageIdle } from './idleSleep'

type ThrottleState = 'idle' | 'paused' | 'playing'

let currentThrottleState: ThrottleState = 'idle'
let lastStateChangeTime = Date.now()

/**
 * 更新节流状态
 */
export function updateCpuThrottleState(state: ThrottleState) {
  if (currentThrottleState === state) return
  
  const now = Date.now()
  console.log(`[CpuThrottle] 状态变化: ${currentThrottleState} → ${state}`)
  currentThrottleState = state
  lastStateChangeTime = now
  
  // 通知所有监听器
  window.dispatchEvent(new CustomEvent('cpu:throttle-state-change', {
    detail: { state, timestamp: now }
  }))
}

/**
 * 获取当前节流状态
 */
export function getCpuThrottleState(): ThrottleState {
  return currentThrottleState
}

/**
 * 获取当前状态已持续时长
 */
export function getStateD