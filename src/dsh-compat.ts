/**
 * Small helpers shared by the plugin entry point.
 *
 * dsh 0.2.1 and newer expose plugin settings as the plugin's own Config: fields
 * marked `.volatile()` update the running instance without a reload, and the
 * `settings` service only projects that Config into generated forms. The
 * `settings.yaml` section API that 0.1.5 used was removed upstream, so this
 * module no longer carries a shim for it.
 */

/**
 * JSON-compatible deep equality. Mirrors the `@deepseek-ai/dsh-util-values`
 * implementation exactly so the plugin needs no extra dependency and behaves
 * identically on every supported engine.
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
