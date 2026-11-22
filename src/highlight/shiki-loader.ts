// shiki-loader.ts — optional Shiki backend.
//
// Decision D1: Shiki is *lazily* loaded. It is not a dependency of this package —
// when it happens to be installed it is imported on first use, and when it is not
// (the normal case: the app ships without a syntax-highlighting bundle) the import
// fails once, the failure is remembered, and the built-in tokenizer serves every
// request. Nothing here is on the startup path.
//
// The specifier is held in a variable so the TypeScript compiler does not try to
// resolve a module that may legitimately be absent.

/** Minimal surface of the Shiki API this file uses. */
interface ShikiHighlighter {
  codeToHtml(code: string, options: { lang: string; theme: string }): string
}

interface ShikiModule {
  createHighlighter?: (options: { themes: string[]; langs: string[] }) => Promise<unknown>
  codeToHtml?: (code: string, options: { lang: string; theme: string }) => string
  getSingletonHighlighter?: (options: { themes: string[]; langs: string[] }) => Promise<unknown>
}

/** Outcome of the one-time Shiki probe. */
export interface ShikiProbe {
  available: boolean
  /** Why Shiki is unavailable, when it is. */
  reason?: string
  /** Loaded module, when available. */
  module?: ShikiModule
}

let probe: ShikiProbe | null = null
let probePromise: Promise<ShikiProbe> | null = null

const SHIKI_THEME_DARK = 'github-dark'
const SHIKI_THEME_LIGHT = 'github-light'

/** Shiki theme id for a scheme. */
export function shikiThemeFor(scheme: 'dark' | 'light'): string {
  return scheme === 'light' ? SHIKI_THEME_LIGHT : SHIKI_THEME_DARK
}

/**
 * Probe for Shiki once per process.
 *
 * Never throws: a missing or broken Shiki is an expected state, not an error.
 */
export async function probeShiki(): Promise<ShikiProbe> {
  if (probe !== null)
    return probe
  if (probePromise !== null)
    return await probePromise

  probePromise = (async (): Promise<ShikiProbe> => {
    const specifier = 'shiki'
    try {
      const loaded = (await import(specifier)) as ShikiModule
      const usable = typeof loaded.codeToHtml === 'function'
        || typeof loaded.createHighlighter === 'function'
        || typeof loaded.getSingletonHighlighter === 'function'
      probe = usable
        ? { available: true, module: loaded }
        : { available: false, reason: 'shiki is installed but exposes no highlighter API' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      probe = { available: false, reason: `shiki is not installed (${message})` }
    }
    return probe
  })()

  return await probePromise
}

/** Synchronous view of the probe; false until `probeShiki()` has resolved. */
export function shikiAvailable(): boolean {
  return probe?.available === true
}

/** Reset the cached probe (tests only). */
export function resetShikiProbe(): void {
  probe = null
  probePromise = null
}

/**
 * Highlight with Shiki, returning its raw HTML.
 *
 * Returns `null` when Shiki is unavailable or fails for this block, so the caller
 * can fall back to the built-in tokenizer instead of showing nothing.
 */
export async function highlightWithShiki(
  code: string,
  language: string,
  scheme: 'dark' | 'light',
): Promise<string | null> {
  const state = await probeShiki()
  if (!state.available || state.module === undefined)
    return null
  const module = state.module
  const theme = shikiThemeFor(scheme)
  try {
    if (typeof module.codeToHtml === 'function')
      return module.codeToHtml(code, { lang: language, theme })
    const factory = module.getSingletonHighlighter ?? module.createHighlighter
    if (factory === undefined)
      return null
    const instance = (await factory({ themes: [theme], langs: [language] })) as ShikiHighlighter
    if (typeof instance.codeToHtml !== 'function')
      return null
    return instance.codeToHtml(code, { lang: language, theme })
  } catch {
    return null
  }
}
