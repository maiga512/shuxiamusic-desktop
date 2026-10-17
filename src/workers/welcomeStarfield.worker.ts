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

type WorkerMessage =
  | {
      type: 'init'
      canvas: OffscreenCanvas
      width: number
      height: number
      dpr: number
    }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'start-fade'; durationMs: number }
  | { type: 'dispose' }

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

const stepZ = CFG.speed * 0.0008
const focalDepthScaled = CFG.focalDepth / 100
const starScale = CFG.starSize * 0.15
const turbulenceScaled = CFG.turbulence * 0.2
const glitter = CFG.glitter * 0.1
const brightnessScaled = Math.min(1, CFG.brightness / 100)
const trail = CFG.trail / 100

let output: OffscreenCanvas | null = null
let outputCtx: OffscreenCanvasRenderingContext2D | null = null
let scene: OffscreenCanvas | null = null
let sceneCtx: OffscreenCanvasRenderingContext2D | null = null
let width = 0
let height = 0
let dpr = 1
let stars: Star[] = []
let elapsed = 0
let lastFrameMs = 0
let fadeStartMs: number | null = null
let fadeDurationMs = 560
let timer = 0
let disposed = false

const rand = () => Math.random()

function resetStar(star: Star, initial: boolean) {
  const angle = rand() * Math.PI * 2
  const radius = (0.2 + rand() * 0.8) * (CFG.density / 15)
  star.x = Math.cos(angle) * radius
  star.y = Math.sin(angle) * radius
  star.z = initial ? rand() : 1
  star.px = NaN
  star.py = NaN
  star.seed = rand() * 1000
  star.vmul = 0.6 + rand() * 0.8
  star.flashUntil = 0
  star.nextFlash = elapsed + 1 + rand() * 4 * (1 / Math.max(0.0001, glitter))
}

function makeStars() {
  stars = Array.from({ length: CFG.particleCount }, () => ({
    x: 0,
    y: 0,
    z: 0,
    px: NaN,
    py: NaN,
    seed: 0,
    vmul: 1,
    flashUntil: 0,
    nextFlash: 0,
  }))
  for (const star of stars) resetStar(star, true)
}

function resize(nextWidth: number, nextHeight: number, nextDpr: number) {
  width = Math.max(1, nextWidth)
  height = Math.max(1, nextHeight)
  dpr = Math.min(2, Math.max(1, nextDpr))
  if (!output || !outputCtx || !scene || !sceneCtx) return

  const pixelWidth = Math.max(1, Math.round(width * dpr))
  const pixelHeight = Math.max(1, Math.round(height * dpr))
  output.width = pixelWidth
  output.height = pixelHeight
  scene.width = pixelWidth
  scene.height = pixelHeight
  sceneCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  sceneCtx.globalCompositeOperation = 'source-over'
  sceneCtx.clearRect(0, 0, width, height)
  for (const star of stars) {
    star.px = NaN
    star.py = NaN
  }
}

function drawStarfield(deltaSec: number, nowMs: number) {
  if (!sceneCtx || width <= 1 || height <= 1) return
  const dt = Math.max(0.001, Math.min(0.1, deltaSec)) * 60
  const keep = Math.pow(Math.min(0.98, Math.max(0, trail)), dt)
  const trailAlpha = Math.max(0.02, 1 - keep)
  // 化开进度 0→1。化开时让星点加速向外冲、散开（配合变透明），
  // 画面"融开、冲出去露出主页"，比单纯线性变透明的衔接更顺。
  const fp =
    fadeStartMs === null
      ? 0
      : Math.max(0, Math.min(1, (nowMs - fadeStartMs) / fadeDurationMs))
  const speedRamp = 1 + fp * 1.5

  sceneCtx.globalCompositeOperation = 'destination-out'
  sceneCtx.fillStyle = `rgba(0,0,0,${trailAlpha})`
  sceneCtx.fillRect(0, 0, width, height)
  sceneCtx.globalCompositeOperation = 'lighter'

  const cx = width / 2
  const cy = height / 2
  const projScale = Math.max(width, height) * 0.9
  const cullMargin = Math.max(40, starScale * 6)

  for (const star of stars) {
    star.z -= stepZ * speedRamp * star.vmul * dt
    if (star.z <= focalDepthScaled) {
      resetStar(star, false)
      continue
    }

    let tx = star.x
    let ty = star.y
    if (turbulenceScaled > 0) {
      const t = elapsed * 1.2 + star.seed
      const amp = turbulenceScaled * (1 - star.z) * 0.25
      tx += Math.sin(t + star.seed) * amp
      ty += Math.cos(t * 1.13 + star.seed * 0.7) * amp
    }

    const persp = focalDepthScaled / Math.max(star.z, 0.0001)
    const sx = cx + tx * persp * projScale
    const sy = cy + ty * persp * projScale
    if (sx < -cullMargin || sx > width + cullMargin || sy < -cullMargin || sy > height + cullMargin) {
      resetStar(star, false)
      continue
    }

    let flashMult = 1
    if (elapsed >= star.nextFlash && star.flashUntil < elapsed) {
      star.flashUntil = elapsed + 0.04 + rand() * 0.07
      star.nextFlash = elapsed + 1 + rand() * 4 * (1 / Math.max(0.0001, glitter))
    }
    if (elapsed <= star.flashUntil) flashMult = 1 + 2.5 * glitter

    const sizePersp = Math.min(2.5, (focalDepthScaled / Math.max(star.z, 0.0001)) * 0.6)
    const baseR = Math.max(0.25, starScale * (0.4 + sizePersp))
    const maxR = 1 + starScale * 2.5
    const r = Math.min(baseR * flashMult, maxR)
    const lifeT = 1 - star.z
    const alpha =
      Math.min(1, lifeT * 0.9 + 0.05) * brightnessScaled * (flashMult > 1 ? 1 : 0.85)

    if (!Number.isNaN(star.px) && !Number.isNaN(star.py)) {
      sceneCtx.strokeStyle = `rgba(255,255,255,${(alpha * 0.5).toFixed(3)})`
      sceneCtx.lineWidth = Math.max(0.4, r * 0.4)
      sceneCtx.lineCap = 'round'
      sceneCtx.beginPath()
      sceneCtx.moveTo(star.px, star.py)
      sceneCtx.lineTo(sx, sy)
      sceneCtx.stroke()
    }
    sceneCtx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`
    sceneCtx.fillRect(sx - r, sy - r, r * 2, r * 2)
    if (flashMult > 1) {
      const rf = Math.min(r * 1.4, maxR * 1.4)
      sceneCtx.fillStyle = `rgba(255,255,255,${(alpha * 0.5).toFixed(3)})`
      sceneCtx.fillRect(sx - rf, sy - rf, rf * 2, rf * 2)
    }
    star.px = sx
    star.py = sy
  }

  sceneCtx.globalCompositeOperation = 'source-over'
  elapsed += Math.max(0, Math.min(0.1, deltaSec))
}

function composite(nowMs: number) {
  if (!output || !outputCtx || !scene) return
  // 化开进度 0→1。未开始化开时 p=0（黑幕完全不透明，盖住主页）。
  const p =
    fadeStartMs === null
      ? 0
      : Math.max(0, Math.min(1, (nowMs - fadeStartMs) / fadeDurationMs))
  // 遮罩不透明度用 ease-in 揭示曲线 1 - p^2：
  // 开头缓（星空在黑色上慢慢"化开"，主页还几乎看不见）→
  // 结尾快（黑幕一次性掀开、主页一次到位），
  // 去掉线性淡出在结尾那段"几乎看不清变化"的拖尾停顿。
  const overlayAlpha = fadeStartMs === null ? 1 : 1 - p * p

  outputCtx.setTransform(1, 0, 0, 1, 0, 0)
  outputCtx.clearRect(0, 0, output.width, output.height)
  // 黑幕：与星空/标题共用同一条 alpha 曲线淡出。
  // 不透明时完全盖住主页，主页在"星空还没化开"前不可见
  // → 不再出现"主页已出来、字还飘着"的观感。
  outputCtx.globalAlpha = overlayAlpha
  outputCtx.fillStyle = '#000000'
  outputCtx.fillRect(0, 0, output.width, output.height)
  outputCtx.globalAlpha = overlayAlpha
  outputCtx.drawImage(scene, 0, 0)
  outputCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  // 标题：比黑幕更快化没（更陡幂次），化开时上移 + 放大"融化散开"，
  // 保证字先于主页完全露出之前化没。
  const melt = 1 - overlayAlpha
  const titleFade = Math.pow(overlayAlpha, 1.6)
  const titleDrift = melt * height * 0.05
  const titleSize = Math.min(width, height) * 0.062 * (1 + melt * 0.18)
  outputCtx.globalAlpha = titleFade
  outputCtx.fillStyle = 'rgba(255,255,255,0.92)'
  outputCtx.font = `600 ${titleSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif`
  outputCtx.textAlign = 'center'
  outputCtx.textBaseline = 'middle'
  outputCtx.shadowColor = 'rgba(0,0,0,0.6)'
  outputCtx.shadowBlur = 24
  outputCtx.shadowOffsetY = 2
  outputCtx.fillText('树夏music', width / 2, height / 2 - titleDrift)
  outputCtx.shadowColor = 'transparent'
  outputCtx.shadowBlur = 0
  outputCtx.shadowOffsetY = 0
  outputCtx.globalAlpha = 1
}

function renderLoop() {
  if (disposed) return
  const nowMs = performance.now()
  const deltaSec = lastFrameMs === 0 ? 1 / 60 : (nowMs - lastFrameMs) / 1000
  lastFrameMs = nowMs
  drawStarfield(deltaSec, nowMs)
  composite(nowMs)
  timer = self.setTimeout(renderLoop, 16)
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data
  if (message.type === 'init') {
    output = message.canvas
    outputCtx = output.getContext('2d', { alpha: true })
    scene = new OffscreenCanvas(1, 1)
    sceneCtx = scene.getContext('2d', { alpha: true })
    makeStars()
    resize(message.width, message.height, message.dpr)
    if (!disposed && !timer) renderLoop()
    return
  }
  if (message.type === 'resize') {
    resize(message.width, message.height, message.dpr)
    return
  }
  if (message.type === 'start-fade') {
    if (fadeStartMs === null) {
      fadeDurationMs = Math.max(1, message.durationMs)
      fadeStartMs = performance.now()
    }
    return
  }
  if (message.type === 'dispose') {
    disposed = true
    self.clearTimeout(timer)
    timer = 0
    output = null
    outputCtx = null
    scene = null
    sceneCtx = null
  }
}
