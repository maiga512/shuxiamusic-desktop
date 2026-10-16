import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { service } from '../sidecar/services/plugins/index.mjs'

const electronPluginsDir = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'ceru-music',
  'plugins'
)
const tauriPluginsDir = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'com.shuxiamusic.tauri',
  'plugins'
)
const tauriConfigDir = path.join(tauriPluginsDir, 'config')

const isPluginFile = (entry) => entry.isFile() && !entry.name.startsWith('.')

const readPluginId = (fileName) => fileName.split('-')[0]

const migrate = async () => {
  await fs.mkdir(tauriPluginsDir, { recursive: true })
  await fs.mkdir(tauriConfigDir, { recursive: true })

  const entries = await fs.readdir(electronPluginsDir, { withFileTypes: true })
  const results = []

  for (const entry of entries) {
    if (!isPluginFile(entry)) continue
    const pluginId = readPluginId(entry.name)
    if (!pluginId) continue

    const code = await fs.readFile(path.join(electronPluginsDir, entry.name), 'utf8')
    try {
      const installed = await service.installFromCode({
        pluginCode: code,
        pluginName: entry.name.slice(pluginId.length + 1),
        targetPluginId: pluginId,
        type: code.includes('CeruMusicPlugin') ? 'cr' : 'lx',
      })

      const configSource = path.join(electronPluginsDir, 'config', `${pluginId}.json`)
      const config = await fs.readFile(configSource, 'utf8').catch(() => '')
      if (config) {
        await fs.writeFile(path.join(tauriConfigDir, `${pluginId}.json`), config, 'utf8')
      }

      results.push({
        pluginId,
        name: installed.pluginName,
        type: installed.pluginType,
        version: installed.pluginInfo?.version || '',
        compatible: true,
        configMigrated: Boolean(config),
      })
    } catch (error) {
      results.push({
        pluginId,
        name: entry.name,
        compatible: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const loaded = await service.loadAll()
  console.log(JSON.stringify({ results, loaded }, null, 2))

  if (results.some((item) => !item.compatible)) {
    process.exitCode = 2
  }
}

await migrate()
