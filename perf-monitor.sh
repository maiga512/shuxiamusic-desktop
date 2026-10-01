#!/bin/bash
# 树夏Music 性能监控脚本
# 用途：采集主进程、WebContent、MPV、Sidecar 的 CPU 和内存数据

INTERVAL=${1:-2}  # 采样间隔秒数，默认2秒
DURATION=${2:-30} # 采样持续时间，默认30秒
OUTPUT_FILE=${3:-perf-data.csv}

echo "timestamp,process_name,pid,cpu_percent,rss_mb,vsz_mb" > "$OUTPUT_FILE"

START_TIME=$(date +%s)
END_TIME=$((START_TIME + DURATION))

echo "开始采样，间隔 ${INTERVAL}s，持续 ${DURATION}s"
echo "输出文件: $OUTPUT_FILE"

while [ $(date +%s) -lt $END_TIME ]; do
    TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
    
    # 查找所有相关进程
    ps aux | grep -E 'ceru-music|mpv.*ceru|WebKit.*WebContent|node.*sidecar' | grep -v grep | while read line; do
        USER=$(echo "$line" | awk '{print $1}')
        PID=$(echo "$line" | awk '{print $2}')
        CPU=$(echo "$line" | awk '{print $3}')
        MEM_PERCENT=$(echo "$line" | awk '{print $4}')
        VSZ=$(echo "$line" | awk '{print $5}')
        RSS=$(echo "$line" | awk '{print $6}')
        COMMAND=$(echo "$line" | awk '{for(i=11;i<=NF;i++) printf $i" "; print ""}')
        
        # 简化进程名
        if echo "$COMMAND" | grep -q "ceru-music"; then
            PROCESS_NAME="ceru-music"
        elif echo "$COMMAND" | grep -q "mpv"; then
            PROCESS_NAME="mpv"
        elif echo "$COMMAND" | grep -q "WebContent"; then
            PROCESS_NAME="WebContent"
        elif echo "$COMMAND" | grep -q "sidecar"; then
            PROCESS_NAME="sidecar"
        else
            PROCESS_NAME="other"
        fi
        
        # 转换内存单位为 MB
        RSS_MB=$(echo "scale=2; $RSS / 1024" | bc)
        VSZ_MB=$(echo "scale=2; $VSZ / 1024" | bc)
        
        echo "$TIMESTAMP,$PROCESS_NAME,$PID,$CPU,$RSS_MB,$VSZ_MB" >> "$OUTPUT_FILE"
    done
    
    sleep "$INTERVAL"
done

echo "采样完成，数据已保存到 $OUTPUT_FILE"

# 生成简单的统计摘要
echo ""
echo "=== 统计摘要 ==="
awk -F',' 'NR>1 {sum[$2]++; cpu[$2]+=$4; rss[$2]+=$5} END {
    for (proc in sum) {
        printf "进程: %-15s 采样次数: %3d  平均CPU: %6.2f%%  平均内存: %8.2f MB\n", 
               proc, sum[proc], cpu[proc]/sum[proc], rss[proc]/sum[proc]
    }
}' "$OUTPUT_FILE" | sort -k6 -nr
