#!/usr/bin/env node
/**
 * Copy a portable mpv + dylibs into packaging/mpv for Tauri resources.
 * The packaged app must not depend on a system mpv install.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const outRoot = path.join(projectRoot, 'packaging', 'mpv')
const outBin = path.join(outRoot, 'bin')
const outLib = path.join(outRoot, 'lib')

const exists = async (file) => {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

const which = (name) => {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const brewPrefix = (formula) => {
  try {
    return execFileSync('brew', ['--prefix', formula], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const realpath = (file) => {
  try {
    return execFileSync('realpath', [file], { encoding: 'utf8' }).trim()
  } catch {
    return file
  }
}

const chmodWritable = async (file) => {
  try {
    await fs.chmod(file, 0o755)
  } catch {}
}

const removeTree = async (dir) => {
  try {
    execFileSync('chmod', ['-R', 'u+w', dir], { stdio: 'ignore' })
  } catch {}
  await fs.rm(dir, { recursive: true, force: true })
}

const adhocSign = (file) => {
  try {
    execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', file], {
      stdio: 'ignore'
    })
  } catch {}
}

const platform = String(process.env.CERU_TARGET_PLATFORM || process.platform).toLowerCase()
const arch = String(process.env.CERU_TARGET_ARCH || process.arch).toLowerCase()

const resolveMpvBinary = async () => {
  const envPath = String(process.env.CERU_MPV_PATH || '').trim()
  if (envPath && (await exists(envPath))) return envPath
  if (platform === 'win32') {
    throw new Error('Windows CI 需要通过 CERU_MPV_PATH 或预置的 mpv.exe 提供 MPV 运行时。')
  }
  const brewMpv = brewPrefix('mpv')
  const candidates = [
    brewMpv ? path.join(brewMpv, 'bin', 'mpv') : '',
    '/opt/homebrew/bin/mpv',
    '/usr/local/bin/mpv',
    which('mpv')
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  throw new Error('本机没有 mpv。先执行 brew install mpv，再打包。')
}

const listLinkedLibs = (file) => {
  const output = execFileSync('otool', ['-L', file], { encoding: 'utf8' })
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' ')[0])
    .filter((item) => item && !item.startsWith('@') && item !== file)
}

const shouldBundleLib = (libPath) => {
  if (!libPath.startsWith('/')) return false
  if (libPath.startsWith('/usr/lib/') || libPath.startsWith('/System/')) return false
  return (
    libPath.includes('/opt/homebrew/') ||
    libPath.includes('/usr/local/') ||
    libPath.includes('/Cellar/') ||
    libPath.includes('/opt/local/')
  )
}

const collectLibs = (binary) => {
  const queue = [realpath(binary)]
  const seenFiles = new Set()
  const libsByName = new Map()
  while (queue.length) {
    const current = queue.shift()
    if (!current || seenFiles.has(current)) continue
    seenFiles.add(current)
    let linked = []
    try {
      linked = listLinkedLibs(current)
    } catch {
      continue
    }
    for (const lib of linked) {
      if (!shouldBundleLib(lib)) continue
      const destName = path.basename(lib)
      const realLib = realpath(lib)
      if (!libsByName.has(destName)) libsByName.set(destName, lib)
      if (!seenFiles.has(realLib)) queue.push(realLib)
    }
  }
  return Array.from(libsByName.values())
}

const copyFile = async (from, to) => {
  const realFrom = realpath(from)
  await fs.mkdir(path.dirname(to), { recursive: true })
  await chmodWritable(to)
  try {
    await fs.unlink(to)
  } catch {}
  await fs.copyFile(realFrom, to)
  await fs.chmod(to, 0o755)
}

const rewriteInstallNames = (file, bundledNames) => {
  chmodWritable(file).catch(() => {})
  const linked = listLinkedLibs(file)
  for (const lib of linked) {
    const base = path.basename(lib)
    if (!bundledNames.has(base)) continue
    try {
      execFileSync('install_name_tool', ['-change', lib, `@rpath/${base}`, file])
    } catch {}
    const realLib = realpath(lib)
    if (realLib !== lib) {
      try {
        execFileSync('install_name_tool', ['-change', realLib, `@rpath/${base}`, file])
      } catch {}
    }
  }
  try {
    execFileSync('install_name_tool', ['-id', `@rpath/${path.basename(file)}`, file])
  } catch {}
  const rpaths = ['@executable_path/../lib', '@loader_path']
  for (const rpath of rpaths) {
    try {
      execFileSync('install_name_tool', ['-add_rpath', rpath, file])
    } catch {}
  }
  adhocSign(file)
}

const macMain = async () => {
  const source = await resolveMpvBinary()
  await removeTree(outRoot)
  await fs.mkdir(outBin, { recursive: true })
  await fs.mkdir(outLib, { recursive: true })

  const destBinary = path.join(outBin, 'mpv')
  await copyFile(source, destBinary)
  await fs.chmod(destBinary, 0o755)

  const libs = collectLibs(source)
  const bundledNames = new Set(libs.map((item) => path.basename(item)))
  bundledNames.add('mpv')
  for (const lib of libs) {
    await copyFile(lib, path.join(outLib, path.basename(lib)))
  }

  rewriteInstallNames(destBinary, bundledNames)
  for (const lib of libs) {
    rewriteInstallNames(path.join(outLib, path.basename(lib)), bundledNames)
  }

  const version = execFileSync(destBinary, ['--version'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DYLD_LIBRARY_PATH: outLib,
      DYLD_FALLBACK_LIBRARY_PATH: outLib
    }
  })
    .split('\n')[0]
    .trim()

  await fs.writeFile(
    path.join(outRoot, 'manifest.json'),
    JSON.stringify(
      {
        source,
        version,
        binary: 'bin/mpv',
        libs: libs.map((item) => path.basename(item)),
        bundledAt: new Date().toISOString()
      },
      null,
      2
    )
  )
  console.log(`[prepare-mpv-runtime] ${destBinary}`)
  console.log(`[prepare-mpv-runtime] ${libs.length} dylibs -> ${outLib}`)
  console.log(`[prepare-mpv-runtime] ${version}`)
}

// Windows：从 CERU_MPV_WINDOWS_URL 指向的压缩包(.zip/.7z)下载便携 mpv，
// 把 mpv.exe 及其同目录 DLL 平铺进 packaging/mpv/bin。
// Rust 侧 resolve_mpv_binary 会在资源目录里找 mpv/bin/mpv(.exe)。
const windowsMain = async () => {
  const url = String(process.env.CERU_MPV_WINDOWS_URL || '').trim()
  const localPath = String(process.env.CERU_MPV_PATH || '').trim()

  await removeTree(outRoot)
  await fs.mkdir(outBin, { recursive: true })

  // 允许直接给一个已解压的 mpv.exe 路径
  if (localPath && (await exists(localPath))) {
    const srcDir = path.dirname(localPath)
    const entries = await fs.readdir(srcDir)
    for (const name of entries) {
      if (name.toLowerCase() === 'mpv.exe' || name.toLowerCase().endsWith('.dll')) {
        await fs.copyFile(path.join(srcDir, name), path.join(outBin, name))
      }
    }
  } else if (url) {
    const tmpDir = path.join(outRoot, '.download')
    await fs.mkdir(tmpDir, { recursive: true })
    const isSevenZip = url.toLowerCase().endsWith('.7z')
    const archive = path.join(tmpDir, isSevenZip ? 'mpv.7z' : 'mpv.zip')
    console.log(`[prepare-mpv-runtime] 下载 Windows mpv: ${url}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`下载 mpv 失败: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(archive, buf)
    const extractDir = path.join(tmpDir, 'extract')
    await fs.mkdir(extractDir, { recursive: true })
    if (isSevenZip) {
      execFileSync('7z', ['x', '-y', `-o${extractDir}`, archive], { stdio: 'inherit' })
    } else {
      // Windows: 用 PowerShell 解 zip；Git bash 的 GNU tar 会把 `C:` 当远程主机而失败。
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -Path '${archive}' -DestinationPath '${extractDir}' -Force`
        ],
        { stdio: 'inherit' }
      )
    }
    // 递归找 mpv.exe，取它所在目录的所有 exe/dll
    const findMpvDir = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          const found = await findMpvDir(full)
          if (found) return found
        } else if (entry.name.toLowerCase() === 'mpv.exe') {
          return dir
        }
      }
      return ''
    }
    const mpvDir = await findMpvDir(extractDir)
    if (!mpvDir) throw new Error('压缩包里没找到 mpv.exe')
    const files = await fs.readdir(mpvDir)
    for (const name of files) {
      const lower = name.toLowerCase()
      if (lower === 'mpv.exe' || lower.endsWith('.dll')) {
        await fs.copyFile(path.join(mpvDir, name), path.join(outBin, name))
      }
    }
    await removeTree(tmpDir)
  } else {
    throw new Error(
      'Windows 需要通过 GitHub Secret CERU_MPV_WINDOWS_URL 提供便携 mpv 压缩包(.zip/.7z)，或本地设 CERU_MPV_PATH 指向 mpv.exe。'
    )
  }

  const destBinary = path.join(outBin, 'mpv.exe')
  if (!(await exists(destBinary))) {
    throw new Error('复制后仍未找到 mpv.exe。')
  }
  const dllCount = (await fs.readdir(outBin)).filter((n) => n.toLowerCase().endsWith('.dll')).length
  await fs.writeFile(
    path.join(outRoot, 'manifest.json'),
    JSON.stringify(
      {
        source: url || localPath,
        platform: 'win32',
        binary: 'bin/mpv.exe',
        dllCount,
        bundledAt: new Date().toISOString()
      },
      null,
      2
    )
  )
  console.log(`[prepare-mpv-runtime] ${destBinary}`)
  console.log(`[prepare-mpv-runtime] ${dllCount} 个 DLL -> ${outBin}`)
}

const run = platform === 'win32' ? windowsMain : macMain

run().catch((error) => {
  console.error('[prepare-mpv-runtime]', error instanceof Error ? error.message : error)
  process.exit(1)
})
