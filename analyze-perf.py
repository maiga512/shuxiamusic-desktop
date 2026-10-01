#!/usr/bin/env python3
"""
树夏Music 性能测试数据分析脚本
分析 CPU、内存趋势，识别泄漏和热点
"""

import pandas as pd
import sys
from pathlib import Path

def analyze_csv(filepath, label):
    """分析单个 CSV 文件"""
    if not Path(filepath).exists():
        print(f"⚠️  文件不存在: {filepath}")
        return None
    
    df = pd.read_csv(filepath)
    
    if df.empty:
        print(f"⚠️  {label}: 数据为空")
        return None
    
    # 转换为 MB
    df['ceru_rss_mb'] = df['ceru_rss_kb'] / 1024
    df['mpv_rss_mb'] = df['mpv_rss_kb'] / 1024
    
    stats = {
        'label': label,
        'samples': len(df),
        'ceru_cpu_avg': df['ceru_cpu'].mean(),
        'ceru_cpu_max': df['ceru_cpu'].max(),
        'ceru_rss_avg': df['ceru_rss_mb'].mean(),
        'ceru_rss_min': df['ceru_rss_mb'].min(),
        'ceru_rss_max': df['ceru_rss_mb'].max(),
        'ceru_rss_growth': df['ceru_rss_mb'].max() - df['ceru_rss_mb'].min(),
        'mpv_cpu_avg': df['mpv_cpu'].mean(),
        'mpv_cpu_max': df['mpv_cpu'].max(),
        'mpv_rss_avg': df['mpv_rss_mb'].mean(),
        'mpv_rss_max': df['mpv_rss_mb'].max(),
    }
    
    return stats

def main():
    if len(sys.argv) < 2:
        print("用法: python3 analyze-perf.py <测试目录>")
        print("示例: python3 analyze-perf.py perf-test-20261001-091500/")
        sys.exit(1)
    
    test_dir = Path(sys.argv[1])
    
    if not test_dir.exists():
        print(f"❌ 目录不存在: {test_dir}")
        sys.exit(1)
    
    print("=" * 80)
    print("树夏Music 性能分析报告")
    print("=" * 80)
    print(f"测试目录: {test_dir}")
    print()
    
    # 分析各个场景
    scenarios = [
        ('baseline-normal.csv', '普通播放基线'),
        ('normal-switching.csv', '普通界面连续切歌'),
        ('baseline-fullscreen.csv', '全屏播放基线'),
        ('fullscreen-switching.csv', '全屏连续切歌'),
        ('after-fullscreen-exit.csv', '退出全屏后'),
    ]
    
    results = []
    for filename, label in scenarios:
        filepath = test_dir / filename
        stats = analyze_csv(filepath, label)
        if stats:
            results.append(stats)
    
    if not results:
        print("❌ 没有有效的测试数据")
        sys.exit(1)
    
    # 打印统计表格
    print("\n" + "=" * 80)
    print("场景统计摘要")
    print("=" * 80)
    print()
    
    header = f"{'场景':<20} {'样本':<6} {'Ceru CPU':<12} {'Ceru 内存(MB)':<25} {'内存增长':<12}"
    print(header)
    print("-" * 80)
    
    for r in results:
        line = (f"{r['label']:<20} "
                f"{r['samples']:<6} "
                f"{r['ceru_cpu_avg']:5.1f}% "
                f"(峰{r['ceru_cpu_max']:4.1f}%) "
                f"{r['ceru_rss_avg']:6.1f} "
                f"({r['ceru_rss_min']:5.1f}~{r['ceru_rss_max']:5.1f}) "
                f"+{r['ceru_rss_growth']:5.1f} MB")
        print(line)
    
    print()
    print("=" * 80)
    print("MPV 后端统计")
    print("=" * 80)
    print()
    
    header = f"{'场景':<20} {'MPV CPU':<15} {'MPV 内存(MB)':<15}"
    print(header)
    print("-" * 80)
    
    for r in results:
        line = (f"{r['label']:<20} "
                f"{r['mpv_cpu_avg']:5.1f}% "
                f"(峰{r['mpv_cpu_max']:4.1f}%) "
                f"{r['mpv_rss_avg']:6.1f} "
                f"(峰{r['mpv_rss_max']:5.1f})")
        print(line)
    
    # 关键发现
    print()
    print("=" * 80)
    print("关键发现")
    print("=" * 80)
    print()
    
    # 找到内存增长最大的场景
    max_growth = max(results, key=lambda x: x['ceru_rss_growth'])
    print(f"📈 最大内存增长: {max_growth['label']}")
    print(f"   增长量: +{max_growth['ceru_rss_growth']:.1f} MB")
    
    if max_growth['ceru_rss_growth'] > 50:
        print(f"   ⚠️  警告：内存增长超过 50 MB，可能存在泄漏")
    
    # 找到 CPU 峰值最高的场景
    max_cpu = max(results, key=lambda x: x['ceru_cpu_max'])
    print()
    print(f"🔥 最高 CPU 峰值: {max_cpu['label']}")
    print(f"   峰值: {max_cpu['ceru_cpu_max']:.1f}%")
    
    if max_cpu['ceru_cpu_max'] > 80:
        print(f"   ⚠️  警告：CPU 峰值超过 80%，可能影响用户体验")
    
    # 对比普通播放和全屏播放
    normal = next((r for r in results if r['label'] == '普通播放基线'), None)
    fullscreen = next((r for r in results if r['label'] == '全屏播放基线'), None)
    
    if normal and fullscreen:
        cpu_diff = fullscreen['ceru_cpu_avg'] - normal['ceru_cpu_avg']
        mem_diff = fullscreen['ceru_rss_avg'] - normal['ceru_rss_avg']
        
        print()
        print(f"📊 全屏 vs 普通播放对比:")
        print(f"   CPU 增加: {cpu_diff:+.1f}% ({normal['ceru_cpu_avg']:.1f}% → {fullscreen['ceru_cpu_avg']:.1f}%)")
        print(f"   内存增加: {mem_diff:+.1f} MB ({normal['ceru_rss_avg']:.1f} MB → {fullscreen['ceru_rss_avg']:.1f} MB)")
    
    # 对比切歌前后
    normal_base = next((r for r in results if r['label'] == '普通播放基线'), None)
    normal_switch = next((r for r in results if r['label'] == '普通界面连续切歌'), None)
    
    if normal_base and normal_switch:
        mem_growth = normal_switch['ceru_rss_growth']
        print()
        print(f"🎵 普通界面切歌内存表现:")
        print(f"   20 次切歌后内存增长: +{mem_growth:.1f} MB")
        
        if mem_growth > 30:
            print(f"   ⚠️  警告：切歌内存增长过大，可能存在资源未释放")
            print(f"   建议检查：URL 缓存、歌词实例、封面解码、事件监听器")
    
    fullscreen_base = next((r for r in results if r['label'] == '全屏播放基线'), None)
    fullscreen_switch = next((r for r in results if r['label'] == '全屏连续切歌'), None)
    
    if fullscreen_base and fullscreen_switch:
        mem_growth = fullscreen_switch['ceru_rss_growth']
        print()
        print(f"🎵 全屏界面切歌内存表现:")
        print(f"   20 次切歌后内存增长: +{mem_growth:.1f} MB")
        
        if mem_growth > 50:
            print(f"   ⚠️  警告：全屏切歌内存增长严重")
            print(f"   建议检查：AMLL 歌词实例、背景烘焙缓存、封面解码、字体加载")
    
    # 退出全屏后内存释放
    after_exit = next((r for r in results if r['label'] == '退出全屏后'), None)
    if fullscreen_switch and after_exit:
        mem_released = fullscreen_switch['ceru_rss_max'] - after_exit['ceru_rss_avg']
        print()
        print(f"🔄 退出全屏后内存释放:")
        print(f"   全屏峰值: {fullscreen_switch['ceru_rss_max']:.1f} MB")
        print(f"   退出后: {after_exit['ceru_rss_avg']:.1f} MB")
        print(f"   释放量: {mem_released:.1f} MB")
        
        if mem_released < 20 and fullscreen_switch['ceru_rss_growth'] > 50:
            print(f"   ⚠️  警告：退出全屏后内存释放不充分")
            print(f"   建议检查：全屏组件 unmount、AMLL dispose、背景图清理")
    
    print()
    print("=" * 80)
    print("优化建议优先级")
    print("=" * 80)
    print()
    
    # 根据数据生成优化建议
    issues = []
    
    if normal_switch and normal_switch['ceru_rss_growth'] > 30:
        issues.append({
            'priority': 'HIGH',
            'area': '普通播放切歌内存增长',
            'value': f"+{normal_switch['ceru_rss_growth']:.1f} MB",
            'suggestion': '检查切歌时的 URL 缓存、歌词请求取消、封面解码缓存上限'
        })
    
    if fullscreen_switch and fullscreen_switch['ceru_rss_growth'] > 50:
        issues.append({
            'priority': 'HIGH',
            'area': '全屏切歌内存增长',
            'value': f"+{fullscreen_switch['ceru_rss_growth']:.1f} MB",
            'suggestion': '检查 AMLL 歌词实例复用、背景烘焙缓存策略、封面图生命周期'
        })
    
    if fullscreen and fullscreen['ceru_cpu_avg'] > 20:
        issues.append({
            'priority': 'MEDIUM',
            'area': '全屏 CPU 占用',
            'value': f"{fullscreen['ceru_cpu_avg']:.1f}%",
            'suggestion': '检查歌词滚动更新频率、背景烘焙触发条件、进度更新时钟'
        })
    
    if max_cpu['ceru_cpu_max'] > 80:
        issues.append({
            'priority': 'MEDIUM',
            'area': 'CPU 峰值',
            'value': f"{max_cpu['ceru_cpu_max']:.1f}%",
            'suggestion': '使用 Safari/Chrome DevTools Performance 定位 JS 热点函数'
        })
    
    if not issues:
        print("✅ 未发现明显的性能问题")
    else:
        for idx, issue in enumerate(issues, 1):
            print(f"{idx}. [{issue['priority']}] {issue['area']}")
            print(f"   当前值: {issue['value']}")
            print(f"   建议: {issue['suggestion']}")
            print()
    
    print("=" * 80)
    print("分析完成")
    print("=" * 80)

if __name__ == '__main__':
    main()
