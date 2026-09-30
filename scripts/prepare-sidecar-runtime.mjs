#!/usr/bin/env node
/**
 * Prepare a portable Node runtime + sidecar npm deps for Tauri packaging.
 *
 * Why: the packaged app must not depend on a system `node` install.
 * Electron previously shipped its own runtime; Tauri needs an explicit sidecar Node.
 *
 * Output:
 *   packaging/sidecar-runtime/node[.exe]
 *   packaging/sidecar-runtime/node_modules/{axios,iconv-lite,...}
 *   packaging/sidecar-runtime/manifest.json
 */
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const outRoot = path.join(projectRoot, 'packaging', 'sidecar-runtime')
const requireFromProject = createRequire(path.join(projectRoot, 'package.json'))

const NODE_VERSION = process.env.CERU_SIDECAR_NODE_VERSION || '22.14.0'
const REQUIRED_PACKAGES = ['axios', 'iconv-lite']

const parseArgs = (argv) => {
  const args = { platform: '', arch: '', force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (item === '--force') args.force = true
    else if (item === '--platform') args.platform = String(argv[++i] || '')
    else if (item === '--arch') args.arch = String(argv[++i] || '')
    else if (item.startsWith('--platform=')) args.platform = item.slice('--platform='.length)
    else if (item.startsWith('--arch=')) args.arch = item.slice('--arch='.length)
  }
  return args
}

const normalizePlatform = (input) => {
  const value = String(input || '').trim().toLowerCase()
  if (!value) return process.platform
  if (value === 'win' || value === 'windows' || value === 'win32') return 'win32'
  if (value === 'mac' || value === 'macos' || value === 'darwin' || value === 'osx') return 'darwin'
  if (value === 'linux') return 'linux'
  return value
}

const normalizeArch = (input) => {
  const value = String(input || '').trim().toLowerCase()
  if (!value) return process.arch
  if (value === 'x64' || value === 'x86_64' || value === 'amd64') return 'x64'
  if (value === 'arm64' || value === 'aarch64') return 'arm64'
  if (value === 'ia32' || value === 'x86' || value === 'i686') return 'ia32'
  return value
}

const detectFromTauriEnv = () => {
  const platform = normalizePlatform(process.env.TAURI_ENV_PLATFORM || '')
  const arch = normalizeArch(process.env.TAURI_ENV_ARCH || '')
  const triple = String(process.env.TAURI_ENV_TARGET_TRIPLE || '').toLowerCase()
  if (triple.includes('windows')) {
    return {
      platform: 'win32',
      arch: triple.includes('aarch64') ? 'arm64' : triple.includes('i686') ? 'ia32' : 'x64'
    }
  }
  if (triple.includes('apple-darwin') || triple.includes('macos')) {
    return {
      platform: 'darwin',
      arch: triple.includes('aarch64') ? 'arm64' : 'x64'
    }
  }
  if (triple.includes('linux')) {
    return {
      platform: 'linux',
      arch: triple.includes('aarch64') ? 'arm64' : 'x64'
    }
  }
  return {
    platform: platform || process.platform,
    arch: arch || process.arch
  }
}

const nodeDistName = (platform, arch) => {
  if (platform === 'win32') {
    if (arch === 'arm64') return 'win-arm64'
    if (arch === 'ia32') return 'win-x86'
    return 'win-x64'
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  }
  throw new Error(`Unsupported sidecar Node target: ${platform}/${arch}`)
}

const nodeBinaryName = (platform) => (platform === 'win32' ? 'node.exe' : 'node')

const mirrorBases = () => {
  const custom = String(process.env.CERU_NODE_DIST_MIRROR || '').trim()
  return [
    custom,
    'https://npmmirror.com/mirrors/node',
    'https://nodejs.org/dist'
  ].filter(Boolean)
}

const ensureDir = async (dir) => fs.mkdir(dir, { recursive: true })

const pathExists = async (target) => {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

const readJson = async (filePath, fallback = null) => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

const downloadToFile = async (url, filePath) => {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}): ${url}`)
  }
  await ensureDir(path.dirname(filePath))
  await pipeline(response.body, createWriteStream(filePath))
}

const run = (bin, args, opts = {}) =>
  execFileSync(bin, args, {
    stdio: 'inherit',
    ...opts
  })

const extractArchive = async ({ archivePath, platform, extractRoot }) => {
  await fs.rm(extractRoot, { recursive: true, force: true })
  await ensureDir(extractRoot)
  if (platform === 'win32') {
    // Windows: 用 PowerShell Expand-Archive 解 .zip。
    // 不能直接 `tar -xf C:\...`：Git bash 里的 GNU tar 会把 `C:` 当成远程主机
    // （报 "Cannot connect to C: resolve failed"）。PowerShell 对 Windows 路径最稳。
    run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${extractRoot}' -Force`
    ])
    return
  }
  run('tar', ['-xzf', archivePath, '-C', extractRoot])
}

const findExtractedNode = async (extractRoot, platform) => {
  const wanted = nodeBinaryName(platform)
  const stack = [extractRoot]
  while (stack.length) {
    const current = stack.pop()
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (entry.isFile() && entry.name === wanted) {
        return full
      }
    }
  }
  throw new Error(`Extracted Node binary not found in ${extractRoot}`)
}

const resolvePackageDir = (packageName) => {
  const roots = [
    path.join(projectRoot, 'node_modules', packageName),
    path.join(projectRoot, 'node_modules', '.pnpm'),
  ]
  // Prefer the flat install path used by npm/yarn.
  return roots[0]
}

const copyPackageTree = async (packageName, seen = new Set()) => {
  if (seen.has(packageName)) return
  seen.add(packageName)

  const resolvedDir = resolvePackageDir(packageName)
  if (!(await pathExists(path.join(resolvedDir, 'package.json')))) {
    // Scoped packages may only exist nested under a parent; fall back to require.resolve.
    try {
      const entry = requireFromProject.resolve(packageName)
      let current = path.dirname(entry)
      while (current !== path.dirname(current)) {
        const pkgPath = path.join(current, 'package.json')
        if (await pathExists(pkgPath)) {
          const pkg = await readJson(pkgPath, {})
          if (pkg.name === packageName) {
            return copyResolvedPackage(packageName, current, seen)
          }
        }
        current = path.dirname(current)
      }
    } catch (error) {
      throw new Error(`Missing dependency "${packageName}" in project node_modules: ${error.message}`)
    }
    throw new Error(`Missing dependency "${packageName}" in project node_modules`)
  }

  await copyResolvedPackage(packageName, resolvedDir, seen)
}

const copyResolvedPackage = async (packageName, resolvedDir, seen) => {
  const targetDir = path.join(outRoot, 'node_modules', packageName)
  await ensureDir(path.dirname(targetDir))
  await fs.rm(targetDir, { recursive: true, force: true })
  await fs.cp(resolvedDir, targetDir, { recursive: true, force: true })

  const pkg = await readJson(path.join(resolvedDir, 'package.json'), {})
  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.optionalDependencies || {})
  }
  for (const depName of Object.keys(deps)) {
    await copyPackageTree(depName, seen)
  }
}

const writePlaceholderReadme = async () => {
  const readmePath = path.join(outRoot, 'README.md')
  const content = `# Sidecar Runtime

This directory is generated by \`scripts/prepare-sidecar-runtime.mjs\`.

It contains:
- portable Node binary used by the packaged Tauri app
- npm packages required by \`sidecar/\` (\`axios\`, \`iconv-lite\`, ...)

Do not commit downloaded binaries. Run:

\`\`\`bash
npm run sidecar:prepare-runtime
\`\`\`
`
  if (!(await pathExists(readmePath))) {
    await fs.writeFile(readmePath, content, 'utf8')
  }
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const detected = detectFromTauriEnv()
  const platform = normalizePlatform(args.platform || detected.platform)
  const arch = normalizeArch(args.arch || detected.arch)
  const dist = nodeDistName(platform, arch)
  const binaryName = nodeBinaryName(platform)
  const binaryPath = path.join(outRoot, binaryName)
  const manifestPath = path.join(outRoot, 'manifest.json')
  const archiveExt = platform === 'win32' ? 'zip' : 'tar.gz'
  const archiveName = `node-v${NODE_VERSION}-${dist}.${archiveExt}`
  const expectedManifest = {
    nodeVersion: NODE_VERSION,
    platform,
    arch,
    dist,
    binaryName,
    packages: REQUIRED_PACKAGES,
    preparedAt: new Date().toISOString()
  }

  await ensureDir(outRoot)
  await writePlaceholderReadme()

  const existing = await readJson(manifestPath, null)
  const binaryReady = await pathExists(binaryPath)
  const sameRuntime =
    existing &&
    existing.nodeVersion === expectedManifest.nodeVersion &&
    existing.platform === expectedManifest.platform &&
    existing.arch === expectedManifest.arch &&
    existing.binaryName === expectedManifest.binaryName

  if (!args.force && binaryReady && sameRuntime) {
    console.log(`[sidecar-runtime] reuse ${binaryName} (${dist}, node ${NODE_VERSION})`)
  } else {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ceru-sidecar-node-'))
    const archivePath = path.join(tmpRoot, archiveName)
    let downloaded = false
    let lastError = null
    for (const base of mirrorBases()) {
      const url = `${base.replace(/\/$/, '')}/v${NODE_VERSION}/${archiveName}`
      try {
        console.log(`[sidecar-runtime] downloading ${url}`)
        await downloadToFile(url, archivePath)
        downloaded = true
        break
      } catch (error) {
        lastError = error
        console.warn(`[sidecar-runtime] mirror failed: ${error.message}`)
      }
    }
    if (!downloaded) {
      throw lastError || new Error('Unable to download portable Node')
    }

    const extractRoot = path.join(tmpRoot, 'extract')
    await extractArchive({ archivePath, platform, extractRoot })
    const extractedNode = await findExtractedNode(extractRoot, platform)
    await fs.rm(binaryPath, { force: true })
    // Keep host-native companion binary names from colliding when switching targets.
    await fs.rm(path.join(outRoot, 'node'), { force: true })
    await fs.rm(path.join(outRoot, 'node.exe'), { force: true })
    await fs.copyFile(extractedNode, binaryPath)
    if (platform !== 'win32') {
      await fs.chmod(binaryPath, 0o755)
    }
    await fs.rm(tmpRoot, { recursive: true, force: true })
    console.log(`[sidecar-runtime] installed ${binaryName}`)
  }

  console.log('[sidecar-runtime] syncing sidecar npm deps')
  await fs.rm(path.join(outRoot, 'node_modules'), { recursive: true, force: true })
  await ensureDir(path.join(outRoot, 'node_modules'))
  const seen = new Set()
  for (const packageName of REQUIRED_PACKAGES) {
    await copyPackageTree(packageName, seen)
  }

  // ESM resolves node_modules from the importing file, not NODE_PATH.
  // Keep a copy next to sidecar/index.mjs so packaged axios imports work.
  const sidecarModules = path.join(projectRoot, 'sidecar', 'node_modules')
  await fs.rm(sidecarModules, { recursive: true, force: true })
  await fs.cp(path.join(outRoot, 'node_modules'), sidecarModules, { recursive: true, force: true })
  console.log(`[sidecar-runtime] mirrored node_modules -> ${sidecarModules}`)

  await fs.writeFile(manifestPath, `${JSON.stringify(expectedManifest, null, 2)}\n`, 'utf8')
  console.log(`[sidecar-runtime] ready -> ${outRoot}`)
  console.log(
    `[sidecar-runtime] target=${platform}/${arch} node=${NODE_VERSION} packages=${REQUIRED_PACKAGES.join(',')}`
  )
}

main().catch((error) => {
  console.error(`[sidecar-runtime] failed: ${error?.stack || error}`)
  process.exit(1)
})
