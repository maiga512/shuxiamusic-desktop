<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { appWindowState } from '@renderer/utils/appWindowState'
import { scheduleHomePrefetch } from '@renderer/utils/navigation/homePrefetch'
import {
  welcomeTransitionActive
} from '@renderer/utils/navigation/welcomeTransition'

// 主导航浏览页：常驻缓存，来回切换不重建、不重复走 onMounted 拉数据。
// 这几页都用了 release-on-hide，切走时解码图会释放，常驻成本只是组件实例和已取到的列表数据。
// 歌单详情(list)、本地(local)、电台详情(radio-detail 随 id 变化)等详情页不在此列，进入即拉最新。
const KEEP_ALIVE_PAGES = ['find', 'songlist', 'recent', 'search', 'podcast']

// 窗口在后台持续超过这个时长，才把「非当前页」卸载掉回收内存。
// 之前是「一不可见就收缩成当前页」，但 macOS 下窗口被别的窗口遮住、切到其它 App、
// 最小化都会让 windowVisible 变 false；KeepAlive 的 include 一变，Vue 立刻 pruneCache
// 把不匹配的缓存实例 unmount → 再切回去等于冷启动（骨架 + 重新拉网络 + 重新解码封面），
// 用户感觉就是「每次都得加载一下才出来」。
// 阈值故意取得很长（1 小时）：最小化挂后台是听歌常态，那时回来必须立刻有界面；
// 真正长时间不在前台的场景才回收，而且此时封面解码图早已按 sImage 策略释放，
// 这里多留的只是页面 DOM 与已取到的列表数据。
const HIDDEN_RECLAIM_MS = 60 * 60 * 1000

const route = useRoute()
// 只有「窗口真的不在屏幕上」（最小化 / 托盘隐藏 / Cmd+H）才允许回收内存。
// 不要用 document.hidden 判断：macOS 下窗口被别的窗口完全遮住时它也会变 true，
// 而「被遮住」是边听歌边干别的的常态，这时回收缓存等于用户一切回来就得重新加载。
const windowOnScreen = computed(() => {
  const current = appWindowState.value
  return Boolean(current.visible && !current.minimized)
})

// collapsed：长时后台阶段只留当前页（max=1）；回到前台立刻恢复整组缓存。
const collapsed = ref(false)
let reclaimTimer: number | null = null
const clearReclaimTimer = () => {
  if (reclaimTimer !== null) {
    window.clearTimeout(reclaimTimer)
    reclaimTimer = null
  }
}

watch(
  windowOnScreen,
  (onScreen) => {
    clearReclaimTimer()
    if (onScreen) {
      collapsed.value = false
      return
    }
    reclaimTimer = window.setTimeout(() => {
      reclaimTimer = null
      collapsed.value = true
    }, HIDDEN_RECLAIM_MS)
  },
  { immediate: true }
)

onMounted(() => {
  // 主页稳定后空闲预热「发现/播客」首屏数据（写 sessionCache，各页已有 SWR）
  scheduleHomePrefetch()
})

onUnmounted(() => {
  clearReclaimTimer()
})

// max 取组大小保证组内页面互不淘汰（LRU 淘汰只会在超过 max 时发生）。
const keepAliveMax = computed(() => (collapsed.value ? 1 : KEEP_ALIVE_PAGES.length))

const keepAliveInclude = computed<string[] | string | undefined>(() => {
  if (!collapsed.value) return KEEP_ALIVE_PAGES
  const name = String(route.name || '').trim()
  return name || undefined
})
</script>

<template>
  <div class="home">
    <HomeLayout>
      <template #body>
        <router-view v-slot="{ Component }">
          <Transition :name="welcomeTransitionActive ? undefined : 'page'">
            <KeepAlive :max="keepAliveMax" :include="keepAliveInclude" exclude="list,local">
              <component :is="Component" />
            </KeepAlive>
          </Transition>
        </router-view>
      </template>
    </HomeLayout>
    <PlayMusic />
  </div>
</template>

<style scoped>
/* 抽屉式单动效过渡：旧页瞬间消失（无退出动画 → 无双影、无双重运动），
   新页整块（内容已备好）从左侧 28px 滑入带回弹。过渡期新页 absolute 叠在
   .mainContent（position:relative + overflow:hidden）里，will-change 提层，
   动画走合成器，切页时的布局计算不会卡住滑动；左侧 28px 间隙露出应用底色，
   像拉开抽屉，没有"黑屏"间隔。 */
.page-enter-active {
  position: absolute;
  inset: 0;
  z-index: 1;
  will-change: transform;
  transition: transform 0.24s cubic-bezier(0.34, 1.75, 0.64, 1);
}

.page-enter-from {
  transform: translateX(28px);
}

/* 旧页：零退出动画 + 首帧就不可见。
   Vue 真正把旧页 DOM 移出文档要等一个 nextFrame，主线程一旦忙着挂载新页
   （插入卡片 DOM、重设封面 src），这一帧可能拖到上百毫秒；期间旧页仍被绘制，
   和新页的左滑入同屏 → 肉眼就是「卡一个页面 / 重影」。visibility 不参与过渡，
   和进入动画在同一帧生效，旧页立刻让位，露出的就是 .content 应用底色。 */
.page-leave-active {
  position: absolute;
  inset: 0;
  visibility: hidden;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .page-enter-active {
    transition: none;
  }

  .page-enter-from {
    transform: none;
  }
}
</style>
