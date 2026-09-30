const normalizePluginToken = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')

const normalizeAuthorToken = (author: unknown) => {
  const token = normalizePluginToken(author)
  if (!token || token === '_' || token === 'unknown' || token === '未知') return '_'
  return token
}

export const musicSourceIdentityKey = (name: unknown, author: unknown) =>
  `music-source:${normalizePluginToken(name)}:${normalizeAuthorToken(author)}`

export const capabilityIdentityKey = (role: unknown) => `capability:${normalizePluginToken(role)}`

export const sameMusicSourcePlugin = (
  local: {identityKey?: string; name?: string; author?: string; contentHash?: string},
  remote: {identityKey?: string; name?: string; author?: string; contentHash?: string}
) => {
  const remoteKey = String(remote.identityKey || '').trim()
  const localKey = String(local.identityKey || '').trim()
  if (remoteKey && (localKey === remoteKey || musicSourceIdentityKey(local.name, local.author) === remoteKey)) {
    return true
  }
  const localName = normalizePluginToken(local.name)
  const remoteName = normalizePluginToken(remote.name)
  if (!localName || localName !== remoteName) return false
  const localHash = String(local.contentHash || '').trim()
  const remoteHash = String(remote.contentHash || '').trim()
  if (!localHash || !remoteHash || localHash !== remoteHash) return false
  const left = normalizeAuthorToken(local.author)
  const right = normalizeAuthorToken(remote.author)
  return left === right || left === '_' || right === '_'
}

export const canonicalizeCapabilityConfig = (
  role: string,
  config: Record<string, unknown> | null | undefined
) => {
  const source = config && typeof config === 'object' ? config : {}
  if (role === 'feiniu') {
    const rawHost = String(source.host || source.inputHost || source.serverUrl || '').trim()
    let host = rawHost
    let port = Number(source.port) > 0 ? Math.floor(Number(source.port)) : 0
    let useHttps = source.useHttps === true
    try {
      const parsed = new URL(/^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`)
      host = parsed.hostname
      if (!port && parsed.port) port = Number(parsed.port)
      if (/^https:/i.test(rawHost) || source.useHttps === true) useHttps = true
      if (source.useHttps === false) useHttps = false
    } catch {
      const [authority] = rawHost.replace(/^https?:\/\//i, '').split('/')
      const [hostname, portText] = authority.split(':')
      host = hostname || rawHost
      if (!port && portText) port = Number(portText) || 0
      if (/^https:\/\//i.test(rawHost)) useHttps = true
    }
    return {
      host,
      port,
      useHttps,
      username: String(source.username || '').trim(),
      password: String(source.password || ''),
      accessCode: String(source.accessCode || '')
    }
  }
  if (role === 'navidrome') {
    return {
      serverUrl: String(source.serverUrl || source.host || '').trim(),
      username: String(source.username || '').trim(),
      password: String(source.password || '')
    }
  }
  if (role === 'nas-sync') {
    const rawHost = String(source.host || source.inputHost || source.serverUrl || '').trim()
    let host = rawHost.replace(/^https?:\/\//i, '').split('/')[0]
    let port = Number(source.port) > 0 ? Math.floor(Number(source.port)) : 0
    let useHttps = source.useHttps === true
    if (!port && host.includes(':')) {
      const [hostname, portText] = host.split(':')
      host = hostname
      port = Number(portText) || 0
    }
    if (/^https:\/\//i.test(rawHost)) useHttps = true
    if (source.useHttps === false) useHttps = false
    return {
      host,
      port,
      useHttps,
      pairCode: String(source.pairCode || '')
    }
  }
  return {}
}

export const pluginFingerprint = (item: {
  identityKey: string
  kind: string
  enabled?: boolean
  disabledSources?: string[]
  contentHash?: string
  config?: Record<string, unknown>
  role?: string
  position?: number
}) =>
  JSON.stringify({
    identityKey: item.identityKey,
    kind: item.kind,
    enabled: item.enabled !== false,
    disabledSources: [...(item.disabledSources || [])].sort(),
    contentHash: item.contentHash || '',
    role: item.role || '',
    position: Number.isFinite(item.position) ? item.position : 0,
    config: item.kind === 'capability' ? canonicalizeCapabilityConfig(item.role || '', item.config) : {}
  })

export const feiniuInputHostFromConfig = (config: Record<string, unknown>) => {
  const host = String(config.host || '').trim()
  const port = Number(config.port)
  if (!host) return ''
  return port > 0 ? `${host}:${port}` : host
}
