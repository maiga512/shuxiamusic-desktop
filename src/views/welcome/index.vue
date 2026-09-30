<template>
  <div class="splash-root">
    <canvas ref="canvasRef" class="splash-canvas"></canvas>
    <div class="splash-title">树夏Music</div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { initPlayback } from '@renderer/utils/audio/globaPlayList'

const router = useRouter()
const canvasRef = ref<HTMLCanvasElement | null>(null)

// ── 启动动画：移植自安卓端 GlitterWrap 星空穿梭（GlitterWrapBackdrop.kt）──
// 参数与安卓启动遮罩 StartupPreloadOverlay 完全一致：
// particleCount 150 / speed 5.2 / density 96 / starSize 20 / focalDepth 5 /
// turbulence 3.6 / brightness 100 / glitter 4.5 / trails 42 / reverse false。
const STARTUP_MIN_MS = 2000
const CFG = {
  particleCount: 150,
  speed: 5.2,
  density: 96,
  starSize: 20,
  focalDepth: 5,
  turbulence: 3.6,
  brightness: 100,
  glitter: 4.5,
  trail: 42,
}

// configure() 中的派生值（见 Kotlin GlitterWrapEngine.configure）
const stepZ = CFG.speed * 0.0008
const focalDepthScaled = CFG.focalDepth / 100
const starScale = CFG.starSize * 0.15
const turbulenceScaled = CFG.turbulence * 0.2
const glitter = CFG.glitter * 0.1
const brightnessScaled = Math.min(1, CFG.brightness / 100)
const trail = CFG.trail / 100

type Star = {
  x: number
  y: number
  z: number
  px: number
  py: number
  seed: number
  vmul: number
  flashUntil: number
  nextFlash: number
}

let rafId = 0
let stars: Star[] = []
let elapsed = 0
let lastTs = 0
let disposed = false

const rand = () => Math.random()

function resetStar(s: Star, initial: boolean) {
  const angle = rand() * Math.PI * 2
  const radius = (0.2 + rand() * 0.8) * (CFG.density / 15)
  s.x = Math.cos(angle) * radius
  s.y = Math.sin(angle) * radius
  s.z = initial ? rand() : 1
  s.px = NaN
  s.py = NaN
  s.seed = rand() * 1000
  s.vmul = 0.6 + rand() * 0.8
  s.flashUntil = 0
  s.nextFlash = elapsed + 1 + rand() * 4 * (1 / Math.max(0.0001, glitter))
}

function makeStars() {
  stars = []
  for (let i = 0; i < CFG.particleCount; i++) {
    const s: Star = {
      x: 0, y: 0, z: 0, px: NaN, py: NaN, seed: 0, vmul: 1, flashUntil: 0, nextFlash: 0,
    }
    resetStar(s, true)
    stars.push(s)
  }
}

onMounted(() => {
  const canvas = canvasRef.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) {
    void bootThenEnter()
    return
  }

  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  let w = 0
  let h = 0
  const resize = () => {
    w = window.innerWidth
    h = window.innerHeight
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.max(1, Math.round(h * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, w, h)
  }
  resize()
  makeStars()

  const reduced =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const frame = (deltaSec: number) => {
    if (w <= 1 || h <= 1) return
    const dt = Math.max(0.001, Math.min(0.1, deltaSec)) * 60
    const keep = Math.pow(Math.min(0.98, Math.max(0, trail)), dt)
    const trailAlpha = Math.max(0.02, 1 - keep)
    // 拖尾：用半透明黑覆盖上一帧（等价于安卓 DST_OUT 淡出）
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = `rgba(0,0,0,${trailAlpha})`
    ctx.fillRect(0, 0, w, h)
    // 星点叠加（等价于安卓 PorterDuff.ADD）
    ctx.globalCompositeOperation = 'lighter'

    const cx = w / 2
    const cy = h / 2
    const projScale = Math.max(w, h) * 0.9
    const focalDepth = focalDepthScaled
    const cullMargin = Math.max(40, starScale * 6)

    for (const s of stars) {
      s.z -= stepZ * s.vmul * dt
      if (s.z <= focalDepth) {
        resetStar(s, false)
        continue
      }
      let tx = s.x
      let ty = s.y
      if (turbulenceScaled > 0) {
        const t = elapsed * 1.2 + s.seed
        const amp = turbulenceScaled * (1 - s.z) * 0.25
        tx += Math.sin(t + s.seed) * amp
        ty += Math.cos(t * 1.13 + s.seed * 0.7) * amp
      }
      const persp = focalDepth / Math.max(s.z, 0.0001)
      const sx = cx + tx * persp * projScale
      const sy = cy + ty * persp * projScale
      if (sx < -cullMargin || sx > w + cullMargin || sy < -cullMargin || sy > h + cullMargin) {
        resetStar(s, false)
        continue
      }
      let flashMult = 1
      if (glitter > 0) {
        if (elapsed >= s.nextFlash && s.flashUntil < elapsed) {
          s.flashUntil = elapsed + 0.04 + rand() * 0.07
          s.nextFlash = elapsed + 1 + rand() * 4 * (1 / Math.max(0.0001, glitter))
        }
        if (elapsed <= s.flashUntil) flashMult = 1 + 2.5 * glitter
      }
      const sizePersp = Math.min(2.5, (focalDepth / Math.max(s.z, 0.0001)) * 0.6)
      const baseR = Math.max(0.25, starScale * (0.4 + sizePersp))
      const maxR = 1 + starScale * 2.5
      const r = Math.min(baseR * flashMult, maxR)
      const lifeT = 1 - s.z
      const a =
        Math.min(1, lifeT * 0.9 + 0.05) * brightnessScaled * (flashMult > 1 ? 1 : 0.85)

      if (!Number.isNaN(s.px) && !Number.isNaN(s.py)) {
        ctx.strokeStyle = `rgba(255,255,255,${(a * 0.5).toFixed(3)})`
        ctx.lineWidth = Math.max(0.4, r * 0.4)
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(s.px, s.py)
        ctx.lineTo(sx, sy)
        ctx.stroke()
      }
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`
      ctx.fillRect(sx - r, sy - r, r * 2, r * 2)
      if (flashMult > 1) {
        const rf = Math.min(r * 1.4, maxR * 1.4)
        ctx.fillStyle = `rgba(255,255,255,${(a * 0.5).toFixed(3)})`
        ctx.fillRect(sx - rf, sy - rf, rf * 2, rf * 2)
      }
      s.px = sx
      s.py = sy
    }
    ctx.globalCompositeOperation = 'source-over'
    elapsed += Math.max(0, Math.min(0.1, deltaSec))
  }

  const loop = (ts: number) => {
    if (disposed) return
    const deltaSec = lastTs === 0 ? 1 / 60 : Math.min(0.1, Math.max(0.001, (ts - lastTs) / 1000))
    lastTs = ts
    frame(deltaSec)
    rafId = requestAnimationFrame(loop)
  }

  if (reduced) {
    // 尊重"减少动效"：预热几十帧成静态星场后停住
    for (let i = 0; i < 80; i++) frame(1 / 60)
  } else {
    rafId = requestAnimationFrame(loop)
  }

  window.addEventListener('resize', resize)
  ;(canvas as any).__ceruResize = resize

  void bootThenEnter()
})

let entered = false
async function bootThenEnter() {
  if (entered) return
  const startAt = Date.now()
  // 插件系统仍在欢迎页预热，但播放恢复必须等正式界面挂载后再开始。
  try {
    await window.electron?.ipcRenderer?.invoke?.('service-plugin-initialize-system')
  } catch (e) {
    console.warn('[welcome] plugin init failed', e)
  }

  const wait = Math.max(0, STARTUP_MIN_MS - (Date.now() - startAt))
  await new Promise<void>((resolve) => window.setTimeout(resolve, wait))
  if (entered) return
  entered = true
  await router.replace('/home')
  // router.replace 完成后 GlobalAudio/Provider 已经在正式页面链路中挂载，
  // 此时才允许恢复 URL 和自动播放，避免欢迎动画阶段先出声再被路由打断。
  try {
    await initPlayback()
  } catch (e) {
    console.error('[welcome] initPlayback failed', e)
  }
}

onUnmounted(() => {
  disposed = true
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  const canvas = canvasRef.value as any
  if (canvas?.__ceruResize) {
    window.removeEventListener('resize', canvas.__ceruResize)
    canvas.__ceruResize = null
  }
})
</script>

<style scoped>
.splash-root {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  background: #000000;
  overflow: hidden;
  z-index: 10;
}

.splash-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

/* 居中标题，白色，字号 = min(视口宽,高) * 0.062，与安卓 titlePaint 一致 */
.splash-title {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: rgba(255, 255, 255, 0.92);
  font-size: calc(min(100vw, 100vh) * 0.062);
  font-weight: 600;
  letter-spacing: 0.06em;
  line-height: 1;
  white-space: nowrap;
  user-select: none;
  pointer-events: none;
  font-family:
    -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', Roboto, 'Helvetica Neue',
    Arial, sans-serif;
  text-shadow: 0 2px 24px rgba(0, 0, 0, 0.6);
}

@media (prefers-reduced-motion: reduce) {
  .splash-title {
    transition: none;
  }
}
</style>
