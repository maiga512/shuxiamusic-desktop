<template>
  <div class="page">
    <!-- <TitleBarControls title="插件管理" :show-back="true" class="header"></TitleBarControls> -->
    <div class="plugins-container">
      <div class="plugin-actions-hearder">
        <h2>插件管理</h2>

        <div class="plugin-actions" style="flex-direction: row">
          <t-button theme="primary" @click="openPluginImportDialog">
            <template #icon><t-icon name="add" /></template> 添加插件
          </t-button>

          <!-- 导入方式选择对话框（插件格式自动识别，无需选择类别） -->
          <t-dialog
            :visible="importMethodDialog"
            :close-btn="true"
            attach="body"
            confirm-btn="确定"
            cancel-btn="取消"
            :on-confirm="handleImport"
            :on-close="closeImportDialog"
            :on-cancel="closeImportDialog"
          >
            <template #header>导入插件</template>
            <template #body>
              <div class="import-method-container">
                <p class="local-hint-container" style="margin-bottom: 12px">
                  智能识别音乐插件
                </p>
                <t-radio-group
                  v-model="importMethod"
                  variant="primary-filled"
                  default-value="local"
                >
                  <t-radio-button value="local">本地导入</t-radio-button>
                  <t-radio-button value="online">在线导入</t-radio-button>
                </t-radio-group>

                <div v-if="importMethod === 'online'" class="online-input-container">
                  <t-input
                    v-model="onlineUrl"
                    placeholder="请输入插件下载地址"
                    size="large"
                    style="margin-top: 15px"
                  />
                  <p class="hint-text">支持 HTTP/HTTPS 链接，插件文件应为 .js 或 .zip 格式</p>
                </div>

                <div v-else class="local-hint-container">
                  Tips: 点击 "确定" 将从本地文件选择插件文件进行导入
                </div>
              </div>
            </template>
          </t-dialog>
          <t-button theme="default" @click="refreshPlugins">
            <template #icon><t-icon name="refresh" /></template> 刷新
          </t-button>
        </div>
      </div>

      <div v-if="loading" class="loading">
        <div class="spinner"></div>
        <span>加载中...</span>
      </div>

      <div v-else-if="error" class="error-state">
        <t-icon name="error-circle" style="font-size: 48px; color: #dc3545" />
        <p>加载插件时出错</p>
        <p class="error-message">{{ error }}</p>
        <t-button theme="default" @click="refreshPlugins">
          <template #icon><t-icon name="refresh" /></template> 重试
        </t-button>
      </div>

      <div v-else-if="plugins.length === 0" class="empty-state">
        <t-icon name="app" style="font-size: 48px" />
        <p>暂无已安装的插件</p>
        <p class="hint">点击"添加插件"按钮来安装新插件</p>
      </div>

      <div v-else class="plugin-list">
        <div
          v-for="plugin in plugins"
          :key="plugin.pluginId"
          class="plugin-item"
          :class="{ selected: isPluginSelected(plugin.pluginId) }"
        >
          <div class="plugin-info">
            <h3>
              {{ pluginDisplayName(plugin) }}
              <span class="version">{{ plugin.pluginInfo?.version }}</span>
              <span v-if="isPluginSelected(plugin.pluginId)" class="current-tag">当前使用</span>
              <span v-if="isServicePlugin(plugin)" class="service-tag">服务插件</span>
              <span v-if="plugin.disabled" class="disabled-tag">已禁用</span>
            </h3>
            <p class="author">作者: {{ plugin.pluginInfo?.author || '未知' }}</p>
            <p v-if="plugin.serviceRole !== 'nas-sync'" class="description">
              {{ plugin.pluginInfo?.description || '无描述' }}
            </p>
            <p v-if="plugin.serviceRole === 'nas-sync'" class="plugin-note">
              这是自建部署的同步服务器插件，用于歌单备份和多端同步；可部署在 NAS、软路由、小服务器或 Docker 面板上。
            </p>
            <div
              v-if="plugin.supportedSources && Object.keys(plugin.supportedSources).length > 0"
              class="plugin-sources"
            >
              <span class="source-label">支持的音源:</span>
              <span v-for="source in plugin.supportedSources" :key="source.name" class="source-tag">
                {{ source.name }}
              </span>
            </div>
          </div>
          <div class="plugin-actions">
            <t-button
              theme="default"
              size="small"
              :disabled="loading"
              @click.stop="viewPluginLogs(plugin.pluginId, pluginDisplayName(plugin))"
            >
              <template #icon><t-icon name="view-list" /></template> 日志
            </t-button>
            <t-button
              v-if="isServicePlugin(plugin)"
              theme="default"
              size="small"
              @click.stop="openConfigDialog(plugin)"
            >
              <template #icon><t-icon name="setting" /></template> 配置
            </t-button>
            <t-button
              v-if="isServicePlugin(plugin) && plugin.serviceRole !== 'nas-sync'"
              theme="primary"
              size="small"
              @click.stop="openImportDialog(plugin)"
            >
              <template #icon><t-icon name="download" /></template> 导入歌单
            </t-button>
            <t-button
              v-if="!isPluginSelected(plugin.pluginId) && !isServicePlugin(plugin)"
              theme="primary"
              size="small"
              @click="selectPlugin(plugin)"
            >
              <template #icon><t-icon name="check" /></template> 使用
            </t-button>
            <t-button
              theme="danger"
              size="small"
              @click="uninstallPlugin(plugin.pluginId, pluginDisplayName(plugin))"
            >
              <template #icon><t-icon name="delete" /></template> 卸载
            </t-button>
          </div>
        </div>
      </div>

      <!-- 插件日志弹窗 -->
      <t-dialog
        v-model:visible="logDialogVisible"
        top="10vh"
        :close-btn="false"
        :footer="false"
        attach="body"
        width="80%"
        :style="{ maxWidth: '900px', maxHeight: '80vh' }"
        class="log-dialog"
      >
        <template #header>
          <div class="log-dialog-header">
            <div class="log-title">
              <i class="iconfont icon-terminal"></i>
              {{ currentLogPluginName }} - 插件日志
            </div>
            <div class="log-actions">
              <t-button
                size="small"
                variant="outline"
                theme="default"
                ghost
                :disabled="logsLoading"
                @click.stop="refreshLogs"
              >
                刷新
              </t-button>
              <t-button
                size="small"
                variant="outline"
                theme="primary"
                ghost
                :disabled="logsLoading || logs.length === 0"
                @click.stop="exportLogs"
              >
                导出
              </t-button>
            </div>
            <div class="mac-controls">
              <div class="mac-button close" @click="logDialogVisible = false"></div>
              <div class="mac-button minimize"></div>
              <div class="mac-button maximize"></div>
            </div>
          </div>
        </template>
        <template #body>
          <div class="console-container">
            <div class="console-header">
              <div class="console-info">
                <span class="console-prompt">$</span>
                <span class="console-path">~/plugins/{{ currentLogPluginName }}</span>
                <span class="console-time">{{ formatTime(new Date()) }}</span>
              </div>
            </div>
            <div ref="logContentRef" class="console-content" :class="{ loading: logsLoading }">
              <div v-if="logsLoading" class="console-loading">
                <div class="loading-spinner"></div>
                <span>正在加载日志...</span>
              </div>
              <div v-else-if="logsError" class="console-error">
                <span class="error-icon">❌</span>
                <span>加载日志失败: {{ logsError }}</span>
              </div>
              <div v-else-if="logs.length === 0" class="console-empty">
                <span class="empty-icon">📝</span>
                <span>暂无日志记录</span>
              </div>
              <div v-else class="log-entries">
                <div
                  v-for="entry in visibleLogs"
                  :key="entry.key"
                  class="log-entry"
                  :class="[
                    logLevelClass(entry.level),
                    {
                      'log-entry-group': entry.isGroup,
                      'log-entry-collapsed': entry.isGroup && collapsedGroups.has(entry.key)
                    }
                  ]"
                  :style="{ paddingLeft: entry.depth * 16 + 'px' }"
                  @click="entry.isGroup && toggleGroup(entry.key)"
                >
                  <span class="log-timestamp">{{ formatLogTime(entry.t) }}</span>
                  <span v-if="entry.isGroup" class="log-group-caret">
                    {{ collapsedGroups.has(entry.key) ? '▶' : '▼' }}
                  </span>
                  <span class="log-content">{{ entry.message }}</span>
                </div>
              </div>
            </div>
          </div>
        </template>
      </t-dialog>

      <!-- 服务插件配置对话框 -->
      <t-dialog
        v-model:visible="configDialogVisible"
        :close-btn="true"
        attach="body"
        width="500px"
        :on-confirm="savePluginConfig"
        confirm-btn="保存"
        cancel-btn="取消"
      >
        <template #header>{{ isNasSyncConfig ? '多端同步配置' : `${configPluginName} - 配置` }}</template>
        <template #body>
          <div class="config-form">
            <div v-if="isNasSyncConfig" class="sync-mode-panel">
              <div class="sync-mode-main">
                <label class="config-label">同步模式</label>
                <t-select
                  v-model="configValues.syncMode"
                  placeholder="请选择同步模式"
                  size="medium"
                >
                  <t-option
                    v-for="mode in nasSyncModeOptions"
                    :key="mode.value"
                    :value="mode.value"
                    :label="mode.label"
                  />
                </t-select>
              </div>
              <t-button
                theme="primary"
                size="medium"
                :loading="configSaving"
                @click="savePluginConfig"
              >
                保存同步设置
              </t-button>
            </div>
            <div
              v-for="field in configSchema"
              :key="field.key"
              v-show="!isNasSyncConfig || field.key !== 'syncMode'"
              class="config-field"
              :class="{ 'config-field-switch': field.type === 'switch' }"
            >
              <label class="config-label">
                {{ field.label }}
                <span v-if="field.required" class="required-mark">*</span>
              </label>
              <t-input
                v-if="field.type === 'text'"
                v-model="configValues[field.key]"
                :placeholder="field.placeholder || ''"
                size="medium"
              />
              <t-input
                v-else-if="field.type === 'password'"
                v-model="configValues[field.key]"
                type="password"
                :placeholder="field.placeholder || ''"
                size="medium"
              />
              <t-input-number
                v-else-if="field.type === 'number'"
                v-model="configValues[field.key]"
                :placeholder="field.placeholder || ''"
                size="medium"
                style="width: 100%"
              />
              <t-select
                v-else-if="field.type === 'select'"
                v-model="configValues[field.key]"
                :placeholder="field.placeholder || '请选择'"
                size="medium"
              >
                <t-option
                  v-for="opt in field.options"
                  :key="opt.value"
                  :value="opt.value"
                  :label="opt.label"
                />
              </t-select>
              <t-switch
                v-else-if="field.type === 'switch'"
                v-model="configValues[field.key]"
              />
            </div>

            <div class="config-test">
              <div v-if="configServiceRole === 'feiniu'" class="nas-sync-status-hint">
                服务器主机只填域名或 IP，不要带 http://、https:// 或路径；端口和 HTTPS 分开填写。反向代理使用 443 等端口时，把实际端口填到“服务器端口”。
              </div>
              <div v-if="isNasSyncConfig" class="nas-sync-status-hint">
                服务器主机只填域名或 IP，不要带 http://、https:// 或路径；443/11443 端口自动使用 HTTPS，内网 31231 保持 HTTP。可部署在 NAS、软路由、小服务器或 Docker 面板上。
              </div>
              <div
                v-if="isNasSyncConfig"
                class="nas-sync-status"
                :class="configValues.status === 'connected' ? 'connected' : 'disconnected'"
              >
                {{ configValues.status === 'connected' ? '已连接' : '未连接' }}
              </div>
              <t-button
                v-if="isNasSyncConfig"
                theme="primary"
                size="small"
                :loading="configTesting"
                @click="loginNasSyncPlugin"
              >
                登录同步服务
              </t-button>
              <t-button
                theme="default"
                size="small"
                :loading="configTesting"
                @click="testPluginConnection"
              >
                {{ isNasSyncConfig ? '检测连接' : '测试连接' }}
              </t-button>
              <t-button
                v-if="isNasSyncConfig"
                theme="warning"
                size="small"
                :loading="nasSyncRunning"
                @click="runCurrentNasSyncMode"
              >
                执行当前模式
              </t-button>
              <span
                v-if="configTestResult"
                class="test-result"
                :class="{ success: configTestResult.success, fail: !configTestResult.success }"
              >
                {{ configTestResult.message }}
              </span>
            </div>
          </div>
        </template>
      </t-dialog>

      <!-- 导入歌单 -->
      <ImportPlaylist
        v-model:visible="importDialogVisible"
        :plugin-id="importPluginId"
        :plugin-name="importPluginName"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, toRaw, computed } from 'vue'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import { LocalUserDetailStore } from '@renderer/store/LocalUserDetail'
import ImportPlaylist from '@renderer/components/ServicePlugin/ImportPlaylist.vue'
import { runNasSyncNow } from '@renderer/services/nasSyncPoller'
import {
  buildNasSyncServerUrl,
  parseNasSyncServerUrl
} from '@renderer/api/nasSync'
import { startNasSyncPoller, stopNasSyncPoller } from '@renderer/services/nasSyncPoller'
import {
  clearLocalPluginUpsert,
  dedupeLocalMusicSourcePlugins,
  markLocalPluginUpsert,
  pushLocalPluginNow,
  removeLocalPluginFromCloud,
  selectLocalMusicSourceForSync,
  collectLocalPlugins
} from '@renderer/utils/playlist/pluginSync'
import { musicSourceIdentityKey } from '@renderer/utils/playlist/pluginIdentity'
import { onSyncEvent } from '@renderer/utils/sync/realtimeSyncBus'

interface PluginSource {
  name: string
  type: string
  qualitys: string[]
}

interface PluginInfo {
  name: string
  version: string
  author: string
  description?: string
}

interface PluginConfigField {
  key: string
  label: string
  type: 'text' | 'password' | 'number' | 'select' | 'switch'
  required?: boolean
  default?: any
  placeholder?: string
  options?: { label: string; value: any }[]
}

const DEFAULT_NAS_SYNC_CONFIG_SCHEMA: PluginConfigField[] = [
  {
    key: 'enabled',
    label: '启用同步',
    type: 'switch',
    default: false
  },
  {
    key: 'syncMode',
    label: '同步模式',
    type: 'select',
    default: 'auto',
    options: [
      { label: '备份到云端', value: 'backup-to-cloud' },
      { label: '从云端恢复到本地', value: 'restore-from-cloud' },
      { label: '多端自动同步', value: 'auto' }
    ]
  },
  {
    key: 'host',
    label: '服务器主机',
    type: 'text',
    required: true,
    placeholder: 'nas.example.com（不要填协议或路径）'
  },
  {
    key: 'port',
    label: '服务器端口',
    type: 'number',
    default: 31231,
    required: true
  },
  {
    key: 'useHttps',
    label: 'HTTPS 安全访问',
    type: 'switch',
    default: false
  },
  {
    key: 'pairCode',
    label: '登录绑定码',
    type: 'text',
    required: true,
    placeholder: '填写管理后台生成的长期绑定码'
  }
]

interface Plugin {
  pluginId: string
  pluginName: string
  pluginInfo?: PluginInfo
  supportedSources: { [key: string]: PluginSource }
  pluginType?: 'music-source' | 'service'
  serviceRole?: string
  disabled?: boolean
}

// 定义API返回结果的接口
interface ApiResult {
  error?: string
  pluginInfo?: PluginInfo
  [key: string]: any
}

// 上次成功加载的插件列表。设置分类切走会卸载本组件，没有这份缓存时
// 每次点“插件管理”都会重新等一次 sidecar 往返并显示转圈。
let cachedPlugins: Plugin[] | null = null

const plugins = ref<Plugin[]>(cachedPlugins ? [...cachedPlugins] : [])
const loading = ref(!cachedPlugins)
const error = ref<string | null>(null)
const importMethodDialog = ref(false)
const importMethod = ref<'local' | 'online'>('local')
const onlineUrl = ref('')

// 日志相关状态
const logDialogVisible = ref(false)
const currentLogPluginId = ref('')
const currentLogPluginName = ref('')
/** 原始日志行（NDJSON 字符串或旧版纯文本）。 */
const logs = ref<string[]>([])
const logsLoading = ref(false)
const logsError = ref<string | null>(null)
const logContentRef = ref<HTMLElement | null>(null)

/** 后端写入的日志级别。 */
type PluginLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'group' | 'groupEnd'

/** 解析后的日志条目（前端渲染单元）。 */
interface ParsedLogEntry {
  /** epoch ms；旧格式行没有真实时间时为 null。 */
  t: number | null
  /** 真实级别。 */
  level: PluginLogLevel
  /** 消息文本。 */
  message: string
  /** group 嵌套深度（>=0）。groupEnd 自身不显示。 */
  depth: number
  /** 标记当前条目是否为分组头（可点击折叠）。 */
  isGroup: boolean
  /** 仅 group 项使用：对应 groupEnd 在原数组中的索引（用于跳过被折叠的条目）。 */
  groupEndIndex?: number
  /** 渲染稳定 key — 索引足以保证局部刷新。 */
  key: number
}

/** 已折叠的 group 头索引集合。 */
const collapsedGroups = ref<Set<number>>(new Set())

// 服务插件配置相关
const configDialogVisible = ref(false)
const configPluginId = ref('')
const configPluginName = ref('')
const configSchema = ref<PluginConfigField[]>([])
const configValues = ref<Record<string, any>>({})
const configSaving = ref(false)
const configTesting = ref(false)
const nasSyncRunning = ref(false)
const configTestResult = ref<{ success: boolean; message: string } | null>(null)
const savedConfigSnapshot = ref<Record<string, any>>({})
const configServiceRole = ref('')
const isNasSyncConfig = computed(() => configServiceRole.value === 'nas-sync')
const nasSyncModeOptions = [
  { label: '备份到云端', value: 'backup-to-cloud' },
  { label: '从云端恢复到本地', value: 'restore-from-cloud' },
  { label: '多端自动同步', value: 'auto' }
]
const NAS_SYNC_PERSISTED_KEYS = [
  'accessToken',
  'tokenExpiresAt',
  'userId',
  'username',
  'nickname',
  'status'
]

// 导入歌单相关
const importDialogVisible = ref(false)
const importPluginId = ref('')
const importPluginName = ref('')

// 获取store实例
const localUserStore = LocalUserDetailStore()

// 检查插件是否被选中
function isPluginSelected(pluginId: string): boolean {
  return localUserStore.userInfo.pluginId === pluginId
}

function pluginDisplayName(plugin?: Plugin | null): string {
  return String(plugin?.pluginInfo?.name || plugin?.pluginName || plugin?.pluginId || '未命名插件')
}

// 选择插件
function selectPlugin(plugin: Plugin) {
  try {
    // 确保store已初始化
    if (!localUserStore.initialization) {
      localUserStore.init()
    }

    const { pluginId, pluginInfo, supportedSources: sources } = plugin
    const displayName = pluginDisplayName(plugin)
    const previousPluginId = String(localUserStore.userInfo.pluginId || '').trim()

    // 检查插件是否提供音源
    if (!sources || Object.keys(sources).length === 0) {
      MessagePlugin.warning(`插件 "${displayName}" 没有提供可用的音源。`)
      // 即使没有音源，也可能需要选择该插件（如果插件有其他功能）
      // 这里我们只更新ID，清空音源相关信息
      localUserStore.userInfo.pluginId = pluginId
      localUserStore.userInfo.pluginName = displayName
      localUserStore.userInfo.supportedSources = {}
      localUserStore.userInfo.selectSources = ''
      localUserStore.userInfo.selectQuality = ''
      if (previousPluginId && previousPluginId !== pluginId) {
        void window.api?.plugins?.unpinPlugin?.(previousPluginId)
      }
      void window.api?.plugins?.pinPlugin?.(pluginId)
      if (!isServicePlugin(plugin)) {
        void selectLocalMusicSourceForSync(
          musicSourceIdentityKey(pluginInfo?.name || displayName, pluginInfo?.author || '')
        )
      }
      MessagePlugin.success(`已选择插件: ${displayName}`)
      return
    }

    // 转换supportedSources格式以匹配UserInfo类型，并添加 `type` 字段
    const supportedSourcesForStore = sources
    let selectSources: string
    // 获取第一个音源作为默认选择
    if (
      !(typeof localUserStore.userInfo.selectSources === 'string') ||
      !sources[localUserStore.userInfo.selectSources as unknown as string]
    ) {
      selectSources = Object.keys(sources)[0]
    } else {
      selectSources = localUserStore.userInfo.selectSources
    }
    let selectQuality: string
    if (
      !(typeof localUserStore.userInfo.selectQuality === 'string') ||
      !sources[localUserStore.userInfo.selectSources as unknown as string] ||
      !sources[localUserStore.userInfo.selectSources as unknown as string][
        localUserStore.userInfo.selectQuality as unknown as string
      ]
    ) {
      const qualitys = sources[selectSources].qualitys
      selectQuality = qualitys[qualitys.length - 1]
    } else {
      selectQuality = localUserStore.userInfo.selectQuality
    }

    // 更新userInfo
    localUserStore.userInfo.pluginId = pluginId
    localUserStore.userInfo.pluginName = displayName
    localUserStore.userInfo.supportedSources = supportedSourcesForStore
    localUserStore.userInfo.selectSources = selectSources
    localUserStore.userInfo.selectQuality = selectQuality
    if (previousPluginId && previousPluginId !== pluginId) {
      void window.api?.plugins?.unpinPlugin?.(previousPluginId)
    }
    void window.api?.plugins?.pinPlugin?.(pluginId)
    if (!isServicePlugin(plugin)) {
      void selectLocalMusicSourceForSync(
        musicSourceIdentityKey(pluginInfo?.name || displayName, pluginInfo?.author || '')
      )
    }

    MessagePlugin.success(`已选择插件: ${displayName}`)
  } catch (err: any) {
    console.error('选择插件失败:', err)
    MessagePlugin.error(`选择插件失败: ${err.message || '未知错误'}`)
  }
}

// 获取已安装的插件列表
async function getPlugins(options: { reload?: boolean } = {}) {
  // 有缓存时直接渲染旧列表，后台刷新即可，不要再整块转圈。
  loading.value = plugins.value.length === 0
  error.value = null

  try {
    const result = options.reload
      ? await window.api.plugins.reloadAllPlugins()
      : await window.api.plugins.loadAllPlugins()
    console.log(result)
    // 检查返回结果是否有错误
    if (result && typeof result === 'object' && 'error' in result) {
      console.error('获取插件列表失败:', result.error)
      error.value = `加载插件失败: ${result.error}`
      plugins.value = []
    } else if (Array.isArray(result)) {
      const removedDuplicates = await dedupeLocalMusicSourcePlugins()
      const source = removedDuplicates > 0
        ? await window.api.plugins.loadAllPlugins()
        : result
      const list = Array.isArray(source) ? source : result
      plugins.value = list.map((plugin: Plugin) => ({
        ...plugin,
        pluginInfo: plugin.pluginInfo || {
          name: plugin.pluginName || plugin.pluginId,
          version: '',
          author: '',
          description: '',
        },
      }))
      // 类型/角色补全并行执行：串行 await 在插件多的时候会连续打几十个
      // 往返，面板一直转圈，切进设置也会发卡。
      await Promise.all(plugins.value.map(async (p) => {
        try {
          if (!p.pluginType) {
            const typeRes = await window.api.plugins.getPluginType(p.pluginId)
            if (typeRes?.data) {
              p.pluginType = typeRes.data
            }
          }
          if (!p.serviceRole && p.pluginType === 'service') {
            const roleRes = await window.api.plugins.getServiceRole(p.pluginId)
            if (roleRes?.data) {
              p.serviceRole = roleRes.data
            }
          }
        } catch {
          // 旧插件可能不支持，忽略
        }
      }))
      console.log('插件列表加载完成', result)
      cachedPlugins = plugins.value.map((item) => ({ ...item }))
    } else {
      // 处理意外的返回格式
      console.error('插件列表格式不正确:', result)
      plugins.value = []
      error.value = '插件数据格式不正确'
    }
  } catch (err: any) {
    console.error('获取插件列表失败:', err)
    error.value = err?.message || '未知错误'
    plugins.value = []
  } finally {
    loading.value = false
  }
}

// 打开插件导入对话框（每次打开重置为本地导入）
function openPluginImportDialog() {
  importMethod.value = 'local'
  onlineUrl.value = ''
  importMethodDialog.value = true
}

// 关闭插件导入对话框
function closeImportDialog() {
  importMethodDialog.value = false
  onlineUrl.value = ''
}

// 处理导入操作
async function handleImport() {
  try {
    importMethodDialog.value = false
    let result: ApiResult

    if (importMethod.value === 'local') {
      // 本地导入：调用文件选择API（格式自动识别）
      result = (await window.api.plugins.selectAndAddPlugin()) as ApiResult
    } else {
      // 在线导入：调用在线下载API
      if (!onlineUrl.value.trim()) {
        MessagePlugin.warning('请输入插件下载地址')
        importMethodDialog.value = true
        return
      }

      // 验证URL格式
      try {
        new URL(onlineUrl.value)
      } catch {
        MessagePlugin.warning('请输入有效的URL地址')
        importMethodDialog.value = true
        return
      }

      result = (await window.api.plugins.downloadAndAddPlugin(onlineUrl.value)) as ApiResult
    }

    // 检查用户是否取消了操作
    if (result && result.canceled) {
      return
    }

    // 检查结果是否包含错误
    if (result && typeof result === 'object' && 'error' in result) {
      const errMsg = String(result.error || '')
      // 与安卓一致：识别不到受支持的插件格式时，用弹窗提示插件不兼容
      if (errMsg.includes('不兼容')) {
        DialogPlugin.alert({
          header: '插件不兼容',
          body: errMsg,
          confirmBtn: '我知道了'
        })
      } else {
        MessagePlugin.error(`安装插件失败: ${errMsg}`)
      }
      console.error('安装插件失败:', result.error)
    } else {
      // 安装成功才刷新插件列表
      await getPlugins()
      if (result?.pluginInfo?.name) {
        const identityKey = musicSourceIdentityKey(result.pluginInfo.name, result.pluginInfo.author)
        markLocalPluginUpsert(identityKey)
        void pushLocalPluginNow(identityKey)
      }
      window.dispatchEvent(new Event('shuxia-nas-local-change'))
      // 显示成功消息
      if (result && result.pluginInfo) {
        MessagePlugin.success(`插件 "${result.pluginInfo.name}" 安装成功！`)
      } else {
        MessagePlugin.success('插件安装成功！')
      }
    }

    // 重置状态
    onlineUrl.value = ''
  } catch (err: any) {
    console.error('安装插件失败:', err)
    MessagePlugin.error(`安装插件失败: ${err.message || '未知错误'}`)
  }
}

// 卸载插件
async function uninstallPlugin(pluginId: string, pluginName: string) {
  try {
    // 使用TDesign对话框，替代confirm
    const dialog = DialogPlugin.confirm({
      header: '确认卸载',
      body: `确定要卸载插件 "${pluginName}" 吗？`,
      confirmBtn: '确认卸载',
      cancelBtn: '取消',
      onConfirm: async () => {
        // 用户确认后，开始卸载操作
        loading.value = true
        const targetPlugin = plugins.value.find((item) => item.pluginId === pluginId)
        const localPlugins = await collectLocalPlugins()
        const matchedPlugin = localPlugins.find((item) => item.localPluginId === pluginId)
        const targetIdentityKey = matchedPlugin?.identityKey || musicSourceIdentityKey(
          targetPlugin?.pluginInfo?.name || pluginName,
          targetPlugin?.pluginInfo?.author || ''
        )

        const result = (await window.api.plugins.uninstallPlugin(pluginId)) as ApiResult

        // 检查结果是否包含错误
        if (result && typeof result === 'object' && 'error' in result) {
          // 使用TDesign消息提示，替代alert
          MessagePlugin.error(`卸载插件失败: ${result.error}`)
          console.error('卸载插件失败:', result.error)
        } else {
          await removeLocalPluginFromCloud(targetIdentityKey, {
            name: matchedPlugin?.name || targetPlugin?.pluginInfo?.name || pluginName,
            author: matchedPlugin?.author || targetPlugin?.pluginInfo?.author || '',
            contentHash: matchedPlugin?.contentHash || '',
            kind: matchedPlugin?.kind || 'music-source',
            role: matchedPlugin?.role
          })
          // 卸载成功才刷新插件列表
          clearLocalPluginUpsert(targetIdentityKey)
          await getPlugins()
          // 显示成功消息
          if (pluginId === localUserStore.userInfo.pluginId) {
            void window.api?.plugins?.unpinPlugin?.(pluginId)
            localUserStore.userInfo.pluginId = ''
            localUserStore.userInfo.pluginName = ''
            localUserStore.userInfo.supportedSources = {}
            localUserStore.userInfo.selectSources = ''
            localUserStore.userInfo.selectQuality = ''
          }
          window.dispatchEvent(new Event('shuxia-nas-local-change'))
          MessagePlugin.success(`插件 "${pluginName}" 卸载成功！`)
        }
        dialog.destroy()
      }
    })
  } catch (err: any) {
    // 使用TDesign消息提示，替代alert
    console.error('卸载插件失败:', err)
    MessagePlugin.error(`卸载插件失败: ${err.message || '未知错误'}`)
  } finally {
    loading.value = false
  }
}

// 刷新插件列表
async function refreshPlugins() {
  await getPlugins({ reload: true })
}

// 查看插件日志
async function viewPluginLogs(pluginId: string, pluginName: string) {
  try {
    currentLogPluginId.value = pluginId
    currentLogPluginName.value = pluginName
    logDialogVisible.value = true
    await loadPluginLogs()
  } catch (err: any) {
    console.error('打开日志弹窗失败:', err)
    MessagePlugin.error(`打开日志弹窗失败: ${err.message || '未知错误'}`)
  }
}

// 加载插件日志
async function loadPluginLogs() {
  if (!currentLogPluginId.value) return

  logsLoading.value = true
  logsError.value = null

  try {
    const result = await window.api.plugins.getPluginLog(currentLogPluginId.value)
    if (result && Array.isArray(result)) {
      logs.value = result
      // 换插件/刷新时清掉旧的折叠状态，避免索引串扰
      collapsedGroups.value = new Set()
      // 滚动到底部显示最新日志
      await nextTick()
      setTimeout(() => {
        if (logContentRef.value) {
          logContentRef.value.scrollTop = logContentRef.value.scrollHeight
        }
      }, 100)
    } else {
      logs.value = []
      collapsedGroups.value = new Set()
    }
  } catch (err: any) {
    console.error('加载插件日志失败:', err)
    logsError.value = err.message || '加载日志失败'
    logs.value = []
  } finally {
    logsLoading.value = false
  }
}

// 刷新日志
async function refreshLogs() {
  try {
    await loadPluginLogs()
  } catch (err: any) {
    console.error('刷新日志失败:', err)
    MessagePlugin.error(`刷新日志失败: ${err.message || '未知错误'}`)
  }
}

// 导出日志为可读 .log 文本
function exportLogs() {
  try {
    if (logs.value.length === 0) {
      MessagePlugin.warning('没有可导出的日志')
      return
    }

    // 以解析后的结构化条目为准，生成人可读的纯文本
    // 格式：[YYYY-MM-DD HH:mm:ss.SSS] [LEVEL] <缩进>message
    const lines = parsedLogs.value.map((entry) => {
      const ts = entry.t
        ? new Date(entry.t).toISOString().replace('T', ' ').replace('Z', '')
        : '----------  --:--:--.---'
      const lvl = entry.level.toUpperCase().padEnd(8, ' ')
      const indent = '  '.repeat(entry.depth)
      const prefix = entry.isGroup ? '▼ ' : ''
      return `[${ts}] [${lvl}] ${indent}${prefix}${entry.message}`
    })

    const header =
      `# 树夏Music Plugin Log\n` +
      `# Plugin: ${currentLogPluginName.value} (${currentLogPluginId.value})\n` +
      `# Exported: ${new Date().toISOString()}\n` +
      `# Entries: ${parsedLogs.value.length}\n` +
      `# ----------------------------------------\n`
    const content = header + lines.join('\n') + '\n'

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)

    const safeName = (currentLogPluginName.value || currentLogPluginId.value || 'plugin')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 60)
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19)
    const filename = `${safeName}_${stamp}.log`

    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)

    MessagePlugin.success(`已导出 ${parsedLogs.value.length} 条日志`)
  } catch (err: any) {
    console.error('导出日志失败:', err)
    MessagePlugin.error(`导出日志失败: ${err.message || '未知错误'}`)
  }
}

// ==================== 服务插件方法 ====================

// 打开配置对话框
async function openConfigDialog(plugin: Plugin) {
  configPluginId.value = plugin.pluginId
  configPluginName.value = pluginDisplayName(plugin)
  configServiceRole.value = plugin.serviceRole || ''
  configTestResult.value = null

  try {
    // 获取配置 schema
    const schemaRes = await window.api.plugins.getConfigSchema(plugin.pluginId)
    configSchema.value = Array.isArray(schemaRes?.data) ? schemaRes.data : []
    if (plugin.serviceRole === 'nas-sync' && configSchema.value.length === 0) {
      configSchema.value = DEFAULT_NAS_SYNC_CONFIG_SCHEMA
    }

    // 获取已保存的配置
    const configRes = await window.api.plugins.getConfig(plugin.pluginId)
    const savedConfig = configRes?.data || {}
    savedConfigSnapshot.value = JSON.parse(JSON.stringify(savedConfig))

    // 用 schema 默认值填充
    const values: Record<string, any> = {}
    for (const field of configSchema.value) {
      values[field.key] = savedConfig[field.key] ?? field.default ?? ''
    }
    if (plugin.serviceRole === 'nas-sync') {
      for (const key of NAS_SYNC_PERSISTED_KEYS) {
        if (savedConfig[key] !== undefined) values[key] = savedConfig[key]
      }
      if (!String(values.host || '').trim() && savedConfig.serverUrl) {
        const parts = parseNasSyncServerUrl(savedConfig.serverUrl)
        if (parts) {
          values.host = parts.host
          values.port = parts.port
          values.useHttps = parts.useHttps
        }
      }
      if (!Number(values.port)) values.port = 31231
      values.useHttps = values.useHttps === true
      if (!values.syncMode) values.syncMode = 'auto'
    }
    configValues.value = values

    configDialogVisible.value = true
    if (plugin.serviceRole === 'nas-sync') {
      void probeNasSyncConnection({ silent: true })
    }
  } catch (err: any) {
    MessagePlugin.error(`获取插件配置失败: ${err.message}`)
  }
}

function buildPluginConfigForSave() {
  const plainConfig = JSON.parse(JSON.stringify(toRaw(configValues.value)))
  if (!isNasSyncConfig.value) {
    return plainConfig
  }

  const savedPairCode = String(savedConfigSnapshot.value.pairCode || '').trim()
  const currentPairCode = String(plainConfig.pairCode || '').trim()
  if (!currentPairCode && savedPairCode) {
    plainConfig.pairCode = savedPairCode
    configValues.value.pairCode = savedPairCode
  }
  for (const key of NAS_SYNC_PERSISTED_KEYS) {
    if (
      (plainConfig[key] === undefined || plainConfig[key] === '') &&
      savedConfigSnapshot.value[key] !== undefined
    ) {
      plainConfig[key] = savedConfigSnapshot.value[key]
      configValues.value[key] = savedConfigSnapshot.value[key]
    }
  }

  const serverUrl = buildNasSyncServerUrl(plainConfig as any)
  plainConfig.serverUrl = serverUrl
  configValues.value.serverUrl = serverUrl
  return plainConfig
}

async function ensureNasSyncSession(reason = 'manual', options: { sync?: boolean } = {}) {
  if (!String(configValues.value.host || '').trim()) {
    throw new Error('请先填写同步服务器主机')
  }

  const currentPairCode =
    String(configValues.value.pairCode || '').trim() ||
    String(savedConfigSnapshot.value.pairCode || '').trim()
  if (!currentPairCode) {
    throw new Error('请填写绑定码')
  }
  configValues.value.pairCode = currentPairCode

  const plainConfigForUrl = buildPluginConfigForSave()
  const baseUrl = String(plainConfigForUrl.serverUrl || '').trim().replace(/\/+$/, '')
  const response = await fetch(`${baseUrl}/auth/pair`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ pairCode: currentPairCode })
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.success === false) {
    throw new Error(body?.error || `同步服务请求失败：${response.status}`)
  }

  const session = body?.success === true && 'data' in body ? body.data : body
  configValues.value.enabled = true
  configValues.value.accessToken = session.accessToken
  configValues.value.tokenExpiresAt = session.expiresAt
  configValues.value.userId = session.user?.id || ''
  configValues.value.username = session.user?.username || ''
  configValues.value.nickname = session.user?.nickname || ''
  configValues.value.status = 'connected'

  const plainConfig = buildPluginConfigForSave()
  await window.api.plugins.saveConfig(configPluginId.value, plainConfig)
  savedConfigSnapshot.value = JSON.parse(JSON.stringify(plainConfig))
  configTestResult.value = { success: true, message: '同步服务已连接' }

  if (plainConfig.enabled && options.sync !== false) {
    runNasSyncNow(reason).catch((error) => {
      console.error('同步执行失败:', error)
      MessagePlugin.warning(`同步服务已连接，执行失败：${error.message || '未知错误'}`)
    })
  }

  return plainConfig
}

async function probeNasSyncConnection(options: { silent?: boolean } = {}) {
  const plainConfig = buildPluginConfigForSave()
  const baseUrl = String(plainConfig.serverUrl || '').trim().replace(/\/+$/, '')
  if (!baseUrl) {
    configValues.value.status = 'disconnected'
    configTestResult.value = { success: false, message: '请先填写同步服务器主机和端口' }
    return configTestResult.value
  }

  const token = String(plainConfig.accessToken || '').trim()
  if (token) {
    try {
      const response = await fetch(`${baseUrl}/me`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`
        }
      })
      const body = await response.json().catch(() => null)
      if (response.ok && body?.success !== false) {
        const user = body?.success === true && 'data' in body ? body.data : body
        configValues.value.status = 'connected'
        configValues.value.userId = user?.id || configValues.value.userId || ''
        configValues.value.username = user?.username || configValues.value.username || ''
        configValues.value.nickname = user?.nickname || configValues.value.nickname || ''
        const nextConfig = buildPluginConfigForSave()
        await window.api.plugins.saveConfig(configPluginId.value, nextConfig)
        savedConfigSnapshot.value = JSON.parse(JSON.stringify(nextConfig))
        configTestResult.value = { success: true, message: '同步服务已连接' }
        return configTestResult.value
      }
    } catch {
      // token 探测失败时继续尝试用长期绑定码重新配对
    }
  }

  const pairCode =
    String(plainConfig.pairCode || '').trim() ||
    String(savedConfigSnapshot.value.pairCode || '').trim()
  if (pairCode) {
    try {
      await ensureNasSyncSession('probe', { sync: false })
      return { success: true, message: '同步服务已连接' }
    } catch (error: any) {
      configValues.value.status = 'disconnected'
      configTestResult.value = { success: false, message: error.message || '同步服务未连接' }
      if (!options.silent) MessagePlugin.error(configTestResult.value.message)
      return configTestResult.value
    }
  }

  configValues.value.status = 'disconnected'
  configTestResult.value = { success: false, message: '服务器可访问时仍需绑定码登录' }
  if (!options.silent) MessagePlugin.error(configTestResult.value.message)
  return configTestResult.value
}

async function loginNasSyncPlugin() {
  configTesting.value = true
  configTestResult.value = null
  try {
    await ensureNasSyncSession('login')
    MessagePlugin.success('同步服务已连接')
  } catch (err: any) {
    configValues.value.status = 'disconnected'
    configValues.value.accessToken = ''
    const plainConfig = buildPluginConfigForSave()
    await window.api.plugins.saveConfig(configPluginId.value, plainConfig)
    savedConfigSnapshot.value = JSON.parse(JSON.stringify(plainConfig))
    configTestResult.value = { success: false, message: err.message || '同步服务连接失败' }
    MessagePlugin.error(err.message || '同步服务连接失败')
  } finally {
    configTesting.value = false
  }
}

// 保存配置
async function savePluginConfig() {
  configSaving.value = true
  try {
    // 验证必填字段
    for (const field of configSchema.value) {
      if (field.required && !configValues.value[field.key]) {
        MessagePlugin.warning(`请填写 ${field.label}`)
        configSaving.value = false
        return
      }
    }

    // toRaw + JSON round-trip 去除 Vue Proxy，避免 IPC structuredClone 报错
    let plainConfig = buildPluginConfigForSave()
    const wasEnabled = savedConfigSnapshot.value.enabled !== false
    // 仅在开关打开时才走登录绑定流程；关闭时直接保存 enabled=false
    if (isNasSyncConfig.value && plainConfig.serverUrl && plainConfig.pairCode && plainConfig.enabled !== false) {
      plainConfig = await ensureNasSyncSession('save', { sync: false })
    } else {
      await window.api.plugins.saveConfig(configPluginId.value, plainConfig)
      savedConfigSnapshot.value = JSON.parse(JSON.stringify(plainConfig))
    }
    MessagePlugin.success('配置已保存')
    window.dispatchEvent(new Event('shuxia-nas-local-change'))
    configDialogVisible.value = false

    // 根据开关状态控制同步轮询
    if (isNasSyncConfig.value) {
      const currentEnabled = plainConfig.enabled !== false
      if (currentEnabled && !wasEnabled) {
        startNasSyncPoller()
      } else if (!currentEnabled && wasEnabled) {
        stopNasSyncPoller()
      }
    }
  } catch (err: any) {
    MessagePlugin.error(`保存配置失败: ${err.message}`)
  } finally {
    configSaving.value = false
  }
}

// 测试连接
async function testPluginConnection() {
  configTesting.value = true
  configTestResult.value = null

  try {
    if (isNasSyncConfig.value) {
      const result = await probeNasSyncConnection()
      if (result.success) {
        MessagePlugin.success(result.message || '连接成功')
      }
      return
    }

    // 先保存当前配置
    const plainConfig = buildPluginConfigForSave()
    await window.api.plugins.saveConfig(configPluginId.value, plainConfig)
    savedConfigSnapshot.value = JSON.parse(JSON.stringify(plainConfig))

    const result = await window.api.plugins.testConnection(configPluginId.value)
    let message = result?.message || (result?.success ? '连接成功' : '连接失败')
    const autoImport = result?.autoImport
    if (result?.success && Array.isArray(autoImport?.imported) && autoImport.imported.length > 0) {
      const importedCount = autoImport.imported.length
      const songCount = autoImport.imported.reduce(
        (sum: number, item: any) => sum + Number(item.total || 0),
        0
      )
      message += `，已同步 ${importedCount} 个歌单、${songCount} 首歌曲到“我的歌单”`
    }
    if (Array.isArray(autoImport?.errors) && autoImport.errors.length > 0) {
      message += `；${autoImport.errors.length} 个歌单同步失败`
    }

    configTestResult.value = { ...result, message }
    if (result?.success) {
      window.dispatchEvent(new Event('playlist-updated'))
      MessagePlugin.success(message)
    } else {
      MessagePlugin.error(message)
    }
  } catch (err: any) {
    configTestResult.value = { success: false, message: err.message }
    MessagePlugin.error(`测试连接失败: ${err.message}`)
  } finally {
    configTesting.value = false
  }
}

async function runCurrentNasSyncMode() {
  if (!isNasSyncConfig.value) return
  nasSyncRunning.value = true
  try {
    const plainConfig = buildPluginConfigForSave()
    if (!plainConfig.enabled) {
      MessagePlugin.warning('请先启用同步')
      return
    }
    await window.api.plugins.saveConfig(configPluginId.value, plainConfig)
    savedConfigSnapshot.value = JSON.parse(JSON.stringify(plainConfig))
    await ensureNasSyncSession('manual-sync', { sync: false })
    const result = await runNasSyncNow(String(plainConfig.syncMode || 'auto'))
    if (result) {
      MessagePlugin.success('当前同步模式已执行')
    } else {
      MessagePlugin.warning('当前没有可执行的同步任务')
    }
  } catch (err: any) {
    MessagePlugin.error(err.message || '执行同步失败')
  } finally {
    nasSyncRunning.value = false
  }
}

// 打开导入歌单
function openImportDialog(plugin: Plugin) {
  importPluginId.value = plugin.pluginId
  importPluginName.value = pluginDisplayName(plugin)
  importDialogVisible.value = true
}

// 检查插件是否是服务插件
function isServicePlugin(plugin: Plugin): boolean {
  return plugin.pluginType === 'service'
}

// 格式化时间
function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

// 格式化日志时间（基于真实时间戳；旧格式行没时间戳时返回 '--:--:--'）
function formatLogTime(ts: number | null): string {
  if (ts == null) return '--:--:--'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return d.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

/**
 * 解析单行日志。
 *   - 优先按 NDJSON 解析（{t,l,m}）
 *   - 兼容旧格式 "level message"（level ∈ log/info/warn/error/start/end）
 *   - 都不匹配时整行作为 log 级别消息
 */
function parseLogLine(raw: string): { t: number | null; level: PluginLogLevel; message: string } {
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed)
      if (obj && typeof obj === 'object' && typeof obj.l === 'string') {
        const lvl = obj.l as PluginLogLevel
        const validLevels: PluginLogLevel[] = [
          'log',
          'info',
          'warn',
          'error',
          'debug',
          'group',
          'groupEnd'
        ]
        if (validLevels.includes(lvl)) {
          return {
            t: typeof obj.t === 'number' ? obj.t : null,
            level: lvl,
            message: typeof obj.m === 'string' ? obj.m : ''
          }
        }
      }
    } catch {
      /* 不是合法 JSON，继续走 fallback */
    }
  }
  // 旧格式 fallback：以第一个空格切分
  const spaceIdx = raw.indexOf(' ')
  if (spaceIdx > 0) {
    const head = raw.slice(0, spaceIdx)
    const rest = raw.slice(spaceIdx + 1)
    switch (head) {
      case 'log':
      case 'info':
      case 'warn':
      case 'error':
      case 'debug':
        return { t: null, level: head, message: rest }
      case 'start':
        return { t: null, level: 'group', message: rest }
      case 'end':
        return { t: null, level: 'groupEnd', message: rest }
    }
  }
  return { t: null, level: 'log', message: raw }
}

/** 把原始行数组解析成带 depth / 折叠索引的渲染条目数组。 */
const parsedLogs = computed<ParsedLogEntry[]>(() => {
  const out: ParsedLogEntry[] = []
  // 用栈记录当前所处的 group 头索引，用于配对 groupEnd → 标记 groupEndIndex
  const groupStack: number[] = []
  let depth = 0
  for (let i = 0; i < logs.value.length; i++) {
    const parsed = parseLogLine(logs.value[i])
    if (parsed.level === 'group') {
      const entry: ParsedLogEntry = {
        t: parsed.t,
        level: 'group',
        message: parsed.message,
        depth,
        isGroup: true,
        key: i
      }
      out.push(entry)
      groupStack.push(out.length - 1)
      depth++
    } else if (parsed.level === 'groupEnd') {
      // 关闭最近一个 group；如果栈空说明是孤儿 groupEnd，直接忽略
      const headIdx = groupStack.pop()
      if (headIdx !== undefined) {
        out[headIdx].groupEndIndex = i
        depth = Math.max(0, depth - 1)
      }
      // groupEnd 本身不输出可见行（行为对齐 console.group 语义）
    } else {
      out.push({
        t: parsed.t,
        level: parsed.level,
        message: parsed.message,
        depth,
        isGroup: false,
        key: i
      })
    }
  }
  return out
})

/** 真实日志级别 → CSS class */
function logLevelClass(level: PluginLogLevel): string {
  switch (level) {
    case 'error':
      return 'log-error'
    case 'warn':
      return 'log-warn'
    case 'info':
      return 'log-info'
    case 'debug':
      return 'log-debug'
    case 'group':
      return 'log-group'
    default:
      return 'log-default'
  }
}

/** 计算折叠后实际展示的条目（被折叠 group 内部的行不渲染）。 */
const visibleLogs = computed<ParsedLogEntry[]>(() => {
  if (collapsedGroups.value.size === 0) return parsedLogs.value
  const result: ParsedLogEntry[] = []
  // skipUntilDepth：在折叠时，跳过深度 > 该值的所有后续条目，直到深度回到 <= 该值
  let skipUntilDepth = -1
  for (const entry of parsedLogs.value) {
    if (skipUntilDepth >= 0) {
      if (entry.depth <= skipUntilDepth) {
        skipUntilDepth = -1
      } else {
        continue
      }
    }
    result.push(entry)
    if (entry.isGroup && collapsedGroups.value.has(entry.key)) {
      skipUntilDepth = entry.depth
    }
  }
  return result
})

function toggleGroup(key: number) {
  const next = new Set(collapsedGroups.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedGroups.value = next
}

// 【旧·已停用，勿再启用】原本配合 plugin-updated window 事件刷新插件列表，
// 现在统一改由下方 onSyncEvent('plugin') 总线处理，二者功能重复。
// const handlePluginUpdated = () => {
//   void getPlugins()
// }

// 【新·现在用这个】统一实时同步总线：插件增删改（本地或远端）的唯一刷新入口
const stopPluginSyncBus = onSyncEvent('plugin', () => {
  void getPlugins()
})

onMounted(async () => {
  // 确保store已初始化
  if (!localUserStore.initialization) {
    console.log('组件挂载时初始化store')
    localUserStore.init()
  }
  // 【旧·已停用，勿再启用】原来的 window 监听，和上面的总线重复
  // window.addEventListener('plugin-updated', handlePluginUpdated)
  await getPlugins()
})

onUnmounted(() => {
  // 【旧·已停用】对应上面已注释的 window 监听
  // window.removeEventListener('plugin-updated', handlePluginUpdated)
  stopPluginSyncBus()
})
</script>

<style scoped lang="scss">
.page {
  display: flex;
  flex-direction: column;
  // height: 100%;
  // max-height: 100vh;
  background: var(--plugins-bg);
  color: var(--plugins-text-primary);
  overflow: hidden;

  h2 {
    font-weight: 600;
    color: var(--plugins-text-primary);
    margin: 0 0 16px 0;
  }
}

.header {
  -webkit-app-region: drag;
  display: flex;
  align-items: center;
  background-color: var(--plugins-header-bg);
  padding: 1.5rem;
  position: sticky;
  z-index: 1000;
  top: 0;
  left: 0;
  right: 0;
  border-bottom: 1px solid var(--plugins-border);
  flex-shrink: 0;
}

.plugins-container {
  flex: 1;
  padding: 24px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
  background: var(--plugins-bg);
}

.plugin-actions-hearder {
  margin-bottom: 24px;
  flex-shrink: 0;

  h2 {
    margin-bottom: 16px;
    font-size: 24px;
    font-weight: 600;
    color: var(--plugins-text-primary);
  }
}

.plugin-actions {
  display: flex;

  gap: 12px;
  margin-top: 16px;
}

.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 0;
  background: var(--plugins-container-bg);
  border-radius: 12px;
  margin: 20px 0;
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--plugins-border);
  border-radius: 50%;
  border-top-color: var(--plugins-loading-spinner);
  animation: spin 1s ease-in-out infinite;
  margin-bottom: 16px;
}

.loading span {
  color: var(--plugins-text-secondary);
  font-size: 14px;
}

.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 0;
  color: var(--plugins-text-secondary);
  background: var(--plugins-container-bg);
  border-radius: 12px;
  margin: 20px 0;
}

.error-state p {
  color: var(--plugins-text-primary);
  font-size: 16px;
  margin: 8px 0;
}

.error-message {
  color: var(--plugins-error-color);
  margin-bottom: 20px;
  text-align: center;
  max-width: 80%;
  font-size: 14px;
  line-height: 1.5;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 0;
  color: var(--plugins-text-secondary);
  background: var(--plugins-container-bg);
  border-radius: 12px;
  margin: 20px 0;
}

.empty-state p {
  color: var(--plugins-text-primary);
  font-size: 16px;
  margin: 8px 0;
}

.hint {
  font-size: 14px;
  color: var(--plugins-text-muted);
  line-height: 1.5;
}

.plugin-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
  // overflow-y: auto;
  // overflow-x: hidden;
  min-height: 0;
  max-height: 100%;

  /* 自定义滚动条 */
  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-track {
    background: var(--plugins-bg);
    border-radius: 3px;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--plugins-border);
    border-radius: 3px;

    &:hover {
      background: var(--plugins-text-muted);
    }
  }
}

.plugin-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 20px;
  border-radius: 12px;
  background-color: var(--plugins-card-bg);
  box-shadow: var(--plugins-card-shadow);
  transition: all 0.3s ease;
  border: 2px solid transparent;
  position: relative;

  // &:hover {
  //   box-shadow: var(--plugins-card-shadow-hover);
  //   transform: translateY(-2px);
  // }
}

.plugin-item.selected {
  background-color: var(--plugins-card-selected-bg);
  border: 2px solid var(--plugins-card-selected-border);

  // &::before {
  //   content: '';
  //   position: absolute;
  //   top: 0;
  //   left: 0;
  //   right: 0;
  //   height: 3px;
  //   background: linear-gradient(90deg, var(--plugins-card-selected-border), var(--td-brand-color));
  //   border-radius: 12px 12px 0 0;
  // }
}

.plugin-info {
  flex: 1;
  margin-right: 20px;
}

.plugin-info h3 {
  margin: 0 0 8px 0;
  font-size: 18px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--plugins-text-primary);
  line-height: 1.4;
}

.version {
  font-size: 12px;
  color: var(--plugins-text-muted);
  font-weight: 500;
  background: var(--plugins-border);
  padding: 2px 8px;
  border-radius: 6px;
}

.current-tag {
  background: linear-gradient(135deg, var(--td-brand-color-5), var(--td-brand-color-6));
  color: white;
  padding: 4px 12px;
  border-radius: 16px;
  font-size: 12px;
  font-weight: 500;
  box-shadow: 0 2px 4px rgba(0, 167, 77, 0.2);
}

.author {
  margin: 0 0 8px 0;
  font-size: 14px;
  color: var(--plugins-text-secondary);
}

.description {
  margin: 0 0 12px 0;
  font-size: 14px;
  color: var(--plugins-text-secondary);
  line-height: 1.5;
  max-width: 500px;
}

.plugin-note {
  margin: 0 0 12px 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--plugins-text-muted);
  max-width: 620px;
}

.plugin-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}

.source-label {
  font-size: 13px;
  color: var(--plugins-text-muted);
  font-weight: 500;
}

.source-tag {
  background: linear-gradient(135deg, var(--td-brand-color-4), var(--td-brand-color-5));
  color: white;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
  box-shadow: 0 1px 3px rgba(0, 167, 77, 0.2);
}

.service-tag {
  background: linear-gradient(135deg, #5b8def, #3a6ed8);
  color: white;
  padding: 4px 12px;
  border-radius: 16px;
  font-size: 12px;
  font-weight: 500;
  box-shadow: 0 2px 4px rgba(58, 110, 216, 0.2);
}

.disabled-tag {
  background: linear-gradient(135deg, #e64545, #b51d1d);
  color: white;
  padding: 4px 12px;
  border-radius: 16px;
  font-size: 12px;
  font-weight: 500;
  box-shadow: 0 2px 4px rgba(181, 29, 29, 0.25);
}

.config-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
}

.config-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sync-mode-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: end;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--plugins-border);
}

.sync-mode-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.config-field-switch {
  align-items: flex-start;

  :deep(.t-switch) {
    width: auto;
    max-width: none;
  }
}

.config-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--plugins-text-primary);

  .required-mark {
    color: #e34d59;
    margin-left: 2px;
  }
}

.config-test {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--plugins-border);

  .test-result {
    font-size: 13px;
    &.success {
      color: #2ba471;
    }
    &.fail {
      color: #e34d59;
    }
  }
}

.nas-sync-status-hint {
  width: 100%;
  font-size: 13px;
  line-height: 1.6;
  color: var(--plugins-text-secondary);
}

.nas-sync-status {
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 13px;
  border: 1px solid var(--plugins-border);

  &.connected {
    color: #2ba471;
    background: rgba(43, 164, 113, 0.12);
  }

  &.disconnected {
    color: var(--plugins-text-secondary);
    background: var(--plugins-card-bg);
  }
}

.plugin-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 120px;
}

/* Moved to global style */

.log-dialog-header {
  display: flex;
  align-items: center;
  padding: 12px 20px;
  background: var(
    --plugins-dialog-header-bg,
    linear-gradient(135deg, var(--plugins-console-header-bg) 0%, var(--plugins-console-bg) 100%)
  );
  min-height: 48px;
  width: 100%;

  .log-title {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--plugins-console-text);
    font-weight: 600;
    font-size: 14px;
    flex: 1;

    .iconfont {
      font-size: 16px;
      color: var(--plugins-console-prompt);
    }
  }

  .log-actions {
    display: flex;
    gap: 8px;
    margin-right: 12px;

    :deep(.t-button) {
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid var(--plugins-console-border);
      color: var(--plugins-console-text);
      font-size: 12px;
      padding: 4px 12px;
      height: auto;

      &:hover {
        background: rgba(255, 255, 255, 0.2) !important;
        border-color: var(--plugins-console-prompt);
      }

      .t-icon {
        font-size: 12px;
      }
    }
  }

  .mac-controls {
    display: flex;
    gap: 8px;
    flex-direction: row-reverse;

    .mac-button {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      cursor: pointer;
      transition: all 0.2s ease;

      &.close {
        background: var(--plugins-mac-close);

        &:hover {
          background: #ff3b30;
        }
      }

      &.minimize {
        background: var(--plugins-mac-minimize);

        &:hover {
          background: #ff9500;
        }
      }

      &.maximize {
        background: var(--plugins-mac-maximize);

        &:hover {
          background: #30d158;
        }
      }
    }
  }
}

.console-container {
  background: var(--plugins-console-bg);
  color: var(--plugins-console-text);
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.4;
  height: calc(80vh - 64px - 48px);
  min-height: 300px;
  display: flex;
  flex-direction: column;
}

.console-header {
  background: var(--plugins-console-header-bg);
  border-bottom: 1px solid var(--plugins-console-border);
  padding: 8px 16px;
  flex-shrink: 0;

  .console-info {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 12px;

    .console-prompt {
      color: var(--plugins-console-prompt);
      font-weight: bold;
    }

    .console-path {
      color: var(--plugins-console-path);
    }

    .console-time {
      color: var(--plugins-console-time);
      margin-left: auto;
    }
  }
}

.console-content {
  flex: 1;
  overflow-y: auto;
  scrollbar-color: var(--plugins-console-scrollbar-thumb) var(--plugins-console-scrollbar-track);
  padding: 16px;
  background: var(--plugins-console-bg);
  position: relative;

  &.loading {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* 自定义滚动条 */
  &::-webkit-scrollbar {
    width: 8px;
  }

  &::-webkit-scrollbar-track {
    background: var(--plugins-console-scrollbar-track);
  }

  &::-webkit-scrollbar-thumb {
    background: var(--plugins-console-scrollbar-thumb);
    border-radius: 4px;

    &:hover {
      background: var(--plugins-console-scrollbar-thumb-hover);
    }
  }
}

.console-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--plugins-console-path);

  .loading-spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--plugins-console-border);
    border-top: 2px solid var(--plugins-console-prompt);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
}

.console-error {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--plugins-log-error);
  padding: 12px;
  background: rgba(255, 107, 107, 0.1);
  border-radius: 6px;
  border-left: 4px solid var(--plugins-log-error);

  .error-icon {
    font-size: 16px;
  }
}

.console-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--plugins-console-path);
  height: 200px;

  .empty-icon {
    font-size: 24px;
    opacity: 0.6;
  }
}

.log-entries {
  .log-entry {
    display: flex;
    margin-bottom: 4px;
    padding: 2px 0;
    border-radius: 3px;
    transition: background-color 0.2s ease;

    &:hover {
      background: rgba(255, 255, 255, 0.05);
    }

    .log-timestamp {
      color: var(--plugins-console-time);
      font-size: 11px;
      width: 80px;
      text-align: center;
      flex-shrink: 0;
      margin-right: 12px;
      font-weight: 500;
    }

    .log-content {
      flex: 1;
      word-break: break-all;
      white-space: pre-wrap;
      user-select: text !important;
    }

    /* 不同日志级别的颜色 */
    &.log-error {
      .log-content {
        color: var(--plugins-log-error);
      }

      .log-timestamp {
        color: var(--plugins-log-error);
      }
    }

    &.log-warn {
      .log-content {
        color: var(--plugins-log-warn);
      }

      .log-timestamp {
        color: var(--plugins-log-warn);
      }
    }

    &.log-info {
      .log-content {
        color: var(--plugins-log-info);
      }

      .log-timestamp {
        color: var(--plugins-log-info);
      }
    }

    &.log-debug {
      .log-content {
        color: var(--plugins-log-debug);
      }

      .log-timestamp {
        color: var(--plugins-log-debug);
      }
    }

    &.log-default {
      .log-content {
        color: var(--plugins-console-text);
      }
    }

    /* group 头：可点击折叠 */
    &.log-entry-group {
      cursor: pointer;
      font-weight: 600;

      .log-group-caret {
        display: inline-block;
        width: 14px;
        margin-right: 4px;
        text-align: center;
        font-size: 10px;
        color: var(--plugins-console-text);
        flex-shrink: 0;
      }

      &:hover {
        background: rgba(255, 255, 255, 0.08);
      }
    }

    &.log-entry-collapsed {
      opacity: 0.85;
    }

    &.log-group {
      .log-content {
        color: var(--plugins-console-text);
      }
    }
  }
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }

  100% {
    transform: rotate(360deg);
  }
}

/* 导入方式选择样式 */
.import-method-container {
  padding: 16px 0;
}

.online-input-container {
  margin-top: 16px;
}

.hint-text {
  font-size: 13px;
  color: var(--plugins-text-muted);
  margin-top: 8px;
  line-height: 1.5;
}

.local-hint-container {
  margin-top: 16px;
  padding: 12px;
  background: var(--plugins-border);
  border-radius: 8px;
}

/* 响应式设计 */
@media (max-width: 768px) {
  .plugins-container {
    padding: 16px;
  }

  .plugin-item {
    flex-direction: column;
    align-items: stretch;
    gap: 16px;

    .plugin-info {
      margin-right: 0;
    }

    .plugin-actions {
      flex-direction: row;
      justify-content: flex-end;
      min-width: auto;
    }
  }

  :deep(.log-dialog) {
    .t-dialog {
      width: 95% !important;
      max-width: none !important;
      max-height: 90vh !important;
    }
  }

  .console-container {
    height: 50vh;
    max-height: 400px;
    min-height: 250px;
  }

  .log-dialog-header {
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 16px;

    .log-title {
      order: 1;
      flex: 1 1 100%;
      justify-content: center;
      margin-bottom: 4px;
    }

    .log-actions {
      order: 2;
      margin-right: 0;

      .t-button {
        padding: 2px 8px;
        font-size: 11px;
      }
    }

    .mac-controls {
      order: 3;
    }
  }

  .console-content {
    font-size: 12px;
  }

  .log-entries .log-entry {
    .log-timestamp {
      width: 60px;
      font-size: 10px;
    }
  }
}
</style>

<style lang="scss">
/* 日志弹窗样式 - 全局样式以支持 attach="body" */
.log-dialog {
  height: 80vh;

  .t-dialog {
    background: var(--plugins-console-bg);
    border-radius: 12px;
    box-shadow: var(--plugins-dialog-shadow, 0 20px 60px rgba(0, 0, 0, 0.4));
    overflow: hidden;
    border: 1px solid var(--plugins-console-border);
  }

  .t-dialog__header {
    background: var(--plugins-console-header-bg);
    border-bottom: 1px solid var(--plugins-console-border);
    padding: 0;
    border-radius: 12px 12px 0 0;
    overflow: hidden;
  }

  .t-dialog__body {
    padding: 0;
    background: var(--plugins-console-bg);
    border-left: 2px solid var(--plugins-console-border);
    border-right: 2px solid var(--plugins-console-border);
    border-bottom: 2px solid var(--plugins-console-border);
    border-radius: 0 0 12px 12px;
    overflow: hidden;
  }
}
</style>
