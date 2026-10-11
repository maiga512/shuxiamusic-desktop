/**
 * 安卓 PlayerGpuBackdrop 的桌面平替：
 * 切歌时把多层取色打光合并烘焙成一张 ≤720 边长的位图，
 * 播放过程中只贴这张图，避免浏览器持续合成多层 CSS 渐变 / Overlay。
 */

export type AmbientRgb = { r: number; g: number; b: number }

export type AmbientBackdropColors = {
  main: AmbientRgb
  accent?: AmbientRgb | string | null
  muted?: AmbientRgb | null
  secondary?: AmbientRgb | null
  base?: AmbientRgb | null
}

const CACHE_MAX_SIDE = 480
const bakeCache = new Map<string, string>()

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

const parseCssColor = (input?: string | null): AmbientRgb | null => {
  if (!input) return null
  const hex = input.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const raw = hex[1]
    if (raw.length === 3) {
      return {
        r: parseInt(raw[0] + raw[0], 16),
        g: parseInt(raw[1] + raw[1], 16),
        b: parseInt(raw[2] + raw[2], 16)
      }
    }
    return {
      r: parseInt(raw.slice(0, 2), 16),
      g: parseInt(raw.slice(2, 4), 16),
      b: parseInt(raw.slice(4, 6), 16)
    }
  }

  const rgb = input
    .trim()
    .match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\)$/i)
  if (!rgb) return null
  return {
    r: Number(rgb[1]),
    g: Number(rgb[2]),
    b: Number(rgb[3])
  }
}

const asRgb = (value?: AmbientRgb | string | null, fallback?: AmbientRgb): AmbientRgb => {
  if (!value) return fallback || { r: 42, g: 42, b: 46 }
  if (typeof value === 'string') return parseCssColor(value) || fallback || { r: 42, g: 42, b: 46 }
  return {
    r: clampByte(value.r),
    g: clampByte(value.g),
    b: clampByte(value.b)
  }
}

const mix = (a: AmbientRgb, b: AmbientRgb, ratio: number): AmbientRgb => {
  const t = Math.max(0, Math.min(1, ratio))
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t
  }
}

const boostForLightField = (color: AmbientRgb, saturation: number, lightness: number): AmbientRgb => {
  const lifted = mix(color, { r: 255, g: 255, b: 255 }, Math.max(0, Math.min(1, lightness)))
  const maxChannel = Math.max(color.r, color.g, color.b, 0.001)
  return {
    r: Math.max(0, Math.min(255, lifted.r + (color.r / maxChannel * 255 - lifted.r) * saturation)),
    g: Math.max(0, Math.min(255, lifted.g + (color.g / maxChannel * 255 - lifted.g) * saturation)),
    b: Math.max(0, Math.min(255, lifted.b + (color.b / maxChannel * 255 - lifted.b) * saturation))
  }
}

const rgba = (color: AmbientRgb, alpha: number) =>
  `rgba(${clampByte(color.r)}, ${clampByte(color.g)}, ${clampByte(color.b)}, ${Math.max(0, Math.min(1, alpha))})`

const fillRadial = (
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  stops: Array<[number, string]>
) => {
  ctx.save()
  ctx.translate(centerX, centerY)
  ctx.scale(Math.max(radiusX, 1) / Math.max(radiusY, 1), 1)
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(radiusY, 1))
  stops.forEach(([stop, color]) => gradient.addColorStop(stop, color))
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(0, 0, Math.max(radiusY, 1), 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

const cacheKeyOf = (
  colors: AmbientBackdropColors,
  width: number,
  height: number,
  darkTheme: boolean
) => {
  const main = asRgb(colors.main)
  const accent = asRgb(colors.accent, main)
  const muted = asRgb(colors.muted, mix(main, { r: 255, g: 255, b: 255 }, 0.18))
  const secondary = asRgb(colors.secondary, {
    r: main.r * 0.35,
    g: main.g * 0.35,
    b: main.b * 0.35
  })
  const base = asRgb(colors.base, {
    r: main.r * 0.18,
    g: main.g * 0.18,
    b: main.b * 0.18
  })
  return [
    width,
    height,
    darkTheme ? 1 : 0,
    clampByte(main.r),
    clampByte(main.g),
    clampByte(main.b),
    clampByte(accent.r),
    clampByte(accent.g),
    clampByte(accent.b),
    clampByte(muted.r),
    clampByte(muted.g),
    clampByte(muted.b),
    clampByte(secondary.r),
    clampByte(secondary.g),
    clampByte(secondary.b),
    clampByte(base.r),
    clampByte(base.g),
    clampByte(base.b)
  ].join(':')
}

export function bakeAmbientBackdropDataUrl(
  colors: AmbientBackdropColors,
  stageWidth: number,
  stageHeight: number,
  options?: { darkTheme?: boolean; maxSide?: number }
): string {
  if (typeof document === 'undefined') return ''

  const width = Math.max(1, Math.round(stageWidth || 1))
  const height = Math.max(1, Math.round(stageHeight || 1))
  const darkTheme = options?.darkTheme !== false
  const maxSideCap = options?.maxSide || CACHE_MAX_SIDE
  const key = cacheKeyOf(colors, width, height, darkTheme)
  const cached = bakeCache.get(key)
  if (cached) return cached

  const scale = Math.min(1, maxSideCap / Math.max(width, height))
  const bitmapWidth = Math.max(1, Math.round(width * scale))
  const bitmapHeight = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = bitmapWidth
  canvas.height = bitmapHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''

  const main = asRgb(colors.main)
  const accent = asRgb(colors.accent, main)
  const muted = asRgb(colors.muted, mix(main, { r: 255, g: 255, b: 255 }, 0.18))
  const secondary = asRgb(colors.secondary, {
    r: main.r * 0.35,
    g: main.g * 0.35,
    b: main.b * 0.35
  })
  const base = asRgb(colors.base, {
    r: main.r * 0.18,
    g: main.g * 0.18,
    b: main.b * 0.18
  })

  const alphaScale = 1
  const themeScale = darkTheme ? 1 : 0.92
  const artAlpha = darkTheme ? 1 : 0.88
  const maxSide = Math.max(bitmapWidth, bitmapHeight)
  const brightMain = boostForLightField(main, 0.42, 0.2)
  const vividMain = boostForLightField(main, 0.64, 0.1)
  const brightAccent = boostForLightField(accent, 0.36, 0.3)

  // 先按安卓同款 1.10 放大，再画进缓存图，最后拉伸回全屏。
  ctx.save()
  ctx.translate(bitmapWidth / 2, bitmapHeight / 2)
  ctx.scale(1.1, 1.1)
  ctx.translate(-bitmapWidth / 2, -bitmapHeight / 2)

  const baseGradient = ctx.createLinearGradient(0, 0, bitmapWidth, bitmapHeight)
  baseGradient.addColorStop(0, rgba(secondary, 1))
  baseGradient.addColorStop(1, rgba(base, 1))
  ctx.fillStyle = baseGradient
  ctx.fillRect(0, 0, bitmapWidth, bitmapHeight)

  const rightCenterX = bitmapWidth * 0.92
  const rightCenterY = bitmapHeight * 0.82
  const rightRadius = maxSide * 0.56
  fillRadial(ctx, rightCenterX, rightCenterY, maxSide * 0.42, rightRadius, [
    [0, rgba(vividMain, 0.94 * alphaScale)],
    [0.28, rgba(brightMain, 0.72 * alphaScale)],
    [0.68, 'rgba(0,0,0,0)'],
    [1, 'rgba(0,0,0,0)']
  ])

  const leftCenterX = bitmapWidth * 0.16
  const leftCenterY = bitmapHeight * 0.14
  const leftRadius = maxSide * 0.48
  fillRadial(ctx, leftCenterX, leftCenterY, maxSide * 0.34, leftRadius, [
    [0, rgba(brightAccent, 0.92 * alphaScale)],
    [0.28, rgba(mix(accent, { r: 255, g: 255, b: 255 }, 0.18), 0.7 * alphaScale)],
    [0.64, 'rgba(0,0,0,0)'],
    [1, 'rgba(0,0,0,0)']
  ])

  const bottomCenterX = bitmapWidth * 0.08
  const bottomCenterY = bitmapHeight * 0.94
  const bottomRadius = maxSide * 0.32
  fillRadial(ctx, bottomCenterX, bottomCenterY, maxSide * 0.12, bottomRadius, [
    [0, rgba(brightMain, 0.055 * alphaScale)],
    [0.32, rgba(accent, 0.032 * alphaScale)],
    [0.72, 'rgba(0,0,0,0)'],
    [1, 'rgba(0,0,0,0)']
  ])



  ctx.restore()

  const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
  bakeCache.set(key, dataUrl)
  if (bakeCache.size > 4) {
    const oldest = bakeCache.keys().next().value
    if (oldest) bakeCache.delete(oldest)
  }
  return dataUrl
}

export function clearAmbientBackdropCache() {
  bakeCache.clear()
}
