/**
 * 性能监控工具 - 用于验证 CPU 和内存优化效果
 * 
 * 使用方法：
 * import { startPerformanceMonitor, stopPerformanceMonitor, getPerformanceReport } from '@renderer/utils/performanceMonitor'
 * 
 * startPerformanceMonitor() // 开始监控
 * // ... 执行操作 ...
 * const report = getPerformanceReport() // 获取报告
 * stopPerformanceMonitor() // 停止监控
 */

interface PerformanceSnapshot {
  timestamp: number
  memory: {
    usedJSHeapSize: number
    totalJSHeapSize: number
    jsHeapSizeLimit: number
  } | null
  activeTimers: number
  activeIntervals: number
  activeAnimationFrames: number
  domNodes: number
  eventListeners: number
}

interface PerformanceReport {
  duration: number
  snapshots: PerformanceSnapshot[]
  summary: {
    avgMemory: number
    maxMemory: number
    memoryGrowth: number
    avgTimers: number
    maxTimers: number
    avgIntervals: number
    maxIntervals: number
    avgAnimationFrames: number
    maxAnimationFrames: number
    domNodeGrowth: number
  }
}

let monitorInterval: number | null = null
let snapshots: PerformanceSnapshot[] = []
let startTime: number = 0

// 计数器代理 - 用于追踪活跃的定时器和动画帧
const timerTracker = {
  timers: new Set<number>(),
  intervals: new Set<number>(),
  animationFrames: new Set<number>()
}

// 代理原生方法
const originalSetTimeout = window.setTimeout
const originalClearTimeout = window.clearTimeout
const originalSetInterval = window.setInterval
const originalClearInterval = window.clearInterval
const originalRequestAnimationFrame = window.requestAnimationFrame
const originalCancelAnimationFrame = window.cancelAnimationFrame

let isProxyInstalled = false

function installProxy() {
  if (isProxyInstalled) return
  isProxyInstalled = true

  window.setTimeout = function (...args: any[]) {
    const id = originalSetTimeout.apply(window, args as any)
    timerTracker.timers.add(id)
    return id
  } as any

  window.clearTimeout = function (id: number) {
    timerTracker.timers.delete(id)
    return originalClearTimeout.call(window, id)
  }

  window.setInterval = function (...args: any[]) {
    const id = originalSetInterval.apply(window, args as any)
    timerTracker.intervals.add(id)
    return id
  } as any

  window.clearInterval = function (id: number) {
    timerTracker.intervals.delete(id)
    return originalClearInterval.call(window, id)
  }

  window.requestAnimationFrame = function (callback: FrameRequestCallback) {
    const id = originalRequestAnimationFrame.call(window, (time) => {
      timerTracker.animationFrames.delete(id)
      callback(time)
    })
    timerTracker.animationFrames.add(id)
    return id
  }

  window.cancelAnimationFrame = function (id: number) {
    timerTracker.animationFrames.delete(id)
    return originalCancelAnimationFrame.call(window, id)
  }
}

function uninstallProxy() {
  if (!isProxyInstalled) return
  isProxyInstalled = false

  window.setTimeout = originalSetTimeout
  window.clearTimeout = originalClearTimeout
  window.setInterval = originalSetInterval
  window.clearInterval = originalClearInterval
  window.requestAnimationFrame = originalRequestAnimationFrame
  window.cancelAnimationFrame = originalCancelAnimationFrame
}

function captureSnapshot(): PerformanceSnapshot {
  const memory = (performance as any).memory
    ? {
        usedJSHeapSize: (performance as any).memory.usedJSHeapSize,
        totalJSHeapSize: (performance as any).memory.totalJSHeapSize,
        jsHeapSizeLimit: (performance as any).memory.jsHeapSizeLimit
      }
    : null

  return {
    timestamp: Date.now(),
    memory,
    activeTimers: timerTracker.timers.size,
    activeIntervals: timerTracker.intervals.size,
    activeAnimationFrames: timerTracker.animationFrames.size,
    domNodes: document.getElementsByTagName('*').length,
    eventListeners: 0 // 无法精确统计，浏览器不提供 API
  }
}

export function startPerformanceMonitor(intervalMs: number = 1000): void {
  if (monitorInterval !== null) {
    console.warn('Performance monitor already running')
    return
  }

  installProxy()
  snapshots = []
  startTime = Date.now()

  // 初始快照
  snapshots.push(captureSnapshot())

  // 定期快照
  monitorInterval = window.setInterval(() => {
    snapshots.push(captureSnapshot())
  }, intervalMs)

  console.log('🔍 Performance monitor started')
}

export function stopPerformanceMonitor(): void {
  if (monitorInterval !== null) {
    clearInterval(monitorInterval)
    monitorInterval = null
  }

  // 最终快照
  if (snapshots.length > 0) {
    snapshots.push(captureSnapshot())
  }

  uninstallProxy()

  console.log('🔍 Performance monitor stopped')
}

export function getPerformanceReport(): PerformanceReport {
  if (snapshots.length === 0) {
    throw new Error('No snapshots available. Start the monitor first.')
  }

  const duration = Date.now() - startTime

  // 计算统计数据
  const memoryValues = snapshots
    .map((s) => s.memory?.usedJSHeapSize || 0)
    .filter((v) => v > 0)

  const avgMemory = memoryValues.reduce((a, b) => a + b, 0) / memoryValues.length
  const maxMemory = Math.max(...memoryValues)
  const memoryGrowth = memoryValues.length > 1 ? memoryValues[memoryValues.length - 1] - memoryValues[0] : 0

  const timerValues = snapshots.map((s) => s.activeTimers)
  const avgTimers = timerValues.reduce((a, b) => a + b, 0) / timerValues.length
  const maxTimers = Math.max(...timerValues)

  const intervalValues = snapshots.map((s) => s.activeIntervals)
  const avgIntervals = intervalValues.reduce((a, b) => a + b, 0) / intervalValues.length
  const maxIntervals = Math.max(...intervalValues)

  const rafValues = snapshots.map((s) => s.activeAnimationFrames)
  const avgAnimationFrames = rafValues.reduce((a, b) => a + b, 0) / rafValues.length
  const maxAnimationFrames = Math.max(...rafValues)

  const domNodeGrowth =
    snapshots.length > 1 ? snapshots[snapshots.length - 1].domNodes - snapshots[0].domNodes : 0

  return {
    duration,
    snapshots,
    summary: {
      avgMemory,
      maxMemory,
      memoryGrowth,
      avgTimers,
      maxTimers,
      avgIntervals,
      maxIntervals,
      avgAnimationFrames,
      maxAnimationFrames,
      domNodeGrowth
    }
  }
}

export function printPerformanceReport(report?: PerformanceReport): void {
  const r = report || getPerformanceReport()

  console.log('📊 Performance Report')
  console.log('─────────────────────────────────────')
  console.log(`Duration: ${(r.duration / 1000).toFixed(2)}s`)
  console.log(`Snapshots: ${r.snapshots.length}`)
  console.log('')
  console.log('Memory:')
  console.log(`  Average: ${(r.summary.avgMemory / 1024 / 1024).toFixed(2)} MB`)
  console.log(`  Maximum: ${(r.summary.maxMemory / 1024 / 1024).toFixed(2)} MB`)
  console.log(`  Growth: ${(r.summary.memoryGrowth / 1024 / 1024).toFixed(2)} MB`)
  console.log('')
  console.log('Timers:')
  console.log(`  Average active: ${r.summary.avgTimers.toFixed(1)}`)
  console.log(`  Maximum active: ${r.summary.maxTimers}`)
  console.log('')
  console.log('Intervals:')
  console.log(`  Average active: ${r.summary.avgIntervals.toFixed(1)}`)
  console.log(`  Maximum active: ${r.summary.maxIntervals}`)
  console.log('')
  console.log('Animation Frames:')
  console.log(`  Average active: ${r.summary.avgAnimationFrames.toFixed(1)}`)
  console.log(`  Maximum active: ${r.summary.maxAnimationFrames}`)
  console.log('')
  console.log('DOM Nodes:')
  console.log(`  Growth: ${r.summary.domNodeGrowth}`)
  console.log('─────────────────────────────────────')
}

// 便捷方法：自动监控一段时间
export async function monitorForDuration(durationMs: number): Promise<PerformanceReport> {
  startPerformanceMonitor()
  await new Promise((resolve) => setTimeout(resolve, durationMs))
  stopPerformanceMonitor()
  const report = getPerformanceReport()
  printPerformanceReport(report)
  return report
}

// 导出到全局，方便在控制台使用
if (typeof window !== 'undefined') {
  ;(window as any).__performanceMonitor = {
    start: startPerformanceMonitor,
    stop: stopPerformanceMonitor,
    report: () => {
      const report = getPerformanceReport()
      printPerformanceReport(report)
      return report
    },
    monitor: monitorForDuration
  }
}
