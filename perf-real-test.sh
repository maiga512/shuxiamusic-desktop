#!/bin/bash
# 真实性能探测脚本

echo "=== 开始真实性能探测 ==="
echo ""

# 1. 检查进程
echo "1. 当前进程状态："
ps aux | grep -E "树夏Music|tauri|ceru" | grep -v grep

echo -e "\n2. 端口监听："
lsof -iTCP -sTCP:LISTEN | grep 1421

echo -e "\n3. 内存详细分析："
# 等待应用启动
sleep 3
echo "等待 Tauri 应用启动..."

# 持续监控 5 分钟，每 10 秒采样
echo -e "\n4. 持续性能监控（5分钟，每10秒采样）："
for i in {1..30}; do
    echo "--- 采样 $i/30 ---"
    ps aux | grep -E "树夏Music|tauri://localhost" | grep -v grep | awk '{print $2, $3, $4, $6, $11}' | head -10
    sleep 10
done

echo -e "\n=== 探测完成 ==="
