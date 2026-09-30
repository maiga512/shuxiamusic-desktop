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

const main = async () => {
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

main().catch((error) => {
  console.error('[prepare-mpv-runtime]', error instanceof Error ? error.message : error)
  process.exit(1)
})
