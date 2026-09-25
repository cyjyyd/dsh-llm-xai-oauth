/**
 * Shims for the two settings surfaces this plugin runs on.
 *
 * dsh 0.1.5 stores plugin settings in `$DSH_HOME/settings.yaml`, one section
 * per namespace, and a plugin attaches with `settings.installSection`. dsh
 * 0.1.7 removed that: settings live in the profile patch, a plugin reads its
 * own Config, and fields marked `.volatile()` update the running instance
 * without a reload. `installSettingsSection` detects which surface is mounted
 * and only registers on the older one; on 0.1.7 it is a no-op because the
 * caller already reads Config directly.
 */
import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

/** Hooks the 0.1.5 settings service calls back with. */
export interface SettingsSectionHooks<T> {
  /** Receive the thunk returning the currently authoritative value. */
  setSource(current: () => T): void
  /** Re-judge facts derived from the source after a committed change. */
  onChange(): void
}

/**
 * Attach a settings section on a 0.1.5 host. 0.1.7 has no `installSection`
 * (its `settings` service only projects Config into forms), so the call
 * returns and the caller keeps reading the Config it was applied with.
 */
export function installSettingsSection<T>(
  ctx: Context,
  ns: string,
  schema: z,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  const host = ctx as {
    inject?: (services: readonly string[], callback: (injected: unknown) => void) => void
  }
  if (typeof host.inject !== 'function') return
  host.inject(['settings'], (injected) => {
    const holder = injected as { settings?: { installSection?: (...args: unknown[]) => void } }
    const provider = (holder.settings ?? injected) as {
      installSection?: (...args: unknown[]) => void
    }
    if (typeof provider.installSection !== 'function') return
    provider.installSection(ctx, ns, schema, entry, hooks)
  })
}

/**
 * JSON-compatible deep equality. 0.1.2-rc.1 stopped re-exporting
 * `deepEqualJson`; this mirrors the `@deepseek-ai/dsh-util-values`
 * implementation exactly so the plugin needs no extra dependency and behaves
 * identically on both engines.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => deepEqualJson(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => key in right && deepEqualJson(left[key], right[key]))
}
