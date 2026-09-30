<script setup lang="ts">
import { defineAsyncComponent } from 'vue'

const PluginsPanel = defineAsyncComponent(
  () => import('@renderer/components/Settings/plugins.vue')
)
</script>

<template>
  <div class="settings-section">
    <div id="plugin-settings">
      <PluginsPanel />
    </div>
  </div>
</template>
