import { ref } from 'vue'

// 与安卓 StartupPreloadOverlay 对齐：先在遮罩下挂主页，再由星空层自己淡出。
export const WELCOME_HOME_MOUNT_MS = 1200
export const WELCOME_MAIN_PREPARE_MS = 1000
export const WELCOME_DISSOLVE_MS = 560
export const WELCOME_OVERLAY_LINGER_MS = 90
export const WELCOME_MAX_READY_DELAY_MS = 1000
export const WELCOME_OVERLAY_LEAVE_MS =
  WELCOME_MAIN_PREPARE_MS + WELCOME_DISSOLVE_MS + WELCOME_OVERLAY_LINGER_MS
export const WELCOME_TRANSITION_MAX_LEAVE_MS =
  WELCOME_OVERLAY_LEAVE_MS + WELCOME_MAX_READY_DELAY_MS

export const welcomeTransitionActive = ref(false)
export const welcomeOverlayReleased = ref(false)

let timelineStartAt: number | null = null
let homeFirstFrameReadyAt: number | null = null
let readyWaiters: Array<() => void> = []

export function beginWelcomeTimeline(now = performance.now()) {
  timelineStartAt = now
  homeFirstFrameReadyAt = null
  readyWaiters = []
  welcomeOverlayReleased.value = false
}

export function getWelcomeTimelineStartedAt() {
  return timelineStartAt ?? performance.now()
}

export function waitForWelcomeHomeFirstFrameReady() {
  if (homeFirstFrameReadyAt !== null) return Promise.resolve()
  return new Promise<void>((resolve) => readyWaiters.push(resolve))
}

export function markWelcomeHomeFirstFrameReady(now = performance.now()) {
  if (timelineStartAt === null || homeFirstFrameReadyAt !== null) return
  homeFirstFrameReadyAt = now
  const waiters = readyWaiters
  readyWaiters = []
  for (const resolve of waiters) resolve()
}

export function scheduleWelcomeFade(
  startFade: (durationMs: number) => void,
  onFadeReleased: () => void
) {
  const startedAt = getWelcomeTimelineStartedAt()
  const earliestFadeAt =
    startedAt + WELCOME_HOME_MOUNT_MS + WELCOME_MAIN_PREPARE_MS
  const fadeAt =
    homeFirstFrameReadyAt === null
      ? earliestFadeAt
      : Math.max(earliestFadeAt, homeFirstFrameReadyAt)
  const delay = Math.max(0, fadeAt - performance.now())

  window.setTimeout(() => {
    startFade(WELCOME_DISSOLVE_MS)
    window.setTimeout(() => {
      welcomeOverlayReleased.value = true
      onFadeReleased()
    }, WELCOME_DISSOLVE_MS + WELCOME_OVERLAY_LINGER_MS)
  }, delay)
}

export function resetWelcomeTimeline() {
  timelineStartAt = null
  homeFirstFrameReadyAt = null
  const waiters = readyWaiters
  readyWaiters = []
  for (const resolve of waiters) resolve()
}
