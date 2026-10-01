#!/bin/bash
# 简化版性能采样：直接在脚本执行环境采集，避免子进程 ps 权限问题

INTERVAL=${1:-2}
DURATION=${2:-30}
OUTPUT=${3:-perf-snapshot.csv}

echo "timestamp,ceru_pid,ceru_cpu,ceru_rss_mb,mpv_pid,mpv_cpu,mpv_rss_mb" > "$OUTPUT"

END_TIME=$(($(date +%s) + DURATION))

while [ $(date +%s) -lt $END_TIME ]; do
    TIMESTAMP=$(date +%s)
    
    # 直接在当前 shell 中执行 ps
    DATA=$(ps aux | grep -E 'ceru-music|mpv.*ceru' | grep -v grep)
    
    CERU_LINE=$(echo "$DATA" | grep 'ceru-music' | head -1)
    MPV_LINE=$(echo "$DATA" | grep 'mpv' | head -1)
    
    if [ -n "$CERU_LINE" ]; then
        CERU_PID=$(echo "$CERU_LINE" | awk '{print $2}')
        CERU_CPU=$(echo "$CERU_LINE" | awk '{print $3}')
        CERU_RSS=$(echo "$CERU_LINE" | awk '{print $6}')
        CERU_RSS_MB=$(echo "scale=2; $CERU_RSS/1024" | bc)
    else
        CERU_PID="-"; CERU_CPU="0"; CERU_RSS_MB="0"
    fi
    
    if [ -n "$MPV_LINE" ]; then
        MPV_PID=$(echo "$MPV_LINE" | awk '{print $2}')
        MPV_CPU=$(echo "$MPV_LINE" | awk '{print $3}')
        MPV_RSS=$(echo "$MPV_LINE" | awk '{print $6}')
        MPV_RSS_MB=$(echo "scale=2; $MPV_RSS/1024" | bc)
    else
        MPV_PID="-"; MPV_CPU="0"; MPV_RSS_MB="0"
    fi
    
    echo "$TIMESTAMP,$CERU_PID,$CERU_CPU,$CERU_RSS_MB,$MPV_PID,$MPV_CPU,$MPV_RSS_MB" >> "$OUTPUT"
    
    sleep "$INTERVAL"
done

echo ""
echo "采样完成: $OUTPUT"
echo ""
echo "=== 摘要 ==="
awk -F',' 'NR>1 {
    ceru_cpu+=$3; ceru_rss+=$4; mpv_cpu+=$6; mpv_rss+=$7; count++
} END {
    printf "Ceru主进程: 平均CPU %.2f%%  平均内存 %.2f MB\n", ceru_cpu/count, ceru_rss/count
    printf "MPV后端:    平均CPU %.2f%%  平均内存 %.2f MB\n", mpv_cpu/count, mpv_rss/count
}' "$OUTPUT"
