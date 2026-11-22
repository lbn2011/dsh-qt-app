/**
 * N-API bridge loader.
 *
 * The Qt host talks to Node through the `dsh-qt-napi` addon, which lives in its
 * own repository and ships prebuilt binaries. This module owns *discovery*: it
 * looks for a binding in a deterministic order, validates its shape, and falls
 * back to a degraded but functional renderer so the Cordis plugin always loads
 * (a missing addon must never take the DSH process down).
 *
 * Discovery order (first hit wins):
 *   1. explicit `explicitPath` option
 *   2. `DSH_QT_NAPI_PATH` environment variable
 *   3. `<packageName>/prebuild/<platform>-<arch>/<binaryName>.node`
 *   4. `<packageName>` package entry (a JS wrapper that re-exports the addon)
 *   5. `<searchRoot>/<packageName>/prebuild/<platform>-<arch>/<binaryName>.node`
 *   6. `<searchRoot>/<packageName>/build/Release/<binaryName>.node`
 *   7. `<searchRoot>/<packageName>/build/<binaryName>.node`
 *
 * Every failure is collected in `NapiLoadResult.attempted`/`error` so the caller
 * can log a precise diagnostic instead of a bare MODULE_NOT_FOUND.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { NAPI_BINARY_NAME, NAPI_PACKAGE_NAME, NAPI_PATH_ENV } from '../constants.js'
import type { CodeBlockOptions, MarkdownOptions } from '../types.js'

/**
 * Shape the Qt host expects from the addon.
 *
 * Both methods may be synchronous (raw C++ binding) or asynchronous (wrapper
 * around a worker); callers always `await` the result.
 */
export interface NapiBridge {
  renderMarkdown(text: string, options?: MarkdownOptions): Promise<string> | string
  highlightCode(code: string, language?: string, options?: CodeBlockOptions): Promise<string> | string
  /** Optional build identifier reported by the addon. */
  version?: string
}

/** Where the loaded bridge came from. */
export type NapiSource =
  | 'explicit'
  | 'env'
  | 'package-prebuild'
  | 'package-main'
  | 'local-build'
  | 'fallback'

/** Options for {@link loadNapiModule}. */
export interface NapiLoadOptions {
  /** Absolute path (or package specifier) to load first. */
  explicitPath?: string
  /** Environment to read `DSH_QT_NAPI_PATH` from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** npm package name of the bridge; defaults to `dsh-qt-napi`. */
  packageName?: string
  /** Addon file name without extension; defaults to `qt-bridge`. */
  binaryName?: string
  /** Platform override (tests); defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Architecture override (tests); defaults to `process.arch`. */
  arch?: string
  /** Roots searched for a sibling `dsh-qt-napi` checkout; defaults to cwd and its parent. */
  searchRoots?: string[]
  /** Injectable require (tests); defaults to `createRequire(import.meta.url)`. */
  requireFn?: (specifier: string) => unknown
}

/** Outcome of {@link loadNapiModule}. */
export interface NapiLoadResult {
  /** Usable bridge: the real addon, or the degraded fallback. */
  bridge: NapiBridge
  /** True when {@link bridge} is the fallback renderer. */
  degraded: boolean
  /** Which discovery step produced the bridge. */
  source: NapiSource
  /** Every specifier/path that was tried, in order. */
  attempted: string[]
  /** Last error that made a candidate unusable, if any. */
  error?: Error
}

const defaultRequire = createRequire(import.meta.url)

/** `linux-x64`, `win32-arm64`, `darwin-arm64`, … — the prebuild directory layout. */
export function prebuildTriple(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Structural check: does `value` look like a usable bridge? */
export function isNapiBridge(value: unknown): value is NapiBridge {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['renderMarkdown'] === 'function' && typeof candidate['highlightCode'] === 'function'
}

/** Minimal HTML escaping used by the degraded renderer. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Degraded renderer used when no addon is available.
 *
 * It never throws and never interprets Markdown: text is escaped and wrapped in
 * `<pre>`, which keeps the Qt UI usable (readable, safe) while the addon is
 * missing or ABI-incompatible.
 */
export function createFallbackBridge(reason: string): NapiBridge {
  return {
    version: `fallback:${reason}`,
    renderMarkdown(text: string): string {
      return `<pre class="dsh-qt-fallback">${escapeHtml(text)}</pre>`
    },
    highlightCode(code: string, language?: string): string {
      const languageClass = escapeHtml(language && language.length > 0 ? language : 'text')
      return `<pre class="dsh-qt-fallback"><code class="language-${languageClass}">${escapeHtml(code)}</code></pre>`
    },
  }
}

/** A discovery candidate plus the source label reported when it loads. */
interface NapiCandidate {
  specifier: string
  source: NapiSource
}

/** Ordered, de-duplicated candidates with their source labels. */
function discoverLabeled(options: NapiLoadOptions = {}): NapiCandidate[] {
  const env = options.env ?? process.env
  const packageName = options.packageName ?? NAPI_PACKAGE_NAME
  const binaryName = options.binaryName ?? NAPI_BINARY_NAME
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const triple = prebuildTriple(platform, arch)
  const roots = options.searchRoots ?? [process.cwd(), join(process.cwd(), '..')]

  const candidates: NapiCandidate[] = []

  if (options.explicitPath) candidates.push({ specifier: options.explicitPath, source: 'explicit' })

  const fromEnv = env[NAPI_PATH_ENV]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    candidates.push({ specifier: fromEnv, source: 'env' })
  }

  candidates.push({ specifier: `${packageName}/prebuild/${triple}/${binaryName}.node`, source: 'package-prebuild' })
  candidates.push({ specifier: packageName, source: 'package-main' })

  for (const root of roots) {
    candidates.push({
      specifier: join(root, packageName, 'prebuild', triple, `${binaryName}.node`),
      source: 'local-build',
    })
    candidates.push({
      specifier: join(root, packageName, 'build', 'Release', `${binaryName}.node`),
      source: 'local-build',
    })
    candidates.push({ specifier: join(root, packageName, 'build', `${binaryName}.node`), source: 'local-build' })
  }

  // Preserve order but drop duplicates (an explicit path may equal a discovered one).
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    if (seen.has(candidate.specifier)) return false
    seen.add(candidate.specifier)
    return true
  })
}

/** Ordered list of load specifiers tried by {@link loadNapiModule}. */
export function discoverCandidates(options: NapiLoadOptions = {}): string[] {
  return discoverLabeled(options).map((candidate) => candidate.specifier)
}

/**
 * Discover and load the N-API bridge.
 *
 * Never throws: an unreachable/incompatible addon yields the degraded fallback
 * bridge plus a diagnostic describing every attempt.
 */
export function loadNapiModule(options: NapiLoadOptions = {}): NapiLoadResult {
  const requireFn = options.requireFn ?? defaultRequire
  const candidates = discoverLabeled(options)
  const attempted: string[] = []
  let lastError: Error | undefined

  for (const candidate of candidates) {
    attempted.push(candidate.specifier)

    // Skip absolute paths that obviously do not exist, so we do not rely on the
    // require() error message to distinguish "absent" from "broken".
    const looksLikePath = candidate.specifier.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate.specifier)
    if (looksLikePath && !existsSync(candidate.specifier)) {
      lastError = new Error(`binding not found at ${candidate.specifier}`)
      continue
    }

    let loaded: unknown
    try {
      loaded = requireFn(candidate.specifier)
    } catch (error) {
      lastError = asError(error)
      continue
    }

    if (!isNapiBridge(loaded)) {
      lastError = new Error(
        `${candidate.specifier} does not expose renderMarkdown()/highlightCode(); got ${typeof loaded}`,
      )
      continue
    }

    return { bridge: loaded, degraded: false, source: candidate.source, attempted }
  }

  const reason = lastError?.message ?? 'no candidate resolved'
  const result: NapiLoadResult = {
    bridge: createFallbackBridge(reason),
    degraded: true,
    source: 'fallback',
    attempted,
  }
  if (lastError) result.error = lastError
  return result
}
