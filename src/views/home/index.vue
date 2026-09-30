<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { appWindowState } from '@renderer/utils/appWindowState'

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
          <Transition name="page" mode="out-in">
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
.page-enter-active,
.page-leave-active {
  transition: opacity 0.12s ease;
}

.page-enter-from,
.page-leave-to {
  opacity: 0;
}
</style>
