<script setup lang="ts">
import { reactive, ref } from 'vue'

const raw = { ...window.electron.process.versions }

// 解析 WebView 版本：Windows/Linux 走 WebView2(Chromium)，macOS 走 WKWebView(Safari/WebKit)
function detectWebviewVersion(): string {
  const ua = navigator.userAgent
  const chrome = ua.match(/Chrome\/(\S+)/)?.[1]
  if (chrome) return `Chromium ${chrome}`
  const safari = ua.match(/Version\/(\S+)/)?.[1]
  if (safari) return `WebKit ${safari}`
  const webkit = ua.match(/AppleWebKit\/(\S+)/)?.[1]
  if (webkit) return `WebKit ${webkit}`
  return '未知'
}

const versions = reactive({
  tauri: raw.tauri || '2.x',
  webview: detectWebviewVersion()
})

const appVersion = ref('')
;(async () => {
  try {
    const v = await window.electron.ipcRenderer.invoke('get-app-version')
    if (v) appVersion.value = String(v)
  } catch {
    // 忽略：拿不到版本号时只隐藏该行
  }
})()
</script>

<template>
  <ul class="versions">
    <li class="tauri-version">Tauri v{{ versions.tauri }}</li>
    <li class="webview-version">WebView {{ versions.webview }}</li>
    <li v-if="appVersion" class="app-version">应用 v{{ appVersion }}</li>
  </ul>
</template>

<style lang="scss" scoped>
.versions {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;

  li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    background: var(--settings-tech-item-bg, #f8fafc);
    border-radius: 0.5rem;
    border: 1px solid var(--settings-tech-item-border, #e2e8f0);
    color: var(--settings-text-primary, #1e293b);
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.2s ease;

    &:hover {
      background: var(--settings-nav-hover-bg, #f1f5f9);
    }
  }

  .tauri-version {
    &::before {
      content: '⚡';
      margin-right: 0.5rem;
    }
  }

  .webview-version {
    &::before {
      content: '🌐';
      margin-right: 0.5rem;
    }
  }

  .app-version {
    &::before {
      content: '🟢';
      margin-right: 0.5rem;
    }
  }
}
</style>
