#!/bin/bash
# 监控正在运行的树夏 Music 应用

echo "=== 实时监控树夏 Music 性能 ==="
echo ""
echo "主进程 PID: 34327"
echo ""

# 获取所有相关进程
echo "1. 所有相关进程："
ps aux | grep -E "34327|34335|树夏|ceru" | grep -v grep | awk '{printf "PID: %s | CPU: %s%% | MEM: %s%% | RSS: %sMB | CMD: %s\n", $2, $3, $4, int($6/1024), substr($0, index($0,$11))}'

echo ""
echo "2. 内存详细统计："
vmmap 34327 2>/dev/null | grep -E "REGION|TOTAL|Physical|Virtual" | head -20

echo ""
echo "3. 线程统计："
ps -M 34327 2>/dev/null | head -20

echo ""
echo "4. 打开的文件描述符："
lsof -p 34327 2>/dev/null | wc -l

echo ""
echo "5. 网络连接："
lsof -i -n -P | grep 34327 | head -10

echo ""
echo "=== 持续监控 60 秒（每 5 秒采样）==="
for i in {1..12}; do
    echo ""
    echo "--- 采样 $i/12 ($(date +%H:%M:%S)) ---"
    ps aux | grep -E "34327|34335" | grep -v grep | awk '{printf "PID %s: CPU=%s%% MEM=%s%% RSS=%sMB\n", $2, $3, $4, int($6/1024)}'
    sleep 5
done

echo ""
echo "=== 监控完成 ==="
