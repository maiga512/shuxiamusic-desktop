<script lang="ts" setup>
defineOptions({ name: 'songlist' })
import { ref, shallowRef, onMounted, onBeforeUnmount, onActivated, onDeactivated, computed, toRaw, h, nextTick, type Component } from 'vue'
import { useRouter } from 'vue-router'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import { NIcon, NDropdown } from 'naive-ui'
import {
  Edit2Icon,
  PlayCircleIcon,
  DeleteIcon,
  ViewListIcon,
  DownloadIcon,
  ShareIcon,
  RefreshIcon,
  FileExportIcon
} from 'tdesign-icons-vue-next'
import { downloadBatchSongs } from '@renderer/utils/audio/download'
import songListAPI from '@renderer/api/songList'
import type { SongList, Songs } from '@common/types/songList'
import defaultCover from '/default-cover.png'
import { listCoverUrl } from '@renderer/utils/coverThumb'
import { LocalUserDetailStore } from '@renderer/store/LocalUserDetail'
import { useSettingsStore } from '@renderer/store/Settings'
import {
  importPlaylistFromFile,
  validateImportedPlaylist,
  exportPlaylistToFile
} from '@renderer/utils/playlist/playlistExportImport'
import {
  cloudSongListAPI,
  type CloudSongList,
  type CloudSongDto
} from '@renderer/api/cloudSongList'
import { getAutoSyncSongListAPI, getPreferredSongListAPI } from '@renderer/api/nasSync'
import { isNasSyncApplyingRemoteEvents } from '@renderer/services/nasSyncPoller'
// 【新】统一实时同步总线：歌单变化的唯一通知入口，替代旧的 playlist-updated window 事件
import { onSyncEvent, emitPlaylistSync, type SyncEvent } from '@renderer/utils/sync/realtimeSyncBus'
import { getPersistentMeta } from '@renderer/utils/playlist/meta'
import { isBridgedRemotePlaylist } from '@renderer/utils/playlist/bridgedPlaylist'
import { CloudIcon, CloudUploadIcon, CloudDownloadIcon } from 'tdesign-icons-vue-next'
import { mapCloudSongToLocal } from '@renderer/utils/playlist/cloudList'
import {
  handleUploadToCloudHelper,
  handleSyncToCloudHelper
} from '@renderer/utils/playlist/cloudSyncHelper'
import {
  pullFavoritesFromCloud,
  syncDeletePlaylistFromCloud,
  syncPlaylistInfoToCloud
} from '@renderer/utils/playlist/cloudLibrarySync'
import SharePlaylistDialog from '@renderer/components/Share/SharePlaylistDialog.vue'
import { useAuthStore } from '@renderer/store'
import {
  hydrateMissingSongCovers,
  isUsableCover,
  resolvePlaylistCover
} from '@renderer/utils/playlist/coverFallback'
import { SESSION_TTL_MS, getSessionCache, setSessionCache } from '@renderer/utils/cache/sessionCache'

const settingsStore = useSettingsStore()

// 歌单列表：优先用会话缓存做首屏，避免每次侧栏点进来都先空态/创建歌单
// shallowRef：增删改统一走下面三个 helper 整体替换数组引用，不就地改元素，省内存
const playlists = shallowRef<SongList[]>(getSessionCache<SongList[]>('songlist:playlists') || [])
const loading = ref(false)
const manualRefreshing = ref(false)
// 喜欢歌单ID（用于排序与标记）
const favoritesId = ref<string | null>(null)

const updatePlaylistState = (id: string, payload: Partial<SongList>) => {
  const idx = playlists.value.findIndex((p) => p.id === id)
  if (idx !== -1) {
    const next = playlists.value.slice()
    next[idx] = { ...next[idx], ...payload }
    playlists.value = next
  }
}
const addPlaylistState = (pl: SongList) => {
  playlists.value = [pl, ...playlists.value]
}
const removePlaylistState = (id: string) => {
  playlists.value = playlists.value.filter((p) => p.id !== id)
}

const getSongListSyncAPI = async () => (await getPreferredSongListAPI()) || cloudSongListAPI

const getPlaylistSortTime = (playlist: SongList) =>
  Date.parse(
    String(
      playlist.meta?.cloudOrderAt ||
        playlist.meta?.cloudUpdatedAt ||
        playlist.createTime ||
        playlist.updateTime ||
        ''
    )
  ) || 0

const sortPlaylistsStable = (items: SongList[], favId?: string | null) => {
  return [...items].sort((a, b) => {
    if (favId && a.id === favId) return -1
    if (favId && b.id === favId) return 1
    const timeDiff = getPlaylistSortTime(a) - getPlaylistSortTime(b)
    if (timeDiff !== 0) return timeDiff
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
  })
}

const getCloudPlaylistMeta = (cloudPlaylist: CloudSongList, existing?: SongList) =>
  getPersistentMeta({
    ...(existing?.meta || {}),
    cloudId: String(cloudPlaylist.id || ''),
    isSynced: true,
    cloudUpdatedAt: cloudPlaylist.updatedAt,
    cloudOrderAt:
      existing?.meta?.cloudOrderAt ||
      (cloudPlaylist as any).createdAt ||
      cloudPlaylist.updatedAt ||
      existing?.createTime
  })

const persistCloudPlaylistLocally = async (cloudPlaylist: CloudSongList, existing?: SongList) => {
  const remoteId = String(cloudPlaylist.id || '')
  if (!remoteId) return null

  const syncAPI = await getAutoSyncSongListAPI()
  const detail = syncAPI
    ? await syncAPI.getSongListDetail(remoteId).catch(() => null)
    : await cloudSongListAPI.getSongListDetail(remoteId).catch(() => null)
  const cloudSongs = Array.isArray(detail?.list) ? detail.list : []
  const localSongs = cloudSongs.map((song) => mapCloudSongToLocal(song) as Songs)
  const baseMeta = getCloudPlaylistMeta(cloudPlaylist, existing)

  let localId = existing?.id
  if (!localId) {
    const created = await songListAPI.create(cloudPlaylist.name, cloudPlaylist.describe || '', 'local', baseMeta)
    if (!created.success || !created.data?.id) {
      throw new Error(created.error || `创建本地歌单失败：${cloudPlaylist.name}`)
    }
    localId = created.data.id
  } else {
    await songListAPI.edit(localId, {
      name: cloudPlaylist.name,
      description: cloudPlaylist.describe || existing?.description || '',
      coverImgUrl: cloudPlaylist.cover || existing?.coverImgUrl || 'default-cover',
      source: 'local',
      meta: baseMeta
    })
  }
  if (!localId) {
    throw new Error(`本地歌单创建失败：${cloudPlaylist.name}`)
  }

  if (cloudPlaylist.cover && cloudPlaylist.cover !== 'default-cover') {
    await songListAPI.updateCover(localId, cloudPlaylist.cover).catch(() => null)
  }

  const current = await songListAPI.getSongs(localId)
  const currentIds = new Set(
    current.success && Array.isArray(current.data)
      ? current.data.map((song) => String(song.songmid))
      : []
  )
  const shouldAdd = localSongs.filter((song) => !currentIds.has(String(song.songmid)))
  if (shouldAdd.length > 0) {
    await songListAPI.addSongs(localId, shouldAdd)
  }

  const saved = await songListAPI.getById(localId)
  return saved.success && saved.data ? saved.data : null
}

const refreshPersistedCloudPlaylistMeta = async (cloudPlaylist: CloudSongList, localPlaylist: SongList) => {
  const nextMeta = getCloudPlaylistMeta(cloudPlaylist, localPlaylist)
  await songListAPI.edit(localPlaylist.id, {
    name: cloudPlaylist.name || localPlaylist.name,
    description: cloudPlaylist.describe || localPlaylist.description || '',
    coverImgUrl: cloudPlaylist.cover || localPlaylist.coverImgUrl || 'default-cover',
    source: 'local',
    meta: nextMeta
  })
  return {
    ...localPlaylist,
    name: cloudPlaylist.name || localPlaylist.name,
    description: cloudPlaylist.describe || localPlaylist.description || '',
    coverImgUrl: cloudPlaylist.cover || localPlaylist.coverImgUrl || 'default-cover',
    source: 'local' as const,
    meta: nextMeta
  }
}

// 对话框状态
const showCreatePlaylistDialog = ref(false)
const showImportDialog = ref(false)
const showEditPlaylistDialog = ref(false)

// 表单数据

const formatServicePlaylistDescription = (playlist: any) => {
  const raw = String(playlist?.description || playlist?.desc || '').trim()
  const meta = playlist?.meta && typeof playlist.meta === 'object' ? playlist.meta : {}
  const importedFrom = String(meta.importedFrom || meta.servicePluginId || '').trim()
  const looksServiceImport =
    /由服务(?:与)?插件(?:\s|\u3000)*\S*(?:\s|\u3000)*导入/.test(raw) ||
    /由服务(?:与)?插件/.test(raw) ||
    raw === '从服务插件导入' ||
    raw === '由服务插件导入' ||
    /9ff4f5f82ce44ce7a565b845eef51a80/i.test(raw) ||
    Boolean(importedFrom)
  if (!looksServiceImport) return raw
  const blob = `${raw} ${JSON.stringify(meta)} ${playlist?.id || ''} ${playlist?.name || ''}`.toLowerCase()
  if (blob.includes('feiniu') || blob.includes('飞牛') || importedFrom === '9ff4f5f82ce44ce7a565b845eef51a80') {
    return '由飞牛服务插件导入'
  }
  if (blob.includes('navidrome')) return '由 Navidrome 服务插件导入'
  if (blob.includes('nas-sync') || blob.includes('nas')) return '由 NAS 同步服务插件导入'
  return '由服务插件导入'
}

const newPlaylistForm = ref({
  name: '我的歌单',
  description: '这是我创建的歌单'
})

// 编辑歌单表单数据
const editPlaylistForm = ref({
  name: '',
  description: ''
})

// 当前编辑的歌单
const currentEditingPlaylist = ref<SongList | null>(null)

// 封面 URL(空或占位时回退到 defaultCover) - 用于 hover 模糊背板
const getCoverUrl = (p: SongList): string =>
  listCoverUrl(p.coverImgUrl && p.coverImgUrl !== 'default-cover' ? p.coverImgUrl : defaultCover, 384)

const hoveredBackdropKey = ref('')
let hoverClearTimer = 0
const coverBackdropStyle = (playlist: SongList) => {
  if (hoveredBackdropKey.value !== String(playlist.id)) return undefined
  return { '--cover-url': `url('${getCoverUrl(playlist)}')` }
}
const onCoverHoverEnter = (playlist: SongList) => {
  if (hoverClearTimer) {
    window.clearTimeout(hoverClearTimer)
    hoverClearTimer = 0
  }
  hoveredBackdropKey.value = String(playlist.id)
}
const onCoverHoverLeave = () => {
  if (hoverClearTimer) window.clearTimeout(hoverClearTimer)
  hoverClearTimer = window.setTimeout(() => {
    hoveredBackdropKey.value = ''
    hoverClearTimer = 0
  }, 400)
}

const formatLocalTime = (input: string | number | Date): string => {
  const d = new Date(input)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const getPlaylistUpdatedAt = (playlist: SongList): string =>
  String(playlist.meta?.cloudUpdatedAt || playlist.updateTime || playlist.createTime || '')

const getSourceBadgeLabel = (source: string | undefined): string =>
  String(source || 'local').toUpperCase()

// 右键菜单状态
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuPlaylist = ref<SongList | null>(null)
const sharePlaylistDialogVisible = ref(false)
const shareTargetPlaylist = ref<SongList | null>(null)
const shareTargetPlaylistSongCount = ref(0)
const songlistFileInputRef = ref<HTMLInputElement | null>(null)
const songlistUploadedFile = ref<File | null>(null)

// 渲染图标辅助函数
const renderIcon = (icon: Component) => {
  return () => h(NIcon, null, { default: () => h(icon) })
}

const triggerSonglistFileInput = () => {
  if (songlistFileInputRef.value) songlistFileInputRef.value.click()
}
const handleSonglistFileChange = (e: Event) => {
  const input = e.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    songlistUploadedFile.value = input.files[0]
    importSonglistFromFile()
  }
}
const importSonglistFromFile = async () => {
  try {
    showImportDialog.value = false
    if (!songlistUploadedFile.value) {
      MessagePlugin.warning('请先选择文件')
      return
    }
    const imported = await importPlaylistFromFile(songlistUploadedFile.value)
    if (!validateImportedPlaylist(imported)) {
      MessagePlugin.error('导入的歌单格式不正确，请选择 .cmpl/.cpl 或洛雪/LX Music 的 .lxmc/.json 歌单')
      return
    }
    const rawName = songlistUploadedFile.value.name.replace(/\.(cmpl|cpl|lxmc|json)$/i, '')
    let parsedName: string | null = null
    const mSonglist = rawName.match(/^cerumusic-songlist-(.+?)-\d{4}-\d{2}-\d{2}$/i)
    if (mSonglist) parsedName = mSonglist[1]
    else {
      const mSimple = rawName.match(/^cerumusic-(.+)$/i)
      if (mSimple) parsedName = mSimple[1]
    }
    const finalName = parsedName || rawName
    const createRes = await songListAPI.create(finalName, '从本地歌单文件导入', 'local')
    if (!createRes.success || !createRes.data) {
      MessagePlugin.error(createRes.error || '创建歌单失败')
      return
    }
    const addRes = await songListAPI.addSongs(createRes.data.id, imported)
    if (addRes.success) {
      const added = (addRes.data && (addRes.data as any).added) ?? imported.length
      const skipped =
        (addRes.data && (addRes.data as any).skipped) ?? Math.max(0, imported.length - added)
      MessagePlugin.success(
        skipped > 0
          ? `成功导入 ${added} 首歌曲到歌单“${finalName}”，跳过 ${skipped} 首重复`
          : `成功导入 ${added} 首歌曲到歌单“${finalName}”`
      )
      addPlaylistState({
        id: createRes.data.id,
        name: finalName,
        description: '从本地歌单文件导入',
        coverImgUrl: 'default-cover',
        createTime: new Date().toISOString(),
        updateTime: new Date().toISOString(),
        source: 'local',
        meta: {}
      } as SongList)
    } else {
      MessagePlugin.error(addRes.error || '添加歌曲到歌单失败')
    }
  } catch (err) {
    MessagePlugin.error(`导入失败: ${(err as Error).message}`)
  } finally {
    songlistUploadedFile.value = null
    if (songlistFileInputRef.value) songlistFileInputRef.value.value = ''
  }
}

// 加载歌单列表
let loadPlaylistsPromise: Promise<void> | null = null
const loadPlaylists = async (): Promise<void> => {
  if (loadPlaylistsPromise) return loadPlaylistsPromise

  // 只有没有可展示数据时才显示整页加载；后台同步保持当前内容稳定可见。
  if (playlists.value.length === 0) loading.value = true
  const authStore = useAuthStore()
  console.log('authStore.isAuthenticated', authStore.isAuthenticated)
  loadPlaylistsPromise = (async () => {
    async function getCloudSongList() {
      const syncAPI = await getPreferredSongListAPI()
      if (!syncAPI && (!authStore.initialized || !authStore.isAuthenticated)) {
        console.log('没有可用的同步服务，保留本地缓存歌单')
        return { success: false, lists: [] }
      }
      try {
        const lists = await (syncAPI || cloudSongListAPI).getUserSongLists()
        return { success: true, lists: Array.isArray(lists) ? lists : [] }
      } catch (err: any) {
        console.warn('获取云歌单失败:', err)
        return { success: false, lists: [] }
      }
    }

    // Paint local playlists first so sidebar entry doesn't wait on cloud.
    const localRes = await songListAPI.getAll()
    const localListsFast = (localRes.success ? localRes.data : []) || []
    if (localListsFast.length) {
      // 已有缓存也覆盖刷新本地快照，避免首屏停在旧空态
      playlists.value = sortPlaylistsStable(
        localListsFast.map((l) => {
          if (!l.meta) l.meta = {}
          return l
        }),
        favoritesId.value
      )
      setSessionCache('songlist:playlists', playlists.value, SESSION_TTL_MS, true)
    }

    const cloudResult = await getCloudSongList()

    const localLists = (localRes.success ? localRes.data : []) || []
    const cloudLists: CloudSongList[] = Array.isArray(cloudResult.lists)
      ? cloudResult.lists.filter((item) => !isBridgedRemotePlaylist(item))
      : []

    console.log('Local Lists:', localLists)
    console.log('Cloud Lists:', cloudLists)

    // Merge Logic
    const mergedLists: SongList[] = []
    const localMap = new Map<string, SongList>()
    const mergedIds = new Set<string>()

    // 1. Process Local Lists
    localLists.forEach((l) => {
      // Ensure meta exists
      if (!l.meta) l.meta = {}
      localMap.set(l.id, l)
      mergedLists.push(l)
      mergedIds.add(l.id)
    })

    // 2. Process Cloud Lists
    for (const c of cloudLists) {
      // Try to find matching local list
      // Match by localId (if cloud knows about it) OR by meta.cloudId (if local knows about it)
      let match = localMap.get(c.localId)

      if (!match) {
        // Try reverse lookup
        match = mergedLists.find((l) => l.meta && l.meta.cloudId === c.id)
      }

      if (match) {
        console.log('Matched:', c.name, match.name)
        match = await refreshPersistedCloudPlaylistMeta(c, match)
      } else {
        console.log('Not Matched (Cloud Only):', c.name)
        const persisted = await persistCloudPlaylistLocally(c)
        if (persisted) match = persisted
      }

      if (match && !mergedIds.has(match.id)) {
        mergedLists.push(match)
        mergedIds.add(match.id)
      } else if (match) {
        const index = mergedLists.findIndex((item) => item.id === match.id)
        if (index !== -1) mergedLists[index] = match
      }
    }

    playlists.value = sortPlaylistsStable(mergedLists, favoritesId.value)
    setSessionCache('songlist:playlists', playlists.value, SESSION_TTL_MS, true)

    // 读取“我的喜欢”ID并置顶与标记
    try {
      const favRes = await (window as any).api?.songList?.getFavoritesId?.()
      favoritesId.value = (favRes && favRes.data) || null
      playlists.value = sortPlaylistsStable(playlists.value, favoritesId.value)
    } catch {}

    void hydratePlaylistCovers()
  })()

  try {
    await loadPlaylistsPromise
  } catch (error) {
    console.error('加载歌单失败:', error)
    MessagePlugin.error('加载歌单失败')
  } finally {
    loading.value = false
    loadPlaylistsPromise = null
  }
}

async function hydratePlaylistCovers() {
  const queue = playlists.value.filter((playlist) => !isUsableCover(playlist.coverImgUrl))
  let cursor = 0
  const worker = async () => {
    while (cursor < queue.length) {
      const playlist = queue[cursor++]
      try {
        const result = await songListAPI.getSongs(playlist.id)
        const songs = result.success && Array.isArray(result.data) ? [...result.data] : []
        if (songs.length === 0) continue
        const cover = await resolvePlaylistCover({
          songs,
          source: playlist.source,
          currentCover: playlist.coverImgUrl,
          playlistId: playlist.id,
          persist: true
        })
        if (isUsableCover(cover)) {
          updatePlaylistState(playlist.id, { coverImgUrl: cover })
        }
      } catch (error) {
        console.warn(`补全歌单封面失败: ${playlist.name}`, error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker))
}

// 创建新歌单
const createPlaylist = async () => {
  if (!newPlaylistForm.value.name.trim()) {
    MessagePlugin.warning('歌单名称不能为空')
    return
  }

  try {
    const result = await songListAPI.create(
      newPlaylistForm.value.name,
      newPlaylistForm.value.description,
      'local'
    )

    if (result.success) {
      MessagePlugin.success('歌单创建成功')
      showCreatePlaylistDialog.value = false
      const created = {
        id: result.data!.id,
        name: newPlaylistForm.value.name,
        description: newPlaylistForm.value.description,
        coverImgUrl: 'default-cover',
        createTime: new Date().toISOString(),
        updateTime: new Date().toISOString(),
        source: 'local' as const,
        meta: {}
      } as SongList
      addPlaylistState(created)
      window.dispatchEvent(new Event('shuxia-nas-local-change'))
      syncPlaylistInfoToCloud(created).catch((error) => {
        console.error('同步创建歌单到云端失败:', error)
        MessagePlugin.warning('本地歌单已创建，云端同步稍后重试')
      })
      newPlaylistForm.value = { name: '我的歌单', description: '这是我创建的歌单' }
      // 触发歌单更新事件
      // 【新】通过统一总线通知本页及「我的喜欢/歌单详情」页刷新
      emitPlaylistSync('add', 'local')
      // 【旧·仍保留】尚未迁移到总线的组件（播放页等）仍靠这个 window 事件刷新
      window.dispatchEvent(new Event('playlist-updated'))
    } else {
      MessagePlugin.error(result.error || '创建歌单失败')
    }
  } catch (error) {
    console.error('创建歌单失败:', error)
    MessagePlugin.error('创建歌单失败')
  }
}

// 编辑歌单
const editPlaylist = (playlist: SongList) => {
  currentEditingPlaylist.value = playlist
  editPlaylistForm.value = {
    name: playlist.name,
    description: playlist.description || ''
  }
  showEditPlaylistDialog.value = true
}

// 保存歌单编辑
const savePlaylistEdit = async () => {
  if (!currentEditingPlaylist.value) return

  if (!editPlaylistForm.value.name.trim()) {
    MessagePlugin.warning('歌单名称不能为空')
    return
  }

  try {
    let success = false
    let errorMsg = ''

    if (currentEditingPlaylist.value.meta?.isCloudOnly) {
      try {
        const syncAPI = await getSongListSyncAPI()
        const resp = await syncAPI.updateUserSongList({
          listId: currentEditingPlaylist.value.id,
          name: editPlaylistForm.value.name.trim(),
          describe: editPlaylistForm.value.description.trim()
        })
        updatePlaylistState(currentEditingPlaylist.value.id, {
          name: editPlaylistForm.value.name.trim(),
          description: editPlaylistForm.value.description.trim(),
          meta: {
            ...(currentEditingPlaylist.value.meta || {}),
            cloudUpdatedAt: resp.updatedAt
          }
        })
        success = true
      } catch (e) {
        success = false
        errorMsg = (e as Error).message
      }
    } else {
      const result = await songListAPI.edit(currentEditingPlaylist.value.id, {
        name: editPlaylistForm.value.name.trim(),
        description: editPlaylistForm.value.description.trim()
      })
      success = result.success
      errorMsg = result.error || '更新歌单信息失败'
      if (result.success) {
        const updatedPlaylist = {
          ...currentEditingPlaylist.value,
          name: editPlaylistForm.value.name.trim(),
          description: editPlaylistForm.value.description.trim()
        }
        updatePlaylistState(currentEditingPlaylist.value.id, {
          name: updatedPlaylist.name,
          description: updatedPlaylist.description
        })
        window.dispatchEvent(new Event('shuxia-nas-local-change'))
        syncPlaylistInfoToCloud(updatedPlaylist).catch((error) => {
          console.error('同步歌单信息到云端失败:', error)
          MessagePlugin.warning('本地歌单已更新，云端同步稍后重试')
        })
      }
    }

    if (success) {
      MessagePlugin.success('歌单信息更新成功')
      showEditPlaylistDialog.value = false
      currentEditingPlaylist.value = null
      // 触发歌单更新事件
      // 【新】通过统一总线通知本页及「我的喜欢/歌单详情」页刷新
      emitPlaylistSync('update', 'local')
      // 【旧·仍保留】尚未迁移到总线的组件（播放页等）仍靠这个 window 事件刷新
      window.dispatchEvent(new Event('playlist-updated'))
    } else {
      MessagePlugin.error(errorMsg || '更新歌单信息失败')
    }
  } catch (error) {
    console.error('更新歌单信息失败:', error)
    MessagePlugin.error('更新歌单信息失败')
  }
}

// 取消编辑歌单
const cancelPlaylistEdit = () => {
  showEditPlaylistDialog.value = false
  currentEditingPlaylist.value = null
  editPlaylistForm.value = {
    name: '',
    description: ''
  }
}

// 删除歌单
const deletePlaylist = async (playlist: SongList) => {
  const confirmDialog = DialogPlugin.confirm({
    header: '确认删除',
    body: `确定要删除歌单"${playlist.name}"吗？此操作不可撤销。`,
    confirmBtn: '删除',
    cancelBtn: '取消',
    theme: 'danger',
    onConfirm: async () => {
      try {
        let success = false
        let errorMsg = ''

        if (playlist.meta?.isCloudOnly) {
          try {
            const syncAPI = await getSongListSyncAPI()
            await syncAPI.deleteUserSongList(playlist.id)
            success = true
          } catch (e) {
            success = false
            errorMsg = (e as Error).message
          }
        } else {
          const result = await songListAPI.delete(playlist.id)
          success = result.success
          errorMsg = result.error || '删除歌单失败'
          if (result.success) {
            window.dispatchEvent(new Event('shuxia-nas-local-change'))
            syncDeletePlaylistFromCloud(playlist).catch((error) => {
              console.error('同步删除云端歌单失败:', error)
              MessagePlugin.warning('本地歌单已删除，云端删除稍后重试')
            })
          }
        }

        if (success) {
          MessagePlugin.success('歌单删除成功')
          removePlaylistState(playlist.id)
          // 触发歌单更新事件
          // 【新】通过统一总线通知本页及「我的喜欢/歌单详情」页刷新
          emitPlaylistSync('remove', 'local')
          // 【旧·仍保留】尚未迁移到总线的组件（播放页等）仍靠这个 window 事件刷新
          window.dispatchEvent(new Event('playlist-updated'))
        } else {
          MessagePlugin.error(errorMsg || '删除歌单失败')
        }
      } catch (error) {
        console.error('删除歌单失败:', error)
        MessagePlugin.error('删除歌单失败')
      }
      confirmDialog.destroy()
    },
    onCancel: () => {
      confirmDialog.destroy()
    }
  })
}

// 初始化路由
const router = useRouter()

// 获取来源名称
const getSourceName = (source: string | undefined): string => {
  const sourceMap: Record<string, string> = {
    qq: 'QQ音乐',
    wy: '网易云',
    kg: '酷狗',
    kw: '酷我',
    mg: '咪咕',
    local: '本地'
  }
  return sourceMap[source || ''] || source || '未知'
}

// 同步平台歌单 - 跳转到详情页并自动触发同步
const syncPlatformPlaylist = (playlist: SongList) => {
  router.push({
    name: 'list',
    params: { id: playlist.id },
    query: {
      title: playlist.name,
      author: 'local',
      cover: playlist.coverImgUrl || '',
      total: '0',
      source: playlist.source,
      type: 'local',
      meta: JSON.stringify(playlist.meta),
      description: formatServicePlaylistDescription(playlist) || '',
      cloudId: playlist.meta?.cloudId,
      autoSync: '1' // 标记自动触发同步
    }
  })
}

// 查看歌单详情
const viewPlaylist = (playlist: SongList) => {
  if (playlist.meta?.isCloudOnly) {
    router.push({
      name: 'list',
      params: { id: playlist.id },
      query: {
        title: playlist.name,
        author: 'cloud',
        cover: playlist.coverImgUrl || '',
        description: formatServicePlaylistDescription(playlist) || '',
        total: '0',
        source: 'cloud',
        type: 'cloud_user',
        meta: JSON.stringify(playlist.meta)
      }
    })
    return
  }

  // 跳转到 list 页面，传递歌单信息作为查询参数
  router.push({
    name: 'list',
    params: { id: playlist.id },
    query: {
      title: playlist.name,
      author: 'local',
      cover: playlist.coverImgUrl || '',
      total: '0', // 这里可以后续优化为实际歌曲数量
      source: playlist.source,
      type: 'local', // 标识这是本地歌单
      meta: JSON.stringify(playlist.meta), // 歌单元数据
      description: formatServicePlaylistDescription(playlist) || '',
      cloudId: playlist.meta?.cloudId // 显式传递 cloudId，防止 meta 被覆盖后丢失
    }
  })
}

// 播放歌单
const playPlaylist = async (playlist: SongList) => {
  try {
    let songs: Songs[] = []

    if (playlist.meta?.isCloudOnly) {
      try {
        const syncAPI = await getSongListSyncAPI()
        songs = (await syncAPI.getSongListDetail(playlist.id)).list.map(mapCloudSongToLocal)
      } catch (e) {
        MessagePlugin.error((e as Error).message || '获取歌单歌曲失败')
        return
      }
    } else {
      const result = await songListAPI.getSongs(playlist.id)
      if (result.success) {
        songs = [...(result.data || [])]
      } else {
        MessagePlugin.error(result.error || '获取歌单歌曲失败')
        return
      }
    }

    if (songs.length === 0) {
      MessagePlugin.warning('歌单中没有歌曲')
      return
    }

    // 调用播放器的方法替换播放列表
    if ((window as any).musicEmitter) {
      ;(window as any).musicEmitter.emit(
        'replacePlaylist',
        songs.map((song) => toRaw(song))
      )
    }
    console.log('播放歌单:', playlist.name, '共', songs.length, '首歌曲')
    MessagePlugin.success(`已将播放列表替换为歌单"${playlist.name}"`)
  } catch (error) {
    console.error('播放歌单失败:', error)
    MessagePlugin.error('播放歌单失败')
  }
}

// 导入功能
const handleImport = () => {
  showImportDialog.value = true
}

// 从播放列表导入
const importFromPlaylist = async () => {
  showImportDialog.value = false

  // 获取当前播放列表
  const localUserStore = LocalUserDetailStore()
  const currentPlaylist = JSON.parse(JSON.stringify(localUserStore.list))

  if (!currentPlaylist || currentPlaylist.length === 0) {
    MessagePlugin.warning('当前播放列表为空，无法导入')
    return
  }

  try {
    // 创建歌单名称（基于当前时间）
    const now = new Date()
    const playlistName = `播放列表 ${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`

    // 创建新歌单
    const createResult = await songListAPI.create(
      playlistName,
      `从播放列表导入，共 ${currentPlaylist.length} 首歌曲`,
      'local'
    )

    if (!createResult.success || !createResult.data) {
      MessagePlugin.error(createResult.error || '创建歌单失败')
      return
    }

    // 等待一小段时间确保文件系统操作完成
    await new Promise((resolve) => setTimeout(resolve, 200))

    // 将播放列表中的歌曲添加到新歌单
    const addResult = await songListAPI.addSongs(createResult.data.id, currentPlaylist)

    if (addResult.success) {
      const added = (addResult.data && (addResult.data as any).added) ?? currentPlaylist.length
      const skipped =
        (addResult.data && (addResult.data as any).skipped) ??
        Math.max(0, currentPlaylist.length - added)
      MessagePlugin.success(
        skipped > 0
          ? `成功从播放列表导入 ${added} 首歌曲到歌单"${playlistName}"，跳过 ${skipped} 首重复`
          : `成功从播放列表导入 ${added} 首歌曲到歌单"${playlistName}"`
      )
      addPlaylistState({
        id: createResult.data!.id,
        name: playlistName,
        description: `从播放列表导入，共 ${currentPlaylist.length} 首歌曲`,
        coverImgUrl: 'default-cover',
        createTime: new Date().toISOString(),
        updateTime: new Date().toISOString(),
        source: 'local',
        meta: {}
      } as SongList)
    } else {
      MessagePlugin.error(addResult.error || '添加歌曲到歌单失败')
    }
  } catch (error) {
    console.error('从播放列表导入失败:', error)
    MessagePlugin.error('从播放列表导入失败')
  }
}

// 网络歌单导入对话框状态
const showNetworkImportDialog = ref(false)
const networkPlaylistUrl = ref('')
const importPlatformType = ref('wy') // 默认选择网易云音乐

// 从网络歌单导入
const importFromNetwork = () => {
  showImportDialog.value = false
  showNetworkImportDialog.value = true
  networkPlaylistUrl.value = ''
  importPlatformType.value = 'wy' // 重置为默认平台
}

// 确认网络歌单导入
const confirmNetworkImport = async () => {
  if (!networkPlaylistUrl.value || !networkPlaylistUrl.value.trim()) {
    MessagePlugin.warning('请输入有效的歌单链接')
    return
  }

  showNetworkImportDialog.value = false
  await handleNetworkPlaylistImport(networkPlaylistUrl.value.trim())
}

// 取消网络歌单导入
const cancelNetworkImport = () => {
  showNetworkImportDialog.value = false
  networkPlaylistUrl.value = ''
  importPlatformType.value = 'wy'
}

// 为歌单歌曲获取封面图片
const setPicForPlaylist = async (songs: any[], source: string) => {
  await hydrateMissingSongCovers(songs, source)
}

// 处理网络歌单导入
const handleNetworkPlaylistImport = async (input: string) => {
  try {
    const load1 = MessagePlugin.loading('正在解析歌单链接...', 0)

    let playlistId: string = ''
    let platformName: string = ''

    if (importPlatformType.value === 'wy') {
      // 网易云音乐歌单ID解析
      const playlistIdRegex = /(?:music\.163\.com\/.*[?&]id=|playlist\?id=|playlist\/|id=)(\d+)/i
      const match = input.match(playlistIdRegex)

      if (match && match[1]) {
        playlistId = match[1]
      } else {
        const numericMatch = input.match(/^\d+$/)
        if (numericMatch) {
          playlistId = input
        } else {
          MessagePlugin.error('无法识别的网易云音乐歌单链接或ID格式')
          load1.then((res) => res.close())
          return
        }
      }
      platformName = '网易云音乐'
    } else if (importPlatformType.value === 'tx') {
      // QQ音乐歌单ID解析：优先通过 SDK 解析，失败再回退到正则
      let parsedId = ''
      try {
        const parsed: any = await window.api.music.requestSdk('parsePlaylistId', {
          source: 'tx',
          url: input
        })
        console.log('QQ音乐歌单解析结果', parsed)
        if (parsed) parsedId = parsed
      } catch (e) {}

      if (parsedId) {
        playlistId = parsedId
      } else {
        const qqPlaylistRegexes = [
          // 标准歌单链接(强烈推荐)
          /(?:y\.qq\.com\/n\/ryqq\/playlist\/|music\.qq\.com\/.*[?&]id=|playlist[?&]id=)(\d+)/i,
          // 分享链接格式
          /(?:i\.y\.qq\.com\/n2\/m\/share\/details\/taoge\.html.*[?&]id=)(\d+)/i,
          // 其他可能的分享格式 https:\/\/c\d+\.y\.qq\.com\/base\/fcgi-bin\/u\?.*__=([A-Za-z0-9]+)/i,
          // 手机版链接
          /(?:i\.y\.qq\.com\/v8\/playsquare\/playlist\.html.*[?&]id=)(\d+)/i,
          // 通用ID提取 - 匹配 id= 或 &id= 参数
          /[?&]id=(\d+)/i
        ]

        let match: RegExpMatchArray | null = null
        for (const regex of qqPlaylistRegexes) {
          match = input.match(regex)
          if (match && match[1]) {
            playlistId = match[1]
            break
          }
        }

        if (!match || !match[1]) {
          // 检查是否直接输入的是纯数字ID
          const numericMatch = input.match(/^\d+$/)
          if (numericMatch) {
            playlistId = input
          } else {
            MessagePlugin.error('无法识别的QQ音乐歌单链接或ID格式，请检查链接是否正确')
            load1.then((res) => res.close())
            return
          }
        }
      }
      platformName = 'QQ音乐'
    } else if (importPlatformType.value === 'kw') {
      // 酷我音乐歌单ID解析
      const kwPlaylistRegexes = [
        // 标准歌单链接
        /(?:kuwo\.cn\/playlist_detail\/|kuwo\.cn\/.*[?&]pid=)(\d+)/i,
        // 手机版歌单链接（旧格式）
        /(?:m\.kuwo\.cn\/h5app\/playlist\/|kuwo\.cn\/.*[?&]id=)(\d+)/i,
        // 手机版歌单链接 (新格式)
        /m\.kuwo\.cn\/newh5app\/playlist_detail\/(\d+)/i,
        // 通用ID提取
        /[?&](?:pid|id)=(\d+)/i
      ]

      let match: RegExpMatchArray | null = null
      for (const regex of kwPlaylistRegexes) {
        match = input.match(regex)
        if (match && match[1]) {
          playlistId = match[1]
          break
        }
      }

      if (!match || !match[1]) {
        const numericMatch = input.match(/^\d+$/)
        if (numericMatch) {
          playlistId = input
        } else {
          MessagePlugin.error('无法识别的酷我音乐歌单链接或ID格式，请检查链接是否正确')
          load1.then((res) => res.close())
          return
        }
      }
      platformName = '酷我音乐'
    } else if (importPlatformType.value === 'bd') {
      // 波点音乐歌单ID解析
      const bdPlaylistRegexes = [
        // 手机版歌单链接
        /h5app\.kuwo\.cn\/m\/bodian\/collection\.html.*[?&]playlistId=(\d+)/i,
        // 通用ID提取
        /[?&]playlistId=(\d+)/i
      ]

      let match: RegExpMatchArray | null = null
      for (const regex of bdPlaylistRegexes) {
        match = input.match(regex)
        if (match && match[1]) {
          playlistId = match[1]
          break
        }
      }

      if (!match || !match[1]) {
        const numericMatch = input.match(/^\d+$/)
        if (numericMatch) {
          playlistId = input
        } else {
          MessagePlugin.error('无法识别的波点音乐歌单链接或ID格式，请检查链接是否正确')
          load1.then((res) => res.close())
          return
        }
      }
      platformName = '波点音乐'
    } else if (importPlatformType.value === 'kg') {
      // 酷狗音乐链接处理 - 传递完整链接给getUserListDetail
      const kgPlaylistRegexes = [
        // 标准歌单链接
        /kugou\.com\/yy\/special\/single\/\d+/i,
        // 手机版歌单链接 (新格式)
        /m\.kugou\.com\/songlist\/gcid_[a-zA-Z0-9]+/i,
        // 手机版链接 (旧格式)
        /m\.kugou\.com\/.*[?&]id=\d+/i,
        // 参数链接
        /kugou\.com\/.*[?&](?:specialid|id)=\d+/i,
        // 通用酷狗链接
        /kugou\.com\/.*playlist/i
      ]

      let isValidLink = false
      for (const regex of kgPlaylistRegexes) {
        if (regex.test(input)) {
          isValidLink = true
          playlistId = input // 传递完整链接
          break
        }
      }

      if (!isValidLink) {
        // 检查是否为纯数字ID
        const numericMatch = input.match(/^\d+$/)
        if (numericMatch) {
          playlistId = input
        } else {
          MessagePlugin.error('无法识别的酷狗音乐歌单链接或ID格式，请检查链接是否正确')
          load1.then((res) => res.close())
          return
        }
      }
      platformName = '酷狗音乐'
    } else if (importPlatformType.value === 'mg') {
      // 咪咕音乐歌单ID解析
      const mgPlaylistRegexes = [
        // 标准歌单链接
        /(?:music\.migu\.cn\/.*[?&]id=)(\d+)/i,
        // 手机版链接
        /(?:m\.music\.migu\.cn\/.*[?&]id=)(\d+)/i,
        // 通用ID提取
        /[?&]id=(\d+)/i
      ]

      let match: RegExpMatchArray | null = null
      for (const regex of mgPlaylistRegexes) {
        match = input.match(regex)
        if (match && match[1]) {
          playlistId = match[1]
          break
        }
      }

      if (!match || !match[1]) {
        const numericMatch = input.match(/^\d+$/)
        if (numericMatch) {
          playlistId = input
        } else {
          MessagePlugin.error('无法识别的咪咕音乐歌单链接或ID格式，请检查链接是否正确')
          load1.then((res) => res.close())
          return
        }
      }
      platformName = '咪咕音乐'
    } else {
      MessagePlugin.error('不支持的平台类型')
      load1.then((res) => res.close())
      return
    }

    // 关闭加载提示
    load1.then((res) => res.close())

    // 获取歌单详情
    const load2 = MessagePlugin.loading('正在获取歌单信息,请不要离开页面...', 0)

    const getListDetail = async (page: number) => {
      let detailResult: any
      try {
        detailResult = (await window.api.music.requestSdk('getPlaylistDetail', {
          source: importPlatformType.value,
          id: playlistId,
          page: page
        })) as any
        console.log('list', detailResult)
      } catch {
        MessagePlugin.error(`获取${platformName}歌单详情失败：歌曲信息可能有误`)
        load2.then((res) => res.close())
        return
      }

      if (detailResult.error) {
        MessagePlugin.error(`获取${platformName}歌单详情失败：` + detailResult.error)
        load2.then((res) => res.close())
        return
      }

      return detailResult
    }

    let page: number = 1
    const detailResult = await getListDetail(page)
    const playlistInfo = detailResult.info
    let songs: Array<any> = detailResult.list || []

    if (songs.length === 0) {
      MessagePlugin.warning('该歌单没有歌曲')
      load2.then((res) => res.close())
      return
    }

    while (true) {
      if (detailResult.total < songs.length) break
      page++
      const { list: songsList } = await getListDetail(page)
      if (!(songsList && songsList.length)) {
        break
      }
      songs = songs.concat(songsList)
    }

    // 处理导入结果
    let successCount = 0
    let failCount = 0

    // 为酷狗音乐获取封面图片
    if (importPlatformType.value === 'kg') {
      load2.then((res) => res.close())
      const load3 = MessagePlugin.loading('正在获取歌曲封面...')
      if (songs.length > 100) MessagePlugin.info('歌曲较多，封面获取可能较慢')

      try {
        await setPicForPlaylist(songs, importPlatformType.value)
      } catch (error) {
        console.warn('获取封面失败，但继续导入:', error)
      }

      load3.then((res) => res.close())
      const load4 = MessagePlugin.loading('正在创建本地歌单...')

      const createResult = await songListAPI.create(
        `${playlistInfo.name} (导入)`,
        playlistInfo.desc
          ? playlistInfo.desc
          : `从${platformName}导入 - 原歌单：${playlistInfo.name}`,
        importPlatformType.value,
        {
          playlistId
        }
      )

      const newPlaylistId = createResult.data!.id
      await songListAPI.updateCover(newPlaylistId, detailResult.info.img)

      if (!createResult.success) {
        MessagePlugin.error('创建本地歌单失败：' + createResult.error)
        load4.then((res) => res.close())
        return
      }

      const addResult = await songListAPI.addSongs(newPlaylistId, songs)
      load4.then((res) => res.close())

      if (addResult.success) {
        const added = (addResult.data && (addResult.data as any).added) ?? songs.length
        successCount = added
        failCount = Math.max(0, songs.length - added)
      } else {
        successCount = 0
        failCount = songs.length
        console.error('批量添加歌曲失败:', addResult.error)
      }
      addPlaylistState({
        id: newPlaylistId,
        name: `${playlistInfo.name} (导入)`,
        description: playlistInfo.desc
          ? playlistInfo.desc
          : `从${platformName}导入 - 原歌单：${playlistInfo.name}`,
        coverImgUrl: detailResult.info.img || 'default-cover',
        createTime: new Date().toISOString(),
        updateTime: new Date().toISOString(),
        source: importPlatformType.value as any,
        meta: { playlistId }
      } as SongList)
    } else {
      const createResult = await songListAPI.create(
        `${playlistInfo.name} (导入)`,
        playlistInfo.desc
          ? playlistInfo.desc
          : `从${platformName}导入 - 原歌单：${playlistInfo.name}`,
        importPlatformType.value,
        {
          playlistId
        }
      )

      const newPlaylistId = createResult.data!.id
      await songListAPI.updateCover(newPlaylistId, detailResult.info.img)

      if (!createResult.success) {
        MessagePlugin.error('创建本地歌单失败：' + createResult.error)
        load2.then((res) => res.close())
        return
      }

      const addResult = await songListAPI.addSongs(newPlaylistId, songs)
      load2.then((res) => res.close())

      if (addResult.success) {
        const added = (addResult.data && (addResult.data as any).added) ?? songs.length
        successCount = added
        failCount = Math.max(0, songs.length - added)
      } else {
        successCount = 0
        failCount = songs.length
        console.error('批量添加歌曲失败:', addResult.error)
      }
      addPlaylistState({
        id: newPlaylistId,
        name: `${playlistInfo.name} (导入)`,
        description: playlistInfo.desc
          ? playlistInfo.desc
          : `从${platformName}导入 - 原歌单：${playlistInfo.name}`,
        coverImgUrl: detailResult.info.img || 'default-cover',
        createTime: new Date().toISOString(),
        updateTime: new Date().toISOString(),
        source: importPlatformType.value as any,
        meta: { playlistId }
      } as SongList)
    }

    // 显示导入结果
    if (successCount > 0) {
      MessagePlugin.success(
        `从${platformName}导入完成！成功导入 ${successCount} 首歌曲` +
          (failCount > 0 ? `，${failCount} 首歌曲导入失败` : '')
      )
    } else {
      MessagePlugin.error('导入失败，没有成功导入任何歌曲')
    }
  } catch (error) {
    console.error('网络歌单导入失败:', error)
    MessagePlugin.error('导入失败：' + (error instanceof Error ? error.message : '未知错误'))
  }
}

const downloadPlaylist = async (playlist: SongList) => {
  try {
    const res = await songListAPI.getSongs(playlist.id)
    if (!res.success) {
      MessagePlugin.error(res.error || '获取歌单歌曲失败')
      return
    }
    const songs = res.data || []
    const downloadableSongs = songs.filter((song) => song.source !== 'local')
    if (downloadableSongs.length === 0) {
      MessagePlugin.warning('歌单中没有可下载的歌曲')
      return
    }

    await downloadBatchSongs(downloadableSongs as any)
  } catch (error) {
    console.error('Download playlist failed:', error)
    MessagePlugin.error('下载失败')
  }
}

const handleUploadToCloud = async (pl: SongList) => {
  let songs: any[] = []
  try {
    const res = await songListAPI.getSongs(pl.id)
    if (!res.success) throw new Error(res.error || '获取歌曲失败')
    songs = [...(res.data || [])]
  } catch (e: any) {
    console.error(e)
    MessagePlugin.error('获取歌曲失败: ' + (e.message || '未知错误'))
    return
  }

  try {
    await handleUploadToCloudHelper(
      {
        id: pl.id,
        name: pl.name,
        description: pl.description || '',
        cover: pl.coverImgUrl,
        meta: pl.meta
      },
      songs,
      loadPlaylists
    )
  } catch (e) {
    // Error handled in helper
  }
}

const handleSyncToCloud = async (pl: any) => {
  let songs: any[] = []
  try {
    const res = await songListAPI.getSongs(pl.id)
    if (!res.success) throw new Error(res.error || '获取歌曲失败')
    songs = [...(res.data || [])]
  } catch (e: any) {
    console.error(e)
    MessagePlugin.error('获取歌曲失败: ' + (e.message || '未知错误'))
    return
  }

  try {
    await handleSyncToCloudHelper(
      {
        id: pl.id,
        name: pl.name,
        description: pl.description || '',
        cover: pl.coverImgUrl,
        meta: pl.meta
      },
      songs,
      loadPlaylists
    )
  } catch (e) {
    // Error handled in helper
  }
}

const openPlaylistShareDialog = async (pl: SongList) => {
  shareTargetPlaylist.value = pl
  try {
    const res = await songListAPI.getSongs(pl.id)
    shareTargetPlaylistSongCount.value = res.success
      ? (res.data || []).filter((s) => s.source !== 'local').length
      : 0
  } catch {
    shareTargetPlaylistSongCount.value = 0
  }
  sharePlaylistDialogVisible.value = true
}

const handleSharePlaylist = async (pl: SongList) => {
  if (pl.meta?.cloudId) {
    openPlaylistShareDialog(pl)
    return
  }

  const dialog = DialogPlugin.confirm({
    header: '先上传到云端',
    body: `歌单"${pl.name}"需要先上传到云端后才能分享，是否继续？`,
    confirmBtn: '上传并分享',
    cancelBtn: '取消',
    onConfirm: async () => {
      dialog.destroy()
      let songs: any[] = []
      try {
        const res = await songListAPI.getSongs(pl.id)
        if (!res.success) throw new Error(res.error || '获取歌曲失败')
        songs = [...(res.data || [])]
      } catch (e: any) {
        MessagePlugin.error('获取歌曲失败: ' + (e.message || '未知错误'))
        return
      }

      try {
        const newMeta = await handleUploadToCloudHelper(
          {
            id: pl.id,
            name: pl.name,
            description: pl.description || '',
            cover: pl.coverImgUrl,
            meta: pl.meta
          },
          songs,
          loadPlaylists
        )
        const patched = {
          ...pl,
          meta: {
            ...(pl.meta || {}),
            ...(newMeta || {})
          }
        }
        updatePlaylistState(pl.id, { meta: patched.meta })
        openPlaylistShareDialog(patched as SongList)
      } catch {
        // helper 内已提示
      }
    },
    onCancel: () => dialog.destroy()
  })
}

const handleDownloadCloudPlaylist = async (pl: any) => {
  const loadingMsg = MessagePlugin.loading('正在下载到本地...', 0)
  try {
    // 循环分页拉取所有歌曲
    let allCloudSongs: CloudSongDto[] = []
    let pos: number | undefined = undefined
    const limit = 100

    while (true) {
      const syncAPI = await getSongListSyncAPI()
      const { list: batch, total } = await syncAPI.getSongListDetail(pl.id, 'asc', limit, pos)
      if (!batch || batch.length === 0) break

      allCloudSongs = [...allCloudSongs, ...batch]

      if (allCloudSongs.length >= total || batch.length < limit) break
      pos = batch[batch.length - 1].pos
    }

    const localSongs = allCloudSongs.map(mapCloudSongToLocal)

    // Create local playlist
    const createRes = await songListAPI.create(pl.name, pl.description, 'local')
    if (!createRes.success || !createRes.data) throw new Error(createRes.error || '创建歌单失败')

    const localId = createRes.data.id

    // Add songs
    await songListAPI.addSongs(localId, localSongs)

    // Update meta
    const newMeta = getPersistentMeta({
      ...pl.meta,
      cloudUpdatedAt: pl.meta.cloudUpdatedAt
    })
    await songListAPI.edit(localId, { meta: newMeta })

    // If cover is URL, update it
    if (pl.coverImgUrl) {
      await songListAPI.updateCover(localId, pl.coverImgUrl)
    }

    // 重要：通知云端更新 localId，建立双向绑定
    const syncAPI = await getSongListSyncAPI()
    await syncAPI.updateUserSongList({
      listId: pl.id,
      localId: localId
    })

    loadingMsg.then((inst) => inst.close())
    MessagePlugin.success('下载成功')
    removePlaylistState(pl.id)
  } catch (e: any) {
    loadingMsg.then((inst) => inst.close())
    console.error(e)
    MessagePlugin.error('下载失败: ' + (e.message || '未知错误'))
  }
}

const handleDeleteCloudPlaylist = async (pl: SongList) => {
  const confirm = DialogPlugin.confirm({
    header: '删除云端歌单',
    body: `确定要删除云端歌单 "${pl.name}" 吗？此操作不可恢复。`,
    onConfirm: async () => {
      confirm.destroy()
      try {
        const syncAPI = await getSongListSyncAPI()
        await syncAPI.deleteUserSongList(pl.id)
        MessagePlugin.success('删除成功')
        removePlaylistState(pl.id)
      } catch (e: any) {
        MessagePlugin.error('删除失败: ' + e.message)
      }
    },
    onCancel: () => confirm.destroy()
  })
}

const handleDeletePlaylist = async (pl: SongList) => {
  const isSynced = pl.meta?.isSynced && pl.meta?.cloudId

  const dialog = DialogPlugin.confirm({
    header: '删除歌单',
    body: `确定要删除歌单 "${pl.name}" 吗？` + (isSynced ? ' (云端副本将保留)' : ''),
    onConfirm: async () => {
      dialog.destroy()
      try {
        const result = await songListAPI.delete(pl.id)
        if (result.success) {
          MessagePlugin.success('歌单删除成功')
          removePlaylistState(pl.id)
        } else {
          MessagePlugin.error(result.error || '删除歌单失败')
        }
      } catch (error) {
        console.error('删除歌单失败:', error)
        MessagePlugin.error('删除歌单失败')
      }
    },
    onCancel: () => dialog.destroy()
  })
}

const handleDeleteBoth = async (pl: SongList) => {
  const dialog = DialogPlugin.confirm({
    header: '删除歌单',
    body: `确定要删除歌单 "${pl.name}" (本地和云端) 吗？`,
    onConfirm: async () => {
      dialog.destroy()
      try {
        // Delete cloud
        if (pl.meta?.cloudId) {
          const syncAPI = await getSongListSyncAPI()
          await syncAPI.deleteUserSongList(pl.meta.cloudId).catch((e) => console.error('Cloud delete failed', e))
        }

        // Delete local
        const result = await songListAPI.delete(pl.id)
        if (result.success) {
          MessagePlugin.success('删除成功')
          await loadPlaylists()
        } else {
          MessagePlugin.error(result.error || '删除本地歌单失败')
        }
      } catch (error) {
        MessagePlugin.error('删除失败')
      }
    },
    onCancel: () => dialog.destroy()
  })
}

// 右键菜单项配置 (Naive UI Dropdown 格式)
const contextMenuOptions = computed(() => {
  if (!contextMenuPlaylist.value) return []
  const pl = contextMenuPlaylist.value
  const isCloudOnly = pl.meta?.isCloudOnly
  const isSynced = pl.meta?.isSynced

  // ========== 云端歌单菜单 ==========
  if (isCloudOnly) {
    return [
      { label: '播放歌单', key: 'play', icon: renderIcon(PlayCircleIcon) },
      { label: '查看详情', key: 'view', icon: renderIcon(ViewListIcon) },
      { type: 'divider', key: 'd1' },
      { label: '分享歌单', key: 'share-playlist', icon: renderIcon(ShareIcon) },
      { label: '下载到本地', key: 'download-cloud', icon: renderIcon(CloudDownloadIcon) },
      { type: 'divider', key: 'd2' },
      { label: '删除云端歌单', key: 'delete-cloud', icon: renderIcon(DeleteIcon) }
    ]
  }

  // ========== 本地/已同步歌单菜单 ==========
  const items: any[] = [
    { label: '播放歌单', key: 'play', icon: renderIcon(PlayCircleIcon) },
    { label: '查看详情', key: 'view', icon: renderIcon(ViewListIcon) }
  ]

  // 同步平台歌单 - 仅对有 playlistId 的歌单显示
  const hasPlatformPlaylistId = pl.meta && 'playlistId' in pl.meta
  if (hasPlatformPlaylistId) {
    const sourceName = getSourceName(pl.meta?.source || pl.source)
    items.push({
      label: `同步平台歌单(${sourceName})`,
      key: 'sync-platform',
      icon: renderIcon(RefreshIcon)
    })
  }

  items.push({ type: 'divider', key: 'd1' })

  // 云端操作
  if (isSynced) {
    items.push({ label: '同步到云端', key: 'sync-cloud', icon: renderIcon(CloudUploadIcon) })
  } else {
    items.push({ label: '上传到云端', key: 'upload-cloud', icon: renderIcon(CloudUploadIcon) })
  }

  items.push(
    { label: '分享歌单', key: 'share-playlist', icon: renderIcon(ShareIcon) },
    { label: '全部下载', key: 'download-all', icon: renderIcon(DownloadIcon) },
    { type: 'divider', key: 'd2' },
    { label: '编辑歌单', key: 'edit', icon: renderIcon(Edit2Icon) },
    { label: '导出歌单', key: 'export', icon: renderIcon(FileExportIcon) },
    { type: 'divider', key: 'd3' }
  )

  // 删除操作 - 已同步歌单显示二级菜单，普通本地歌单直接删除
  if (isSynced) {
    items.push({
      label: '删除',
      key: 'delete-menu',
      icon: renderIcon(DeleteIcon),
      children: [
        { label: '删除本地歌单', key: 'delete-local' },
        { label: '删除云端歌单', key: 'delete-cloud-only' },
        { label: '删除(双端)', key: 'delete-both' }
      ]
    })
  } else {
    items.push({ label: '删除歌单', key: 'delete', icon: renderIcon(DeleteIcon) })
  }

  return items
})

// 处理右键菜单选择
const handleContextMenuSelect = async (key: string) => {
  const pl = contextMenuPlaylist.value
  if (!pl) return

  contextMenuVisible.value = false

  switch (key) {
    case 'play':
      playPlaylist(pl)
      break
    case 'view':
      viewPlaylist(pl)
      break
    case 'sync-platform':
      syncPlatformPlaylist(pl)
      break
    case 'sync-cloud':
      handleSyncToCloud(pl)
      break
    case 'upload-cloud':
      handleUploadToCloud(pl)
      break
    case 'share-playlist':
      handleSharePlaylist(pl)
      break
    case 'download-all':
      downloadPlaylist(pl)
      break
    case 'download-cloud':
      handleDownloadCloudPlaylist(pl)
      break
    case 'edit':
      editPlaylist(pl)
      break
    case 'export':
      await handleExportPlaylist(pl)
      break
    case 'delete':
    case 'delete-local':
      handleDeletePlaylist(pl)
      break
    case 'delete-cloud':
    case 'delete-cloud-only':
      handleDeleteCloudPlaylist(pl)
      break
    case 'delete-both':
      handleDeleteBoth(pl)
      break
  }
}

// 导出歌单处理函数
const handleExportPlaylist = async (pl: SongList) => {
  try {
    const res = await songListAPI.getSongs(pl.id)
    if (!res.success) {
      MessagePlugin.error(res.error || '获取歌单歌曲失败')
      return
    }
    const songs = res.data || []
    if (songs.length === 0) {
      MessagePlugin.warning('歌单中没有可导出的歌曲')
      return
    }
    const filtered = songs.filter((s) => s.source !== 'local')
    const removed = songs.length - filtered.length
    const safeName = pl.name.replace(/[\\/:*?"<>|]+/g, '_')
    const fileName = `树夏Music-${safeName}.cmpl`
    const saved = await exportPlaylistToFile(filtered, fileName)
    if (removed > 0) MessagePlugin.info(`已筛除 ${removed} 首本地歌曲`)
    MessagePlugin.success(`歌单已导出为 ${saved}`)
  } catch (e) {
    MessagePlugin.error(`导出失败: ${(e as Error).message}`)
  }
}

// 处理歌单右键菜单
const handlePlaylistContextMenu = (event: MouseEvent, playlist: SongList) => {
  event.preventDefault()
  event.stopPropagation()

  // 先关闭再打开，确保位置更新
  contextMenuVisible.value = false
  nextTick(() => {
    contextMenuPlaylist.value = playlist
    contextMenuX.value = event.clientX
    contextMenuY.value = event.clientY
    contextMenuVisible.value = true
  })
}

// 关闭右键菜单
const closeContextMenu = () => {
  contextMenuVisible.value = false
}

// 滚动位置保持
const scrollRef = ref<HTMLElement>()
const scrollTop = ref(0)
let unsubscribePlaylistSync: (() => void) | null = null
let cloudFavoritesPulling = false
let playlistRefreshTimer: number | null = null
let lastPlaylistRefreshAt = 0
let playlistRefreshPromise: Promise<void> | null = null

const refreshPlaylistsWithCloudFavorites = async (
  options: { immediate?: boolean } = {}
): Promise<void> => {
  if (playlistRefreshPromise) return playlistRefreshPromise
  const now = performance.now()
  const elapsed = now - lastPlaylistRefreshAt
  if (elapsed < 1200 && !options.immediate) {
    if (playlistRefreshTimer != null) window.clearTimeout(playlistRefreshTimer)
    playlistRefreshTimer = window.setTimeout(() => {
      playlistRefreshTimer = null
      void refreshPlaylistsWithCloudFavorites()
    }, 1200 - elapsed)
    return Promise.resolve()
  }
  if (playlistRefreshTimer != null) {
    window.clearTimeout(playlistRefreshTimer)
    playlistRefreshTimer = null
  }
  lastPlaylistRefreshAt = now
  cloudFavoritesPulling = true
  playlistRefreshPromise = (async () => {
    const authStore = useAuthStore()
    const syncAPI = await getPreferredSongListAPI()
    if (!syncAPI && (!authStore.initialized || !authStore.isAuthenticated)) {
      await loadPlaylists()
      return
    }
    await pullFavoritesFromCloud().catch((error) => {
      console.warn('拉取云端收藏失败:', error)
    })
    await loadPlaylists()
  })()

  try {
    await playlistRefreshPromise
  } finally {
    cloudFavoritesPulling = false
    playlistRefreshPromise = null
  }
}

const handleManualRefresh = async () => {
  if (manualRefreshing.value) return
  manualRefreshing.value = true
  try {
    await refreshPlaylistsWithCloudFavorites({ immediate: true })
  } finally {
    manualRefreshing.value = false
  }
}

const handleDesktopLibraryResume = () => {
  if (document.visibilityState !== 'visible') return
  if (performance.now() - lastPlaylistRefreshAt < 30_000) return
  void refreshPlaylistsWithCloudFavorites()
}

const handlePlaylistUpdated = (event?: Event) => {
  if ((event as CustomEvent | undefined)?.detail?.remote) {
    // 远端事件已经写入本地库；只重新加载本地列表，不能再次拉云端并冲刷 outbox。
    void loadPlaylists()
    return
  }
  // 远端事件应用期间只等待本地数据库事务完成。此时再次调用
  // pullFavoritesFromCloud 会先发送旧 outbox，可能把取消收藏复活。
  if (isNasSyncApplyingRemoteEvents()) return
  void refreshPlaylistsWithCloudFavorites()
}

// 【新·现在用这个】统一实时同步总线处理器：与旧的 handlePlaylistUpdated 行为一致，
// 用 event.source 区分远端 / 本地（等价于旧的 detail.remote）。这是当前唯一生效的一套。
let stopPlaylistSyncBus: (() => void) | null = null
const handlePlaylistSyncBus = (event: SyncEvent) => {
  if (event.source === 'remote') {
    void loadPlaylists()
    return
  }
  if (isNasSyncApplyingRemoteEvents()) return
  void refreshPlaylistsWithCloudFavorites()
}

// 组件挂载时加载数据
let isFirstActivation = true

onMounted(() => {
  // 事件监听器在 onMounted 中注册，避免重复注册
  document.addEventListener('visibilitychange', handleDesktopLibraryResume)
  window.addEventListener('focus', handleDesktopLibraryResume)
  // 【新】改用统一实时同步总线；歌单增删改（本地或远端）都从这里收到
  stopPlaylistSyncBus = onSyncEvent('playlist', handlePlaylistSyncBus)
  // 【旧·已停用，勿再启用】原来的 window 事件监听，和上面的总线做同一件事，
  // 再监听就是重复刷新（多余）。保留注释仅作对照。
  // window.addEventListener('playlist-updated', handlePlaylistUpdated)
  unsubscribePlaylistSync = window.api.plugins.onPlaylistsSynced(() => {
    handlePlaylistUpdated()
  })
  // 监听页面滚动，关闭右键菜单
  nextTick(() => {
    if (scrollRef.value) {
      scrollRef.value.addEventListener('scroll', handleScrollCloseMenu, { passive: true })
    }
  })
})

onBeforeUnmount(() => {
  if (hoverClearTimer) {
    window.clearTimeout(hoverClearTimer)
    hoverClearTimer = 0
  }
  document.removeEventListener('visibilitychange', handleDesktopLibraryResume)
  window.removeEventListener('focus', handleDesktopLibraryResume)
  // 【新】取消统一同步总线订阅
  stopPlaylistSyncBus?.()
  stopPlaylistSyncBus = null
  // 【旧·已停用】对应上面已注释的 window 监听，无需再解绑
  // window.removeEventListener('playlist-updated', handlePlaylistUpdated)
  if (playlistRefreshTimer != null) {
    window.clearTimeout(playlistRefreshTimer)
    playlistRefreshTimer = null
  }
  unsubscribePlaylistSync?.()
  unsubscribePlaylistSync = null
  if (scrollRef.value) {
    scrollRef.value.removeEventListener('scroll', handleScrollCloseMenu)
  }
})

// 滚动时关闭右键菜单
const handleScrollCloseMenu = () => {
  if (contextMenuVisible.value) {
    closeContextMenu()
  }
}

onActivated(() => {
  // 首次激活时加载数据，后续激活时只恢复滚动位置
  if (isFirstActivation) {
    isFirstActivation = false
    void refreshPlaylistsWithCloudFavorites()
  }
  if (scrollRef.value) {
    scrollRef.value.scrollTop = scrollTop.value
  }
})

onDeactivated(() => {
  if (scrollRef.value) {
    scrollTop.value = scrollRef.value.scrollTop
  }
})
</script>

<template>
  <div ref="scrollRef" class="page">
    <input
      ref="songlistFileInputRef"
      accept=".cmpl,.cpl,.lxmc,.json"
      style="display: none"
      type="file"
      @change="handleSonglistFileChange"
    />
    <div class="local-container">
      <!-- 页面标题和操作 -->
      <div class="page-header">
        <div class="header-left">
          <h2>本地歌单</h2>
        </div>
        <div class="header-actions">
          <!-- <t-button theme="default" @click="openMusicFolder">
            <i class="iconfont icon-shouye"></i>
            打开文件夹
          </t-button>
          <t-button theme="primary" @click="importMusic">
            <i class="iconfont icon-zengjia"></i>
            导入音乐
          </t-button> -->
          <t-button theme="primary" variant="outline" @click="showCreatePlaylistDialog = true">
            <i class="iconfont icon-zengjia"></i>
            新建歌单
          </t-button>
          <t-button theme="primary" @click="handleImport">
            <i class="iconfont icon-daoru"></i>
            导入
          </t-button>
        </div>
      </div>

      <!-- 歌单区域 -->
      <div class="playlists-section">
        <div class="section-header">
          <h3>我的歌单 ({{ playlists.length }})</h3>
          <div class="section-actions">
            <t-button
              :loading="manualRefreshing"
              size="small"
              theme="primary"
              variant="text"
              @click="handleManualRefresh"
            >
              <i class="iconfont icon-shuaxin"></i>
              刷新
            </t-button>
          </div>
        </div>

        <!-- 首次进入才整页转圈；已有列表时后台刷新，避免侧栏点进来再闪一下 -->
        <div v-if="loading && playlists.length === 0" class="loading-state">
          <t-loading size="large" text="加载中..." />
        </div>

        <!-- 歌单网格 -->
        <div v-else-if="playlists.length > 0" class="playlists-grid">
          <div
            v-for="playlist in playlists"
            :key="playlist.id"
            class="playlist-card"
            :class="{ 'custom-bg': settingsStore.settings.globalBackground?.enable }"
            @contextmenu="handlePlaylistContextMenu($event, playlist)"
            :style="coverBackdropStyle(playlist)"
            @mouseenter="onCoverHoverEnter(playlist)"
            @mouseleave="onCoverHoverLeave"
          >
            <div class="playlist-cover" @click="viewPlaylist(playlist)">
              <s-image
                v-if="playlist.coverImgUrl"
                :alt="playlist.name"
                :src="getCoverUrl(playlist)"
                :max-edge="384"
                :observe-visibility="true"
                :release-on-hide="true"
                class="cover-image"
              />
              <div class="cover-overlay">
                <i class="iconfont icon-bofang"></i>
              </div>
              <div class="cover-meta">
                <span class="cover-source">{{ getSourceBadgeLabel(playlist.source) }}</span>
                <div
                  v-if="getPlaylistUpdatedAt(playlist)"
                  class="cover-updated"
                  :title="formatLocalTime(getPlaylistUpdatedAt(playlist))"
                >
                  <span class="cover-updated-label">更新于</span>
                  <time class="cover-updated-time">
                    {{ formatLocalTime(getPlaylistUpdatedAt(playlist)) }}
                  </time>
                </div>
              </div>
            </div>
            <div class="playlist-info">
              <div class="playlist-name-row" @click="viewPlaylist(playlist)">
                <div :title="playlist.name" class="playlist-name-text">
                  {{ playlist.name }}
                </div>
                <div
                  v-if="
                    playlist.id === favoritesId ||
                    playlist.meta?.isSynced ||
                    playlist.meta?.isCloudOnly
                  "
                  class="playlist-tags"
                >
                  <t-tag
                    v-if="playlist.id === favoritesId"
                    size="small"
                    theme="danger"
                    variant="light-outline"
                    >我的喜欢</t-tag
                  >
                  <t-tooltip
                    v-if="playlist.meta?.isSynced || playlist.meta?.isCloudOnly"
                    :content="playlist.meta?.isSynced ? '已同步' : '仅云端'"
                  >
                    <span style="display: inline-flex; vertical-align: middle">
                      <CloudIcon
                        v-if="playlist.meta?.isSynced"
                        style="color: var(--td-brand-color); font-size: 16px"
                      />
                      <CloudIcon v-else style="color: #999; font-size: 16px" />
                    </span>
                  </t-tooltip>
                </div>
              </div>
              <div :title="playlist.description" class="playlist-description">
                {{ formatServicePlaylistDescription(playlist) || '这个人很懒并没有留下任何描述...' }}
              </div>
            </div>
            <div class="playlist-actions">
              <t-tooltip content="播放歌单">
                <t-button
                  shape="circle"
                  size="small"
                  theme="primary"
                  variant="text"
                  @click="playPlaylist(playlist)"
                >
                  <i class="iconfont icon-bofang"></i>
                </t-button>
              </t-tooltip>
              <t-tooltip content="查看详情">
                <t-button
                  shape="circle"
                  size="small"
                  theme="default"
                  variant="text"
                  @click="viewPlaylist(playlist)"
                >
                  <view-list-icon
                    :fill-color="'transparent'"
                    :stroke-color="'#000000'"
                    :stroke-width="1.5"
                  />
                </t-button>
              </t-tooltip>
              <t-tooltip content="编辑歌单">
                <t-button
                  shape="circle"
                  size="small"
                  theme="success"
                  variant="text"
                  @click="editPlaylist(playlist)"
                >
                  <Edit2Icon />
                </t-button>
              </t-tooltip>

              <t-tooltip content="删除歌单">
                <t-button
                  shape="circle"
                  size="small"
                  theme="danger"
                  variant="text"
                  @click="deletePlaylist(playlist)"
                >
                  <i class="iconfont icon-shanchu"></i>
                </t-button>
              </t-tooltip>
            </div>
          </div>
        </div>

        <!-- 歌单空状态：加载中不展示“创建歌单”，避免每次切入闪一下 -->
        <div v-else-if="!loading" class="empty-playlists">
          <div class="empty-icon">
            <i class="iconfont icon-gedan"></i>
          </div>
          <h4>暂无歌单</h4>
          <p>创建您的第一个歌单来管理音乐</p>
          <t-button theme="primary" @click="showCreatePlaylistDialog = true">
            <i class="iconfont icon-zengjia"></i>
            创建歌单
          </t-button>
        </div>
      </div>
    </div>

    <!-- 创建歌单对话框 -->
    <t-dialog
      v-model:visible="showCreatePlaylistDialog"
      :cancel-btn="{ content: '取消' }"
      :confirm-btn="{ content: '创建', theme: 'primary' }"
      header="创建新歌单"
      placement="center"
      width="500px"
      @confirm="createPlaylist"
    >
      <div class="create-form">
        <t-form :data="newPlaylistForm" layout="vertical">
          <t-form-item label="歌单名称" name="name" required>
            <t-input
              v-model="newPlaylistForm.name"
              clearable
              placeholder="请输入歌单名称"
              @keyup.enter="createPlaylist"
            />
          </t-form-item>
          <t-form-item label="歌单描述" name="description">
            <t-textarea
              v-model="newPlaylistForm.description"
              :autosize="{ minRows: 3, maxRows: 5 }"
              :maxlength="200"
              placeholder="请输入歌单描述（可选）"
            />
          </t-form-item>
        </t-form>
      </div>
    </t-dialog>

    <!-- 导入选择对话框 -->
    <t-dialog
      v-model:visible="showImportDialog"
      :footer="false"
      header="选择导入方式"
      placement="center"
      width="400px"
    >
      <div class="import-options">
        <div class="import-option" @click="importFromPlaylist">
          <div class="option-icon">
            <i class="iconfont icon-liebiao"></i>
          </div>
          <div class="option-content">
            <h4>从播放列表</h4>
            <p>将当前播放列表保存为歌单</p>
          </div>
          <div class="option-arrow">
            <i class="iconfont icon-youjiantou"></i>
          </div>
        </div>
        <div class="import-option" @click="triggerSonglistFileInput">
          <div class="option-icon">
            <i class="iconfont icon-daoru"></i>
          </div>
          <div class="option-content">
            <h4>从本地歌单文件</h4>
            <p>导入 .cmpl/.cpl，或洛雪/LX Music 导出的 .lxmc/.json 歌单</p>
          </div>
          <div class="option-arrow">
            <i class="iconfont icon-youjiantou"></i>
          </div>
        </div>
        <div class="import-option" @click="importFromNetwork">
          <div class="option-icon">
            <i class="iconfont icon-wangluo"></i>
          </div>
          <div class="option-content">
            <h4>从网络歌单</h4>
            <p>导入网易云音乐、QQ音乐等平台歌单</p>
            <span class="coming-soon">实验性功能</span>
          </div>
          <div class="option-arrow">
            <i class="iconfont icon-youjiantou"></i>
          </div>
        </div>
      </div>
    </t-dialog>
    <!-- 网络歌单导入对话框 -->
    <t-dialog
      v-model:visible="showNetworkImportDialog"
      :cancel-btn="{ content: '取消', variant: 'outline' }"
      :confirm-btn="{ content: '开始导入', theme: 'primary' }"
      :style="{ maxHeight: '80vh' }"
      header="导入网络歌单"
      placement="center"
      width="600px"
      @cancel="cancelNetworkImport"
      @confirm="confirmNetworkImport"
    >
      <div class="network-import-content">
        <!-- 平台选择 -->
        <div class="platform-selector">
          <label class="form-label">选择导入平台</label>
          <t-radio-group v-model="importPlatformType" variant="primary-filled">
            <t-radio-button value="wy"> 网易云音乐 </t-radio-button>
            <t-radio-button value="tx"> QQ音乐 </t-radio-button>
            <t-radio-button value="kw"> 酷我音乐 </t-radio-button>
            <t-radio-button value="bd"> 波点音乐 </t-radio-button>
            <t-radio-button value="kg"> 酷狗音乐 </t-radio-button>
            <t-radio-button value="mg"> 咪咕音乐 </t-radio-button>
          </t-radio-group>
        </div>

        <!-- 内容区域 - 添加过渡动画 -->
        <div class="import-content-wrapper">
          <transition mode="out-in" name="fade-slide">
            <div :key="importPlatformType" class="import-content">
              <div style="margin-bottom: 1em">
                请输入{{
                  importPlatformType === 'wy'
                    ? '网易云音乐'
                    : importPlatformType === 'tx'
                      ? 'QQ音乐'
                      : importPlatformType === 'kw'
                        ? '酷我音乐'
                        : importPlatformType === 'bd'
                          ? '波点音乐'
                          : importPlatformType === 'kg'
                            ? '酷狗音乐'
                            : importPlatformType === 'mg'
                              ? '咪咕音乐'
                              : '音乐平台'
                }}歌单链接或歌单ID，系统将自动识别格式并导入歌单中的所有歌曲到本地歌单。
              </div>
              <t-input
                v-model="networkPlaylistUrl"
                :placeholder="
                  importPlatformType === 'wy'
                    ? '支持链接或ID：https://music.163.com/playlist?id=123456789 或 123456789'
                    : importPlatformType === 'tx'
                      ? '支持链接或ID：https://y.qq.com/n/ryqq/playlist/123456789 或 123456789'
                      : importPlatformType === 'kw'
                        ? '支持链接或ID：http://www.kuwo.cn/playlist_detail/123456789 或 123456789'
                        : importPlatformType === 'bd'
                          ? '支持链接或ID：https://h5app.kuwo.cn/m/bodian/collection.html?playlistId=123456789 或 123456789'
                          : importPlatformType === 'kg'
                            ? '手机链接或酷狗码：https://www.kugou.com/yy/special/single/123456789 或 123456789'
                            : importPlatformType === 'mg'
                              ? '支持链接或ID：https://music.migu.cn/v3/music/playlist/123456789 或 123456789'
                              : '请输入歌单链接或ID'
                "
                autofocus
                class="url-input"
                clearable
                @enter="confirmNetworkImport"
              />

              <div class="import-tips">
                <p class="tip-title">
                  {{
                    importPlatformType === 'wy'
                      ? '网易云音乐'
                      : importPlatformType === 'tx'
                        ? 'QQ音乐'
                        : importPlatformType === 'kw'
                          ? '酷我音乐'
                          : importPlatformType === 'bd'
                            ? '波点音乐'
                            : importPlatformType === 'kg'
                              ? '酷狗音乐'
                              : importPlatformType === 'mg'
                                ? '咪咕音乐'
                                : '音乐平台'
                  }}支持的输入格式：
                </p>
                <ul v-if="importPlatformType === 'wy'" class="tip-list">
                  <li>完整链接：https://music.163.com/playlist?id=123456789</li>
                  <li>手机链接：https://music.163.com/m/playlist?id=123456789</li>
                  <li>分享链接：https://y.music.163.com/m/playlist/123456789</li>
                  <li>纯数字ID：123456789</li>
                  <li>其他包含ID的网易云链接格式</li>
                </ul>
                <ul v-else-if="importPlatformType === 'tx'" class="tip-list">
                  <li>完整链接：https://y.qq.com/n/ryqq/playlist/123456789</li>
                  <li>手机链接：https://i.y.qq.com/v8/playsquare/playlist.html?id=123456789</li>
                  <li>分享链接：https://i.y.qq.com/n2/m/share/details/taoge.html?id=123456789</li>
                  <li>其他分享：https://c.y.qq.com/base/fcgi-bin/u?__=123456789</li>
                  <li>纯数字ID：123456789</li>
                </ul>
                <ul v-else-if="importPlatformType === 'kw'" class="tip-list">
                  <li>完整链接：http://www.kuwo.cn/playlist_detail/123456789</li>
                  <li>手机链接：http://m.kuwo.cn/h5app/playlist/123456789</li>
                  <li>参数链接：http://www.kuwo.cn/playlist?pid=123456789</li>
                  <li>纯数字ID：123456789</li>
                  <li>其他包含ID的酷我音乐链接格式</li>
                </ul>
                <ul v-else-if="importPlatformType === 'bd'" class="tip-list">
                  <li>
                    手机链接：https://h5app.kuwo.cn/m/bodian/collection.html?playlistId=123456789
                  </li>
                  <li>纯数字ID：123456789</li>
                  <li>其他包含ID的波点音乐链接格式</li>
                </ul>
                <ul v-else-if="importPlatformType === 'kg'" class="tip-list">
                  <li>酷狗码（推荐）：123456789</li>
                  <li>完整链接：https://www.kugou.com/yy/special/single/123456789</li>
                  <li>手机版链接：https://m.kugou.com/songlist/gcid_3z9vj0yqz4bz00b</li>
                  <li>旧版手机链接：https://m.kugou.com/playlist?id=123456789</li>
                  <li>参数链接：https://www.kugou.com/playlist?specialid=123456789</li>
                </ul>
                <ul v-else-if="importPlatformType === 'mg'" class="tip-list">
                  <li>完整链接：https://music.migu.cn/v3/music/playlist/123456789</li>
                  <li>手机链接：https://m.music.migu.cn/playlist?id=123456789</li>
                  <li>参数链接：https://music.migu.cn/playlist?id=123456789</li>
                  <li>纯数字ID：123456789</li>
                  <li>其他包含ID的咪咕音乐链接格式</li>
                </ul>
                <p class="tip-note">智能识别：系统会自动从输入中提取歌单ID</p>
              </div>
            </div>
          </transition>
        </div>
      </div>
    </t-dialog>

    <!-- 编辑歌单对话框 -->
    <t-dialog
      v-model:visible="showEditPlaylistDialog"
      :cancel-btn="{ content: '取消', variant: 'outline' }"
      :confirm-btn="{ content: '保存', theme: 'primary' }"
      header="编辑歌单信息"
      placement="center"
      width="500px"
      @cancel="cancelPlaylistEdit"
      @confirm="savePlaylistEdit"
    >
      <div class="edit-playlist-content">
        <div class="form-item">
          <label class="form-label">歌单名称</label>
          <t-input
            v-model="editPlaylistForm.name"
            autofocus
            clearable
            maxlength="50"
            placeholder="请输入歌单名称"
            show-word-limit
          />
        </div>

        <div class="form-item">
          <label class="form-label">歌单描述</label>
          <t-textarea
            v-model="editPlaylistForm.description"
            :autosize="{ minRows: 3, maxRows: 6 }"
            maxlength="200"
            placeholder="请输入歌单描述（可选）"
            show-word-limit
          />
        </div>
      </div>
    </t-dialog>

    <!-- 歌单右键菜单 -->
    <n-dropdown
      placement="bottom-start"
      trigger="manual"
      :x="contextMenuX"
      :y="contextMenuY"
      :options="contextMenuOptions"
      :show="contextMenuVisible"
      @select="handleContextMenuSelect"
      @clickoutside="closeContextMenu"
    />

    <SharePlaylistDialog
      v-model="sharePlaylistDialogVisible"
      :playlist="shareTargetPlaylist"
      :song-count="shareTargetPlaylistSongCount"
    />
  </div>
</template>

<style lang="scss" scoped>
.page {
  width: 100%;
  height: 100%;
  overflow-y: auto;
}
.local-container {
  padding: 0 2rem;
  padding-top: 1rem;
  margin: 0 auto;
  width: 100%;
  position: relative;
  // background: var(--local-bg);
  color: var(--local-text-primary);
}

// 编辑歌单对话框样式
.edit-playlist-content {
  .form-item {
    margin-bottom: 1.5rem;

    &:last-child {
      margin-bottom: 0;
    }

    .form-label {
      display: block;
      margin-bottom: 0.5rem;
      font-weight: 500;
      color: var(--local-text-primary);
      font-size: 14px;
    }
  }

  .form-tips {
    margin-top: 1rem;
    padding: 0.75rem;
    background: var(--local-tips-bg);
    border-radius: 6px;
    border-left: 3px solid var(--td-success-color);

    .tip-note {
      margin: 0;
      color: var(--local-text-secondary);
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 0.5rem;

      .iconfont {
        color: var(--td-success-color);
        font-size: 14px;
      }
    }
  }
}

// 网络歌单导入对话框样式
.network-import-content {
  max-height: 60vh;
  overflow-y: auto;
  scrollbar-width: none;
  padding: 0 10px;
  // 自定义滚动条样式
  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-track {
    background: #f1f1f1;
    border-radius: 3px;
  }

  &::-webkit-scrollbar-thumb {
    background: #c1c1c1;
    border-radius: 3px;

    &:hover {
      background: #a8a8a8;
    }
  }

  .platform-selector {
    margin-bottom: 2rem;
    position: sticky;
    top: 0;
    background: var(--td-bg-color-container);
    z-index: 10;
    padding: 0.5rem 0;
    margin: -0.5rem 0 1.5rem 0;
    border-bottom: 1px solid var(--local-border);

    .form-label {
      display: block;
      margin-bottom: 1rem;
      font-weight: 600;
      color: var(--local-text-primary);
      font-size: 15px;
    }

    :deep(.t-radio-group) {
      width: 100%;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
    }

    :deep(.t-radio-button) {
      display: flex;
      justify-content: center;
      align-items: center;

      .t-radio-button__label {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        font-weight: 500;
        text-align: center;

        .iconfont {
          font-size: 16px;
          transition: all 0.2s ease;
        }
      }

      &.t-is-checked .t-radio-button__label .iconfont {
        transform: scale(1.1);
      }
    }
  }

  .import-content-wrapper {
    position: relative;
    min-height: 200px;
    flex: 1;
  }

  .import-content {
    .import-description {
      margin-bottom: 1.25rem;
      color: var(--local-text-secondary);
      font-size: 14px;
      line-height: 1.6;
      padding: 1rem;
      background: var(--local-tips-bg);
      border-radius: 8px;
      border-left: 4px solid var(--td-brand-color-4);
    }

    .url-input {
      margin-bottom: 1.5rem;
    }

    .import-tips {
      background: var(--local-tips-bg);
      border-radius: 12px;
      padding: 1.25rem;
      border: 1px solid var(--local-border);
      position: relative;
      overflow: hidden;

      &::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        width: 4px;
        height: 100%;
        background: linear-gradient(to bottom, var(--td-brand-color-4), var(--td-brand-color-6));
      }

      .tip-title {
        margin: 0 0 0.75rem 0;
        font-weight: 600;
        color: var(--local-text-primary);
        font-size: 15px;
        display: flex;
        align-items: center;
        gap: 0.5rem;

        &::before {
          content: '💡';
          font-size: 16px;
        }
      }

      .tip-list {
        margin: 0 0 0.75rem 0;
        padding-left: 1.5rem;

        li {
          color: var(--local-text-secondary);
          font-size: 13px;
          margin-bottom: 0.5rem;
          font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
          padding: 0.25rem 0.5rem;
          background: var(--local-code-bg);
          border-radius: 4px;
          transition: all 0.2s ease;

          &:hover {
            background: var(--local-code-hover-bg);
            transform: translateX(4px);
          }
        }
      }

      .tip-note {
        margin: 0;
        color: var(--local-text-tertiary);
        font-size: 12px;
        font-style: italic;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem;
        background: var(--local-note-bg);
        border-radius: 6px;

        &::before {
          content: '✨';
          font-size: 14px;
        }
      }
    }
  }

  // 过渡动画
  .fade-slide-enter-active,
  .fade-slide-leave-active {
    transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .fade-slide-enter-from {
    opacity: 0;
    transform: translateY(20px) scale(0.95);
  }

  .fade-slide-leave-to {
    opacity: 0;
    transform: translateY(-20px) scale(0.95);
  }

  .fade-slide-enter-to,
  .fade-slide-leave-from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 2rem;
  font-family: Arial, Helvetica, sans-serif;

  .header-left {
    h2 {
      line-height: 1.5em;
      color: var(--local-text-primary);
      margin-bottom: 0.5rem;
      font-size: 1.875rem;
      font-weight: 600;
    }

    .stats {
      display: flex;
      gap: 1rem;
      font-size: 0.875rem;
      color: var(--local-text-secondary);

      span {
        &:not(:last-child)::after {
          content: '•';
          margin-left: 1rem;
          color: var(--local-border);
        }
      }
    }
  }

  .header-actions {
    display: flex;
    gap: 0.75rem;
  }
}

/* 歌单区域样式 */
.playlists-section {
  margin-bottom: 3rem;

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;

    h3 {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--local-text-primary);
    }

    .section-actions {
      display: flex;
      gap: 0.5rem;
    }
  }
}

.loading-state {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 4rem 2rem;
}

.playlists-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1.5rem;
}
@media (min-width: 1600px) {
  .playlists-grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
}
@media (max-width: 1100px) {
  .playlists-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 820px) {
  .playlists-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 560px) {
  .playlists-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.playlist-card {
  display: flex;
  flex-direction: column;
  background: var(--local-card-bg);
  border-radius: 0.75rem;
  overflow: hidden;
  box-shadow: var(--local-card-shadow);
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;

  &.custom-bg {
    background-color: var(--td-bg-color-component);
    backdrop-filter: blur(8px);
  }

  &:hover {
    transform: translateY(-4px);
    box-shadow: var(--local-card-shadow-hover);

    .playlist-cover .cover-overlay {
      opacity: 1;
    }
    .playlist-cover .cover-image {
      transform: scale(1.06);
    }
    .playlist-info::before {
      opacity: 1;
    }
    .playlist-info {
      .playlist-name-text {
        color: #fff !important;
      }
      .playlist-description {
        color: rgba(255, 255, 255, 0.85);
      }
    }
  }

  .playlist-cover {
    height: 180px;
    background: #e4e4e4;
    position: relative;
    cursor: pointer;
    overflow: hidden;

    .cover-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .cover-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.2s ease;

      .iconfont {
        font-size: 3rem;
        color: #fff;
      }
    }

    .cover-meta {
      position: absolute;
      left: 0.625rem;
      right: 0.625rem;
      bottom: 0.625rem;
      z-index: 2;
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 0.5rem;
      pointer-events: none;
    }

    .cover-source,
    .cover-updated {
      background: rgba(12, 15, 13, 0.78);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 3px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
      backdrop-filter: blur(6px);
    }

    .cover-source {
      flex: 0 0 auto;
      padding: 0.25rem 0.375rem;
      color: var(--td-brand-color);
      font-size: 0.625rem;
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0;
    }

    .cover-updated {
      min-width: 0;
      max-width: 68%;
      padding: 0.25rem 0.375rem;
      color: rgba(255, 255, 255, 0.92);
      text-align: right;

      .cover-updated-label,
      .cover-updated-time {
        display: block;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .cover-updated-label {
        margin-bottom: 0.0625rem;
        color: rgba(255, 255, 255, 0.68);
        font-size: 0.5625rem;
        line-height: 1;
      }

      .cover-updated-time {
        font-size: 0.6875rem;
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        line-height: 1.15;
      }
    }
  }

  .playlist-info {
    padding: 0.75rem 0.875rem 0.5rem;
    flex: 1;
    display: flex;
    flex-direction: column;
    position: relative;
    z-index: 0;
    transition: color 0.3s ease;

    // GPU-only hover backdrop:用封面本身做模糊背板,无需 JS 算色
    // 只在 hover 时才绑定 --cover-url，避免每张卡都解码一张模糊底图。
    // 离开 400ms 后再清掉，保留 opacity 过渡。
    &::before {
      content: '';
      position: absolute;
      inset: 0;
      background-image: var(--cover-url, none);
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
      filter: blur(40px) brightness(0.55) saturate(1.6);
      transform: scale(1.6);
      opacity: 0;
      transition: opacity 0.35s ease;
      z-index: -1;
      pointer-events: none;
    }
    .playlist-name-row {
      display: flex;
      align-items: flex-start;
      margin-bottom: 0.35rem;
      cursor: pointer;
      gap: 6px;

      &:hover .playlist-name-text {
        color: var(--td-brand-color);
      }

      .playlist-name-text {
        font-weight: 600;
        color: var(--local-text-primary);
        font-size: 1rem;

        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        text-overflow: ellipsis;
        word-break: break-all;
        line-height: 1.4;
      }

      .playlist-tags {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
        height: 1.4em;
        margin-top: 1px;
      }
    }

    .playlist-description {
      flex: 1;
      font-size: 0.78rem;
      color: var(--local-text-secondary);
      margin-bottom: 0;
      display: -webkit-box;

      -webkit-line-clamp: 2;
      // white-space: nowrap;
      overflow: hidden;
      -webkit-box-orient: vertical;

      text-overflow: ellipsis;
    }

  }

  .playlist-actions {
    display: flex;
    justify-content: flex-end;
    padding: 0.35rem 0.75rem 0.65rem;
    gap: 0.35rem;
  }
}

.empty-playlists {
  text-align: center;
  padding: 4rem 2rem;

  .empty-icon {
    margin-bottom: 1.5rem;

    .iconfont {
      font-size: 4rem;
      color: var(--local-text-tertiary);
    }
  }

  h4 {
    color: var(--local-text-primary);
    margin-bottom: 0.5rem;
    font-size: 1.125rem;
    font-weight: 600;
  }

  p {
    color: var(--local-text-secondary);
    margin-bottom: 2rem;
  }
}

/* 本地音乐区域 */
.music-section {
  .section-header {
    margin-bottom: 1rem;

    h3 {
      font-size: 1.25rem;
      font-weight: 600;
      color: #111827;
    }
  }
}

.music-list {
  width: 100%;
  background: var(--local-card-bg);
  border-radius: 0.75rem;
  overflow: hidden;
  box-shadow: var(--local-card-shadow);
}

.list-header {
  display: grid;
  width: 100%;
  grid-template-columns: 0.5fr 2fr 1fr 2fr 1fr 1fr 1fr 1fr;
  gap: 1rem;
  padding: 1rem 1.5rem;
  background: var(--local-header-bg);
  border-bottom: 1px solid var(--local-border);

  .header-item {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--local-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
}

.list-body {
  .song-row {
    display: grid;
    grid-template-columns: 0.5fr 2fr 1fr 2fr 1fr 1fr 1fr 1fr;
    gap: 1rem;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--local-border);
    cursor: pointer;
    transition: background-color 0.2s ease;

    &:last-child {
      border-bottom: none;
    }

    &:hover {
      background-color: var(--local-hover-bg);

      .actions {
        opacity: 1;
      }
    }

    .row-item {
      display: flex;
      align-items: center;
      font-size: 0.875rem;

      &.index {
        justify-content: center;
        color: var(--local-text-secondary);
        font-weight: 500;
      }

      &.title {
        .song-title {
          font-weight: 500;
          color: var(--local-text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      }

      &.artist,
      &.album {
        color: var(--local-text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      &.duration,
      &.size {
        color: var(--local-text-secondary);
        font-variant-numeric: tabular-nums;
      }

      &.format {
        flex-direction: column;
        align-items: flex-start;
        gap: 0.125rem;

        .format-badge {
          background: var(--local-badge-bg);
          color: var(--local-text-secondary);
          padding: 0.125rem 0.375rem;
          border-radius: 0.25rem;
          font-size: 0.75rem;
          font-weight: 500;
        }

        .bitrate {
          font-size: 0.75rem;
          color: var(--local-text-tertiary);
        }
      }

      &.actions {
        gap: 0.25rem;
        opacity: 0;
        transition: opacity 0.2s ease;
      }
    }
  }
}

.empty-state {
  text-align: center;
  padding: 4rem 2rem;

  .empty-icon {
    margin-bottom: 1.5rem;

    .iconfont {
      font-size: 4rem;
      color: var(--local-text-tertiary);
    }
  }

  h3 {
    color: var(--local-text-primary);
    margin-bottom: 0.5rem;
    font-size: 1.25rem;
    font-weight: 600;
  }

  p {
    color: var(--local-text-secondary);
    margin-bottom: 2rem;
  }
}

/* 创建歌单表单 */
.create-form {
  padding: 1rem 0;
}

/* 导入选择对话框 */
.import-options {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.import-option {
  display: flex;
  align-items: center;
  padding: 1rem;
  border: 1px solid var(--local-border);
  border-radius: 0.5rem;
  cursor: pointer;
  transition: all 0.2s ease;
  background: var(--local-card-bg);

  &:hover {
    border-color: var(--td-brand-color-4);
    background-color: var(--local-hover-bg);
  }

  .option-icon {
    margin-right: 1rem;

    .iconfont {
      font-size: 1.5rem;
      color: var(--td-brand-color-4);
    }
  }

  .option-content {
    flex: 1;

    h4 {
      font-size: 1rem;
      font-weight: 600;
      color: var(--local-text-primary);
      margin-bottom: 0.25rem;
    }

    p {
      font-size: 0.875rem;
      color: var(--local-text-secondary);
      margin: 0;
    }

    .coming-soon {
      display: inline-block;
      background: var(--local-warning-bg);
      color: var(--local-warning-text);
      padding: 0.125rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      font-weight: 500;
      margin-top: 0.5rem;
    }
  }

  .option-arrow {
    .iconfont {
      font-size: 1rem;
      color: var(--local-text-tertiary);
    }
  }
}
</style>
