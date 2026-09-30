<template>
  <BaseDialog v-model:show="dialogVisible" title="查重清理" width="820px">
    <div class="dup-wrap">
      <div class="dup-summary">
        <div class="dup-summary-main">
          <strong>{{ duplicateGroups.length }}</strong>
          <span>组重复</span>
          <strong>{{ visibleSongCount }}</strong>
          <span>首可处理</span>
          <strong>{{ selectedCount }}</strong>
          <span>首已勾选待清理</span>
        </div>
        <div class="dup-summary-actions">
          <t-button
            theme="default"
            variant="outline"
            size="small"
            :disabled="duplicateGroups.length === 0 || removing"
            @click="applySuggestedSelection"
          >
            按建议勾选
          </t-button>
          <t-button
            theme="danger"
            variant="outline"
            size="small"
            :disabled="selectedCount === 0 || removing"
            :loading="removing"
            @click="removeSelected"
          >
            一键清理
          </t-button>
        </div>
      </div>

      <div class="dup-hint">
        每组重复歌曲都会全部展开。勾选表示准备删除，点「保留」取消勾选，点「删除」立刻删这一首；也可勾选多首后再点「一键清理」。
      </div>

      <div v-if="duplicateGroups.length === 0" class="dup-empty">当前歌单没有检测到重复歌曲</div>

      <div v-else class="dup-list">
        <section v-for="group in duplicateGroups" :key="group.key" class="dup-group">
          <header class="dup-group-head">
            <div class="dup-group-title">{{ group.displayName }}</div>
            <div class="dup-group-meta">
              {{ group.items.length }} 首重复 · 已勾选 {{ countSelectedInGroup(group) }} 首
            </div>
          </header>

          <div class="dup-group-body">
            <article
              v-for="item in group.items"
              :key="item.uniqueKey"
              class="dup-item"
              :class="{ selected: isSelected(item.uniqueKey), keeper: !isSelected(item.uniqueKey) }"
            >
              <button
                type="button"
                class="dup-check"
                :class="{ on: isSelected(item.uniqueKey) }"
                :disabled="removing"
                :aria-pressed="isSelected(item.uniqueKey)"
                :title="isSelected(item.uniqueKey) ? '取消勾选，改为保留' : '勾选后可一键清理'"
                @click="setSelected(item.uniqueKey, !isSelected(item.uniqueKey))"
              >
                <span class="dup-check-dot" />
              </button>

              <div class="dup-item-main">
                <div class="dup-song-name">
                  {{ item.song.name || '未知歌曲' }}
                  <span v-if="isSelected(item.uniqueKey)" class="dup-flag delete">待清理</span>
                  <span v-else class="dup-flag keep">保留</span>
                </div>
                <div class="dup-song-meta">
                  {{ item.song.singer || '未知歌手' }}
                  <span v-if="item.song.albumName"> · {{ item.song.albumName }}</span>
                  <span v-if="sourceText(item.song.source)"> · {{ sourceText(item.song.source) }}</span>
                  <span v-if="item.song.interval"> · {{ item.song.interval }}</span>
                </div>
              </div>

              <div class="dup-item-side">
                <t-button
                  theme="success"
                  :variant="isSelected(item.uniqueKey) ? 'text' : 'outline'"
                  size="small"
                  :disabled="removing"
                  @click="markKeep(item)"
                >
                  保留
                </t-button>
                <t-button
                  theme="danger"
                  :variant="isSelected(item.uniqueKey) ? 'outline' : 'text'"
                  size="small"
                  :disabled="removing"
                  @click="removeOne(item)"
                >
                  删除
                </t-button>
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>

    <template #action>
      <t-button theme="default" @click="dialogVisible = false">关闭</t-button>
    </template>
  </BaseDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import BaseDialog from '@renderer/components/BaseDialog.vue'
import { sourceLabel } from '@renderer/utils/sourceName'

type SongItem = {
  songmid: string | number
  source: string
  name: string
  singer: string
  albumName: string
  interval?: string
}

type DuplicateItem = {
  uniqueKey: string
  suggestedDelete: boolean
  song: SongItem
}

type DuplicateGroup = {
  key: string
  displayName: string
  items: DuplicateItem[]
}

const props = defineProps<{
  show: boolean
  songs: SongItem[]
  playlistTitle?: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  remove: [payload: { songmid: string | number; source: string }]
  removeMany: [payload: { songs: Array<{ songmid: string | number; source: string }> }]
}>()

const removing = ref(false)
const selectedKeys = ref<Set<string>>(new Set())
const selectionReady = ref(false)

const dialogVisible = computed({
  get: () => props.show,
  set: (value: boolean) => emit('update:show', value)
})

const sourceText = (source?: string) => sourceLabel(source)

const normalizeSongName = (name?: string) =>
  (name || '')
    .toLowerCase()
    .replace(/[\(\[（【].*?[\)\]）】]/g, '')
    .replace(/[^\w\s\u4e00-\u9fa5]/g, '')
    .replace(/\s+/g, '')
    .trim()

const duplicateGroups = computed<DuplicateGroup[]>(() => {
  const bucket = new Map<string, DuplicateItem[]>()

  props.songs.forEach((song) => {
    const normalized = normalizeSongName(song.name)
    if (!normalized) return
    const uniqueKey = `${String(song.source || '')}::${String(song.songmid)}`
    const list = bucket.get(normalized) || []
    list.push({
      uniqueKey,
      suggestedDelete: list.length > 0,
      song
    })
    bucket.set(normalized, list)
  })

  return [...bucket.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({
      key,
      displayName: items[0]?.song.name || key,
      items
    }))
})

const allItems = computed(() => duplicateGroups.value.flatMap((group) => group.items))
const visibleSongCount = computed(() => allItems.value.length)

const selectedCount = computed(() =>
  allItems.value.reduce((count, item) => (selectedKeys.value.has(item.uniqueKey) ? count + 1 : count), 0)
)

const isSelected = (uniqueKey: string) => selectedKeys.value.has(uniqueKey)

const countSelectedInGroup = (group: DuplicateGroup) =>
  group.items.reduce((count, item) => (selectedKeys.value.has(item.uniqueKey) ? count + 1 : count), 0)

const setSelected = (uniqueKey: string, checked: boolean) => {
  const next = new Set(selectedKeys.value)
  if (checked) {
    next.add(uniqueKey)
  } else {
    next.delete(uniqueKey)
  }
  selectedKeys.value = next
}

const markKeep = (item: DuplicateItem) => {
  setSelected(item.uniqueKey, false)
}

const applySuggestedSelection = () => {
  selectedKeys.value = new Set(
    allItems.value.filter((item) => item.suggestedDelete).map((item) => item.uniqueKey)
  )
  selectionReady.value = true
}

const pruneSelection = () => {
  const validKeys = new Set(allItems.value.map((item) => item.uniqueKey))
  const next = new Set<string>()
  selectedKeys.value.forEach((key) => {
    if (validKeys.has(key)) {
      next.add(key)
    }
  })
  selectedKeys.value = next
}

const syncSelection = (forceSuggest = false) => {
  if (!props.show) {
    selectionReady.value = false
    selectedKeys.value = new Set()
    return
  }

  if (forceSuggest || !selectionReady.value) {
    applySuggestedSelection()
    return
  }

  pruneSelection()
}

watch(
  () => props.show,
  (visible) => {
    if (visible) {
      syncSelection(true)
    } else {
      selectionReady.value = false
      selectedKeys.value = new Set()
    }
  }
)

watch(
  () => props.songs,
  () => {
    if (!props.show) return
    syncSelection(false)
  },
  { deep: true }
)

const removeOne = async (item: DuplicateItem) => {
  removing.value = true
  try {
    setSelected(item.uniqueKey, false)
    emit('remove', { songmid: item.song.songmid, source: item.song.source })
  } finally {
    removing.value = false
  }
}

const removeSelected = async () => {
  const songs = allItems.value
    .filter((item) => selectedKeys.value.has(item.uniqueKey))
    .map((item) => ({
      songmid: item.song.songmid,
      source: item.song.source
    }))

  if (songs.length === 0) {
    return
  }

  removing.value = true
  try {
    emit('removeMany', { songs })
  } finally {
    removing.value = false
  }
}
</script>

<style scoped lang="scss">
.dup-wrap {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: min(72vh, 740px);
  min-height: 320px;
}

.dup-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--td-bg-color-container-hover);
  border: 1px solid var(--td-component-stroke);
  flex: 0 0 auto;
}

.dup-summary-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--td-text-color-secondary);

  strong {
    color: var(--td-text-color-primary);
    font-size: 15px;
  }
}

.dup-summary-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.dup-hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--td-text-color-secondary);
  flex: 0 0 auto;
}

.dup-empty {
  padding: 32px 16px;
  text-align: center;
  color: var(--td-text-color-secondary);
  border: 1px dashed var(--td-component-stroke);
  border-radius: 12px;
}

.dup-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding-right: 2px;
}

.dup-group {
  flex: 0 0 auto;
  border: 1px solid var(--td-component-stroke);
  border-radius: 12px;
  background: var(--td-bg-color-container);
  overflow: visible;
}

.dup-group-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px 8px;
}

.dup-group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--td-text-color-secondary);
}

.dup-group-meta {
  font-size: 12px;
  color: var(--td-text-color-placeholder);
  flex-shrink: 0;
}

.dup-group-body {
  display: flex;
  flex-direction: column;
}

.dup-item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 64px;
  flex: 0 0 auto;
  padding: 12px 14px;
  border-top: 1px solid var(--td-component-stroke);

  &.keeper {
    background: rgba(43, 164, 113, 0.08);
  }

  &.selected {
    background: rgba(227, 77, 89, 0.1);
  }
}

.dup-check {
  appearance: none;
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1.5px solid var(--td-text-color-placeholder);
  border-radius: 50%;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;

  &.on {
    border-color: #e34d59;
    background: #e34d59;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
}

.dup-check-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: transparent;
}

.dup-check.on .dup-check-dot {
  background: #fff;
}

.dup-item-main {
  min-width: 0;
  flex: 1;
}

.dup-song-name {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--td-text-color-primary);
  font-weight: 600;
  word-break: break-word;
}

.dup-flag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  flex-shrink: 0;

  &.keep {
    background: rgba(43, 164, 113, 0.16);
    color: #2ba471;
  }

  &.delete {
    background: rgba(227, 77, 89, 0.16);
    color: #e34d59;
  }
}

.dup-song-meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--td-text-color-secondary);
  word-break: break-word;
}

.dup-item-side {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}

@media (max-width: 720px) {
  .dup-summary,
  .dup-group-head,
  .dup-item {
    align-items: flex-start;
    flex-direction: column;
  }

  .dup-summary-actions,
  .dup-item-side {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
