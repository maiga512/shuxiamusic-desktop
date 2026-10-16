import { ref } from 'vue'

export const WELCOME_DISSOLVE_MS = 800
// 在 2.2s 启动序列结束前 0.8s 开始交叉溶解，让星空后段与主页首帧重叠。
export const WELCOME_TRANSITION_START_MS = 1400
export const welcomeTransitionActive = ref(false)
