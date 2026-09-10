/**
 * Dual-stack shims for dsh 0.1.2-rc.1 and 0.1.5-rc.1.
 *
 * 0.1.2-rc.1 removed the free exports `installSettingsSection`,
 * `settingsNamespace` and `deepEqualJson` from @deepseek-ai/dsh-settings:
 * settings section registration moved onto the `settings` service as
 * `SettingsProvider.installSection` (reached via `ctx.inject`, the pattern
 * the harness's own packages use), namespaces are now branded at the type
 * level only, and `deepEqualJson` lives in @deepseek-ai/dsh-util-values.
 * 0.1.5 kept that settings surface and the `LlmAdapter` stream contract this
 * plugin already implements, so the same build runs on either host.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsSectionHooks } from '@deepseek-ai/dsh-settings'
import * as dshSettings from '@deepseek-ai/dsh-settings'
import type z from '@deepseek-ai/schemastery'

/**
 * 0.1.1-rc.2 wraps namespaces via `settingsNamespace()`; 0.1.2 brands them at
 * the type level and takes the plain string at runtime. A cast covers both.
 */
export function settingsNamespace(value: string): SettingsNamespace {
  return value as SettingsNamespace
}

/**
 * Register a settings section: 0.1.2-rc.1 moved the free function onto the
 * `settings` service as `installSection`, callable only once that service is
 * injected (plugins apply before it, so `ctx.inject` must defer — same
 * pattern the harness's own packages use); 0.1.1-rc.2 keeps the free
 * function, which defers internally and is safe at apply time.
 */
export function installSettingsSection<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  const legacy = (dshSettings as {
    installSettingsSection?: (
      ctx: Context,
      ns: SettingsNamespace,
      schema: z<T>,
      entry: T,
      hooks: SettingsSectionHooks<T>,
    ) => void
  }).installSettingsSection
  if (typeof legacy === 'function') {
    legacy(ctx, ns, schema, entry, hooks)
    return
  }
  const host = ctx as {
    inject?: (services: readonly string[], callback: (injected: unknown) => void) => void
  }
  if (typeof host.inject !== 'function') {
    throw new Error('dsh-settings: no legacy installSettingsSection and ctx.inject is unavailable')
  }
  host.inject(['settings'], (injected) => {
    const holder = injected as { settings?: { installSection?: (...args: unknown[]) => void } }
    const provider = (holder.settings ?? injected) as {
      installSection?: (...args: unknown[]) => void
    }
    if (typeof provider?.installSection !== 'function') {
      throw new Error('dsh-settings: settings service has no installSection')
    }
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
