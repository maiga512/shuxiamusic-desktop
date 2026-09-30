import { createApp } from 'vue'
import { createDesktopLyricBridge } from './desktop-lyric-bridge'
import DeskTopLyric from './views/DeskTopLyric/DeskTopLyric.vue'

createDesktopLyricBridge()

document.documentElement.classList.add('desktop-lyric-window')
document.documentElement.style.background = 'transparent'
document.documentElement.style.backgroundColor = 'transparent'
if (document.body) {
  document.body.style.background = 'transparent'
  document.body.style.backgroundColor = 'transparent'
}

const app = createApp(DeskTopLyric)
app.mount('#app')
