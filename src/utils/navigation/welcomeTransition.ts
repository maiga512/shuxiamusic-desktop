import { ref } from 'vue'

// 与安卓 StartupPreloadOverlay 对齐：先在遮罩下挂主页，再由星空层自己淡出。
export const WELCOME_HOME_MOUNT_MS = 1200
export const WELCOME_MAIN_PREPARE_MS = 500
export const WELCOME_DISSOLVE_MS = 560
export const WELCOME_OVERLAY_LINGER_MS = 90
export const WELCOME_OVERLAY_LEAVE_MS =
  WELCOME_MAIN_PREPARE_MS + WELCOME_DISSOLVE_MS + WELCOME_OVERLAY_LINGER_MS

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

export function resetWelcomeTimeline() {
  timelineStartAt = null
}
