<!-- Lightweight icon for desktop lyric (no naive-ui dependency). -->
<template>
  <span class="lyric-icon" :style="wrapStyle" aria-hidden="true">
    <span ref="svgContainer" class="lyric-icon__svg"></span>
  </span>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  name: string
  size?: string | number
  color?: string
}>()

const svgContainer = ref<HTMLElement | null>(null)

const wrapStyle = computed(() => {
  const size = props.size ?? 18
  const value = typeof size === 'number' ? `${size}px` : String(size)
  return {
    width: value,
    height: value,
    color: props.color || 'currentColor',
  }
})

const loadSVG = async (name: string) => {
  if (!name || !svgContainer.value) return
  try {
    const svg = await import(`../../assets/icons/${name}.svg?raw`)
    svgContainer.value.innerHTML = (svg as any).default || svg
  } catch (error) {
    console.error(`Could not load lyric icon: ${name}`, error)
    svgContainer.value.innerHTML = ''
  }
}

watch(
  () => props.name,
  (name) => {
    void loadSVG(name)
  }
)

onMounted(() => {
  void loadSVG(props.name)
})
</script>

<style scoped>
.lyric-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  line-height: 0;
}

.lyric-icon__svg {
  display: inline-flex;
  width: 100%;
  height: 100%;
}

.lyric-icon__svg :deep(svg) {
  width: 100%;
  height: 100%;
  fill: currentColor;
}
</style>
