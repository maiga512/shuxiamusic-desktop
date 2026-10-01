#!/bin/bash
# 树夏Music 完整性能测试套件
# 需要在本地终端（非沙盒）执行，因为需要 ps 命令权限

set -e

PERF_DIR="perf-test-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$PERF_DIR"
cd "$PERF_DIR"

echo "=========================================="
echo "树夏Music 性能测试套件"
echo "输出目录: $PERF_DIR"
echo "=========================================="
echo ""

# ============================================
# 阶段 1: 普通播放基线
# ============================================
echo "阶段 1: 普通播放基线采样（30秒）"
echo "请确保应用正在正常播放一首歌曲..."
read -p "按回车开始采样..."

echo "timestamp,ceru_pid,ceru_cpu,ceru_rss_kb,mpv_pid,mpv_cpu,mpv_rss_kb" > baseline-normal.csv

for i in {1..15}; do
    TIMESTAMP=$(date +%s)
    DATA=$(ps aux | grep -E 'ceru-music|mpv.*ceru' | grep -v grep)
    
    CERU=$(echo "$DATA" | grep 'ceru-music' | head -1)
    MPV=$(echo "$DATA" | grep 'mpv' | head -1)
    
    CERU_PID=$(echo "$CERU" | awk '{print $2}')
    CERU_CPU=$(echo "$CERU" | awk '{print $3}')
    CERU_RSS=$(echo "$CERU" | awk '{print $6}')
    
    MPV_PID=$(echo "$MPV" | awk '{print $2}')
    MPV_CPU=$(echo "$MPV" | awk '{print $3}')
    MPV_RSS=$(echo "$MPV" | awk '{print $6}')
    
    echo "$TIMESTAMP,$CERU_PID,$CERU_CPU,$CERU_RSS,$MPV_PID,$MPV_CPU,$MPV_RSS" >> baseline-normal.csv
    echo "  [$i/15] Ceru CPU: ${CERU_CPU}%  RSS: ${CERU_RSS}KB | MPV CPU: ${MPV_CPU}%  RSS: ${MPV_RSS}KB"
    sleep 2
done

echo "✓ 普通播放基线采样完成"
echo ""

# ============================================
# 阶段 2: 普通界面连续切歌
# ============================================
echo "阶段 2: 普通界面连续切歌测试（20次）"
echo "脚本将自动控制播放器切换下一首歌曲..."
read -p "按回车开始测试..."

echo "timestamp,action,ceru_pid,ceru_cpu,ceru_rss_kb,mpv_pid,mpv_cpu,mpv_rss_kb" > normal-switching.csv

for i in {1..20}; do
    # 触发下一首
    osascript -e 'tell application "System Events" to keystroke "]" using {command down}' 2>/dev/null || true
    
    sleep 1
    
    TIMESTAMP=$(date +%s)
    DATA=$(ps aux | grep -E 'ceru-music|mpv.*ceru' | grep -v grep)
    
    CERU=$(echo "$DATA" | grep 'ceru-music' | head -1)
    MPV=$(echo "$DATA" | grep 'mpv' | head -1)
    
    CERU_PID=$(echo "$CERU" | awk '{print $2}')
    CERU_CPU=$(echo "$CERU" | awk '{print $3}')
    CERU_RSS=$(echo "$CERU" | awk '{print $6}')
    
    MPV_PID=$(echo "$MPV" | awk '{print $2}')
    MPV_CPU=$(echo "$MPV" | awk '{print $3}')
    MPV_RSS=$(echo "$MPV" | awk '{print $6}')
    
    echo "$TIMESTAMP,next_track,$CERU_PID,$CERU_CPU,$CERU_RSS,$MPV_PID,$MPV_CPU,$MPV_RSS" >> normal-switching.csv
    echo "  [切歌 $i/20] Ceru: ${CERU_CPU}% / ${CERU_RSS}KB | MPV: ${MPV_CPU}% / ${MPV_RSS}KB"
    
    sleep 2
done

echo "✓ 普通界面切歌测试完成"
echo ""

# ============================================
# 阶段 3: 进入全屏并采样
# ============================================
echo "阶段 3: 全屏播放基线采样"
echo "请手动进入全屏模式（双击播放器或快捷键）..."
read -p "进入全屏后按回车开始采样..."

echo "timestamp,ceru_pid,ceru_cpu,ceru_rss_kb,mpv_pid,mpv_cpu,mpv_rss_kb" > baseline-fullscreen.csv

for i in {1..15}; do
    TIMESTAMP=$(date +%s)
    DATA=$(ps aux | grep -E 'ceru-music|mpv.*ceru' | grep -v grep)
    
    CERU=$(echo "$DATA" | grep 'ceru-music' | head -1)
    MPV=$(echo "$DATA" | grep 'mpv' | head -1)
    
    CERU_PID=$(echo "$CERU" | awk '{print $2}')
    CERU_CPU=$(echo "$CERU" | awk '{print $3}')
    CERU_RSS=$(echo "$CERU" | awk '{print $6}')
    
    MPV_PID=$(echo "$MPV" | awk '{print $2}')
    MPV_CPU=$(echo "$MPV" | awk '{print $3}')
    MPV_RSS=$(echo "$MPV" | awk '{print $6}')
    
    echo "$TIMESTAMP,$CERU_PID,$CERU_CPU,$CERU_RSS,$MPV_PID,$MPV_CPU,$MPV_RSS" >> baseline-fullscreen.csv
    echo "  [$i/15] 全屏 Ceru: ${CERU_CPU}% / ${CERU_RSS}KB | MPV: ${MPV_CPU}% / ${MPV_RSS}KB"
    sleep 2
done

echo "✓ 全屏基线采样完成"
echo ""

# ============================================
# 阶段 4: 全屏连续切歌
# ============================================
echo "阶段 4: 全屏连续切歌测试（20次）"
echo "保持全屏状态，脚本将自动切换歌曲..."
read -p "按回车开始测试..."

echo "timestamp,action,ceru_pid,ceru_cpu,ceru_rss_kb,mpv_pid,mpv_cpu,mpv_rss_kb" > fullscreen-switching.csv

for i in {1..20}; do
    # 触发下一首
    osascript -e 'tell application "System Events" to keystroke "]" using {command down}' 2>/dev/null || true
    
    sleep 1
    
    TIMESTAMP=$(date +%s)
    DATA=$(ps aux | grep -E 'ceru-music|mpv.*ceru' | grep -v grep)
    
    CERU=$(echo "$DATA" | grep 'ceru-music' | head -1)
    MPV=$(echo "$DATA" | grep 'mpv' | head -1)
    
    CERU_PID=$(echo "$CERU" | awk '{print $2}')
    CERU_CPU=$(echo "$CERU" | awk '{print $3}')
    CERU_RSS=$(echo "$CERU" | awk '{print $6}')
    
    MPV_PID=$(echo "$MPV" | awk '{print $2}')
    MPV_CPU=$(echo "$MPV" | awk '{print $3}')
    MPV_RSS=$(echo "$MPV" | awk '{print $6}')
    
    echo "$TIMESTAMP,next_track,$CERU_PID,$CERU_CPU,$CERU_RSS,$MPV_PID,$MPV_CPU,$MPV_RSS" >> fullscreen-switching.csv
    echo "  [全屏切歌 $i/20] Ceru: ${CERU_CPU}% / ${CERU_RSS}KB | MPV: ${MPV_CPU}% / ${MPV_RSS}KB"
    
    sleep 2
done

echo "✓ 全屏切歌测试完成"
echo ""

# ============================================
# 阶段 5: 退出全屏观察内存释放
# ============================================
echo "阶段 5: 退出全屏后内存释放观察"
echo "请手动退出全屏（ESC 或双击）..."
read -p "退出全屏后按回车开始观察..."

echo "timestamp,ceru_pid,ceru_cpu,ceru_rss_kb,mpv_pid,mpv_cpu,mpv_rss_kb" > after-fullscreen-exit.csv

for i in {1..15}; do
    TIMESTAMP=$(date +%s)
    DATA=$(ps aux | grep -E 'ceru-music|mpv.*ceru' | grep -v grep)
    
    CERU=$(echo "$DATA" | grep 'ceru-music' | head -1)
    MPV=$(echo "$DATA" | grep 'mpv' | head -1)
    
    CERU_PID=$(echo "$CERU" | awk '{print $2}')
    CERU_CPU=$(echo "$CERU" | awk '{print $3}')
    CERU_RSS=$(echo "$CERU" | awk '{print $6}')
    
    MPV_PID=$(echo "$MPV" | awk '{print $2}')
    MPV_CPU=$(echo "$MPV" | awk '{print $3}')
    MPV_RSS=$(echo "$MPV" | awk '{print $6}')
    
    echo "$TIMESTAMP,$CERU_PID,$CERU_CPU,$CERU_RSS,$MPV_PID,$MPV_CPU,$MPV_RSS" >> after-fullscreen-exit.csv
    echo "  [$i/15] 退出全屏后 Ceru: ${CERU_CPU}% / ${CERU_RSS}KB | MPV: ${MPV_CPU}% / ${MPV_RSS}KB"
    sleep 2
done

echo "✓ 退出全屏观察完成"
echo ""

# ============================================
# 生成统计报告
# ============================================
echo "=========================================="
echo "生成统计报告..."
echo "=========================================="

cat > REPORT.md << 'EOF'
# 树夏Music 性能测试报告

## 测试环境
- 测试时间: $(date)
- macOS 版本: $(sw_vers -productVersion)
- 应用版本: 树夏Music

## 测试场景

### 1. 普通播放基线
文件: `baseline-normal.csv`
持续时间: 30秒
采样间隔: 2秒

### 2. 普通界面连续切歌
文件: `normal-switching.csv`
切歌次数: 20次
每次间隔: 约3秒

### 3. 全屏播放基线
文件: `baseline-fullscreen.csv`
持续时间: 30秒
采样间隔: 2秒

### 4. 全屏连续切歌
文件: `fullscreen-switching.csv`
切歌次数: 20次
每次间隔: 约3秒

### 5. 退出全屏后观察
文件: `after-fullscreen-exit.csv`
持续时间: 30秒
采样间隔: 2秒

## 分析方法

使用以下 Python 脚本分析数据：

```python
import pandas as pd
import matplotlib.pyplot as plt

# 读取数据
baseline_normal = pd.read_csv('baseline-normal.csv')
normal_switching = pd.read_csv('normal-switching.csv')
baseline_fullscreen = pd.read_csv('baseline-fullscreen.csv')
fullscreen_switching = pd.read_csv('fullscreen-switching.csv')
after_exit = pd.read_csv('after-fullscreen-exit.csv')

# 分析内存增长趋势
print("普通播放基线 - Ceru 平均内存:", baseline_normal['ceru_rss_kb'].mean() / 1024, "MB")
print("普通切歌后 - Ceru 平均内存:", normal_switching['ceru_rss_kb'].mean() / 1024, "MB")
print("全屏播放基线 - Ceru 平均内存:", baseline_fullscreen['ceru_rss_kb'].mean() / 1024, "MB")
print("全屏切歌后 - Ceru 平均内存:", fullscreen_switching['ceru_rss_kb'].mean() / 1024, "MB")
print("退出全屏后 - Ceru 平均内存:", after_exit['ceru_rss_kb'].mean() / 1024, "MB")
```

## 原始数据文件

所有 CSV 文件已保存在当前目录。
EOF

echo "✓ 报告模板已生成: REPORT.md"
echo ""
echo "=========================================="
echo "测试完成！"
echo "所有数据已保存在: $PERF_DIR"
echo "=========================================="
echo ""
echo "下一步："
echo "1. 使用 Python/Excel 分析 CSV 数据"
echo "2. 对比各阶段的 CPU 和内存变化"
echo "3. 识别内存增长和 CPU 峰值"
