#!/bin/bash
# 分析 WebView 内存消耗

echo "=== WebView 内存分析 ==="
echo ""

# 查找所有树夏 Music 相关进程
echo "1. 进程树："
pstree -p 34327 2>/dev/null || ps -ejH | grep -E "34327|34335|树夏"

echo ""
echo "2. 每个进程的详细内存："
for pid in 34327 34335 34329 34331; do
    if ps -p $pid > /dev/null 2>&1; then
        echo ""
        echo "--- PID $pid ---"
        ps aux | grep "^[^ ]* *$pid " | awk '{printf "CPU: %s%% | MEM: %s%% | RSS: %sMB | VSZ: %sMB\n", $3, $4, int($6/1024), int($5/1024)}'
        
        # 获取进程名称
        ps -p $pid -o comm= 2>/dev/null
        
        # 内存区域统计
        vmmap $pid 2>/dev/null | tail -5
    fi
done

echo ""
echo "3. 总计算："
echo "主进程 + 所有子进程的总内存消耗："
ps aux | grep -E "34327|34335|34329|34331" | grep -v grep | awk '{sum+=$6} END {printf "总 RSS: %.2f GB\n", sum/1024/1024}'

