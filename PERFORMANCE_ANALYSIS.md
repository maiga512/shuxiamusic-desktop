# 树夏Music 性能分析报告 - 空闲状态高占用

## 问题现状

根据活动监视器截图（2026-10-01）：

| 进程 | CPU | 内存 | 说明 |
|---|---|---|---|
| **tauri://localhost** | **32.2%** | **821.8 MB** | WebView 渲染进程（主要问题） |
| 树夏Music 主进程 | 46.0% | 210.4 MB | 可能在播放中 |
| 树夏Music (其他) | 3.2% | 63.8 MB | 正常 |
| MPV | 0-5% | 正常 | 音频播放正常 |

**核心问题**：`tauri://localhost` 在**没有播放音乐时仍占用 32% CPU 和 821 MB 内存**，说明有后台任务持续运行。

---

## 定位的性能热点

### 1. 全屏播放组件（FullPlay.vue）未完全卸载

**问题代码**：
```vue
<!-- FullPlay.vue:1286-1290 -->
<AudioVisualizer
  v-if="props.show && keepHeavyContent && coverImage && playSetting.getIsAudioVisualizer"
/>
```

**问题描述**：
- 全屏播放界面使用 `keepHeavyContent` 延迟卸载重资源（歌词、背景、频谱）
- 如果退出全屏后 `keepHeavyContent` 未及时设为 `false`，这些组件会继续运行
- 音频可视化器（AudioVisualizer）使用 `requestAnimationFrame` 持续渲染 Canvas

**影响**：
- 频谱 Canvas 30fps 渲染循环
- FFT 音频分析持续占用 CPU
- 大量 Canvas 缓冲区占用内存

---

### 2. 全局背景（GlobalBackground.vue）持续播放视频

**问题代码**：
```vue
<!-- GlobalBackground.vue:28-32 -->
<video
  v-if="bgType === 'video'"
  ref="videoRef"
  :src="bgUrl"
  loop
  muted
  autoplay
  playsinline
/>
```

**问题描述**：
- 如果用户设置了全局背景视频（如壁纸引擎效果），视频会持续解码
- 即使窗口最小化或在后台，`syncVideoPlayback` 只在特定条件下暂停
- 视频解码器会占用大量 CPU 和内存

**当前保护措施**：
```typescript
const syncVideoPlayback = () => {
  if (!isEnabled.value || bgType.value !== 'video' || !isAppWindowVisible()) {
    video.pause()
    return
  }
  video.play().catch(...)
}
```

但 `watch` 和 `visibilitychange` 事件可能在某些场景下未触发。

---

### 3. 着色器背景（ShaderBackground.vue）WebGL 渲染

**当前状态**：已优化 ✅

```typescript
// 已有 12fps 帧率限制和窗口可见性检测
if (!isAppWindowVisible() || isPageIidle()) {
  animationFrameId = null
  return
}
```

这个组件已经有正确的优化，但如果全屏播放界面未正确卸载，着色器会继续渲染。

---

### 4. 播客页面（podcast.vue）的后台定时器

**当前状态**：已优化 ✅

```typescript
// 已使用 onActivated/onDeactivated 管理
onDeactivated(() => {
  stopRecommendationTimer()
  stopPodcastPoll()
})
```

这个组件已经正确处理了 KeepAlive 生命周期。

---

## 根本原因分析

### 最可能的原因：全屏播放组件的延迟卸载机制

`FullPlay.vue` 有一个 **1 秒延迟卸载** 机制：

```typescript
// FullPlay.vue:1063-1066
hideHeavyTimer = setTimeout(() => {
  keepHeavyContent.value = false
  console.log('[FullPlay] 延迟隐藏重内容完成')
}, 1000)
```

**问题场景**：
1. 用户进入全屏播放 → `keepHeavyContent = true`，加载音频可视化器、着色器背景
2. 用户退出全屏 → 启动 1 秒延迟定时器
3. **如果在这 1 秒内用户最小化窗口或切换应用**，定时器可能不会正确执行
4. 结果：`keepHeavyContent` 保持 `true`，所有重资源组件继续在后台运行

---

## 内存占用分析

821 MB 内存占用可能来自：

1. **Canvas 缓冲区**：
   - AudioVisualizer Canvas（频谱）
   - ShaderBackground Canvas（WebGL）
   - FullPlay 背景烘焙 Canvas
   - 每个 Canvas 按窗口分辨率分配，全屏时可能达到 4K 缓冲区

2. **歌词和字体**：
   - AMLL 歌词引擎实例
   - 自定义字体文件（可能多次加载）
   - 歌词 DOM 元素未清理

3. **封面图片缓存**：
   - 原始封面图（可能是高分辨率）
   - 背景烘焙图（data URL）
   - 颜色提取中间结果

4. **音频分析器**：
   - Web Audio API 的 AnalyserNode 和 AudioContext
   - FFT 缓冲区
   - 如果未正确释放，会累积多个实例

---

## 优化方案

### 高优先级修复（立即实施）

#### 1. 强制清理全屏组件资源（窗口不可见时）

在 `FullPlay.vue` 的 `onDeactivated` 和窗口可见性监听中立即清理：

```typescript
// 新增：窗口隐藏时立即清理重资源
const onWindowHide = () => {
  if (!isAppWindowVisible()) {
    keepHeavyContent.value = false
    // 立即停止所有动画
    if (hideHeavyTimer) {
      clearTimeout(hideHeavyTimer)
      hideHeavyTimer = null
    }
    console.log('[FullPlay] 窗口隐藏，立即清理重资源')
  }
}

onMounted(() => {
  window.addEventListener('ceru-window-state-change', onWindowHide)
  document.addEventListener('visibilitychange', onWindowHide)
})

onBeforeUnmount(() => {
  window.removeEventListener('ceru-window-state-change', onWindowHide)
  document.removeEventListener('visibilitychange', onWindowHide)
})
```

#### 2. AudioVisualizer 强制停止检测

在 `AudioVisualizer.vue` 中添加双重保护：

```typescript
const stopVisualization = (force = false) => {
  if (animationId.value) {
    cancelAnimationFrame(animationId.value)
    animationId.value = undefined
  }
  if (force) {
    releaseAudioAnalyser()
  }
}

// 每帧渲染前检查
const draw = (ts?: number) => {
  // 窗口不可见、页面闲置或组件隐藏时立即停止
  if (!props.show || !isAppWindowVisible() || isPageIdle()) {
    stopVisualization(true)
    return
  }
  // ... 原有渲染逻辑
}
```

#### 3. GlobalBackground 视频强制暂停

在 `GlobalBackground.vue` 中使用 `setInterval` 定期检查：

```typescript
let visibilityCheckInterval: number | null = null

watch(
  [bgType, bgUrl, isEnabled],
  ([type, _url, enabled]) => {
    if (enabled && type === 'video' && videoRef.value) {
      videoRef.value.load()
      syncVideoPlayback()
      
      // 启动定期检查（每秒一次）
      if (visibilityCheckInterval) clearInterval(visibilityCheckInterval)
      visibilityCheckInterval = window.setInterval(() => {
        syncVideoPlayback()
      }, 1000)
    } else {
      if (videoRef.value) videoRef.value.pause()
      if (visibilityCheckInterval) {
        clearInterval(visibilityCheckInterval)
        visibilityCheckInterval = null
      }
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (visibilityCheckInterval) {
    clearInterval(visibilityCheckInterval)
  }
})
```

---

### 中优先级优化（建议实施）

#### 4. Canvas 缓冲区显式释放

在所有 Canvas 组件中添加显式清理：

```typescript
const releaseCanvas = (canvas: HTMLCanvasElement) => {
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }
  // 重置尺寸释放内存
  canvas.width = 0
  canvas.height = 0
}

onBeforeUnmount(() => {
  if (canvasRef.value) {
    releaseCanvas(canvasRef.value)
  }
})
```

#### 5. 封面图片缓存上限

在 `colorExtractor.ts` 中限制缓存大小：

```typescript
const MAX_CACHE_SIZE = 20
const colorCache = new Map<string, Color[]>()

function addToCache(key: string, value: Color[]) {
  if (colorCache.size >= MAX_CACHE_SIZE) {
    // 删除最早的条目
    const firstKey = colorCache.keys().next().value
    colorCache.delete(firstKey)
  }
  colorCache.set(key, value)
}
```

---

## 预期效果

实施上述优化后，空闲状态的资源占用应该降至：

| 状态 | CPU | 内存 | 说明 |
|---|---|---|---|
| **当前（未优化）** | 32% | 821 MB | 后台仍有渲染循环 |
| **优化后（空闲）** | < 2% | 200-300 MB | 只保留基础 Vue 实例和缓存 |
| **优化后（普通播放）** | 5-8% | 250-350 MB | 音频解码 + 进度更新 |
| **优化后（全屏播放）** | 15-25% | 400-500 MB | 频谱 + 歌词 + 背景 |

---

## 测试验证方案

### 1. 空闲状态测试

```bash
# 启动应用，不播放音乐，等待 30 秒
# 预期：CPU < 2%，内存 < 300 MB
```

### 2. 播放后暂停测试

```bash
# 播放一首歌 → 暂停 → 等待 10 秒
# 预期：CPU < 3%，内存稳定不增长
```

### 3. 全屏进出测试

```bash
# 播放 → 进入全屏 → 播放 10 秒 → 退出全屏 → 等待 5 秒
# 预期：退出全屏后内存回落至普通播放水平
```

### 4. 连续切歌测试

```bash
# 连续下一首 20 次，每首播放 3 秒
# 预期：内存增长 < 50 MB，无线性增长趋势
```

### 5. 窗口最小化测试

```bash
# 播放中 → 最小化窗口 → 等待 30 秒
# 预期：CPU < 5%（仅音频解码），内存稳定
```

---

## 下一步行动

1. ✅ 分析完成，定位到 `FullPlay.vue` 的延迟卸载机制和全局背景视频
2. ⏳ 实施高优先级修复（预计降低 80% 空闲 CPU）
3. ⏳ 验证优化效果（需要本地终端执行性能测试）
4. ⏳ 实施中优先级优化（进一步降低内存占用）
5. ⏳ 更新 AI_INDEX.md 和 CONTEXT_HANDOFF.md

---

## 相关文件

- `src/components/Play/FullPlay.vue` - 全屏播放主组件
- `src/components/Play/AudioVisualizer.vue` - 音频可视化器
- `src/components/Play/ShaderBackground.vue` - WebGL 背景
- `src/components/GlobalBackground.vue` - 全局背景视频
- `src/utils/color/colorExtractor.ts` - 封面颜色提取
- `src/utils/audio/audioManager.ts` - 音频分析器管理

---

生成时间：2026-10-01 09:30
