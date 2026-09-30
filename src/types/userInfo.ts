import { PlayMode } from './audio'
import { Sources } from './Sources'

export interface UserInfo {
  lastPlaySongId?: number | string | null
  lastPlaySongSource?: string | null
  currentTime?: number
  volume?: number
  topBarStyle?: boolean
  mainColor?: string
  playMode?: PlayMode
  pluginId?: string
  pluginName?: string
  supportedSources?: Sources['supportedSources']
  selectSources?: string
  selectQuality?: string
  sourceQualityMap?: Record<string, string>
  hasGuide?: boolean
  /** 上次播放的实际音频 URL，用于零等待启动 */
  cachedAudioUrl?: string
  /** 上次关闭时是否在播放 */
  wasPlaying?: boolean
}
