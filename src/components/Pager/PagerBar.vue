<script setup lang="ts">
import { computed, ref, watch } from 'vue'

interface Props {
  page: number
  totalPages: number
  loading?: boolean
  /** 总页数还在探测中时为 true，此时末页按钮显示占位 */
  totalPending?: boolean
  /** 总条数，用于展示「共 N 个」 */
  totalItems?: number
  /** 中间连续页码的数量，两侧各留首末页 */
  siblingCount?: number
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
  totalPending: false,
  totalItems: 0,
  siblingCount: 2
})

const emit = defineEmits<{ (event: 'change', page: number): void }>()

const jumpValue = ref('')

const safeTotalPages = computed(() => Math.max(1, Math.floor(props.totalPages) || 1))
const currentPage = computed(() => Math.min(Math.max(1, props.page), safeTotalPages.value))

/**
 * 生成 1 … x-2 x-1 [x] x+1 x+2 … last 形式的页码序列。
 * 字符串 'left-gap' / 'right-gap' 代表省略号。
 */
const rawItems = computed<(number | 'left-gap' | 'right-gap')[]>(() => {
  const total = safeTotalPages.value
  const current = currentPage.value
  const sibling = Math.max(1, props.siblingCount)
  const maxSlots = sibling * 2 + 5

  if (total <= maxSlots) {
    return Array.from({ length: total }, (_, index) => index + 1)
  }

  const showLeftGap = current - sibling > 2
  const showRightGap = current + sibling < total - 1
  const result: (number | 'left-gap' | 'right-gap')[] = [1]

  if (!showLeftGap) {
    for (let i = 2; i <= Math.max(2, sibling * 2 + 2); i++) result.push(i)
    result.push('right-gap')
    result.push(total)
    return result
  }

  if (!showRightGap) {
    result.push('left-gap')
    for (let i = total - (sibling * 2 + 1); i < total; i++) result.push(i)
    result.push(total)
    return result
  }

  result.push('left-gap')
  for (let i = current - sibling; i <= current + sibling; i++) result.push(i)
  result.push('right-gap')
  result.push(total)
  return result
})

const items = computed(() =>
  rawItems.value.map((value, index) => ({
    key: typeof value === 'number' ? `page-${value}` : `gap-${index}`,
    value
  }))
)

const canPrev = computed(() => !props.loading && currentPage.value > 1)
const canNext = computed(() => !props.loading && currentPage.value < safeTotalPages.value)

const go = (target: number) => {
  if (props.loading) return
  const next = Math.min(Math.max(1, Math.floor(target) || 1), safeTotalPages.value)
  if (next === currentPage.value) return
  emit('change', next)
}

const jumpBy = (offset: number) => go(currentPage.value + offset)

const submitJump = () => {
  const next = Number(jumpValue.value)
  if (!Number.isFinite(next) || next < 1) {
    jumpValue.value = ''
    return
  }
  go(next)
  jumpValue.value = ''
}

watch(currentPage, () => {
  jumpValue.value = ''
})
</script>

<template>
  <div class="pager-bar">
    <button class="pager-btn" :disabled="!canPrev" @click="go(1)">首页</button>
    <button class="pager-btn" :disabled="!canPrev" @click="jumpBy(-1)">上一页</button>

    <template v-for="item in items" :key="item.key">
      <button
        v-if="typeof item.value === 'number'"
        class="pager-btn"
        :class="{ active: item.value === currentPage }"
        :disabled="loading"
        @click="go(item.value)"
      >
        {{ item.value }}
      </button>
      <button
        v-else
        class="pager-btn gap"
        :disabled="loading"
        :title="item.value === 'left-gap' ? '向前 5 页' : '向后 5 页'"
        @click="jumpBy(item.value === 'left-gap' ? -5 : 5)"
      >
        ···
      </button>
    </template>

    <button class="pager-btn" :disabled="!canNext" @click="jumpBy(1)">下一页</button>
    <button class="pager-btn" :disabled="!canNext" @click="go(safeTotalPages)">
      末页
      <span v-if="totalPending" class="pager-hint">探测中</span>
    </button>

    <div class="pager-jump">
      <span>跳至</span>
      <input
        v-model="jumpValue"
        class="pager-input"
        type="text"
        inputmode="numeric"
        :placeholder="String(currentPage)"
        :disabled="loading"
        @keyup.enter="submitJump"
      />
      <span>页</span>
      <button class="pager-btn ghost" :disabled="loading || !jumpValue" @click="submitJump">
        确定
      </button>
    </div>

    <span class="pager-total">
      共 {{ safeTotalPages }} 页<template v-if="totalItems"> / {{ totalItems }} 个</template>
    </span>
  </div>
</template>

<style lang="scss" scoped>
.pager-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 16px;
}

.pager-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 36px;
  height: 34px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--find-text-primary) 10%, transparent);
  color: var(--find-text-primary);
  font-size: 13px;
  cursor: pointer;
  transition:
    background 0.18s ease,
    color 0.18s ease;
}

.pager-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--find-text-primary) 18%, transparent);
}

.pager-btn.active {
  background: var(--find-text-primary);
  color: var(--td-bg-color-container);
}

.pager-btn.gap {
  padding: 0 8px;
  letter-spacing: 1px;
  background: transparent;
}

.pager-btn.ghost {
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--find-text-primary) 20%, transparent);
}

.pager-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.pager-hint {
  font-size: 11px;
  opacity: 0.7;
}

.pager-jump {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--find-text-secondary);
  font-size: 13px;
}

.pager-input {
  width: 52px;
  height: 34px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--find-text-primary) 20%, transparent);
  border-radius: 8px;
  background: transparent;
  color: var(--find-text-primary);
  font-size: 13px;
  text-align: center;
  outline: none;
}

.pager-input:focus {
  border-color: color-mix(in srgb, var(--find-text-primary) 45%, transparent);
}

.pager-total {
  color: var(--find-text-secondary);
  font-size: 12px;
}
</style>
