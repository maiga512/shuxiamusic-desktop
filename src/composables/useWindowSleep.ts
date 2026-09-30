import { computed } from 'vue'
import { appWindowState } from '@renderer/utils/appWindowState'

export function useWindowSleep() {
  return computed(() => {
    const current = appWindowState.value
    return !current.visible || current.hidden || current.minimized || document.hidden
  })
}
