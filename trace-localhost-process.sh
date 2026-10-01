#!/bin/bash
# 追踪 tauri://localhost 进程

echo "=== 追踪 tauri://localhost 高内存消耗 ==="
echo ""

# 从活动监视器看，tauri://localhost 是 1.84GB
# 这通常是主 WebView 进程

echo "1. 查找 WebView 进程："
ps aux | grep -i "webview\|webkit\|helper\|renderer" | grep -E "34327|34329|34330|34331|34335" | grep -v grep

echo ""
echo "2. 所有树夏 Music 进程按内存排序："
ps aux | grep -E "树夏|ceru|34327|34329|34330|34331|34335" | grep -v grep | sort -k4 -r

echo ""
echo "3. 检查 GPU 进程："
ps aux | grep -E "34329.*Graphics" | grep -v grep

echo ""
echo "4. Heap 分析（需要一点时间）："
for pid in 34327 34329; do
    if ps -p $pid > /dev/null 2>&1; then
        echo ""
        echo "--- PID $pid Heap Summary ---"
        heap $pid 2>/dev/null | grep -E "TOTAL|Zone|malloc" | head -10
    fi
done

