import { getCurrentWindow } from '@tauri-apps/api/window'

const INTERACTIVE_SELECTOR = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[data-no-window-drag]',
].join(',')

export function startWindowDrag(event: MouseEvent) {
  if (event.button !== 0) return
  const target = event.target
  if (target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) return
  getCurrentWindow().startDragging().catch(() => undefined)
}
