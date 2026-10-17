import { ref } from 'vue'

// 与安卓 StartupPreloadOverlay 对齐：先在遮罩下挂主页，再由星空层自己淡出。
export const WELCOME_HOME_MOUNT_MS = 1200
// 主页首帧渲染准备窗口：对齐安卓 STARTUP_MAIN_PREPARE_AHEAD_MS=1000。
// 必须让主页在"星空还没化开"前就把首帧（发现页网格 + 封面 + 首屏数据）渲染完，
// 否则这波重渲染占住主线程，会把 Worker 画好的星空的"屏幕呈现"卡住 →
// 化开瞬间星空看起来冻结/停一下（用户看到的关键问题）。
export const WELCOME_MAIN_PREPARE_MS = 1000
// 化开时长：从 560ms 放宽到 700ms，让"星空一直播→自然融化进主页"，去掉播完后的停顿感。
export const WELCOME_DISSOLVE_MS = 700
export const WELCOME_OVERLAY_LINGER_MS = 90
export const WELCOME_OVERLAY_LEAVE_MS =
  WELCOME_MAIN_PREPARE_MS + WELCOME_DISSOLVE_MS + WELCOME_OVERLAY_LINGER_MS
// 恢复歌曲/起 mpv/拉封面是启动期最重的一波主线程负载。
// 现在遮罩是"不透明黑幕"（Worker 自己画），化开前完全盖住主页；
// 所以把这波最重的活放在主页刚挂载、黑幕还完全不透明的时刻跑，
// 全程被黑幕遮住，化开瞬间主页已就绪、不再出现"落地才卡一下"的停顿。
export const WELCOME_INIT_PLAYBACK_MS = WELCOME_HOME_MOUNT_MS

export const welcomeTransitionActive = ref(false)

let timelineStartAt: number | null = null

export function beginWelcomeTimeline(now = performance.now()) {
  timelineStartAt = now
}

export function getWelcomeTimelineStartedAt() {
  return timelineStartAt ?? performance.now()
}

export function scheduleWelcomeFade(startFade: (durationMs: number) => void) {
  const startedAt = getWelcomeTimelineStartedAt()
  const fadeAt = startedAt + WELCOME_HOME_MOUNT_MS + WELCOME_MAIN_PREPARE_MS
  const delay = Math.max(0, fadeAt - performance.now())

  window.setTimeout(() => {
    startFade(WELCOME_DISSOLVE_MS)
  }, delay)
}

// 把"恢复歌曲 + 起 mpv + 拉封面"这一波启动期最重的主线程负载，
// 延后到化开结束、主页已经露出之后再跑，让星空满屏播放那段时间主线程保持轻载。
export function scheduleInitPlayback(run: () => void) {
  const startedAt = getWelcomeTimelineStartedAt()
  const at = startedAt + WELCOME_INIT_PLAYBACK_MS
  const delay = Math.max(0, at - performance.now())
  window.setTimeout(run, delay)
}

export function resetWelcomeTimeline() {
  timelineStartAt = null
}
