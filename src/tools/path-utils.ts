import { resolve, dirname } from 'path'
import { realpath } from 'node:fs/promises'
import { realpathSync } from 'node:fs'

export function getHome(): string {
  const home = process.env.HOME
  if (!home) {
    throw new Error('HOME environment variable is not set')
  }
  return home
}

export function resolveAllowedDirs(dirs: readonly string[]): readonly string[] {
  const home = getHome()
  return dirs.map((d) => {
    const resolved = resolve(d.replace('$HOME', home))
    try {
      return realpathSync(resolved)
    } catch {
      return resolved
    }
  })
}

export function expandHome(rawPath: string): string {
  const home = getHome()
  if (rawPath === '~' || rawPath === '$HOME') return home
  if (rawPath.startsWith('~/')) return home + rawPath.slice(1)
  if (rawPath.startsWith('$HOME/')) return home + rawPath.slice(5)
  return rawPath
}

function checkPrefix(
  resolved: string,
  allowedDirs: readonly string[]
): boolean {
  return allowedDirs.some(
    (dir) => resolved === dir || resolved.startsWith(dir + '/')
  )
}

export async function isPathAllowed(
  target: string,
  allowedDirs: readonly string[]
): Promise<boolean> {
  const resolved = resolve(target)

  try {
    const real = await realpath(resolved)
    return checkPrefix(real, allowedDirs)
  } catch {
    // File doesn't exist yet (e.g. write_file) — walk up to find existing ancestor
    let current = dirname(resolved)
    while (current !== dirname(current)) {
      try {
        const realAncestor = await realpath(current)
        return checkPrefix(realAncestor, allowedDirs)
      } catch {
        current = dirname(current)
      }
    }
    // No existing ancestor found — rely on resolved path check
    return checkPrefix(resolved, allowedDirs)
  }
}

export function isPathAllowedSync(
  target: string,
  allowedDirs: readonly string[]
): boolean {
  const resolved = resolve(target)
  return checkPrefix(resolved, allowedDirs)
}
