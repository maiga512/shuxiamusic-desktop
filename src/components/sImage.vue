<!-- 图片组件 -->
<template>
  <div ref="imgContainer" :key="src" class="s-image">
    <!-- 加载图片 -->
    <Transition name="fade">
      <img
        v-if="!isLoaded"
        :src="defaultSrc"
        class="loading"
        alt="loading"
        referrerpolicy="no-referrer"
      />
    </Transition>
    <!-- 真实图片 -->
    <img
      v-if="imgSrc"
      ref="imgRef"
      :key="imgSrc"
      :src="imgSrc"
      :alt="alt || 'image'"
      :class="['cover', { loaded: isLoaded }]"
      :decoding="decodeAsync ? 'async' : 'auto'"
      :loading="nativeLazy ? 'lazy' : 'eager'"
      referrerpolicy="no-referrer"
      :style="{ objectFit: objectFit }"
      @load="imageLoaded"
      @error="imageError"
    />
  </div>
</template>

<script setup lang="ts">
import { useElementVisibility } from '@vueuse/core'
import { appWindowState } from '@renderer/utils/appWindowState'
import songCover from '@assets/images/song.jpg'
import { rewritePublicCoverUrl } from '@renderer/utils/coverThumb'
const props = withDefaults(
  defineProps<{
    src: string | undefined
    defaultSrc?: string
    alt?: string
    // 图片填充方式
    objectFit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down'
    // 是否进行可视状态变化
    observeVisibility?: boolean
    // 在不可视时是否释放图片以回收内存
    releaseOnHide?: boolean
    // 是否使用浏览器异步解码
    decodeAsync?: boolean
    // 是否使用原生懒加载
    nativeLazy?: boolean
    // 列表缩略图边长。全屏/Now Playing 不要传。
    maxEdge?: number
  }>(),
  {
    defaultSrc: songCover,
    observeVisibility: true,
    releaseOnHide: false,
    decodeAsync: true,
    nativeLazy: true,
    objectFit: 'cover'
  }
)

const emit = defineEmits<{
  // 加载完成
  load: [e: Event]
  // 加载失败
  error: [e: Event]
  // 可视状态变化
  'update:show': [show: boolean]
}>()

// 图片数据
const imgRef = ref<HTMLImageElement>()
const imgSrc = ref<string>()
const imgContainer = ref<HTMLImageElement>()
// 代理封面加载失败时，先回退到直连 CDN 地址（仅一次），再回退到默认图
const directFallbackSrc = ref<string>()
const triedDirectFallback = ref<boolean>(false)

const normalizeImageSrc = (value?: string) => {
  // Electron loads the original URL, including http CDN covers.
  // Kuwo covers return 514 on https, so never upgrade public http images.
  return value
}

// 是否加载完成
const isLoaded = ref<boolean>(false)
// 可视状态上一次值，避免重复 emit
const lastShowState = ref<boolean | null>(null)
// 加载竞态 token，防止旧图片回调覆盖新状态
const loadToken = ref<number>(0)
const currentToken = ref<number>(0)
const requestedSrc = ref<string | undefined>()

const isLocalCoverProxySrc = (value?: string) =>
  typeof value === 'string' &&
  /https?:\/\/(127\.0\.0\.1|localhost):\d+\/cover\//i.test(value)

// 远程 http(s) 图片（非本地代理地址）都需要走代理缓存：飞牛封面需要鉴权，
// 公共 CDN 封面走代理是为了复用内存 + 磁盘缓存，避免每次进页面重新下载。
const isRemoteHttpSrc = (value?: string) =>
  typeof value === 'string' && /^https?:\/\//i.test(value) && !isLocalCoverProxySrc(value)

// 从本地代理地址还原原始 CDN 地址，供代理抓取失败时直连回退使用。
const decodeLocalCoverProxySrc = (value?: string): string | undefined => {
  if (!isLocalCoverProxySrc(value)) return undefined
  try {
    const match = /\/cover\/([^/?#]+)/.exec(String(value))
    if (!match) return undefined
    let token = match[1].replace(/-/g, '+').replace(/_/g, '/')
    while (token.length % 4) token += '='
    const binary = window.atob(token)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const decoded = new TextDecoder().decode(bytes)
    return /^https?:\/\//i.test(decoded) ? decoded : undefined
  } catch {
    return undefined
  }
}

const wantsThumbEdge = () => {
  const edge = Number(props.maxEdge) || 0
  return edge >= 32 && edge <= 512
}

const withThumbEdge = (value?: string) => {
  if (!value || !wantsThumbEdge()) return value
  const rewritten = rewritePublicCoverUrl(value, Number(props.maxEdge))
  if (rewritten !== value) return rewritten
  if (!isLocalCoverProxySrc(value) || /[?&]edge=/.test(value)) return value
  return `${value}${value.includes('?') ? '&' : '?'}edge=${Math.round(Number(props.maxEdge))}`
}

const assignImgSrc = (value?: string) => {
  imgSrc.value = withThumbEdge(value)
}

const needsCoverProxySrc = (value?: string) => isRemoteHttpSrc(value)

const wrapCoverSrcSync = (value: string) => {
  const imagesApi = window.api?.images as
    | {
        proxyUrlSync?: (url: string) => string
      }
    | undefined
  // 先在 CDN 侧压缩公共封面缩略图，再交给本地代理缓存这张小图；
  // 飞牛/未知源保持原尺寸，由代理的 edge= 参数做服务端缩放。
  const target = wantsThumbEdge() ? rewritePublicCoverUrl(value, Number(props.maxEdge)) : value
  if (typeof imagesApi?.proxyUrlSync === 'function') {
    const sync = imagesApi.proxyUrlSync(target)
    if (typeof sync === 'string' && sync) return sync
  }
  return target
}

const wrapCoverSrc = async (value: string) => {
  const imagesApi = window.api?.images as
    | {
        proxyUrl?: (url: string) => Promise<string>
      }
    | undefined
  const target = wantsThumbEdge() ? rewritePublicCoverUrl(value, Number(props.maxEdge)) : value
  if (typeof imagesApi?.proxyUrl === 'function') {
    const proxied = await imagesApi.proxyUrl(target)
    if (typeof proxied === 'string' && proxied) return proxied
  }
  return target
}

const resolveDisplaySrc = (value?: string) => {
  const normalized = normalizeImageSrc(value)
  if (!normalized) return undefined
  if (!needsCoverProxySrc(normalized)) return withThumbEdge(normalized)
  const sync = wrapCoverSrcSync(normalized)
  if (sync && !needsCoverProxySrc(sync)) return withThumbEdge(sync)
  return undefined
}

const applyImageSrc = async (value?: string) => {
  const token = loadToken.value + 1
  loadToken.value = token
  currentToken.value = token
  requestedSrc.value = value
  const normalized = normalizeImageSrc(value)
  triedDirectFallback.value = false
  directFallbackSrc.value = normalized
    ? needsCoverProxySrc(normalized)
      ? withThumbEdge(normalized)
      : decodeLocalCoverProxySrc(normalized)
    : undefined
  if (!normalized) {
    isLoaded.value = false
    imgSrc.value = undefined
    return
  }
  const syncSrc = resolveDisplaySrc(value)
  if (syncSrc) {
    if (imgSrc.value !== syncSrc) isLoaded.value = false
    assignImgSrc(syncSrc)
    return
  }
  if (!needsCoverProxySrc(normalized)) {
    const nextSrc = withThumbEdge(normalized)
    if (imgSrc.value !== nextSrc) isLoaded.value = false
    assignImgSrc(nextSrc)
    return
  }
  isLoaded.value = false
  try {
    const proxied = await wrapCoverSrc(normalized)
    if (currentToken.value !== token) return
    assignImgSrc(proxied || normalized)
  } catch {
    if (currentToken.value !== token) return
    assignImgSrc(normalized)
  }
}

// 是否可视
const isCanLook = useElementVisibility(imgContainer)
const hasBeenVisible = ref(false)
const windowVisible = computed(() => {
  const current = appWindowState.value
  return Boolean(current.visible && !current.hidden && !current.minimized && !document.hidden)
})
// 最小化时 IntersectionObserver 会把整页判成看不见。
// 只钉住隐藏瞬间仍可见的热层封面，冷层解码图可以丢掉，文件缓存留下。
const pinnedThroughWindowSleep = ref(false)
const visibleWhileAwake = ref(false)
watch(
  [windowVisible, isCanLook],
  ([visible, looking], previous) => {
    const wasVisible = previous ? Boolean(previous[0]) : visible
    const wasLooking = previous ? Boolean(previous[1]) : looking
    if (visible) {
      visibleWhileAwake.value = Boolean(looking)
      if (looking) pinnedThroughWindowSleep.value = false
      return
    }
    const hot = Boolean((wasVisible ? wasLooking : visibleWhileAwake.value) && imgSrc.value)
    pinnedThroughWindowSleep.value = hot
  },
  { immediate: true }
)
const shouldReleaseDecoded = computed(() => {
  if (!props.observeVisibility || !props.releaseOnHide || !hasBeenVisible.value) return false
  if (pinnedThroughWindowSleep.value) return false
  if (!windowVisible.value) return true
  return !isCanLook.value
})
const shouldLoadImage = computed(() => {
  if (!props.src) return false
  if (shouldReleaseDecoded.value) return false
  if (!windowVisible.value) return Boolean(imgSrc.value)
  return true
})

const releaseDecodedImage = () => {
  loadToken.value += 1
  currentToken.value = loadToken.value
  requestedSrc.value = undefined
  if (imgSrc.value !== undefined) imgSrc.value = undefined
  isLoaded.value = false
}

// 图片加载完成
const imageLoaded = (e: Event) => {
  // 竞态保护：仅响应最新一次设置的图片
  if (currentToken.value !== loadToken.value) return
  if (isLoaded.value) return
  isLoaded.value = true
  emit('load', e)
}

// 图片加载失败
const imageError = (e: Event) => {
  // 竞态保护
  if (currentToken.value !== loadToken.value) return
  isLoaded.value = false
  const current = imgSrc.value
  // 代理封面加载失败时，先直连原始 CDN 地址重试一次，避免封面直接消失
  const fallback = directFallbackSrc.value
  if (
    !triedDirectFallback.value &&
    isLocalCoverProxySrc(current) &&
    fallback &&
    !isLocalCoverProxySrc(fallback) &&
    fallback !== current
  ) {
    triedDirectFallback.value = true
    imgSrc.value = fallback
    return
  }
  // 避免默认图也反复触发导致死循环
  if (imgSrc.value !== props.defaultSrc) {
    imgSrc.value = props.defaultSrc
  }
  emit('error', e)
}

watch(
  isCanLook,
  (show) => {
    if (show) hasBeenVisible.value = true
    if (windowVisible.value && show) pinnedThroughWindowSleep.value = false
    if (!props.observeVisibility) return
    if (lastShowState.value !== show) {
      lastShowState.value = show
      emit('update:show', show)
    }
  }
)

watch(shouldReleaseDecoded, (release) => {
  if (release) releaseDecodedImage()
})

watch(
  [() => props.src, shouldLoadImage],
  () => {
    if (!props.src) {
      if (imgSrc.value) releaseDecodedImage()
      return
    }
    if (shouldReleaseDecoded.value || !shouldLoadImage.value) return
    if (requestedSrc.value !== props.src || !imgSrc.value) {
      void applyImageSrc(props.src)
    }
  },
  { immediate: true }
)

watch(
  () => props.maxEdge,
  () => {
    if (!shouldLoadImage.value) return
    if (requestedSrc.value) void applyImageSrc(requestedSrc.value)
  }
)

onUnmounted(() => {
  try {
    if (imgRef.value) imgRef.value.src = ''
  } catch {
    /* empty */
  }
  imgSrc.value = undefined
  imgRef.value = undefined
  imgContainer.value = undefined
})
</script>

<style lang="scss" scoped>
.s-image {
  position: relative;
  width: 100%;
  height: 100%;
  img {
    width: 100%;
    height: 100%;
    overflow: hidden;
    transition: opacity 0.18s ease;
  }
  .loading {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 0;
  }
  .cover {
    // position: absolute;
    // top: 0;
    // left: 0;
    width: 100%;
    height: 100%;
    z-index: 1;
    opacity: 0;
    &.loaded {
      opacity: 1;
    }
  }
}

// 修复闪烁问题的过渡动画
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.5s ease; // 比图片淡入稍微慢一点，防止透出背景
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
