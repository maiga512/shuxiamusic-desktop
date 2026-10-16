<template>
  <div class="music-cache">
    <t-card hover-shadow :loading="!cacheInfo || cacheInfo.clearing" title="本地歌曲缓存">
      <template #actions>
        已缓存 {{ cacheInfo?.count || 0 }} 首 · {{ cacheInfo?.sizeFormatted || '0 B' }}
      </template>

      <p class="cache-desc">
        这里统计的是<b>在线听歌自动落盘</b>的音频缓存（受上方"自动缓存音乐"开关控制）。
        你点"下载"的歌曲保存在"下载目录"，不算这里。
      </p>

      <!-- 缓存容量上限滑块 -->
      <div class="limit-section">
        <div class="limit-header">
          <span class="limit-label">缓存容量上限</span>
          <t-tag theme="primary" variant="light">{{ limitFormatted }}</t-tag>
        </div>
        <t-slider
          v-model="limitGb"
          :min="1"
          :max="20"
          :step="1"
          :marks="sliderMarks"
          @change="onLimitChange"
        />
        <div class="limit-tip">超出上限时自动删除最久未播放的缓存歌曲（LRU）</div>
      </div>

      <!-- 容量使用进度 -->
      <div class="usage-bar">
        <div class="usage-fill" :style="{ width: usagePercent + '%' }"></div>
      </div>
      <div class="usage-text">
        已用 {{ cacheInfo?.sizeFormatted || '0 B' }} / {{ limitFormatted }}
        <span v-if="usagePercent > 90" class="usage-warn">（接近上限）</span>
      </div>

      <!-- 已缓存歌曲列表 -->
      <div v-if="cacheEntries.length > 0" class="cache-list">
        <div class="cache-list-header">
          <span>已缓存歌曲</span>
          <t-button size="small" variant="text" @click="loadCacheInfo(true)">刷新</t-button>
        </div>
        <div class="cache-list-body">
          <div v-for="item in cacheEntries" :key="item.path" class="cache-item">
            <div class="cache-item-info">
              <div class="cache-item-name">{{ item.name }}</div>
              <div class="cache-item-artist">{{ item.artist || '未知歌手' }}</div>
            </div>
            <div class="cache-item-size">{{ item.sizeFormatted }}</div>
          </div>
          <div v-if="cacheInfo?.count > cacheEntries.length" class="cache-more">
            还有 {{ cacheInfo.count - cacheEntries.length }} 首...
          </div>
        </div>
      </div>

      <!-- 操作按钮 -->
      <div class="card-body">
        <t-button
          size="large"
          theme="danger"
          variant="outline"
          :loading="cacheInfo?.clearing"
          :disabled="!cacheInfo?.count || cacheInfo?.count === 0"
          @click="clearCache"
        >
          {{ cacheInfo?.clearing ? '正在清除...' : '清除全部缓存' }}
        </t-button>
        <div v-if="!cacheInfo?.count || cacheInfo?.count === 0" class="no-cache-tip">
          暂无缓存文件
        </div>
      </div>
    </t-card>
  </div>
</template>

<script lang="ts" setup>
import { DialogPlugin, MessagePlugin } from 'tdesign-vue-next'
import { computed, onMounted, ref } from 'vue'

const emit = defineEmits<{ 'cache-cleared': [] }>()

const cacheInfo: any = ref({})
const limitGb = ref(5)

const sliderMarks = { 1: '1G', 5: '5G', 10: '10G', 15: '15G', 20: '20G' }

const cacheEntries = computed(() => cacheInfo.value?.entries || [])

const limitFormatted = computed(() => `${limitGb.value} GB`)

const usagePercent = computed(() => {
  const max = limitGb.value * 1024 * 1024 * 1024
  const used = cacheInfo.value?.size || 0
  return max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0
})

const loadCacheInfo = async (forceRefresh = false) => {
  try {
    const res = await window.api.musicCache.getInfo()
    cacheInfo.value = res
    // 从后端读取实际上限（用户可能在别处改过）
    try {
      const limit = await window.api.musicCache.getLimit()
      if (limit?.bytes > 0) {
        limitGb.value = Math.round(limit.bytes / (1024 * 1024 * 1024))
      }
    } catch {}
  } catch (error) {
    console.error('获取缓存信息失败:', error)
    MessagePlugin.error('获取缓存信息失败')
  }
}

const onLimitChange = async (val: any) => {
  // TDesign slider 的 change 事件可能给 number 或 number[]，取第一个数
  const num = Array.isArray(val) ? Number(val[0]) : Number(val)
  if (!Number.isFinite(num) || num <= 0) return
  limitGb.value = num
  const bytes = num * 1024 * 1024 * 1024
  try {
    const result = await window.api.musicCache.setLimit(bytes)
    if (result?.success !== false) {
      MessagePlugin.success(`缓存上限已设为 ${num} GB`)
      // 重新加载，显示淘汰后的实际大小
      setTimeout(() => void loadCacheInfo(true), 300)
    }
  } catch (error) {
    console.error('设置缓存上限失败:', error)
    MessagePlugin.error('设置缓存上限失败')
  }
}

const clearCache = () => {
  const confirm = DialogPlugin.confirm({
    header: '确认清除缓存吗',
    body: '这可能会导致歌曲加载缓慢，你确定要清除所有缓存吗？',
    confirmBtn: '确定清除',
    cancelBtn: '我再想想',
    placement: 'center',
    onClose: () => { confirm.hide() },
    onConfirm: async () => {
      confirm.hide()
      try {
        cacheInfo.value = { ...cacheInfo.value, clearing: true }
        const result = await window.api.musicCache.clear()
        if (result?.success !== false) {
          MessagePlugin.success('缓存清除成功')
          emit('cache-cleared')
          cacheInfo.value = { count: 0, size: 0, sizeFormatted: '0 B', entries: [], clearing: false }
          setTimeout(() => void loadCacheInfo(true), 500)
        } else {
          MessagePlugin.error(result?.message || '缓存清除失败')
          delete cacheInfo.value.clearing
        }
      } catch (error) {
        console.error('清除缓存失败:', error)
        MessagePlugin.error('清除缓存失败，请重试')
        delete cacheInfo.value.clearing
      }
    }
  })
}

const refreshCacheInfo = () => loadCacheInfo(true)
defineExpose({ refreshCacheInfo })

onMounted(() => {
  cacheInfo.value = { sizeFormatted: '计算中...', count: 0, entries: [] }
  void loadCacheInfo()
})
</script>

<style lang="scss" scoped>
.music-cache {
  width: 100%;

  .cache-desc {
    margin: 0 0 16px 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--td-text-color-secondary);

    b {
      color: var(--td-text-color-primary);
      font-weight: 600;
    }
  }

  .limit-section {
    margin-bottom: 20px;

    .limit-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;

      .limit-label {
        font-weight: 600;
        font-size: 14px;
      }
    }

    .limit-tip {
      margin-top: 8px;
      font-size: 12px;
      color: var(--td-text-color-placeholder);
    }
  }

  .usage-bar {
    height: 8px;
    border-radius: 4px;
    background: var(--td-bg-color-component, rgba(255, 255, 255, 0.1));
    overflow: hidden;
    margin-bottom: 6px;

    .usage-fill {
      height: 100%;
      border-radius: 4px;
      background: var(--td-brand-color, #00dac0);
      transition: width 0.3s ease;
    }
  }

  .usage-text {
    font-size: 12px;
    color: var(--td-text-color-secondary);
    margin-bottom: 20px;

    .usage-warn {
      color: var(--td-warning-color, #ff8f1f);
    }
  }

  .cache-list {
    margin-bottom: 20px;
    border: 1px solid var(--td-border-level-1-color, rgba(255, 255, 255, 0.08));
    border-radius: 8px;
    overflow: hidden;

    .cache-list-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      background: var(--td-bg-color-component, rgba(255, 255, 255, 0.04));
      font-weight: 600;
      font-size: 13px;
    }

    .cache-list-body {
      max-height: 240px;
      overflow-y: auto;
    }

    .cache-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 14px;
      border-top: 1px solid var(--td-border-level-1-color, rgba(255, 255, 255, 0.04));

      .cache-item-info {
        flex: 1;
        min-width: 0;

        .cache-item-name {
          font-size: 13px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .cache-item-artist {
          font-size: 11px;
          color: var(--td-text-color-placeholder);
        }
      }

      .cache-item-size {
        flex-shrink: 0;
        font-size: 12px;
        color: var(--td-text-color-secondary);
        margin-left: 12px;
      }
    }

    .cache-more {
      padding: 8px 14px;
      font-size: 12px;
      color: var(--td-text-color-placeholder);
      text-align: center;
      border-top: 1px solid var(--td-border-level-1-color, rgba(255, 255, 255, 0.04));
    }
  }

  .card-body {
    padding: 0;
    text-align: center;

    .no-cache-tip {
      margin-top: 10px;
      color: var(--td-text-color-placeholder);
      font-size: 14px;
    }
  }
}
</style>
