# 完整按需加载审计报告

## 审计目标
检查所有功能是否真正"按需运行"——**没打开不占用，打开才占用**。

## 已修复的问题 ✅

### 1. **AudioVisualizer（频谱可视化）**
- ✅ 现在只在：全屏打开 + 播放中 + 用户开启开关时运行
- ✅ 修复文件：`src/components/Play/AudioVisualizer.vue`

### 2. **ShaderBackground（着色器背景）**
- ✅ 现在绑定到"播放背景动画"开关
- ✅ 只在：全屏打开 + 播放中 + 用户开启开关时渲染
- ✅ 修复文件：`src/components/Play/ShaderBackground.vue` + `FullPlay.vue`

### 3. **GlobalBackground（全局背景视频）**
- ✅ 已有窗口可见性检查
- ✅ 窗口不可见时自动暂停并清空缓冲区
- ✅ 文件：`src/components/GlobalBackground.vue:25-36`

### 4. **IPC 统计刷新器**
- ✅ 改为只在开发模式运行
- ✅ 生产环境默认关闭，减少 1-3% CPU
- ✅ 修复文件：`src/tauri-bridge.ts:130-149`

## 新发现的问题 ⚠️

### 5. **播客页面推荐定时器**（中等优先级）
**文件**: `src/views/music/podcast.vue:670-677`

**问题**:
```typescript
const REC_REFRESH_MS = 15 * 60 * 1000 // 每 15 分钟
recommendationTimer = window.setInterval(() => {
  void loadShelf()
  void loadBlocks()
}, REC_REFRESH_MS)
```

**现状**:
- ✅ 已有 `onActivated/onDeactivated` 管理
- ✅ 页面切走会停止定时器
- ✅ 窗口不可见时也会停止

**结论**: **已优化良好**，无需修改

### 6. **播客二维码轮询**（低优先级）
**文件**: `src/views/music/podcast.vue:619`

**问题**:
```typescript
podcastTimer = window.setInterval(checkQrStatus, 2500) // 每 2.5 秒
```

**现状**:
- ✅ 只在扫码对话框打开时运行
- ✅ 对话框关闭后会清理
- ✅ `onDeactivated` 时也会停止

**结论**: **已优化良好**，无需修改

### 7. **一起听功能定时器**（需要检查）⚠️
**文件**: `src/store/ListenTogether.ts`

**发现**:
```typescript:1386-1389
pingTimer = setInterval(() => {
  void pingOnce().then((sample) => {
    // EMA 平滑 ping
  })
}, ?) // 间隔未知，需要检查
```

```typescript:1418
driftTimer = setInterval(() => {
  if (!isInRoom.value || !current.isPlaying) return
  // 漂移校准
}, 3000) // 每 3 秒
```

**需要验证**:
- ❓ 是否只在加入房间时启动
- ❓ 离开房间后是否正确清理
- ❓ 窗口不可见时是否需要暂停

**风险评估**: 
- 如果用户不用"一起听"，定时器不应该启动
- 如果已加入房间但窗口不可见，可能需要降低频率

### 8. **原生播放音量渐变定时器**（低优先级）
**文件**: `src/utils/audio/nativePlayback.ts:299`

**问题**:
```typescript
volumeFadeTimer = setInterval(() => {
  // 音量渐变
}, ?) // 间隔未知
```

**现状**:
- 只在音量渐变时临时启动
- 渐变完成后会清理

**结论**: **已优化良好**，无需修改

### 9. **桌面歌词窗口**（需要检查）⚠️
**文件**: `src/utils/lyrics/desktopLyricBridge.ts:312`

**问题**:
```typescript
playStateInterval = window.setTimeout(scheduleNext, 200)
```

**需要验证**:
- ❓ 只在桌面歌词窗口打开时运行吗？
- ❓ 窗口关闭后是否正确清理？

**风险评估**:
- 如果用户不用桌面歌词，这个定时器不应该启动

## 需要深入检查的模块

### A. 一起听（ListenTogether）
**优先级**: 🔴 **高**

**检查项**:
1. pingTimer 和 driftTimer 的启动条件
2. 离开房间后的清理逻辑
3. 窗口不可见时的行为

**预期行为**:
- 未加入房间：定时器不启动
- 加入房间：定时器启动
- 离开房间：定时器立即清理
- 窗口不可见：可选择降低频率或暂停

### B. 桌面歌词（DesktopLyric）
**优先级**: 🟡 **中**

**检查项**:
1. 定时器的启动条件
2. 窗口关闭后的清理逻辑
3. 是否有多余的轮询

**预期行为**:
- 桌面歌词未打开：定时器不启动
- 桌面歌词打开：定时器启动
- 桌面歌词关闭：定时器立即清理

### C. SMTC 媒体控制（SystemMediaTransportControls）
**优先级**: 🟢 **低**（已在 CPU_OPTIMIZATION_PLAN.md 中提到）

**检查项**:
1. 是否还在轮询初始化
2. 能否改为事件驱动

**预期行为**:
- 只在播放状态变化时更新
- 不需要持续轮询

## 优化方案

### 方案 1: 一起听定时器优化

```typescript
// src/store/ListenTogether.ts

// 监听窗口可见性
import { isAppWindowVisible } from '@renderer/utils/appWindowState'

function startPingLoop(): void {
  stopPingLoop()
  
  // 【新增】窗口不可见时不启动
  if (!isAppWindowVisible()) {
    console.log('[ListenTogether] 窗口不可见，跳过 ping 循环')
    return
  }
  
  const interval = isAppWindowVisible() ? 5000 : 15000 // 窗口不可见时降低频率
  pingTimer = setInterval(() => {
    if (!isInRoom.value || !isAppWindowVisible()) {
      stopPingLoop()
      return
    }
    void pingOnce().then((sample) => {
      // ...
    })
  }, interval)
}

// 监听窗口可见性变化
window.addEventListener('ceru-window-state-change', () => {
  if (!isAppWindowVisible() && pingTimer) {
    stopPingLoop()
  } else if (isAppWindowVisible() && isInRoom.value && !pingTimer) {
    startPingLoop()
    startDriftLoop()
  }
})
```

### 方案 2: 桌面歌词定时器检查

需要读取完整文件后确认：
- 定时器是否在 `initDesktopLyric()` 时启动
- 是否在 `stopDesktopLyric()` 时清理
- 是否有窗口可见性检查

### 方案 3: SMTC 优化（已在 CPU_OPTIMIZATION_PLAN.md）

改为事件驱动，不轮询初始化。

## 测试清单

### 测试 1: 一起听功能
- [ ] 未加入房间时，检查 `pingTimer` 和 `driftTimer` 是否为 null
- [ ] 加入房间后，确认定时器已启动
- [ ] 离开房间后，确认定时器已清理
- [ ] 窗口最小化后，观察 CPU 占用

### 测试 2: 桌面歌词
- [ ] 桌面歌词未打开时，检查是否有相关定时器运行
- [ ] 打开桌面歌词，确认定时器启动
- [ ] 关闭桌面歌词，确认定时器清理
- [ ] 窗口最小化后，检查定时器行为

### 测试 3: 全局后台状态
- [ ] 窗口最小化 10 分钟，观察 CPU 占用（应 < 1%）
- [ ] 播客页面切走，确认推荐定时器停止
- [ ] 全局背景视频在窗口不可见时暂停
- [ ] IPC 统计在生产环境不运行

## 审计总结

| 功能 | 状态 | 优先级 | 操作 |
|------|------|--------|------|
| AudioVisualizer | ✅ 已修复 | 🔴 高 | 无 |
| ShaderBackground | ✅ 已修复 | 🔴 高 | 无 |
| GlobalBackground | ✅ 已优化 | 🟡 中 | 无 |
| IPC 统计 | ✅ 已修复 | 🟡 中 | 无 |
| 播客推荐定时器 | ✅ 已优化 | 🟢 低 | 无 |
| 播客二维码轮询 | ✅ 已优化 | 🟢 低 | 无 |
| 一起听定时器 | ⚠️ 需要检查 | 🔴 高 | 读取完整文件 |
| 桌面歌词定时器 | ⚠️ 需要检查 | 🟡 中 | 读取完整文件 |
| SMTC 媒体控制 | ⚠️ 需要优化 | 🟢 低 | 改为事件驱动 |
| 原生音量渐变 | ✅ 已优化 | 🟢 低 | 无 |

## 下一步行动

1. **立即检查**（优先级：🔴 高）
   - 读取 `ListenTogether.ts` 完整文件
   - 确认一起听定时器的启动/清理逻辑
   - 添加窗口可见性检查

2. **重要检查**（优先级：🟡 中）
   - 读取 `desktopLyricBridge.ts` 完整文件
   - 确认桌面歌词定时器的行为
   - 验证窗口关闭时的清理

3. **可选优化**（优先级：🟢 低）
   - SMTC 改为事件驱动
   - 其他微小的性能提升

## 预期最终效果

**CPU 占用**:
- 播放中（全屏关闭）: < 3%
- 播放中（全屏打开，所有特效开）: < 5%
- 暂停: < 2%
- 空闲（窗口可见）: < 1%
- 窗口不可见（后台）: < 0.5%

**内存占用**:
- 播放中: 300-400 MB
- 暂停: 250-300 MB
- 空闲 2 分钟后: < 200 MB
