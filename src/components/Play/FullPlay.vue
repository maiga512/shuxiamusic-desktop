<script lang="ts" setup>
// lyric-fonts.css 按需注入：打开全屏时加载，关闭后移除以释放 ~12MB 字体缓存
let _lyricFontLink: HTMLLinkElement | null = null
const ensureLyricFonts = () => {
  if (_lyricFontLink || typeof document === 'undefined') return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = new URL('@renderer/assets/lyric-fonts.css', import.meta.url).href
  document.head.appendChild(link)
  _lyricFontLink = link
}
const releaseLyricFonts = () => {
  if (!_lyricFontLink) return
  try { _lyricFontLink.remove() } catch {}
  _lyricFontLink = null
}
import type { LyricPlayerRef } from '@applemusic-like-lyrics/vue'
import type { SongList } from '@renderer/types/audio'
import { ref, computed, onMounted, onUnmounted, watch, reactive, onBeforeUnmount, nextTick, toRaw, defineAsyncComponent } from 'vue'
import { ControlAudioStore } from '@renderer/store/ControlAudio'
import { isNativePlaybackActive, nativeSeek } from '@renderer/utils/audio/nativePlayback'
import {
  Fullscreen1Icon,
  FullscreenExit1Icon,
  ChevronDownIcon,
  PenBallIcon
} from 'tdesign-icons-vue-next'
import { debounce } from 'lodash'
import { storeToRefs } from 'pinia'
import { useSettingsStore } from '@renderer/store/Settings'
import { useGlobalPlayStatusStore } from '@renderer/store/GlobalPlayStatus'
import { useDlnaStore } from '@renderer/store/dlna'
import { MessagePlugin } from 'tdesign-vue-next'

// 全局播放模式设置
import { usePlaySettingStore } from '@renderer/store'
import PlaySettings from './PlaySettings.vue'
import LyricAdapter from './Lyric/LyricAdapter.vue'
import CommentsOverlay from './CommentsOverlay.vue'
import LyricCopyOverlay from './LyricCopyOverlay.vue'
import ListenTogetherOverlay from './ListenTogetherOverlay.vue'
import LtDanmakuLayer from '@renderer/components/ListenTogether/LtDanmakuLayer.vue'
import { useLyricExtrasStore } from '@renderer/store/LyricExtras'
import { appWindowState, isAppWindowActive, isAppWindowVisible } from '@renderer/utils/appWindowState'
import DefaultCover from '@renderer/assets/images/Default.jpg'
import { clearAmbientBackdropCache } from '@renderer/utils/color/bakedAmbientBackdrop'
import { startWindowDrag } from '@renderer/utils/windowDrag'

const playSetting = usePlaySettingStore()
const settingsStore = useSettingsStore()
const dlnaStore = useDlnaStore()
const globalPlayStatus = useGlobalPlayStatusStore()
const { player } = storeToRefs(globalPlayStatus)
const lyricExtrasStore = useLyricExtrasStore()
const showSettings = ref(false)

const LyricPlayer = defineAsyncComponent(async () => {
  await import('@applemusic-like-lyrics/core/style.css')
  const mod = await import('@applemusic-like-lyrics/vue')
  return mod.LyricPlayer
})

const lyricFontSize = computed(() => {
  const rate = settingsStore.settings.FullPlayLyricFontRate || 1.0
  return `calc(min(clamp(30px, 2.5vw, 50px), 5vh) * ${rate})`
})
const lyricFontWeight = computed(() => settingsStore.settings.lyricFontWeight || 600)

const lyricFontFamily = computed(
  () => settingsStore.settings.lyricFontFamily || 'PingFangSC-Semibold'
)

const showLeftPanel = computed({
  get: () => playSetting.getShowLeftPanel,
  set: (val) => playSetting.setShowLeftPanel(val)
})

// 全屏播放手势：
// 双指左右滑 = 黑胶 / 方形封面
// 双指放大 = 进真正全屏，双指捏合 = 恢复窗口
type FullPlayGestureKind = 'layout' | 'panel' | 'fullscreen'
type SafariGestureEvent = Event & { scale?: number }

const gestureWheelState = {
  horizontal: 0,
  vertical: 0,
  lastDirection: 0,
  lastTriggeredAt: 0
}
const GESTURE_TRIGGER_DISTANCE = 48
const GESTURE_COOLDOWN_MS = 300
const PINCH_WHEEL_THRESHOLD = 92
const PINCH_SCALE_THRESHOLD = 0.14
const THREE_FINGER_TOUCH_DISTANCE = 72
const pinchWheelState = { acc: 0, lastDir: 0 }
const pinchScaleState = { start: 1, armed: false }
const threeFingerTouchState = {
  active: false,
  startX: 0,
  startY: 0,
  triggered: false
}

const resetGestureWheelState = () => {
  gestureWheelState.horizontal = 0
  gestureWheelState.vertical = 0
  gestureWheelState.lastDirection = 0
}

// 双指横滑"滑动段"状态：一次甩动只允许触发一次布局切换。
// 触控板甩动会带出数百 ms 的惯性 wheel 事件流，仅靠固定冷却挡不住
// 惯性 —— 惯性没停就会再次累计过阈值，造成"滑一下切好几下"。
// 按"段"处理：同方向累计位移，过阈值切一次并锁存(latched)；
// 锁存不随切换清除，减速衰减的惯性尾事件全部忽略。
// 重新武装（判定"又甩了一下"）满足其一：
//   1) 事件断流 > SWIPE_GAP_MS（惯性完全停住）；
//   2) 尾部已衰减到峰值 60% 以下且当前幅度回升到上一事件 1.4 倍
//      （新甩动会重新加速，惯性尾只会减速）。
// 误判重武装也无害：再触发仍需真实累计 48px 新位移。
const swipeState = {
  acc: 0,
  dir: 0,
  latched: false,
  lastEventAt: 0,
  // 触发瞬间的事件幅度，作为惯性尾衰减的参照
  peakDelta: 0,
  // 最近一个参与判定事件的幅度（惯性尾逐事件变小）
  lastDelta: 0
}
const SWIPE_GAP_MS = 180

const resetSwipeState = () => {
  swipeState.acc = 0
  swipeState.dir = 0
  swipeState.latched = false
  swipeState.lastEventAt = 0
  swipeState.peakDelta = 0
  swipeState.lastDelta = 0
}
const resetPinchState = () => {
  pinchWheelState.acc = 0
  pinchWheelState.lastDir = 0
  pinchScaleState.start = 1
  pinchScaleState.armed = false
}

const resetThreeFingerTouchState = () => {
  threeFingerTouchState.active = false
  threeFingerTouchState.startX = 0
  threeFingerTouchState.startY = 0
  threeFingerTouchState.triggered = false
}

const averageTouchPoint = (touches: TouchList) => {
  let x = 0
  let y = 0
  for (let i = 0; i < touches.length; i++) {
    x += touches[i].clientX
    y += touches[i].clientY
  }
  const count = Math.max(1, touches.length)
  return { x: x / count, y: y / count }
}

const isFullPlayGestureActive = () => props.show && isSlideOpen.value

const applyFullPlayGesture = (kind: FullPlayGestureKind, enter?: boolean) => {
  if (!isFullPlayGestureActive()) return false
  // 'layout' 已由滑动段锁存保证一次甩动只切一次；这里不再叠加固定冷却，
  // 否则快速连续的两次甩动(间隔 <300ms)会被误吞掉第二下。
  if (kind !== 'layout') {
    const now = performance.now()
    if (now - gestureWheelState.lastTriggeredAt < GESTURE_COOLDOWN_MS) return false
    gestureWheelState.lastTriggeredAt = now
  }
  if (kind === 'layout') {
    playSetting.setLayoutMode(playSetting.getLayoutMode === 'cd' ? 'cover' : 'cd')
  } else if (kind === 'panel') {
    playSetting.setShowLeftPanel(!playSetting.getShowLeftPanel)
  } else {
    // 方向式捏合：放大(enter=true)进全屏，捏合(enter=false)恢复。
    // 目标状态由 Rust 端窗口化全屏快照判断，避免动画期间状态滞后。
    window.api?.toggleFullscreen?.(enter)
  }
  // 'layout' 由滑动段锁存驱动：切换后不能清锁存，否则同一次甩动的惯性尾
  // 会重新累计过阈值再切（滑一下切好几下）。其他手势状态互清，防残留。
  if (kind !== 'layout') {
    resetGestureWheelState()
    resetSwipeState()
    resetPinchState()
    resetThreeFingerTouchState()
  }
  return true
}

const isGestureExcludedTarget = (target: EventTarget | null): boolean => {
  const element = target instanceof HTMLElement ? target : null
  return !!element?.closest(
    '.fullplay-drag-strip, button, input, textarea, select, [contenteditable="true"]'
  )
}

const onFullPlayWheel = (event: WheelEvent) => {
  if (!isFullPlayGestureActive() || isGestureExcludedTarget(event.target)) return

  // WKWebView 把双指捏合映射成 ctrl + wheel，用来切窗口全屏而不是页面缩放。
  if (event.ctrlKey) {
    event.preventDefault()
    const delta = event.deltaY || event.deltaX
    if (!delta) return
    const direction = delta > 0 ? 1 : -1
    if (pinchWheelState.lastDir && pinchWheelState.lastDir !== direction) {
      pinchWheelState.acc = 0
    }
    pinchWheelState.lastDir = direction
    pinchWheelState.acc += delta
    if (Math.abs(pinchWheelState.acc) < PINCH_WHEEL_THRESHOLD) return
    applyFullPlayGesture('fullscreen', delta < 0)
    return
  }

  // 滑动段锁存：一次甩动最多触发一次 layout 切换，惯性尾事件被忽略
  const now = performance.now()
  const absX = Math.abs(event.deltaX)
  const absY = Math.abs(event.deltaY)
  // 垂直占优时完全不干预，保留歌词上下滚动和系统行为。
  if (absY > absX * 1.15) {
    resetSwipeState()
    return
  }
  // 太小只当抖动忽略。
  if (absX < 8) return

  // 本段已切过一次（锁存中）：惯性尾默认忽略，识别出"又甩了一下"才重新武装。
  if (swipeState.latched) {
    const dt = swipeState.lastEventAt ? now - swipeState.lastEventAt : 0
    const freshBurst =
      dt > SWIPE_GAP_MS ||
      (swipeState.lastDelta > 0 &&
        swipeState.lastDelta < swipeState.peakDelta * 0.6 &&
        absX > swipeState.lastDelta * 1.4)
    if (!freshBurst) {
      swipeState.lastEventAt = now
      swipeState.lastDelta = absX
      return
    }
    resetSwipeState()
  }
  swipeState.lastEventAt = now
  swipeState.lastDelta = absX
  const direction = event.deltaX > 0 ? 1 : -1
  // 方向反转 = 上一段滑完了，按新方向重新累计（来回甩都各算一次）。
  if (swipeState.dir !== 0 && direction !== swipeState.dir) {
    swipeState.acc = 0
    swipeState.latched = false
  }
  swipeState.dir = direction
  swipeState.acc += event.deltaX

  // 本段已经切过一次 → 剩余的惯性事件全部忽略，保证"滑一下切一次"。
  if (swipeState.latched) return
  if (Math.abs(swipeState.acc) < GESTURE_TRIGGER_DISTANCE) return

  event.preventDefault()
  swipeState.latched = true
  swipeState.peakDelta = Math.max(absX, 16)
  applyFullPlayGesture('layout')
}

const onFullPlayGestureStart = (event: Event) => {
  if (!isFullPlayGestureActive()) return
  event.preventDefault()
  const scale = Number((event as SafariGestureEvent).scale || 1)
  pinchScaleState.start = Number.isFinite(scale) && scale > 0 ? scale : 1
  pinchScaleState.armed = true
}

const onFullPlayGestureChange = (event: Event) => {
  if (!isFullPlayGestureActive() || !pinchScaleState.armed) return
  event.preventDefault()
  const scale = Number((event as SafariGestureEvent).scale || 1)
  if (!Number.isFinite(scale) || scale <= 0) return
  const delta = scale - pinchScaleState.start
  if (Math.abs(delta) < PINCH_SCALE_THRESHOLD) return
  // 放大(scale 变大)= 进全屏，捏合(scale 变小)= 恢复。
  applyFullPlayGesture('fullscreen', delta > 0)
}

const onFullPlayGestureEnd = () => {
  pinchScaleState.armed = false
  pinchScaleState.start = 1
}

const onFullPlayTouchStart = (event: TouchEvent) => {
  if (!isFullPlayGestureActive() || isGestureExcludedTarget(event.target)) return
  if (event.touches.length !== 3) {
    resetThreeFingerTouchState()
    return
  }
  const point = averageTouchPoint(event.touches)
  threeFingerTouchState.active = true
  threeFingerTouchState.triggered = false
  threeFingerTouchState.startX = point.x
  threeFingerTouchState.startY = point.y
}

const onFullPlayTouchMove = (event: TouchEvent) => {
  if (!isFullPlayGestureActive() || !threeFingerTouchState.active || threeFingerTouchState.triggered) {
    return
  }
  if (event.touches.length !== 3) {
    resetThreeFingerTouchState()
    return
  }
  const point = averageTouchPoint(event.touches)
  const dx = point.x - threeFingerTouchState.startX
  const dy = point.y - threeFingerTouchState.startY
  if (Math.abs(dx) < THREE_FINGER_TOUCH_DISTANCE) return
  if (Math.abs(dx) <= Math.abs(dy) * 1.2) return
  event.preventDefault()
  threeFingerTouchState.triggered = true
  applyFullPlayGesture('panel')
}

const onFullPlayTouchEnd = (event: TouchEvent) => {
  if (event.touches.length < 3) resetThreeFingerTouchState()
}

const festivalOverlay = ref<HTMLDivElement | null>(null)
let fwCanvas: HTMLCanvasElement | null = null
let fwCtx: CanvasRenderingContext2D | null = null
let rafId: number | null = null
let loopId: number | null = null
let bursts: any[] = []
let particles: any[] = []
let lastTime = 0
let running = false
const showFestivalEffects = computed(
  () =>
    settingsStore.shouldUseSpringFestivalTheme() && !settingsStore.settings.springFestivalDisabled
)

const rnd = (min: number, max: number) => Math.random() * (max - min) + min
const pick = (arr: any[]) => arr[Math.floor(Math.random() * arr.length)]
const colors = ['#ff3b3b', '#ffd65a', '#ff7a00', '#ff2d55', '#ffe08a', '#fa383e', '#ff9f0a']

const resizeCanvas = () => {
  if (!fwCanvas || !festivalOverlay.value) return
  const rect = festivalOverlay.value.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio, 2)
  fwCanvas.width = Math.floor(rect.width * dpr)
  fwCanvas.height = Math.floor(rect.height * dpr)
}

const addBurst = (x: number, y: number) => {
  const c = pick(colors)
  const count = Math.floor(rnd(20, 40))
  for (let i = 0; i < count; i++) {
    const angle = rnd(0, Math.PI * 2)
    const speed = rnd(2, 6)
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: rnd(60, 120),
      color: c,
      alpha: 1,
      size: rnd(1, 2.8)
    })
  }
  if (particles.length > 1000) {
    particles.splice(0, particles.length - 1000)
  }
}

const scheduleBursts = (w: number, h: number) => {
  bursts.push({ t: 0, x: rnd(w * 0.15, w * 0.85), y: rnd(h * 0.15, h * 0.5) })
  bursts.push({ t: 400, x: rnd(w * 0.1, w * 0.9), y: rnd(h * 0.2, h * 0.6) })
  bursts.push({ t: 800, x: rnd(w * 0.2, w * 0.8), y: rnd(h * 0.15, h * 0.55) })
  bursts.push({ t: 1200, x: rnd(w * 0.25, w * 0.75), y: rnd(h * 0.1, h * 0.5) })
  bursts.push({ t: 1600, x: rnd(w * 0.2, w * 0.8), y: rnd(h * 0.15, h * 0.6) })
}

const step = (ts: number) => {
  if (!running || !isAppWindowActive()) {
    stopFireworks()
    return
  }
  if (!fwCtx || !fwCanvas) return
  const dt = ts - lastTime
  lastTime = ts
  fwCtx.globalCompositeOperation = 'source-over'
  fwCtx.fillStyle = 'rgba(0,0,0,0)'
  fwCtx.clearRect(0, 0, fwCanvas.width, fwCanvas.height)
  const g = 0.05
  const f = 0.985
  fwCtx.globalCompositeOperation = 'lighter'
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]
    p.vx *= f
    p.vy = p.vy * f + g
    p.x += p.vx
    p.y += p.vy
    p.life -= 1
    p.alpha = Math.max(0, p.life / 120)
    fwCtx.beginPath()
    fwCtx.fillStyle = p.color
    fwCtx.globalAlpha = p.alpha
    fwCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
    fwCtx.fill()
    if (p.life <= 0) particles.splice(i, 1)
  }
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i]
    b.t -= dt
    if (b.t <= 0) {
      addBurst(b.x, b.y)
      bursts.splice(i, 1)
    }
  }
  if (running) rafId = requestAnimationFrame(step)
}

const startFireworks = () => {
  if (running) return
  if (!isAppWindowActive()) return
  if (!festivalOverlay.value) return
  fwCanvas = document.createElement('canvas')
  fwCanvas.style.position = 'absolute'
  fwCanvas.style.top = '0'
  fwCanvas.style.left = '0'
  fwCanvas.style.width = '100%'
  fwCanvas.style.height = '100%'
  fwCanvas.style.zIndex = '0'
  fwCanvas.style.pointerEvents = 'none'
  festivalOverlay.value.appendChild(fwCanvas)
  fwCtx = fwCanvas.getContext('2d')
  resizeCanvas()
  particles = []
  bursts = []
  const w = fwCanvas.width
  const h = fwCanvas.height
  scheduleBursts(w, h)
  scheduleBursts(w, h)
  lastTime = performance.now()
  running = true
  rafId = requestAnimationFrame(step)
  loopId = window.setInterval(() => {
    if (!running || !fwCanvas) return
    const cw = fwCanvas.width
    const ch = fwCanvas.height
    scheduleBursts(cw, ch)
  }, 3500)
  window.setTimeout(() => stopFireworks(), 10000)
}

const stopFireworks = () => {
  running = false
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  if (loopId) {
    clearInterval(loopId)
    loopId = null
  }
  particles = []
  bursts = []
  if (fwCanvas && festivalOverlay.value) {
    festivalOverlay.value.removeChild(fwCanvas)
  }
  fwCanvas = null
  fwCtx = null
}

onMounted(() => {
  window.addEventListener('resize', resizeCanvas)
})

onUnmounted(() => {
  window.removeEventListener('resize', resizeCanvas)
  stopFireworks()
})
interface Props {
  show?: boolean
  showComments?: boolean
  /** 一起听浮层是否可见 —— 与 store.overlayVisible 双向绑定 */
  showListenTogether?: boolean
  coverImage?: string
  songId?: string | null
  songInfo: SongList | { songmid: number | null | string; lrc: string | null }
  mainColor: string
  disableAutoHide?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  show: false,
  showComments: false,
  showListenTogether: false,
  coverImage: '@assets/images/Default.jpg',
  songId: '',
  mainColor: '#rgb(0,0,0)',
  disableAutoHide: false
})
// 定义事件
const emit = defineEmits([
  'toggle-fullscreen',
  'idle-change',
  'update:showComments',
  'update:showListenTogether'
])

// 跟踪全屏状态
const isFullscreen = ref(false)

// 动画状态
const isAnimating = ref(false)
let animatingTimer: any = null

// 自动隐藏相关逻辑
const isIdle = ref(false)
const isHide = ref(false)
let idleTimer: any = null

const nudgeLyricPlayback = () => {
  if (!props.show) return
  const nowMs = Math.round((Audio.value.currentTime || 0) * 1000)
  state.currentTime = nowMs
  // AMLL 在布局抖动后偶发停更；强制 setCurrentTime(true) 拉回当前行。
  try {
    const player = (lyricPlayerRef.value as any)?.lyricPlayer
    if (player?.setCurrentTime) player.setCurrentTime(nowMs, true)
    if (isAudioPlaying.value) player?.resume?.()
  } catch {}
}

const resetIdleTimer = () => {
  // 如果当前为隐藏模式，则不自动清除
  if (isHide.value) return

  if (!playSetting.getAutoHideBottom) {
    isIdle.value = false
    emit('idle-change', false)
    return
  }

  // 外部要求禁用自动隐藏（例如更多菜单打开时）
  if (props.disableAutoHide) {
    if (idleTimer) clearTimeout(idleTimer)
    if (isIdle.value) {
      isIdle.value = false
      emit('idle-change', false)
      nudgeLyricPlayback()
    }
    return
  }

  // 恢复显示时
  if (isIdle.value) {
    isIdle.value = false
    emit('idle-change', false)
    nudgeLyricPlayback()
  }

  if (idleTimer) clearTimeout(idleTimer)

  if (props.show) {
    idleTimer = setTimeout(() => {
      if (
        props.show &&
        playSetting.getAutoHideBottom &&
        !showSettings.value &&
        !props.disableAutoHide
      ) {
        isIdle.value = true
        emit('idle-change', true)
      }
    }, 3000)
  }
}

let bindPointerDownTimer: ReturnType<typeof setTimeout> | null = null

const bindIdleActivityListeners = () => {
  unbindIdleActivityListeners()
  window.addEventListener('mousemove', resetIdleTimer)
  // 打开全屏的那次点击已经发生过 pointerdown。立刻监听会把同一击当成“操作”，
  // 极端情况下会把刚打开的全屏又切回去。
  bindPointerDownTimer = setTimeout(() => {
    bindPointerDownTimer = null
    window.addEventListener('pointerdown', resetIdleTimer, { passive: true })
  }, 400)
}

const unbindIdleActivityListeners = () => {
  if (bindPointerDownTimer !== null) {
    clearTimeout(bindPointerDownTimer)
    bindPointerDownTimer = null
  }
  window.removeEventListener('mousemove', resetIdleTimer)
  window.removeEventListener('pointerdown', resetIdleTimer)
}

const wakeFromIdle = () => {
  if (!props.show || isHide.value) return
  resetIdleTimer()
}

defineExpose({ wakeFromIdle })

watch(
  () => [props.show, showFestivalEffects.value],
  (vals) => {
    const visible = vals[0]
    const seasonal = vals[1]
    if (visible && seasonal && !running) startFireworks()
    if ((!visible || !seasonal) && running) stopFireworks()
  },
  { immediate: true }
)

const handleKeyDown = (e: { key: string; preventDefault: () => void }) => {
  if (e.key === 'F1') {
    e.preventDefault()
    // 切换隐藏状态
    isHide.value = !isHide.value
    // 隐藏界面
    isIdle.value = isHide.value
    emit('idle-change', isHide.value)
  }
}

watch(
  () => props.show,
  (val) => {
    // 触发动画状态
    isAnimating.value = true
    if (animatingTimer) clearTimeout(animatingTimer)
    animatingTimer = setTimeout(() => {
      isAnimating.value = false
    }, 350)

    if (val) {
      resetIdleTimer()
      bindIdleActivityListeners()
    } else {
      unbindIdleActivityListeners()
      if (idleTimer) clearTimeout(idleTimer)
      isIdle.value = false
      emit('idle-change', false)
    }
  },
  { immediate: true }
)

watch(
  () => playSetting.getAutoHideBottom,
  (val) => {
    if (!val) {
      if (idleTimer) clearTimeout(idleTimer)
      isIdle.value = false
      emit('idle-change', false)
    } else {
      resetIdleTimer()
    }
  }
)

watch(
  () => showSettings.value,
  (val) => {
    if (val) {
      // 打开设置时，取消自动隐藏
      if (idleTimer) clearTimeout(idleTimer)
      isIdle.value = false
      emit('idle-change', false)
    } else {
      resetIdleTimer()
    }
  }
)

watch(
  () => props.disableAutoHide,
  (val) => {
    if (val) {
      if (idleTimer) clearTimeout(idleTimer)
      if (isIdle.value) {
        isIdle.value = false
        emit('idle-change', false)
      }
    } else {
      resetIdleTimer()
    }
  }
)

// 切换全屏模式
const toggleFullscreen = () => {
  // 状态由主进程的 onFullscreenChanged 事件回写，避免双重 toggle
  window.api.toggleFullscreen()
}

// 监听窗口化全屏状态变化（来自主进程）
let unsubscribeFullscreen: (() => void) | null = null
onMounted(async () => {
  unsubscribeFullscreen = window.api.onFullscreenChanged((value: boolean) => {
    isFullscreen.value = value
  })
})

// removed redundant onBeforeUnmount

// 获取音频控制状态
const controlAudio = ControlAudioStore()
const { Audio } = storeToRefs(controlAudio)

// 响应式播放状态
const isAudioPlaying = ref(false)

// 更新播放状态的函数
const updatePlayState = () => {
  if (isNativePlaybackActive()) {
    isAudioPlaying.value = Audio.value.isPlay
  } else if (Audio.value.audio) {
    isAudioPlaying.value = !Audio.value.audio.paused
  } else {
    isAudioPlaying.value = Audio.value.isPlay
  }
}

// 监听音频播放状态变化
watch(
  () => Audio.value.isPlay,
  () => {
    if (isNativePlaybackActive()) updatePlayState()
  }
)

watch(
  () => Audio.value.audio,
  (newAudio, oldAudio) => {
    // 移除旧音频的事件监听器
    if (oldAudio) {
      oldAudio.removeEventListener('play', updatePlayState)
      oldAudio.removeEventListener('pause', updatePlayState)
    }

    // 添加新音频的事件监听器
    if (newAudio) {
      newAudio.addEventListener('play', updatePlayState)
      newAudio.addEventListener('pause', updatePlayState)
      // 初始化状态
      updatePlayState()
    }
  },
  { immediate: true }
)

// removed redundant onBeforeUnmount
// 组件内部状态
const state = reactive({
  audioUrl: Audio.value.url,
  albumUrl: props.coverImage,
  albumIsVideo: false,
  currentTime: 0,
  lowFreqVolume: 1.0
})

const lyricPlayerRef = ref<LyricPlayerRef | undefined>(undefined)

/**
 * 当前曲目歌词偏移(ms)。正值=歌词向"前"挪(更早出现);负值=向"后"挪。
 * effectiveLyricTime = state.currentTime + offset
 * (offset 通过 PlayMusic.vue 更多菜单 -> 歌词偏移 调节)
 *
 * 直接读 store.offsetMap (而不是调 store.getOffset(...)) —— Pinia setup-style store
 * 的 ref 字段被 computed 直接访问时,响应式追踪最可靠;函数调用偶尔会因 effect scope
 * 边界丢失订阅,导致切歌或刷新后看不到更新。
 *
 * map 的 value 现在是 `{ value, updatedAt }` 结构(为了 LRU/TTL),
 * 这里兼容旧的裸 number(冷启动从 localStorage 读到的历史数据)。
 */
const currentLyricOffset = computed(() => {
  const mid = (player.value.songInfo as any)?.songmid
  if (mid === null || mid === undefined || mid === '') return 0
  const raw = (lyricExtrasStore.offsetMap as Record<string, any>)[String(mid)]
  if (raw === undefined || raw === null) return 0
  if (typeof raw === 'number') return raw || 0
  return (raw.value as number) || 0
})
const effectiveLyricTime = computed(
  () => (Number(state.currentTime) || 0) + currentLyricOffset.value
)

// 订阅音频事件，保持数据同步
const unsubscribeTimeUpdate = ref<(() => void) | undefined>(undefined)
const unsubscribePlay = ref<(() => void) | undefined>(undefined)

// 计算实际的封面图片路径
const actualCoverImage = computed(() => {
  const src = player.value.cover || props.coverImage || ''
  if (!src || String(src).includes('Default.jpg')) return DefaultCover
  return src
})

const jumpTime = (e) => {
  if (dlnaStore.currentDevice) {
    MessagePlugin.warning('投屏模式下不支持拖拽进度')
    return
  }
  const next = e.line.getLine().startTime / 1000
  if (isNativePlaybackActive()) {
    void nativeSeek(next)
  } else if (Audio.value.audio) {
    Audio.value.audio.currentTime = next
  }
}
// 全屏背景只保留安卓横屏同款封面取色打光（.bg-backdrop，对齐 PlayerGpuBackdrop）。
// 用户明确不要 AMLL/PIXI 流光层盖住取色背景，因此这里不再创建 WebGL 背景。
const shouldRunBackground = () => props.show && isAppWindowVisible()

// 在全屏播放显示时阻止系统息屏
const blockerActive = ref(false)
let blockerTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => props.show,
  async (visible) => {
    try {
      if (blockerTimer !== null) {
        clearTimeout(blockerTimer)
        blockerTimer = null
      }
      if (visible) {
        // IPC + native work during the slide can steal a frame on macOS.
        blockerTimer = setTimeout(async () => {
          blockerTimer = null
          if (!props.show || blockerActive.value) return
          await (window as any)?.api?.powerSaveBlocker?.start?.()
          blockerActive.value = true
        }, 420)
      } else if (blockerActive.value) {
        await (window as any)?.api?.powerSaveBlocker?.stop?.()
        blockerActive.value = false
      }
    } catch (e) {
      console.error('powerSaveBlocker 切换失败:', e)
    }
    if (!visible) stopFireworks()
  },
  { immediate: true }
)

// 组件卸载前清理订阅
onBeforeUnmount(async () => {
  // 移除事件监听器
  unsubscribeFullscreen?.()
  unsubscribeFullscreen = null
  window.removeEventListener('gesturestart', onFullPlayGestureStart)
  window.removeEventListener('gesturechange', onFullPlayGestureChange)
  window.removeEventListener('gestureend', onFullPlayGestureEnd)
  unbindIdleActivityListeners()
  fullPlayRootRef.value?.removeEventListener('wheel', onFullPlayWheel)
  window.removeEventListener('resize', debouncedCheckOverflow)
  document.removeEventListener('click', handleClickOutside)

  if (idleTimer) clearTimeout(idleTimer)
  if (animatingTimer) clearTimeout(animatingTimer)
  if (blockerTimer !== null) clearTimeout(blockerTimer)
  if (resizeTimer !== null) clearTimeout(resizeTimer)
  if (bakeBackdropTimer !== null) {
    clearTimeout(bakeBackdropTimer)
    bakeBackdropTimer = null
  }
  if (clearInactiveBackdropTimer !== null) {
    clearTimeout(clearInactiveBackdropTimer)
    clearInactiveBackdropTimer = null
  }

  // 组件卸载时确保恢复系统息屏
  if (blockerActive.value) {
    try {
      await (window as any)?.api?.powerSaveBlocker?.stop?.()
    } catch {}
    blockerActive.value = false
  }
  // 取消订阅以防止内存泄漏
  if (unsubscribeTimeUpdate.value) {
    unsubscribeTimeUpdate.value()
  }
  if (unsubscribePlay.value) {
    unsubscribePlay.value()
  }
  if (Audio.value.audio) {
    Audio.value.audio.removeEventListener('play', updatePlayState)
    Audio.value.audio.removeEventListener('pause', updatePlayState)
  }
  releaseFullPlayHeavyResources({ unmountRoot: true })
})

// 监听音频URL变化
watch(
  () => Audio.value.url,
  (newUrl) => {
    state.audioUrl = newUrl
  }
)

// 监听当前播放时间变化
watch(
  () => Audio.value.currentTime,
  (newTime) => {
    if (!props.show) return
    state.currentTime = Math.round(newTime * 1000)
  }
)

// 处理低频音量更新
const handleLowFreqUpdate = (volume: number) => {
  state.lowFreqVolume = volume
  // console.log('lowFreqVolume', volume)
}

// 计算偏白的主题色
const lightMainColor = computed(() => {
  return player.value.coverDetail.lightMainColor || 'rgba(255, 255, 255, 0.9)'
})

const useBlackText = computed(() => {
  return player.value.coverDetail.useBlackText
})

// 安卓同款：切歌/改尺寸时把多层打光合并烘焙成一张 ≤720 图，播放中只贴图。
const activeLayer = ref<'A' | 'B'>('A')
const bakedBackdropKey = ref('')
const bgLayerA = ref('')
const bgLayerB = ref('')
// 安卓横屏 PlayerGpuBackdrop 同款：切歌/改尺寸时把多层打光烘焙成 CSS 渐变
//（stack 光斑组 + Overlay 柔光 + 黑色 Scrim），双层交替淡入实现切歌平滑过渡。
// baseColor 是渐变下方的纯色兜底层。
const bgOverlayA = ref('')
const bgOverlayB = ref('')
const bgBaseColorA = ref('')
const bgBaseColorB = ref('')
// Scrim（整体压黑 + 左右/上下黑渐变 + 径向暗角）是不依赖歌曲色的纯常量层，两层共享。
const backdropScrim = ref('')
let bakeBackdropTimer: ReturnType<typeof setTimeout> | null = null
let clearInactiveBackdropTimer: ReturnType<typeof setTimeout> | null = null
const fullPlayRootRef = ref<HTMLElement | null>(null)
watch(fullPlayRootRef, (node, prev) => {
  prev?.removeEventListener('wheel', onFullPlayWheel)
  node?.addEventListener('wheel', onFullPlayWheel, { passive: false })
})
const keepHeavyContent = ref(false)

const scheduleClearInactiveBackdrop = () => {
  if (clearInactiveBackdropTimer !== null) {
    clearTimeout(clearInactiveBackdropTimer)
  }
  clearInactiveBackdropTimer = setTimeout(() => {
    clearInactiveBackdropTimer = null
    if (activeLayer.value === 'A') bgLayerB.value = ''
    else bgLayerA.value = ''
    if (activeLayer.value === 'A') bgOverlayB.value = ''
    else bgOverlayA.value = ''
    if (activeLayer.value === 'A') bgBaseColorB.value = ''
    else bgBaseColorA.value = ''
  }, 900)
}

const isResizing = ref(false)
let resizeTimer: ReturnType<typeof setTimeout> | null = null
const handleBackdropResize = () => {
  // resize 期间隐藏 ShaderBackground，防止流光层闪帧
  isResizing.value = true
  if (resizeTimer !== null) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    isResizing.value = false
    resizeTimer = null
    // 窗口宽高变了，光斑半径(px) 需要按新宽度重算。
    if (keepHeavyContent.value && isAppWindowVisible()) scheduleBakeCurrentBackdrop(0)
  }, 150)
}

const fallbackBackdropColors = {
  main: { r: 42, g: 42, b: 46 },
  accent: { r: 72, g: 72, b: 78 },
  secondary: { r: 26, g: 26, b: 29 },
  base: { r: 18, g: 18, b: 20 }
}

const resolveBackdropStageSize = () => {
  const node = fullPlayRootRef.value
  const width = Math.max(1, Math.round(node?.clientWidth || window.innerWidth || 1280))
  const height = Math.max(1, Math.round(node?.clientHeight || window.innerHeight || 720))
  return { width, height }
}

// 安卓 hasArtwork：有真实封面时启用 art 光场（3 层光斑 + 方向雾），主光斑 alpha 系数也随其变化。
const hasBackdropArtwork = () => {
  const src = player.value.cover || props.coverImage || ''
  return !!src && !String(src).includes('Default.jpg')
}

// ---- 与安卓横屏背景 (PlayerGpuBackdrop 新版 + CoverColorUtils) 对齐的色阶推导 ----
// 注意：Mac 端 ColorObject 已走过 enhanceColor（src/utils/color/colorExtractor.ts，与安卓
// enhanceDesktopMainColor 同算法），直接当安卓 vibrant 用，不要再增强。
const WHITE_RGB = { r: 255, g: 255, b: 255 }

const scaleRgb = (c: { r: number; g: number; b: number }, f: number) => ({
  r: Math.max(0, Math.min(255, Math.round(c.r * f))),
  g: Math.max(0, Math.min(255, Math.round(c.g * f))),
  b: Math.max(0, Math.min(255, Math.round(c.b * f)))
})

const mixRgb = (
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  t: number
) => ({
  r: Math.round(a.r * (1 - t) + b.r * t),
  g: Math.round(a.g * (1 - t) + b.g * t),
  b: Math.round(a.b * (1 - t) + b.b * t)
})

const rgbStr = (c: { r: number; g: number; b: number }) => `rgb(${c.r},${c.g},${c.b})`
const rgbaStr = (c: { r: number; g: number; b: number }, a: number) => `rgba(${c.r},${c.g},${c.b},${a})`

// 安卓 boostForLightField：先按 lightness 向白色提亮，再按 saturation 把饱和度拉回（0..1 空间，clamp）
const boostForLightField = (
  c: { r: number; g: number; b: number },
  saturation: number,
  lightness: number
) => {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const safeMax = Math.max(r, g, b, 0.001)
  const out = (ch: number) => {
    const lifted = ch + (1 - ch) * Math.max(0, Math.min(1, lightness))
    const v = lifted + (ch / safeMax - lifted) * saturation
    return Math.round(Math.max(0, Math.min(1, v)) * 255)
  }
  return { r: out(r), g: out(g), b: out(b) }
}

const bakeCurrentBackdrop = () => {
  const { width, height } = resolveBackdropStageSize()
  const color = player.value.coverDetail.ColorObject
  // 安卓 CoverColorUtils.extractBackdropColors：vibrant 即增强后主色（Mac ColorObject 已增强过，不重复增强）；
  // 再推导 lightAccent=main.mix(white,0.80)、secondary/muted=main*0.35、base=main*0.18。
  const main = color || fallbackBackdropColors.main
  const accent = mixRgb(main, WHITE_RGB, 0.8) // 安卓 lightAccent
  const dark = scaleRgb(main, 0.35) // 安卓 secondary/muted
  const deep = scaleRgb(main, 0.18) // 安卓 base
  const hasArtwork = hasBackdropArtwork()
  // 安卓 CachedEnvironmentLayer 同款派生色与光斑系数（深色主题 themeScale=1）
  const brightMain = boostForLightField(main, 0.42, 0.2)
  const vividMain = boostForLightField(main, 0.64, 0.1)
  const brightAccent = boostForLightField(accent, 0.36, 0.3)
  const mutedMix = mixRgb(dark, main, 0.38)
  const alphaScale = hasArtwork ? 1 : 1.08
  const maxSide = Math.max(width, height)
  const px = (factor: number) => Math.round(maxSide * factor)

  const nextKey = `${main.r},${main.g},${main.b}:${width}x${height}:${hasArtwork ? 1 : 0}`
  if (nextKey === bakedBackdropKey.value) return
  bakedBackdropKey.value = nextKey

  // 安卓新版（BACKDROP_USE_BITMAP_CACHE=true）把光斑/方向雾/Overlay/Scrim 整组预光栅化成一张位图，
  // 每帧只贴图（省电、效果不减）；Mac 用同一策略：整组烤成一条静态 CSS 渐变（浏览器只合成一次）。
  // Compose 绘制顺序（下→上）：底渐变→右下/左上/左下主光斑→art 三层→方向雾三层；
  // CSS 列表第一个在最上层，因此整体倒序。
  const fogLayers = hasArtwork
    ? [
        `radial-gradient(circle ${px(0.72)}px at 50% 106%, ${rgbaStr(main, 0.12)} 0%, ${rgbaStr(accent, 0.06)} 44%, rgba(0,0,0,0) 84%)`,
        `radial-gradient(circle ${px(0.72)}px at 104% 58%, ${rgbaStr(mixRgb(main, WHITE_RGB, 0.12), 0.2)} 0%, ${rgbaStr(main, 0.09)} 46%, rgba(0,0,0,0) 86%)`,
        `radial-gradient(circle ${px(0.56)}px at -10% -5%, ${rgbaStr(WHITE_RGB, 0.08)} 0%, ${rgbaStr(mixRgb(accent, WHITE_RGB, 0.45), 0.035)} 42%, rgba(0,0,0,0) 82%)`
      ]
    : []
  const artLayers = hasArtwork
    ? [
        `radial-gradient(circle ${px(0.76)}px at 52% 98%, ${rgbaStr(mixRgb(main, WHITE_RGB, 0.16), 0.13)} 0%, ${rgbaStr(main, 0.07)} 42%, rgba(0,0,0,0) 76%)`,
        `radial-gradient(circle ${px(0.86)}px at 82% 70%, ${rgbaStr(main, 0.3)} 0%, ${rgbaStr(dark, 0.18)} 36%, rgba(0,0,0,0) 78%)`,
        `radial-gradient(circle ${px(0.74)}px at 18% 18%, ${rgbaStr(accent, 0.24)} 0%, ${rgbaStr(mutedMix, 0.16)} 30%, rgba(0,0,0,0) 72%)`
      ]
    : []
  // 主光斑三个椭圆：安卓是 drawCircle 再 y 轴压扁（0.42/0.34/0.12 maxSide），等价于 CSS ellipse
  const mainLightLayers = [
    `radial-gradient(ellipse ${px(0.32)}px ${px(0.12)}px at 8% 94%, ${rgbaStr(brightMain, 0.055 * alphaScale)} 0%, ${rgbaStr(accent, 0.032 * alphaScale)} 32%, rgba(0,0,0,0) 72%)`,
    `radial-gradient(ellipse ${px(0.48)}px ${px(0.34)}px at 16% 14%, ${rgbaStr(brightAccent, 0.92 * alphaScale)} 0%, ${rgbaStr(mixRgb(accent, WHITE_RGB, 0.18), 0.7 * alphaScale)} 28%, rgba(0,0,0,0) 64%)`,
    `radial-gradient(ellipse ${px(0.56)}px ${px(0.42)}px at 92% 82%, ${rgbaStr(vividMain, 0.94 * alphaScale)} 0%, ${rgbaStr(brightMain, 0.72 * alphaScale)} 28%, rgba(0,0,0,0) 68%)`
  ]
  const baseLayer = `linear-gradient(to bottom right, ${rgbStr(dark)} 0%, ${rgbStr(deep)} 100%)`
  const cssGradient = [...fogLayers, ...artLayers, ...mainLightLayers, baseLayer].join(', ')
  const cssBase = rgbStr(deep)
  // Overlay 混合白柔光两层：在安卓 scale(1.1) 组外用 BlendMode.Overlay 绘制 → CSS mix-blend-mode
  const cssOverlay = [
    `radial-gradient(circle ${px(0.572)}px at 74% 66%, ${rgbaStr(WHITE_RGB, 0.15)} 0%, rgba(0,0,0,0) 40%)`,
    `radial-gradient(circle ${px(0.52)}px at 22% 28%, ${rgbaStr(WHITE_RGB, 0.22)} 0%, rgba(0,0,0,0) 35%)`
  ].join(', ')
  // Scrim：安卓 DesktopEnvironmentScrim 四层压暗（平涂黑 0.256 用 background-color；径向/纵向/横向渐变
  // 按 CSS 顶层在前排列）。不依赖歌曲色，A/B 共享的常量层。
  backdropScrim.value = [
    `radial-gradient(circle ${Math.round(width * 1.02)}px at 48% 46%, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 66%, rgba(0,0,0,0.3) 100%)`,
    'linear-gradient(to bottom, rgba(255,255,255,0.012) 0%, rgba(0,0,0,0) 58%, rgba(0,0,0,0) 90%, rgba(0,0,0,0.3) 100%)',
    'linear-gradient(to right, rgba(0,0,0,0.03) 0%, rgba(0,0,0,0) 34%, rgba(0,0,0,0) 72%, rgba(0,0,0,0.12) 100%)'
  ].join(', ')

  if (!bgLayerA.value && !bgLayerB.value) {
    bgLayerA.value = cssGradient
    bgOverlayA.value = cssOverlay
    bgBaseColorA.value = cssBase
    activeLayer.value = 'A'
    return
  }
  if (activeLayer.value === 'A') {
    bgLayerB.value = cssGradient
    bgOverlayB.value = cssOverlay
    bgBaseColorB.value = cssBase
    activeLayer.value = 'B'
  } else {
    bgLayerA.value = cssGradient
    bgOverlayA.value = cssOverlay
    bgBaseColorA.value = cssBase
    activeLayer.value = 'A'
  }
  scheduleClearInactiveBackdrop()
}

const scheduleBakeCurrentBackdrop = (delay = 0) => {
  if (resizeTimer !== null) clearTimeout(resizeTimer)
  if (bakeBackdropTimer !== null) {
    clearTimeout(bakeBackdropTimer)
    bakeBackdropTimer = null
  }
  if (delay <= 0) {
    void nextTick(() => bakeCurrentBackdrop())
    return
  }
  bakeBackdropTimer = setTimeout(() => {
    bakeBackdropTimer = null
    bakeCurrentBackdrop()
  }, delay)
}

const backdropInputKey = computed(() => {
  const color = player.value.coverDetail.ColorObject || fallbackBackdropColors.main
  const light = player.value.coverDetail.lightMainColor || ''
  const song = player.value.songInfo as any
  return `${song?.source || ''}:${song?.songmid || song?.hash || ''}:${color.r},${color.g},${color.b}:${light}:${props.show ? 1 : 0}`
})

watch(
  backdropInputKey,
  () => {
    // 烘焙是一次性字符串计算（成本极低），暂停首开全屏也要有背景
    if (!keepHeavyContent.value || !isAppWindowVisible()) return
    scheduleBakeCurrentBackdrop(0)
  },
  { immediate: true }
)

// 计算歌词颜色
const lyricViewColor = computed(() => {
  return playSetting.getIsImmersiveLyricColor ? lightMainColor.value : 'rgba(255, 255, 255, 1)'
})

// const lyricHeight = computed(() => {
//   return playSetting.getisJumpLyric ? '100%' : '200%'
// })
// const lyricTranslateY = computed(() => {
//   return playSetting.getisJumpLyric ? '0' : '-25%'
// })

// --- 滚动文字逻辑 Start ---
const titleRef = ref<HTMLElement | null>(null)
const shouldScrollTitle = ref(false)
const titleContentRef = ref<HTMLElement | null>(null)

const songName = computed(() => {
  const info = player.value.songInfo
  if (info && 'name' in info && typeof info.name === 'string') {
    return info.name
  }
  return '未知歌曲'
})

const checkOverflow = async () => {
  await nextTick()

  // 检查标题
  if (titleRef.value && titleContentRef.value) {
    // 比较内容宽度（scrollWidth）和容器宽度（clientWidth）
    // 为了准确测量，暂时移除滚动相关的类可能会更准，但这里我们主要看 content 的自然宽度
    const containerWidth = titleRef.value.clientWidth
    const contentWidth = titleContentRef.value.offsetWidth
    shouldScrollTitle.value = contentWidth > containerWidth
  }
}

// 监听歌曲信息变化和窗口大小变化
watch(
  () => [props.songInfo, props.show],
  ([, visible]) => {
    if (visible) {
      setTimeout(checkOverflow, 380)
    } else {
      void checkOverflow()
    }
  },
  { immediate: true }
)


// 点击外部关闭设置面板
const floatActionRef = ref<HTMLElement | null>(null)
const handleClickOutside = (event: MouseEvent) => {
  if (
    showSettings.value &&
    floatActionRef.value &&
    !floatActionRef.value.contains(event.target as Node)
  ) {
    showSettings.value = false
  }
}

// --- 后台暂停动画逻辑 Start ---
const isAppActive = ref(isAppWindowActive())
const shouldRenderOverlays = computed(() => props.show && isAppActive.value)
// 全屏打开时页面动画降级只看窗口是否真的不可见，不看 focused。
// 失焦不等于关全屏；否则鼠标一晃就像歌词/特效被关掉了。
const isFullPlaySurfaceActive = computed(() => Boolean(props.show) && isAppWindowVisible())

const syncAppActiveState = () => {
  const active = isAppWindowActive()
  isAppActive.value = active
  if (!active || !shouldRunBackground()) {
    stopFireworks()
    return
  }
  if (showFestivalEffects.value && !running) {
    startFireworks()
  }
}

const handleBlur = syncAppActiveState
const handleFocus = syncAppActiveState
// --- 后台暂停动画逻辑 End ---

// 保存 debounce 函数引用以便后续移除
const debouncedCheckOverflow = debounce(checkOverflow, 200)

onMounted(() => {
  window.addEventListener('resize', debouncedCheckOverflow)
  window.addEventListener('resize', handleBackdropResize)
  document.addEventListener('click', handleClickOutside)
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('blur', handleBlur)
  window.addEventListener('focus', handleFocus)
  window.addEventListener('ceru-window-state-change', syncAppActiveState)
  window.addEventListener('ceru-window-state-change', onFullPlayWindowState)
  window.addEventListener('ceru-sleep', onFullPlayWindowState)
  window.addEventListener('ceru-wake', onFullPlayWindowState)
  // 初始检查
  setTimeout(checkOverflow, 500)
})

onUnmounted(() => {
  window.removeEventListener('resize', debouncedCheckOverflow)
  window.removeEventListener('resize', handleBackdropResize)
  document.removeEventListener('click', handleClickOutside)
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('blur', handleBlur)
  window.removeEventListener('focus', handleFocus)
  window.removeEventListener('ceru-window-state-change', syncAppActiveState)
  window.removeEventListener('ceru-window-state-change', onFullPlayWindowState)
  window.removeEventListener('ceru-sleep', onFullPlayWindowState)
  window.removeEventListener('ceru-wake', onFullPlayWindowState)
})
// removed redundant onBeforeUnmount
// --- 滚动文字逻辑 End ---

const blockFullPlayPointerEvents = (el: Element) => {
  const node = el as HTMLElement
  node.style.pointerEvents = 'none'
}

const allowFullPlayPointerEvents = (el: Element) => {
  const node = el as HTMLElement
  node.style.pointerEvents = 'auto'
}

const fullPlayMounted = ref(false)
const isSlideOpen = ref(false)
const isDormant = ref(true)
// 抽屉滑入过渡结束后才置 true：滑入期间关闭全屏 80px blur/黑胶滤镜/动画，
// 只让轻量的 transform 位移走 GPU 合成，避免重滤镜光栅化与位移抢帧导致掉帧。
const slideSettled = ref(false)
let settleTimer: ReturnType<typeof setTimeout> | null = null
let hideHeavyTimer: ReturnType<typeof setTimeout> | null = null

const shouldKeepHeavyContent = computed(() => props.show && isAppWindowVisible())

function releaseFullPlayHeavyResources(options?: { unmountRoot?: boolean }) {
  if (hideHeavyTimer !== null) {
    clearTimeout(hideHeavyTimer)
    hideHeavyTimer = null
  }
  if (settleTimer !== null) {
    clearTimeout(settleTimer)
    settleTimer = null
  }
  if (resizeTimer !== null) clearTimeout(resizeTimer)
  if (bakeBackdropTimer !== null) {
    clearTimeout(bakeBackdropTimer)
    bakeBackdropTimer = null
  }
  if (clearInactiveBackdropTimer !== null) {
    clearTimeout(clearInactiveBackdropTimer)
    clearInactiveBackdropTimer = null
  }
  try {
    lyricPlayerRef.value?.lyricPlayer?.dispose()
  } catch {}
  // 先清空歌词播放器 DOM 子树，帮助 WebKit 尽早回收
  try {
    const wrapper = (lyricPlayerRef.value?.wrapperEl as any)?.value
    if (wrapper) { wrapper.innerHTML = "" }
  } catch {}
  lyricPlayerRef.value = undefined
  festivalOverlay.value = null
  stopFireworks()
  bgLayerA.value = ''
  bgLayerB.value = ''
  bgOverlayA.value = ''
  bgOverlayB.value = ''
  bgBaseColorA.value = ''
  bgBaseColorB.value = ''
  backdropScrim.value = ''
  bakedBackdropKey.value = ''
  keepHeavyContent.value = false
  isDormant.value = true
  clearAmbientBackdropCache()
  releaseLyricFonts()
  if (options?.unmountRoot) {
    isSlideOpen.value = false
    slideSettled.value = false
    fullPlayMounted.value = false
  }
}

const openFullPlaySlide = async (instant = false) => {
  isDormant.value = instant
  ensureLyricFonts()
  keepHeavyContent.value = true
  fullPlayMounted.value = true
  if (settleTimer !== null) {
    clearTimeout(settleTimer)
    settleTimer = null
  }
  // instant(窗口恢复,无位移动画)直接判定就位;有动画时先关重滤镜,滑完再开。
  slideSettled.value = instant
  if (instant) isSlideOpen.value = true
  await nextTick()
  const node = fullPlayRootRef.value
  if (node) {
    void node.offsetHeight
    allowFullPlayPointerEvents(node)
  }
  if (!props.show || !isAppWindowVisible()) return
  isSlideOpen.value = true
  scheduleBakeCurrentBackdrop(0)
  nudgeLyricPlayback()
  if (instant) {
    await nextTick()
    isDormant.value = false
  } else {
    // 抽屉滑入过渡为 0.28s,结束后再启用全屏 80px blur/黑胶滤镜/动画
    settleTimer = setTimeout(() => {
      settleTimer = null
      if (props.show && isSlideOpen.value) slideSettled.value = true
    }, 300)
  }
}

const scheduleHideHeavyContent = () => {
  hideHeavyTimer = setTimeout(() => {
    hideHeavyTimer = null
    if (shouldKeepHeavyContent.value) return
    // 常驻预热:窗口仍可见时只休眠(dormant),保留已构建的歌词引擎/黑胶/背景,
    // 下次点开就是纯 transform 滑动、开场也不重建;仅在窗口最小化/切后台
    // (无人可见)时才彻底卸载,释放 GPU/内存。
    if (isAppWindowVisible()) {
      isDormant.value = true
      return
    }
    releaseFullPlayHeavyResources({ unmountRoot: true })
  }, 200)
}

const onFullPlayWindowState = () => {
  if (isAppWindowVisible()) {
    if (props.show && (!keepHeavyContent.value || !fullPlayMounted.value)) {
      void openFullPlaySlide(true)
    }
    return
  }
  releaseFullPlayHeavyResources({ unmountRoot: true })
}

watch(
  () => props.show,
  async (visible) => {
    if (hideHeavyTimer !== null) {
      clearTimeout(hideHeavyTimer)
      hideHeavyTimer = null
    }
    if (visible) {
      await openFullPlaySlide()
      window.addEventListener('gesturestart', onFullPlayGestureStart, { passive: false })
      window.addEventListener('gesturechange', onFullPlayGestureChange, { passive: false })
      window.addEventListener('gestureend', onFullPlayGestureEnd)
      return
    }

    isSlideOpen.value = false
    slideSettled.value = false
    window.removeEventListener('gesturestart', onFullPlayGestureStart)
    window.removeEventListener('gesturechange', onFullPlayGestureChange)
    window.removeEventListener('gestureend', onFullPlayGestureEnd)
    if (settleTimer !== null) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    const node = fullPlayRootRef.value
    if (node) blockFullPlayPointerEvents(node)
    scheduleHideHeavyContent()
  },
  { immediate: true }
)

</script>

<template>
  <div
    v-if="fullPlayMounted"
    ref="fullPlayRootRef"
    class="full-play"
    @gesturestart="onFullPlayGestureStart"
    @gesturechange="onFullPlayGestureChange"
    @gestureend="onFullPlayGestureEnd"
    @touchstart="onFullPlayTouchStart"
    @touchmove="onFullPlayTouchMove"
    @touchend="onFullPlayTouchEnd"
    :class="{
      'use-black-text': useBlackText,
      idle: isIdle,
      'is-open': isSlideOpen,
      settled: slideSettled,
      leaving: !props.show,
      dormant: isDormant,
      fullscreen: isFullscreen
    }"
  >
      <!-- 安卓横屏 PlayerGpuBackdrop（A1 单层贴图）同款：A/B 双层交替淡入光场渐变 + Overlay 柔光 + Scrim 压暗 -->
    <div
      class="bg-fallback bg-fallback-a"
      :class="{ active: activeLayer === 'A' }"
      :style="{ backgroundImage: bgLayerA || undefined, backgroundColor: bgBaseColorA || undefined }"
    ></div>
    <div
      class="bg-fallback bg-fallback-b"
      :class="{ active: activeLayer === 'B' }"
      :style="{ backgroundImage: bgLayerB || undefined, backgroundColor: bgBaseColorB || undefined }"
    ></div>
    <!-- Overlay 混合白柔光：在安卓 scale(1.1) 组外用 BlendMode.Overlay 单独绘制，随 A/B 一起淡入淡出 -->
    <div
      class="bg-fallback bg-overlay-a"
      :class="{ active: activeLayer === 'A' }"
      :style="{ backgroundImage: bgOverlayA || undefined }"
    ></div>
    <div
      class="bg-fallback bg-overlay-b"
      :class="{ active: activeLayer === 'B' }"
      :style="{ backgroundImage: bgOverlayB || undefined }"
    ></div>
    <!-- Scrim 常量压暗层：平涂黑 0.256 + 左右/上下黑渐变 + 径向暗角，切歌不变 -->
    <div class="bg-backdrop-scrim" :style="{ backgroundImage: backdropScrim || undefined }"></div>
    <!-- 着色器背景：受「播放背景动画」开关控制；暂停/收起全屏时组件内停 rAF，不卸 DOM -->
    <ShaderBackground
      v-if="keepHeavyContent && playSetting.getBgPlaying && !isResizing"
      :cover-image="actualCoverImage"
      :show="props.show && isSlideOpen && slideSettled"
    />
    <!-- 背景仅使用上方封面取色打光层，不再挂 PIXI 流光 -->
    <div v-if="keepHeavyContent && showFestivalEffects" ref="festivalOverlay" class="festival-overlay"></div>
    <!-- 全屏按钮 -->
    <button
      class="fullscreen-btn"
      :class="{ 'black-text': useBlackText }"
      @click.stop="toggleFullscreen"
      @mousedown.stop
    >
      <Fullscreen1Icon v-if="!isFullscreen" class="icon" />
      <FullscreenExit1Icon v-else class="icon" />
    </button>
    <button
      class="putawayscreen-btn"
      :class="{ 'black-text': useBlackText }"
      @click.stop="emit('toggle-fullscreen')"
      @mousedown.stop
    >
      <ChevronDownIcon class="icon" />
    </button>
    <!-- Tauri/WKWebView 不吃 -webkit-app-region；全屏页顶部单独留拖拽带。 -->
    <div
      class="fullplay-drag-strip"
      data-tauri-drag-region
      @mousedown="startWindowDrag"
      aria-hidden="true"
    ></div>
    <Transition name="fade-nav">
      <TitleBarControls
        v-if="props.show"
        class="top"
        :color="useBlackText ? 'black' : 'white'"
        :show-account="false"
      />
    </Transition>
    <div
      v-if="keepHeavyContent"
      class="playbox"
      :style="{
        padding:
          playSetting.getLayoutMode === 'cover' || !playSetting.getShowLeftPanel
            ? '0 min(4.5vw, 100px)'
            : '0 10vw'
      }"
      :class="{
        'mode-cover': playSetting.getLayoutMode === 'cover',
        'single-column': !showLeftPanel,
        'no-lyrics': player.lyrics.lines.length <= 0
      }"
    >
      <div
        class="left"
        :style="player.lyrics.lines.length <= 0 && showLeftPanel ? 'width:100vw' : ''"
      >
        <template v-if="playSetting.getLayoutMode === 'cd'">
          <img
            class="pointer"
            :class="{ playing: isAudioPlaying }"
            src="@renderer/assets/pointer.png"
            alt="pointer"
          />
          <div
            class="cd-container"
            :class="{ playing: isAudioPlaying }"
            :style="!isAudioPlaying ? 'animation-play-state: paused;' : ''"
          >
            <!-- 黑胶唱片 -->
            <div class="vinyl-record"></div>
            <!-- 唱片标签 -->
            <div class="vinyl-label">
              <s-image
                :key="`${(player.songInfo as any)?.source || ''}:${(player.songInfo as any)?.songmid || (player.songInfo as any)?.hash || songName}`"
                :src="actualCoverImage"
                shape="circle"
                class="cover"
              />
              <div class="label-shine"></div>
            </div>
            <!-- 中心孔 -->
            <div class="center-hole"></div>
          </div>
        </template>

        <template v-else-if="playSetting.getLayoutMode === 'cover'">
          <div class="cover-layout-container">
            <div class="cover-wrapper-square" :class="{ playing: controlAudio.Audio.isPlay }">
              <s-image
                :key="`${(player.songInfo as any)?.source || ''}:${(player.songInfo as any)?.songmid || (player.songInfo as any)?.hash || songName}`"
                :src="actualCoverImage"
                class="cover-img-square"
                shape="round"
                fit="cover"
              />
            </div>
            <div class="song-info-area">
              <div ref="titleRef" class="song-title-large text-scroll-container">
                <div class="text-scroll-wrapper" :class="{ 'animate-scroll': shouldScrollTitle }">
                  <div ref="titleContentRef" class="text-scroll-item">
                    {{ songName }}
                  </div>
                  <div v-if="shouldScrollTitle" class="text-scroll-item">
                    {{ songName }}
                  </div>
                </div>
              </div>
              <div class="song-meta-large">
                <span class="artist">{{ (player.songInfo as any)?.singer }}</span>
                <span
                  v-if="(player.songInfo as any)?.singer && (player.songInfo as any)?.albumName"
                  class="divider"
                >
                  /
                </span>
                <span class="album">{{ (player.songInfo as any)?.albumName }}</span>
              </div>
            </div>
          </div>
        </template>
      </div>
      <div
        v-if="player.lyrics.lines.length > 0"
        class="right"
        @contextmenu.prevent="lyricExtrasStore.openCopy()"
      >
        <component
          :is="playSetting.getUseAmlLyricRenderer ? LyricPlayer : LyricAdapter"
          ref="lyricPlayerRef"
          :lyric-lines="toRaw(player.lyrics.lines) || []"
          :current-time="effectiveLyricTime"
          :word-fade-width="0.5"
          :playing="isAudioPlaying && slideSettled"
          class="lyric-player"
          :align-position="
            playSetting.getLayoutMode === 'cd' && playSetting.getShowLeftPanel ? 0.5 : 0.34
          "
          :enable-blur="playSetting.getIsBlurLyric"
          :enable-spring="playSetting.getisJumpLyric"
          :enable-scale="playSetting.getisJumpLyric"
          :text-align="!playSetting.getShowLeftPanel ? 'center' : 'left'"
          :style="playSetting.getShowLeftPanel ? '' : 'text-align: center;'"
          @line-click="jumpTime"
        />
      </div>
    </div>
    <!-- 音频可视化组件 -->
    <div
      v-if="props.show && keepHeavyContent && coverImage && playSetting.getIsAudioVisualizer"
      class="audio-visualizer-container"
      :class="{ idle: isIdle }"
    >
      <AudioVisualizer
        :show="Audio.isPlay"
        :height="70"
        :bar-count="80"
        :color="mainColor"
        @low-freq-update="handleLowFreqUpdate"
      />
    </div>

    <div ref="floatActionRef" class="float-action" :class="{ idle: isIdle }">
      <t-Tooltip content="播放器主题" placement="bottom">
        <button class="skin-btn" @click="showSettings = !showSettings">
          <pen-ball-icon
            :fill-color="'transparent'"
            :stroke-color="'currentColor'"
            :stroke-width="2"
            :style="{ fontSize: '20px' }"
          />
        </button>
      </t-Tooltip>
      <Transition name="fade-up">
        <div v-if="showSettings" class="settings-panel">
          <PlaySettings />
        </div>
      </Transition>
    </div>
    <CommentsOverlay
      v-if="shouldRenderOverlays"
      :show="props.showComments"
      :main-color="lightMainColor"
      @close="emit('update:showComments', false)"
    />
    <!-- 歌词复制浮层 —— 右键歌词区域 / 更多菜单触发,样式与评论/一起听保持一致 -->
    <LyricCopyOverlay
      v-if="shouldRenderOverlays"
      :show="lyricExtrasStore.copyOverlayVisible"
      :lyric-lines="(player.lyrics.lines as any) || []"
      :song-title="player.songInfo?.name || ''"
      :artist="player.songInfo?.singer || ''"
      :main-color="lightMainColor"
      @close="lyricExtrasStore.closeCopy()"
    />
    <!-- 一起听浮层 —— 与 CommentsOverlay 平行的浮层，由 store.overlayVisible 控制 -->
    <ListenTogetherOverlay
      v-if="shouldRenderOverlays"
      :show="props.showListenTogether"
      :main-color="lightMainColor"
      @close="emit('update:showListenTogether', false)"
    />
    <!-- 一起听弹幕层 —— 房间内自动激活,房外什么都不渲染 -->
    <LtDanmakuLayer v-if="shouldRenderOverlays" />
  </div>
</template>

<style lang="scss" scoped>
.festival-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
}
.fullplay-drag-strip {
  position: absolute;
  top: 0;
  left: 0;
  /* 右上角留给 TitleBarControls，避免盖住设置/窗口按钮 */
  right: 13.5rem;
  height: 28px;
  z-index: 2;
  pointer-events: auto;
}
.fade-nav-enter-active,
.fade-nav-leave-active {
  transition: all 0.6s cubic-bezier(0.8, 0, 0.8, 0.43);
}

.fade-nav-enter-from,
.fade-nav-leave-to {
  opacity: 0;
}

.fullscreen-btn,
.putawayscreen-btn {
  position: absolute;

  -webkit-app-region: no-drag;
  top: 25px;
  left: 30px;
  padding: 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  // border: 1px solid rgba(255, 255, 255, 0.3);
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 100000;
  color: white;
  font-size: 18px;
  transition: all 0.3s ease;
  // box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);

  &:hover {
    background: rgba(255, 255, 255, 0.3);
    transform: scale(1.05);
  }

  &:active {
    transform: scale(0.95);
  }

  .icon {
    color: rgba(255, 255, 255, 0.6);
    width: 25px;
    height: 25px;
  }

  &.black-text {
    background: rgba(0, 0, 0, 0.1);

    .icon {
      color: rgba(0, 0, 0, 0.6);
    }

    &:hover {
      background: rgba(0, 0, 0, 0.2);
    }
  }
}

.putawayscreen-btn {
  left: 90px;
}

/* 安卓横屏 PlayerGpuBackdrop（A1 单层贴图）同款：封面取色烘焙渐变，双层交替实现切歌平滑过渡 */
.bg-fallback {
  position: absolute;
  inset: 0;
  z-index: 0;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  opacity: 0;
  transition: opacity 0.8s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
  contain: layout style;
  overflow: hidden;
  /* 安卓 scale(1.10, pivot=center) 组：整层略放大避开边缘硬边（Scrim/Overlay 不受影响） */
  transform: scale(1.1);
  transform-origin: center center;
}
.bg-fallback.active {
  opacity: 1;
}
/* Overlay 混合层：安卓在 scale 组外用 BlendMode.Overlay 画 → 不跟随缩放，用 mix-blend-mode 对齐 */
.bg-overlay-a,
.bg-overlay-b {
  transform: none;
  mix-blend-mode: overlay;
}
/* Scrim 常量压暗层（安卓 DesktopEnvironmentScrim）：平涂黑在 background-color，三层渐变由 JS 烤好 */
.bg-backdrop-scrim {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-color: rgba(0, 0, 0, 0.256);
  background-repeat: no-repeat;
}

.full-play {
  --height: calc(100dvh - var(--play-bottom-height));
  --text-color: rgba(255, 255, 255, 0.9);
  z-index: 120;
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100dvh;
  min-height: 100vh;
  border-radius: var(--app-window-radius, 22px);
  overflow: hidden; /* 裁掉 bg-fallback 的 blur 光晕外溢到主内容区 */
  /* 窗口化全屏：窗口已占满整块显示器（borderless），去掉窗口圆角否则四角露出桌面 */
  &.fullscreen {
    border-radius: 0;
  }
  background-clip: padding-box;
  pointer-events: none;
  overscroll-behavior: none;
  /* 抽屉滑入用 transform 位移,不要动画 top。
     top 每帧都触发布局+整块全屏重绘(内含 WebGL 背景/AMLL 歌词/黑胶),
     在 WKWebView 下必然掉帧;translateY 走 GPU 合成层,不触发布局与重绘。 */
  transform: translateY(100%);
  will-change: transform;
  transition: transform 0.28s cubic-bezier(0.8, 0, 0.8, 0.43);

  &.use-black-text {
    --text-color: rgba(255, 255, 255, 0.9);
  }

  &.is-open {
    transform: translateY(0);
    pointer-events: auto;
  }

  &.leaving,
  &:not(.is-open) {
    pointer-events: none !important;
  }

  &.leaving :deep(*),
  &:not(.is-open) :deep(*) {
    pointer-events: none !important;
  }

  &.leaving,
  &:not(.is-open),
  &.is-open:not(.settled) {
    .cd-container,
    .vinyl-record::after,
    .label-shine,
    .text-scroll-wrapper.animate-scroll {
      animation-play-state: paused !important;
    }
    .playbox {
      -webkit-drop-filter: none;
    }
    .cd-container {
      filter: none !important;
    }
  }

  &.dormant {
    visibility: hidden;
    .bg-fallback {
      opacity: 0 !important;
      transition-duration: 0s !important;
    }
  }
}

.full-play {
  &.idle {
    .playbox {
      cursor: none;
      .left,
      .right {
        margin-bottom: 0;
      }
      /* 不要在 idle 时改 lyric-player 高度。
         Tauri/WKWebView 下 AMLL 被 ResizeObserver 来回打会雾住、停滚，
         鼠标一移（退出 idle）反而更明显。 */
    }

    .fullscreen-btn,
    .putawayscreen-btn,
    .top {
      opacity: 0;
      pointer-events: none;
      transform: translateY(-100%);
    }
  }

  .top {
    position: absolute;
    width: calc(100% - 200px);
    z-index: 3;
    right: 0;
    padding: 30px 30px;
    padding-bottom: 10px;
    transition: all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .playbox {
    width: 100%;
    height: 100%;
    z-index: 0;
    background-color: rgba(0, 0, 0, 0.256);
    padding: 0 10vw;
    -webkit-drop-filter: blur(80px);
    overflow: hidden;
    display: flex;
    position: relative;
    --cd-width-auto: max(200px, min(27vw, 620px, calc(100vh - var(--play-bottom-height) - 230px)));

    &.no-lyrics {
      --cd-width-auto: max(260px, min(32vw, 720px, calc(100vh - var(--play-bottom-height) - 160px)));
    }

    .left {
      width: 40%;
      // max-width: 600px;
      transition: all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
      opacity: 1;
      transform: translateX(0);
    }

    .right {
      width: 60%;
      transition: width 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    .left {
      display: flex;
      justify-content: center;
      align-items: center;
      margin: 0 0 var(--play-bottom-height) 0;
      perspective: 1000px;

      .pointer {
        user-select: none;
        -webkit-user-drag: none;
        position: absolute;
        --pointer-width: calc(var(--cd-width-auto) / 3.5);
        width: var(--pointer-width);
        left: calc(50% - var(--pointer-width) * 0.1235);
        top: calc(50% - var(--cd-width-auto) / 2 - var(--pointer-width) * 0.8805);
        transform: rotate(-20deg);
        transform-origin: calc(var(--pointer-width) * 0.1235) calc(var(--pointer-width) * 0.1195);
        z-index: 2;
        transition: transform 0.3s;

        &.playing {
          transform: rotate(0deg);
        }
      }

      .cd-container {
        width: var(--cd-width-auto);
        height: var(--cd-width-auto);
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: rotateRecord 33s linear infinite;
        transition: filter 0.3s ease;
        filter: drop-shadow(0 15px 35px rgba(0, 0, 0, 0.6));

        &:hover {
          filter: drop-shadow(0 20px 45px rgba(0, 0, 0, 0.7));
        }

        /* 黑胶唱片主体 */
        .vinyl-record {
          aspect-ratio: 1/1;

          // margin-top: calc(var(--play-bottom-height) / 2);
          width: 100%;
          height: 100%;
          position: relative;
          border-radius: 50%;
          background: radial-gradient(circle at 50% 50%, #1a1a1a 0%, #0d0d0d 100%);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;

          /* 唱片纹理轨道 */
          &::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            border-radius: 50%;
            background:
              repeating-conic-gradient(
                from 0deg,
                transparent 0deg,
                rgba(255, 255, 255, 0.02) 0.5deg,
                transparent 1deg,
                rgba(255, 255, 255, 0.01) 1.5deg,
                transparent 2deg
              ),
              repeating-radial-gradient(
                circle at 50% 50%,
                transparent 0px,
                rgba(255, 255, 255, 0.03) 1px,
                transparent 2px,
                transparent 8px
              );
            z-index: 1;
          }

          /* 唱片光泽效果 */
          &::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: radial-gradient(
              ellipse at 30% 30%,
              rgba(255, 255, 255, 0.08) 0%,
              rgba(255, 255, 255, 0.04) 25%,
              rgba(255, 255, 255, 0.02) 50%,
              rgba(255, 255, 255, 0.01) 75%,
              transparent 100%
            );
            border-radius: 50%;
            z-index: 2;
            animation: vinylShine 8s ease-in-out infinite;
          }
        }

        /* 唱片标签区域 */
        .vinyl-label {
          position: absolute;
          width: 60%;
          height: 60%;
          background: radial-gradient(
            circle at 50% 50%,
            rgba(40, 40, 40, 0.95) 0%,
            rgba(25, 25, 25, 0.98) 70%,
            rgba(15, 15, 15, 1) 100%
          );
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 3;
          box-shadow:
            inset 0 0 20px rgba(0, 0, 0, 0.8),
            inset 0 0 0 1px rgba(255, 255, 255, 0.05),
            0 0 10px rgba(0, 0, 0, 0.5);

          :deep(.cover) {
            position: relative;
            z-index: 4;
            border-radius: 50%;
            overflow: hidden;
            box-shadow:
              0 0 20px rgba(0, 0, 0, 0.4),
              inset 0 0 0 2px rgba(255, 255, 255, 0.1);
            width: 95% !important;
            height: 95% !important;
            aspect-ratio: 1 / 1;

            img {
              user-select: none;
              -webkit-user-drag: none;
              border-radius: 50%;
              filter: brightness(0.85) contrast(1.15) saturate(1.1);
              width: 100% !important;
              height: 100% !important;
              object-fit: cover;
            }
          }

          /* 标签光泽 */
          .label-shine {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: radial-gradient(
              ellipse at 25% 25%,
              rgba(255, 255, 255, 0.1) 0%,
              transparent 50%
            );
            border-radius: 50%;
            z-index: 5;
            pointer-events: none;
            animation: labelShine 10s ease-in-out infinite;
          }
        }

        /* 中心孔 */
        .center-hole {
          position: absolute;
          width: 8%;
          height: 8%;
          background: radial-gradient(circle, #000 0%, #111 30%, #222 70%, #333 100%);
          border-radius: 50%;
          z-index: 10;
          box-shadow:
            inset 0 0 8px rgba(0, 0, 0, 0.9),
            0 0 3px rgba(0, 0, 0, 0.8);
        }
      }
    }

    .right {
      mask: linear-gradient(
        rgba(255, 255, 255, 0) 0px,
        rgba(255, 255, 255, 0.6) 5%,
        rgb(255, 255, 255) 15%,
        rgb(255, 255, 255) 75%,
        rgba(255, 255, 255, 0.6) 85%,
        rgba(255, 255, 255, 0)
      );

      :deep(.lyric-player) {
        height: calc(100vh - var(--play-bottom-height));
        transform: translateY(-80px);
        --amll-lyric-view-color: v-bind(lyricViewColor);
        --amll-lp-color: v-bind(lyricViewColor);
        --amll-lyric-player-font-size: v-bind(lyricFontSize);
        --amll-lp-font-size: v-bind(lyricFontSize);
        --amll-lyric-player-font-weight: v-bind(lyricFontWeight);
        --amll-lp-bg-line-scale: 0.7;
        font-family: v-bind(lyricFontFamily);

        [class*='romanWord'] {
          font-size: calc(var(--amll-lp-font-size) * 0.5);
          font-family: v-bind(lyricFontFamily) !important;
          opacity: 0.8;
        }

        [class*='lyricSubLine'] {
          font-weight: v-bind(lyricFontWeight) !important;
        }

        [class^='_interludeDots'] {
          // left: 1.2em;
          padding: auto;
          height: calc(var(--amll-lyric-player-font-size) + 1em);
          justify-content: center;
          align-items: center;
        }
        // & > div {
        //   padding-bottom: 0;
        //   overflow: hidden;
        //   transform: translateY(-20px);
        // }
      }

      padding: 0 20px;

      margin: 80px 0 calc(var(--play-bottom-height)) 0;
      overflow: hidden;
    }

    &.mode-cover {
      .left {
        width: 35%;
        padding: 0 3vw;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: flex-start;
      }
      .right {
        padding-left: 3vw;
        width: 65%;
      }
    }

    &.single-column {
      .left {
        width: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        opacity: 0;
        transform: translateX(-100px);
        pointer-events: none;
      }

      .right {
        width: 100%;
        padding: 0 10vw;
        display: flex;
        justify-content: center;

        :deep(.lyric-player) {
          width: 100%;
          max-width: 1000px;
          margin: 0 auto;
        }
      }
    }

    .cover-layout-container {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 40px;
      margin-top: calc(var(--play-bottom-height) / 2);
      max-height: calc(100vh - 200px);

      .cover-wrapper-square {
        width: 100%;
        max-width: min(580px, 55vh);
        aspect-ratio: 1/1;
        border-radius: 24px;
        overflow: hidden;
        box-shadow:
          0 25px 50px -12px rgba(0, 0, 0, 0.5),
          0 0 0 1px rgba(255, 255, 255, 0.1);
        transition: transform 0.44s cubic-bezier(0.44, 2, 0.64, 1);
        margin: 0 auto;
        transform: scale(0.8);

        &.playing {
          transform: scale(1);

          &:hover {
            transition: transform 0.2s;
            transform: scale(1.02);
          }
        }

        &:hover {
          transform: scale(0.82);
        }

        :deep(.cover-img-square) {
          width: 100%;
          height: 100%;
          object-fit: cover;
          user-select: none;
          img {
            -webkit-user-drag: none;

            user-select: none;
          }
        }
      }

      .song-info-area {
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 12px;

        .song-title-large {
          font-size: min(3vw, 42px);
          font-weight: 800;
          color: rgba(255, 255, 255, 0.95);
          line-height: 1.2;
          letter-spacing: -0.5px;
          /* display: -webkit-box; */
          /* -webkit-line-clamp: 2; */
          /* -webkit-box-orient: vertical; */
          /* overflow: hidden; */
          text-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);

          &.text-scroll-container {
            overflow: hidden;
            white-space: nowrap;
            position: relative;
            width: 100%;
          }

          .text-scroll-wrapper {
            display: inline-flex;
            &.animate-scroll {
              animation: scroll 15s linear infinite;
            }
          }

          .text-scroll-item {
            font-weight: 800;
            flex-shrink: 0;
            padding-right: 2rem;
            display: inline-block;
          }
        }

        .song-meta-large {
          font-size: min(1.5vw, 20px);
          color: rgba(255, 255, 255, 0.6);
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          opacity: 0.55;
          .artist {
            color: v-bind(lightMainColor);
            filter: brightness(1.2);
          }

          .divider {
            opacity: 0.4;
          }
        }

        .song-extra-info {
          margin-top: 8px;
        }
      }
    }
  }

  @keyframes scroll {
    0% {
      transform: translateX(0);
    }
    25% {
      transform: translateX(0);
    }
    100% {
      transform: translateX(-50%);
    }
  }

  .audio-visualizer-container {
    position: absolute;
    bottom: calc(var(--play-bottom-height) - 10px);
    z-index: 9999;
    left: 0;
    right: 0;
    height: 60px;
    // background: linear-gradient(to top, rgba(0, 0, 0, 0.3), transparent);
    filter: blur(6px);
    // max-width: 1000px;
    // -webkit-backdrop-filter: blur(10px);
    // border-top: 1px solid rgba(255, 255, 255, 0.1);
    z-index: 5;
    // padding: 0 20px;
    display: flex;
    align-items: center;
    transition: bottom 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
    &.idle {
      bottom: 0 !important;
    }
  }
}

.float-action {
  position: absolute;
  z-index: 5;
  transition:
    opacity 0.5s ease,
    transform 0.5s ease;
  &.idle {
    opacity: 0;
    transform: translateY(20px);
    pointer-events: none;
  }
  --bottom-height: 60px;
  right: 20px;
  bottom: calc(var(--bottom-height) + var(--play-bottom-height));
  .skin-btn {
    backdrop-filter: blur(15px);
    background: rgba(255, 255, 255, 0.15);
    // box-shadow:
    //   0 8px 32px 0 rgba(0, 0, 0, 0.1),
    //   0 0 20px v-bind(lightMainColor),
    //   inset 0 0 0 1px rgba(255, 255, 255, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.628);
    // border: none;
    height: 50px;
    width: 50px;
    border-radius: 50%;
    cursor: pointer;

    /* 弹性过渡效果 */
    transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);

    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(255, 255, 255, 0.9);
    font-size: 14px;
    font-weight: 500;
    letter-spacing: 1px;

    &:hover {
      // transform: translateY(-2px);
      background-color: rgba(255, 255, 255, 0.25);
      box-shadow:
        0 12px 40px 0 rgba(0, 0, 0, 0.15),
        0 0 30px v-bind(lightMainColor),
        inset 0 0 0 1px rgba(255, 255, 255, 0.4);
    }

    &:active {
      transform: translateY(1px) scale(0.92);
      box-shadow:
        0 4px 10px 0 rgba(0, 0, 0, 0.1),
        0 0 10px v-bind(lightMainColor),
        inset 0 0 0 1px rgba(255, 255, 255, 0.1);
      transition: all 0.1s ease;
    }
  }

  .settings-panel {
    max-height: calc(
      100vh - 40px - 2.25rem - 70px - calc(var(--bottom-height) + var(--play-bottom-height))
    );
    display: flex;
    flex-direction: column;
    position: absolute;
    bottom: 70px;
    right: 0;
    width: 340px;
    background: rgb(30 30 30 / 29%);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border-radius: 24px;
    padding: 20px;
    box-shadow:
      0 20px 50px rgba(0, 0, 0, 0.4),
      0 0 0 1px rgba(255, 255, 255, 0.1);
    transform-origin: bottom right;
    z-index: 100;
  }
}

.fade-up-enter-active,
.fade-up-leave-active {
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.fade-up-enter-from,
.fade-up-leave-to {
  opacity: 0;
  transform: translateY(20px) scale(0.95);
}

@keyframes rotateRecord {
  0% {
    transform: rotate(0deg);
  }

  100% {
    transform: rotate(360deg);
  }
}

@keyframes vinylShine {
  0% {
    opacity: 0.1;
    transform: rotate(0deg) scale(1);
  }

  50% {
    opacity: 0.2;
    transform: rotate(180deg) scale(1.1);
  }

  100% {
    opacity: 0.1;
    transform: rotate(360deg) scale(1);
  }
}

@keyframes labelShine {
  0% {
    opacity: 0.05;
    transform: rotate(0deg);
  }

  25% {
    opacity: 0.15;
  }

  50% {
    opacity: 0.1;
    transform: rotate(180deg);
  }

  75% {
    opacity: 0.15;
  }

  100% {
    opacity: 0.05;
    transform: rotate(360deg);
  }
}

/* 页面隐藏时激进的 GPU 降级：窗口最小化/后台时无人可见，停止一切昂贵的渲染操作 */
.full-play.page-hidden {
  /* 暂停所有 CSS 动画 */
  .cd-container,
  .vinyl-record::after,
  .label-shine,
  .text-scroll-wrapper.animate-scroll {
    animation-play-state: paused !important;
  }
  /* 移除最昂贵的全屏 drop-filter (blur 80px)，这是 #1 GPU 消耗 */
  .playbox {
    -webkit-drop-filter: none;
  }
  /* 移除黑胶唱片阴影滤镜 */
  .cd-container {
    filter: none !important;
  }
  /* 背面渐变切换瞬间完成 */
  .bg-fallback {
    transition-duration: 0s !important;
  }
}
</style>

<style lang="scss">
.full-play {
  /* 强制注入变量到歌词界面 */
  --user-lyric-fw: v-bind(lyricFontWeight) !important;

  .lyric-player {
    /* 暴力覆盖所有包含 Line 字样的类及其下的所有层级 */
    [class*='Line' i] {
      &,
      & *,
      span,
      div {
        font-weight: var(--user-lyric-fw) !important;
      }
    }

    /* 针对 romanWord 存在时可能产生的强调标签 */
    [class*='emphasize' i] {
      font-weight: var(--user-lyric-fw) !important;
    }

    /* 针对注音文字的大小和行高进行微调，防止字重增加后挤在一起 */
    [class*='romanWord' i] {
      font-size: 0.5em !important;
      font-weight: var(--user-lyric-fw) !important;
      line-height: 1 !important;
    }
  }
}
</style>
