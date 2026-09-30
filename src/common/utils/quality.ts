export const QUALITY_ORDER = [
  'master',
  'atmos_plus',
  'atmos',
  'hires',
  'flac24bit',
  'flac',
  '320k',
  '192k',
  '128k'
] as const

export type KnownQuality = (typeof QUALITY_ORDER)[number]
export type QualityInput = KnownQuality | string | { type: string; size?: string }

/**
 * 插件返回的音质字段偶尔会多层嵌套，例如 { type: { type: '128k' } }。
 * 统一解析到最内层字符串，避免对象被直接渲染或传给插件接口。
 */
export function normalizeQualityType(quality: unknown): string {
  let current = quality
  const seen = new Set<unknown>()

  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current === 'string') return current.trim()
    if (!current || typeof current !== 'object' || seen.has(current)) return ''

    seen.add(current)
    current = (current as { type?: unknown }).type
  }

  return ''
}

const DISPLAY_NAME_MAP: Record<string, string> = {
  '128k': '标准',
  '192k': '高品',
  '320k': '超高',
  flac: '无损',
  flac24bit: '超高解析',
  hires: '高清臻音',
  atmos: '全景环绕',
  atmos_plus: '全景增强',
  master: '超清母带'
}

/**
 * 统一获取音质中文显示名称
 */
export function getQualityDisplayName(quality: QualityInput | null | undefined): string {
  if (!quality) return ''
  const type = normalizeQualityType(quality)
  return DISPLAY_NAME_MAP[type] || String(type || '')
}

/**
 * 比较两个音质优先级（返回负数表示 a 优于 b）
 */
export function compareQuality(aType: string, bType: string): number {
  const ia = QUALITY_ORDER.indexOf(aType as KnownQuality)
  const ib = QUALITY_ORDER.indexOf(bType as KnownQuality)
  const va = ia === -1 ? QUALITY_ORDER.length : ia
  const vb = ib === -1 ? QUALITY_ORDER.length : ib
  return va - vb
}

/**
 * 规范化 types，兼容 string 与 {type,size}
 */
export function normalizeTypes(
  types: Array<string | { type: unknown; size?: unknown }> | null | undefined
): string[] {
  if (!types || !Array.isArray(types)) return []
  return types
    .map(normalizeQualityType)
    .filter((t): t is string => Boolean(t))
}

/**
 * 获取数组中最高音质类型
 */
export function getHighestQualityType(
  types: Array<string | { type: string; size?: string }> | null | undefined
): string | null {
  const arr = normalizeTypes(types)
  if (!arr.length) return null
  return arr.sort(compareQuality)[0]
}

/**
 * 构建并按优先级排序的 [{type, size}] 列表
 * 支持传入：
 * - 数组：[{type,size}]
 * - _types 映射：{ [type]: { size } }
 */
export function buildQualityFormats(
  input:
    | Array<string | { type: unknown; size?: unknown }>
    | Record<string, { size?: unknown }>
    | null
    | undefined
): Array<{ type: string; size?: string }> {
  if (!input) return []
  let list: Array<{ type: string; size?: string }>
  if (Array.isArray(input)) {
    list = input.map((item) => {
      if (typeof item === 'string') return { type: item }
      const size = typeof item.size === 'string' ? item.size : undefined
      return { type: normalizeQualityType(item), size }
    })
  } else {
    list = Object.keys(input).map((key) => {
      const size = input[key]?.size
      return { type: normalizeQualityType(key), size: typeof size === 'string' ? size : undefined }
    })
  }
  return list.filter((item) => item.type).sort((a, b) => compareQuality(a.type, b.type))
}

/**
 * 计算最佳匹配音质（降级逻辑）
 * 在可用音质中寻找不高于目标音质的最高音质
 * @param availableTypes 可用音质列表
 * @param targetQuality 目标音质
 * @returns 最佳匹配音质，如果没有匹配则返回 null
 */
export function calculateBestQuality(
  availableTypes: Array<string | { type: string; size?: string }> | null | undefined,
  targetQuality: string
): string | null {
  const normalizedTypes = normalizeTypes(availableTypes)
  if (!normalizedTypes.length) return null

  if (normalizedTypes.includes(targetQuality)) return targetQuality

  const targetIndex = QUALITY_ORDER.indexOf(targetQuality as KnownQuality)
  if (targetIndex === -1) return getHighestQualityType(normalizedTypes)

  const lowerOrEqual = normalizedTypes.filter((t) => {
    const index = QUALITY_ORDER.indexOf(t as KnownQuality)
    return index !== -1 && index >= targetIndex
  })
  if (lowerOrEqual.length > 0) {
    return lowerOrEqual.sort(compareQuality)[0]
  }

  const higherOnly = normalizedTypes.filter((t) => QUALITY_ORDER.includes(t as KnownQuality))
  if (higherOnly.length > 0) {
    return higherOnly.sort(compareQuality)[higherOnly.length - 1]
  }

  return getHighestQualityType(normalizedTypes)
}
