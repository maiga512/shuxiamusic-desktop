import { ref } from 'vue'

// 与安卓 StartupPreloadOverlay 对齐：先在遮罩下挂主页，再由星空层自己淡出。
export const WELCOME_HOME_MOUNT_MS = 1200
export const WELCOME_MAIN_PREPARE_MS = 1000
export const WELCOME_DISSOLVE_MS = 560
export const WELCOME_OVERLAY_LINGER_MS = 90
export const WELCOME_OVERLAY_LEAVE_MS =
  WELCOME_MAIN_PREPARE_MS + WELCOME_DISSOLVE_MS + WELCOME_OVERLAY_LINGER_MS
export const welcomeTransitionActive = ref(false)
