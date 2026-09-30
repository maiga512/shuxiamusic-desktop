<script setup lang="ts">
import { defineAsyncComponent } from 'vue'

const HotkeySettings = defineAsyncComponent(
  () => import('@renderer/components/Settings/HotkeySettings.vue')
)
</script>

<template>
  <div class="settings-section">
    <div id="hotkey-settings" class="setting-group">
      <h3>快捷键设置</h3>
      <p>配置系统级全局快捷键，来快速达到你的理想效果</p>
      <HotkeySettings />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.setting-group {
  background: var(--settings-group-bg);
  border-radius: 0.75rem;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
  border: 1px solid var(--settings-group-border);
  box-shadow: 0 1px 0.1875rem var(--settings-group-shadow);

  h3 {
    margin: 0 0 0.5rem;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--settings-text-primary);
  }

  > p {
    margin: 0 0 1.5rem;
    color: var(--settings-text-secondary);
    font-size: 0.875rem;
  }
}

</style>
