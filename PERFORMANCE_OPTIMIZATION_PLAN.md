# 性能优化执行计划

## 优化目标
- 空闲状态：CPU < 0.5%, 内存增长 < 5MB/小时
- 最小化播放：CPU < 1%, 内存稳定
- 全屏播放：CPU < 5%, 内存稳定
- 窗口隐藏/失焦：立即暂停所有非必要渲染

## 已识别的性能热点

### 1. 动画和渲染循环
- ✅ AudioVisualizer: 已优化 (30fps + 窗口状态检测)
- ✅ ShaderBackground: 已优化 (12fps + 窗口状态检测)
- ⚠️ GlobalBackground 视频: 需要在隐藏时清空缓冲区
- ⚠️ FullPlay 背景烘焙: 需要优化时机和缓存清理

### 2. 定时器和轮询
- ⚠️ podcast.vue: 2个定时器 (二维码轮询 2.5s, 推荐刷新 15min)
- ⚠️ PlayMusic.vue: DLNA同步 1s 间隔
- ⚠️ 大量组件的 setTimeout/setInterval 需要在页面闲置时清理

### 3. 内存泄漏风险
- ⚠️ 定时器未正确清理
- ⚠️ 事件监听器未移除
- ⚠️ ResizeObserver/IntersectionObserver 未断开
- ⚠️ AudioContext/AnalyserNode 未释放
- ⚠️ Canvas/WebGL 上下文未清理

### 4. 闲置优化
- ✅ idleSleep 机制已存在
- ⚠️ 需要确保所有组件正确响应 ceru-sleep/ceru-wake 事件

## 执行步骤

### Phase 1: 核心渲染优化 (已完成)
- ✅ AudioVisualizer 帧率控制 + 窗口状态检测
- ✅ ShaderBackground 帧率控制 + 窗口状态检测

### Phase 2: 定时器优化 (进行中)
- [ ] podcast.vue 定时器优化
- [ ] PlayMusic.vue DLNA 同步优化
- [ ] 全局定时器审计和清理

### Phase 3: 内存管理 (计划中)
- [ ] 确保所有组件正确清理资源
- [ ] 添加内存泄漏检测工具
- [ ] 优化图片/视频缓存策略

### Phase 4: 验证测试 (最后)
- [ ] 空闲状态性能测试
- [ ] 最小化状态测试
- [ ] 全屏播放性能测试
- [ ] 内存泄漏测试

## 当前执行: Phase 2 定时器优化
