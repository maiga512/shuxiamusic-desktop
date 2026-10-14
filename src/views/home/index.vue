<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { appWindowState } from '@renderer/utils/appWindowState'
import { scheduleHomePrefetch } from '@renderer/utils/navigation/homePrefetch'

// 主导航浏览页：窗口可见时常驻缓存，来回切换不重建、不重复走 onMounted 拉数据。
// 这几页都用了 release-on-hide，切走时解码图会释放，常驻成本只是组件实例和已取到的列表数据。
// 歌单详情(list)、本地(local)、电台详情(radio-detail 随 id 变化)等详情页不在此列，进入即拉最新。
const KEEP_ALIVE_PAGES = ['find', 'songlist', 'recent', 'search', 'podcast']

const route = useRoute()
const windowVisible = computed(() => {
  const current = appWindowState.value
  return Boolean(current.visible && !current.hidden && !current.minimized)
})
// 可见时按整组缓存，max 取组大小保证组内页面互不淘汰；隐藏/最小化时只留当前页，其余卸载释放内存。
const keepAliveMax = computed(() => (windowVisible.value ? KEEP_ALIVE_PAGES.length : 1))
onMounted(() => {
  // 主页稳定后空闲预热「发现/播客」首屏数据（写 sessionCache，各页已有 SWR）
  scheduleHomePrefetch()
})

const keepAliveInclude = computed<string[] | string | undefined>(() => {
  if (windowVisible.value) return KEEP_ALIVE_PAGES
  const name = String(route.name || '').trim()
  return name || undefined
})
</script>

<template>
  <div class="home">
    <HomeLayout>
      <template #body>
        <router-view v-slot="{ Component }">
          <Transition name="page">
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

.page-leave-active {
  position: absolute;
  inset: 0;
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
