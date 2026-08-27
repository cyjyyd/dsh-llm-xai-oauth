/**
 * Bounded local search for SuperGrok / xAI OAuth tokens.
 *
 * The plugin reuses whatever grok-bridge or the official Grok CLI already
 * wrote. When those two files are missing, walk a small, explicit set of
 * home/config locations instead of scanning the whole machine.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeTokens } from './tokens.js'
import type { OAuthConfig, StoredTokens, TokenSource } from './tokens.js'

export type TokenSourceKind = TokenSource

export interface DiscoveredTokens extends StoredTokens {
  path: string
}

const EXPLICIT_RELATIVE_PATHS = [
  join('.grok-bridge', 'auth.json'),
  join('.grok', 'auth.json'),
  join('.config', 'grok', 'auth.json'),
  join('.config', 'xai', 'auth.json'),
  join('.config', 'grok-cli', 'auth.json'),
  join('.local', 'share', 'grok', 'auth.json'),
  join('.xai', 'auth.json'),
] as const

const DISCOVERY_DIR_NAMES = new Set([
  '.grok-bridge',
  '.grok',
  '.xai',
  'grok',
  'grok-bridge',
  'grok-cli',
  'xai',
])

const AUTH_FILE_NAMES = new Set(['auth.json', 'oauth.json', 'tokens.json', 'credentials.json'])

const MAX_WALK_DEPTH = 2
const MAX_WALK_ENTRIES = 64

export function explicitSearchPaths(home = homedir(), config?: OAuthConfig): string[] {
  const paths = [
    ...config === undefined ? [] : [config.authFile, config.grokCliAuthFile],
    ...EXPLICIT_RELATIVE_PATHS.map(relative => join(home, relative)),
  ]
  return [...new Set(paths)]
}

export function discoveryRoots(home = homedir()): string[] {
  return [
    join(home, '.grok-bridge'),
    join(home, '.grok'),
    join(home, '.xai'),
    join(home, '.config'),
    join(home, '.local', 'share'),
  ]
}

async function readTokensFromFile(path: string, source: TokenSourceKind): Promise<DiscoveredTokens | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
    const tokens = normalizeTokens(raw, source)
    if (tokens === null) return null
    return { ...tokens, source, path }
  } catch {
    return null
  }
}

function sourceForPath(path: string, config?: OAuthConfig): TokenSourceKind {
  if (config !== undefined && path === config.authFile) return 'grok-bridge'
  if (config !== undefined && path === config.grokCliAuthFile) return 'grok-cli'
  if (path.endsWith(`${join('.grok-bridge', 'auth.json')}`)) return 'grok-bridge'
  if (path.includes(`${join('.grok', 'auth.json')}`)) return 'grok-cli'
  return 'discovered'
}

async function walkAuthFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let seen = 0
  while (stack.length > 0) {
    const next = stack.pop()
    if (next === undefined) break
    let entries
    try {
      entries = await readdir(next.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      seen += 1
      if (seen > MAX_WALK_ENTRIES) return found
      const path = join(next.dir, entry.name)
      if (entry.isFile() && AUTH_FILE_NAMES.has(entry.name)) {
        found.push(path)
        continue
      }
      if (!entry.isDirectory() || next.depth >= MAX_WALK_DEPTH) continue
      if (!DISCOVERY_DIR_NAMES.has(entry.name)) continue
      stack.push({ dir: path, depth: next.depth + 1 })
    }
  }
  return found
}

export async function searchLocalTokens(
  config?: OAuthConfig,
  home = homedir(),
): Promise<DiscoveredTokens | null> {
  const visited = new Set<string>()
  for (const path of explicitSearchPaths(home, config)) {
    if (visited.has(path)) continue
    visited.add(path)
    const tokens = await readTokensFromFile(path, sourceForPath(path, config))
    if (tokens !== null) return tokens
  }

  for (const root of discoveryRoots(home)) {
    let info
    try {
      info = await stat(root)
    } catch {
      continue
    }
    if (!info.isDirectory()) continue
    for (const path of await walkAuthFiles(root)) {
      if (visited.has(path)) continue
      visited.add(path)
      const tokens = await readTokensFromFile(path, sourceForPath(path, config))
      if (tokens !== null) return tokens
    }
  }
  return null
}

export function expiresInSeconds(tokens: StoredTokens): number | undefined {
  if (tokens.expiresAt === null) return undefined
  return Math.max(1, Math.ceil((tokens.expiresAt - Date.now()) / 1000))
}
