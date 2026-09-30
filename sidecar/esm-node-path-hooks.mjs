import { pathToFileURL } from 'node:url'
import path from 'node:path'

const roots = String(process.env.NODE_PATH || '')
  .split(path.delimiter)
  .map((item) => item.trim())
  .filter(Boolean)

const isBareSpecifier = (specifier) =>
  specifier &&
  !specifier.startsWith('.') &&
  !specifier.startsWith('/') &&
  !specifier.startsWith('node:') &&
  !specifier.startsWith('file:') &&
  !specifier.startsWith('data:') &&
  !path.isAbsolute(specifier)

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (!isBareSpecifier(specifier)) throw error
    for (const root of roots) {
      const parentURL = pathToFileURL(path.join(root, '__ceru_node_path__.mjs')).href
      try {
        return await nextResolve(specifier, { ...context, parentURL })
      } catch {
        // Try the next NODE_PATH root.
      }
    }
    throw error
  }
}
