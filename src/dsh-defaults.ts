/**
 * Persist SuperGrok as the harness default model after a successful login.
 *
 * Uses `ctx.agentDefaultModel.saveSelection` when the service is mounted
 * (writes `$DSH_HOME/settings.yaml` through the settings seam). Falls back to
 * a direct YAML edit of that file when the plugin is running as a CLI.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

export const DEFAULT_DSH_PROVIDER = 'xai'
export const DEFAULT_DSH_MODEL = 'grok-4.6'
export const DEFAULT_DSH_REASONING_EFFORT = 'high'

export interface DshDefaultModel {
  provider: string
  model: string
  reasoningEffort?: string
}

export function dshHomeDir(): string {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

export function dshSettingsPath(home = dshHomeDir()): string {
  return join(home, 'settings.yaml')
}

export function defaultModelSelection(): DshDefaultModel {
  return {
    provider: DEFAULT_DSH_PROVIDER,
    model: DEFAULT_DSH_MODEL,
    reasoningEffort: DEFAULT_DSH_REASONING_EFFORT,
  }
}

function quoteYaml(value: string): string {
  return /[:#{}[\],&*!|>'"%@`]|^\s|\s$/u.test(value) ? JSON.stringify(value) : value
}

function renderDefaultModelSection(selection: DshDefaultModel): string {
  const lines = [
    'agent-default-model:',
    `  provider: ${quoteYaml(selection.provider)}`,
    `  model: ${quoteYaml(selection.model)}`,
  ]
  if (selection.reasoningEffort !== undefined) {
    lines.push(`  reasoningEffort: ${quoteYaml(selection.reasoningEffort)}`)
  }
  return `${lines.join('\n')}\n`
}

export function upsertDefaultModelSection(document: string, selection: DshDefaultModel): string {
  const replacement = renderDefaultModelSection(selection).trimEnd()
  const lines = document.split(/\n/u)
  const start = lines.findIndex(line => line === 'agent-default-model:' || line.startsWith('agent-default-model:'))
  if (start === -1) {
    const trimmed = document.replace(/\s+$/u, '')
    if (trimmed.length === 0) return `${replacement}\n`
    return `${trimmed}\n${replacement}\n`
  }
  let end = start + 1
  while (end < lines.length && (lines[end] === '' || /^[ \t]/u.test(lines[end] ?? ''))) end += 1
  const next = [
    ...lines.slice(0, start),
    ...replacement.split('\n').filter(line => line.length > 0),
    ...lines.slice(end),
  ]
  const joined = next.join('\n')
  return joined.endsWith('\n') ? joined : `${joined}\n`
}

/** True when the settings file already carries any `agent-default-model` section. */
export function settingsHasAnyDefaultModel(document: string): boolean {
  const lines = document.split(/\n/u)
  return lines.some(line => line === 'agent-default-model:' || line.startsWith('agent-default-model:'))
}

export function settingsHasDefaultModel(document: string, selection: DshDefaultModel): boolean {
  const lines = document.split(/\n/u)
  const start = lines.findIndex(line => line === 'agent-default-model:' || line.startsWith('agent-default-model:'))
  if (start === -1) return false
  let provider: string | undefined
  let model: string | undefined
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line !== '' && !/^[ \t]/u.test(line)) break
    const providerMatch = /^[ \t]+provider:\s*(.+?)\s*$/u.exec(line)
    if (providerMatch) provider = providerMatch[1]?.replace(/^["']|["']$/gu, '')
    const modelMatch = /^[ \t]+model:\s*(.+?)\s*$/u.exec(line)
    if (modelMatch) model = modelMatch[1]?.replace(/^["']|["']$/gu, '')
  }
  return provider === selection.provider && model === selection.model
}

export async function writeDshDefaultModelFile(
  selection: DshDefaultModel = defaultModelSelection(),
  path = dshSettingsPath(),
): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  let existing = ''
  try {
    existing = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const next = upsertDefaultModelSection(existing, selection)
  await writeFile(path, next, { mode: 0o600 })
  return path
}

export async function applyDshDefaultModel(
  ctx: Context | undefined,
  selection: DshDefaultModel = defaultModelSelection(),
  options: { onlyIfUnset?: boolean } = {},
): Promise<'service' | 'file' | 'unchanged'> {
  const onlyIfUnset = options.onlyIfUnset === true
  const service = ctx?.get('agentDefaultModel')
  const settings = ctx?.get('settings')
  if (service !== undefined && settings !== undefined) {
    const current = service.currentSelection()
    if (current.provider === selection.provider && current.model === selection.model) return 'unchanged'
    if (onlyIfUnset) {
      // A user-owned section (whatever provider it names) means the user
      // already picked a default explicitly; do not flip it back to Grok.
      const doc = (settings as unknown as { document?: unknown }).document
      const hasUserSection = doc !== null && typeof doc === 'object' && !Array.isArray(doc)
        && (doc as Record<string, unknown>)['agent-default-model'] !== undefined
      if (hasUserSection) return 'unchanged'
    }
    await service.saveSelection({
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
    })
    return 'service'
  }
  const path = dshSettingsPath()
  let existing = ''
  try {
    existing = await readFile(path, 'utf8')
  } catch {
    existing = ''
  }
  if (settingsHasDefaultModel(existing, selection)) return 'unchanged'
  if (onlyIfUnset && settingsHasAnyDefaultModel(existing)) return 'unchanged'
  await writeDshDefaultModelFile(selection, path)
  return 'file'
}
