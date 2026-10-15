/**
 * localStorage 键名迁移：ceru_* -> shuxia_*
 *
 * 项目从 Ceru 更名树夏Music 后，localStorage 里的历史键名也要跟着改。
 * 直接改名会让老用户丢失同步游标、设备 ID、插件状态等本地数据，
 * 所以这里做一次性迁移：启动时把旧键的值搬到新键（只搬值不在新键的情况）。
 *
 * 调用一次即可（见 main.ts），迁移完成后旧键保留不动，不会重复迁移。
 */
const KEY_MAP: Record<string, string> = {
  // 歌单同步操作队列
  'shuxia_nas_playlist_song_operations': 'shuxia_nas_playlist_song_operations',
  'shuxia_nas_playlist_song_operation_sequence': 'shuxia_nas_playlist_song_operation_sequence',
  'shuxia_nas_playlist_song_operation_device': 'shuxia_nas_playlist_song_operation_device',
  'shuxia_nas_playlist_song_operation_occurred_at': 'shuxia_nas_playlist_song_operation_occurred_at',
  'shuxia_nas_playlist_song_operations_acknowledged': 'shuxia_nas_playlist_song_operations_acknowledged',
  'shuxia_nas_playlist_mutations': 'shuxia_nas_playlist_mutations',
  'shuxia_nas_playlist_recently_local_modified': 'shuxia_nas_playlist_recently_local_modified',
  // 插件同步
  'shuxia_sync_disabled_music_sources': 'shuxia_sync_disabled_music_sources',
  'shuxia_sync_plugins_initialized': 'shuxia_sync_plugins_initialized',
  'shuxia_sync_device_id': 'shuxia_sync_device_id',
  'shuxia_sync_plugin_sequence': 'shuxia_sync_plugin_sequence',
  'shuxia_sync_pending_plugin_upserts': 'shuxia_sync_pending_plugin_upserts',
  'shuxia_sync_pending_plugin_deletes': 'shuxia_sync_pending_plugin_deletes',
  'shuxia_sync_plugin_identity_aliases': 'shuxia_sync_plugin_identity_aliases',
  'shuxia_sync_known_plugin_keys': 'shuxia_sync_known_plugin_keys',
  'shuxia_sync_applied_plugin_hashes': 'shuxia_sync_applied_plugin_hashes',
  // 同步游标 / 设备 ID
  'shuxia_nas_sync_last_revision': 'shuxia_nas_sync_last_revision',
  'shuxia_nas_sync_device_id': 'shuxia_nas_sync_device_id',
  // 播客收藏
  'shuxia_podcast_favorites': 'shuxia_podcast_favorites',
  'shuxia_podcast_favorite_pins': 'shuxia_podcast_favorite_pins',
  'shuxia_podcast_favorite_mutations': 'shuxia_podcast_favorite_mutations',
  // 播放统计
  'shuxia_playback_timings_v1': 'shuxia_playback_timings_v1',
  // UI 状态
  'shuxia_share_consent': 'shuxia_share_consent',
  'shuxia_welcome_newyear_preview': 'shuxia_welcome_newyear_preview',
  'shuxia_hotkey_config_v1': 'shuxia_hotkey_config_v1',
  // 管理页 token（localStorage key，非服务端环境变量）
  'shuxia.sync.adminToken': 'shuxia.sync.adminToken',
}

let migrated = false

export function migrateCeruStorageKeys(): void {
  if (migrated) return
  migrated = true
  try {
    for (const [oldKey, newKey] of Object.entries(KEY_MAP)) {
      const value = localStorage.getItem(oldKey)
      if (value === null) continue
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, value)
      }
    }
  } catch {
    /* localStorage 不可用（隐私模式等）时静默跳过 */
  }
}
