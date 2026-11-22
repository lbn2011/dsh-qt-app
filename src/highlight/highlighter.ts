// highlighter.ts — the façade the renderer and the Cordis service call.
//
// Order of business for one code block:
//   1. empty input                      → nothing to do, `engine: 'none'`
//   2. unknown / plaintext language     → escaped plain text, no colouring
//   3. longer than maxHighlightChars    → escaped plain text (decision D1: a huge
//                                         block is never tokenized, so a pasted log
//                                         cannot stall the UI thread)
//   4. Shiki available and requested    → Shiki, converted to QML-safe markup
//   5. otherwise                        → the built-in tokenizer
//
// The result always carries a `html` string that is safe to drop into a Qt rich
// text item, plus `plainHtml` (the same text with no colour) so a caller can
// switch off highlighting without re-highlighting.
import {
  DEFAULT_MAX_HIGHLIGHT_CHARS,
  PLAINTEXT_LANGUAGE,
} from './types.js'
import type {
  HighlightEngine,
  HighlightOptions,
  HighlightResult,
  HighlightScheme,
  HighlightToken,
} from './types.js'
import { isKnownLanguage, LANGUAGES, resolveLanguage } from './languages.js'
import type { LanguageSpec } from './languages.js'
import { plainMarkup, shikiHtmlToMarkup, tokensToMarkup } from './markup.js'
import { highlightWithShiki, probeShiki } from './shiki-loader.js'
import { tokenize } from './tokenizer.js'

/** Simple bounded cache so re-rendering the same block does not re-tokenize it. */
interface CacheEntry {
  html: string
  plainHtml: string
  engine: HighlightEngine
  highlighted: boolean
}

const CACHE_LIMIT = 64
const cache = new Map<string, CacheEntry>()

function cacheKey(code: string, language: string, scheme: HighlightScheme, max: number): string {
  return `${scheme}\u0000${max}\u0000${language}\u0000${code}`
}

function rememberInCache(key: string, entry: CacheEntry): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done)
      cache.delete(oldest.value)
  }
  cache.set(key, entry)
}

/** Clear the highlight cache (tests, and theme changes that alter palettes). */
export function clearHighlightCache(): void {
  cache.clear()
}

/**
 * Guess the language of a code block from its own text.
 *
 * Deliberately crude: a handful of unambiguous markers, first match wins. Anything
 * ambiguous stays `plaintext` — colouring Python as JavaScript looks worse than
 * no colour at all.
 */
export function detectLanguage(code: string): string {
  const sample = code.slice(0, 4000)

  if (/^\s*#!/m.test(sample) && /(?:^|\n)#!.*\b(?:ba|z|k)?sh\b/.test(sample))
    return 'bash'
  if (/^\s*(?:def|class)\s+\w+.*:\s*$/m.test(sample) && /(?:^|\n)\s*(?:import|from)\s+\w+/.test(sample))
    return 'python'
  if (/(?:^|\n)\s*(?:def|async def)\s+\w+\s*\(/.test(sample))
    return 'python'
  if (/(?:^|\n)\s*from\s+[\w.]+\s+import\s+/.test(sample))
    return 'python'
  if (/(?:^|\n)\s*(?:export\s+)?(?:interface|type)\s+\w+\s*[=:{]/.test(sample))
    return 'typescript'
  if (/(?:^|\n)\s*(?:const|let|var)\s+\w+\s*:\s*[A-Za-z_$]/.test(sample))
    return 'typescript'
  if (/console\.(?:log|error|warn|debug|info)\s*\(|require\s*\(|=>/.test(sample))
    return 'javascript'
  if (/(?:^|\n)\s*(?:function|class|const|let|var|import|export)\b/.test(sample))
    return 'javascript'
  if (/(?:^|\n)\s*\{[\s\S]*"[\w-]+"\s*:/.test(sample))
    return 'json'
  if (/(?:^|\n)\s*(?:echo|cd|export|sudo|apt(?:-get)?|npm|pnpm|git|curl|mkdir)\s/.test(sample))
    return 'bash'
  return PLAINTEXT_LANGUAGE
}

/** Everything the highlighter needs for one call, defaults filled in. */
interface ResolvedOptions {
  language: string
  scheme: HighlightScheme
  maxHighlightChars: number
  allowShiki: boolean
}

function resolveOptions(code: string, language: string | undefined, options: HighlightOptions | undefined): ResolvedOptions {
  const declared = (options?.language ?? language ?? '').trim()
  const resolved = declared === ''
    ? detectLanguage(code)
    : resolveLanguage(declared) ?? declared.toLowerCase()
  const max = options?.maxHighlightChars
  return {
    language: resolved === '' ? PLAINTEXT_LANGUAGE : resolved,
    scheme: options?.scheme === 'light' ? 'light' : 'dark',
    maxHighlightChars: typeof max === 'number' && max > 0 ? Math.floor(max) : DEFAULT_MAX_HIGHLIGHT_CHARS,
    allowShiki: options?.engine !== 'builtin',
  }
}

function result(
  html: string,
  plainHtml: string,
  language: string,
  engine: HighlightEngine,
  highlighted: boolean,
  tokens?: HighlightToken[],
  skipReason?: HighlightResult['skipReason'],
): HighlightResult {
  const out: HighlightResult = { html, plainHtml, language, engine, highlighted }
  if (tokens !== undefined)
    out.tokens = tokens
  if (skipReason !== undefined)
    out.skipReason = skipReason
  return out
}

/**
 * Highlight one code block.
 *
 * `async` because Shiki is loaded lazily; when Shiki is absent (the shipped
 * default) the await resolves immediately.
 */
export async function highlight(
  code: string,
  language?: string,
  options?: HighlightOptions,
): Promise<HighlightResult> {
  if (typeof code !== 'string')
    return result('', '', PLAINTEXT_LANGUAGE, 'none', false, undefined, 'empty')
  if (code === '')
    return result('', '', resolveOptions(code, language, options).language, 'none', false, undefined, 'empty')

  const resolved = resolveOptions(code, language, options)
  const plainHtml = plainMarkup(code)

  // A block over the cap is never tokenized (D1).
  if (code.length > resolved.maxHighlightChars) {
    return result(plainHtml, plainHtml, resolved.language, 'none', false, undefined, 'too-large')
  }

  if (resolved.language === PLAINTEXT_LANGUAGE || !isKnownLanguage(resolved.language)) {
    return result(plainHtml, plainHtml, resolved.language, 'none', false, undefined, 'plaintext')
  }

  const key = cacheKey(code, resolved.language, resolved.scheme, resolved.maxHighlightChars)
  const cached = cache.get(key)
  if (cached !== undefined) {
    return result(cached.html, cached.plainHtml, resolved.language, cached.engine, cached.highlighted)
  }

  if (resolved.allowShiki) {
    const probe = await probeShiki()
    if (probe.available) {
      const shikiHtml = await highlightWithShiki(code, resolved.language, resolved.scheme)
      if (shikiHtml !== null) {
        const html = shikiHtmlToMarkup(shikiHtml)
        rememberInCache(key, { html, plainHtml, engine: 'shiki', highlighted: true })
        return result(html, plainHtml, resolved.language, 'shiki', true)
      }
    }
  }

  const spec: LanguageSpec | null = LANGUAGES[resolved.language] ?? null
  if (spec === null) {
    return result(plainHtml, plainHtml, resolved.language, 'none', false, undefined, 'plaintext')
  }
  const tokens = tokenize(code, spec)
  const html = tokensToMarkup(tokens, resolved.scheme)
  rememberInCache(key, { html, plainHtml, engine: 'builtin', highlighted: true })
  return result(html, plainHtml, resolved.language, 'builtin', true, tokens)
}

/** Synchronous variant, always using the built-in tokenizer. */
export function highlightSync(
  code: string,
  language?: string,
  options?: HighlightOptions,
): HighlightResult {
  if (typeof code !== 'string' || code === '')
    return result('', '', PLAINTEXT_LANGUAGE, 'none', false, undefined, 'empty')

  const resolved = resolveOptions(code, language, options)
  const plainHtml = plainMarkup(code)

  if (code.length > resolved.maxHighlightChars)
    return result(plainHtml, plainHtml, resolved.language, 'none', false, undefined, 'too-large')

  const spec: LanguageSpec | null = LANGUAGES[resolved.language] ?? null
  if (spec === null || resolved.language === PLAINTEXT_LANGUAGE)
    return result(plainHtml, plainHtml, resolved.language, 'none', false, undefined, 'plaintext')

  const key = cacheKey(code, resolved.language, resolved.scheme, resolved.maxHighlightChars)
  const cached = cache.get(key)
  if (cached !== undefined && cached.engine === 'builtin')
    return result(cached.html, cached.plainHtml, resolved.language, 'builtin', cached.highlighted)

  const tokens = tokenize(code, spec)
  const html = tokensToMarkup(tokens, resolved.scheme)
  rememberInCache(key, { html, plainHtml, engine: 'builtin', highlighted: true })
  return result(html, plainHtml, resolved.language, 'builtin', true, tokens)
}

/** Languages the built-in tokenizer knows. */
export function supportedLanguages(): string[] {
  return ['javascript', 'typescript', 'python', 'bash', 'json', PLAINTEXT_LANGUAGE]
}

/** One object-oriented handle, for callers that prefer a service shape. */
export class Highlighter {
  private readonly options_: HighlightOptions

  constructor(options: HighlightOptions = {}) {
    this.options_ = options
  }

  highlight(code: string, language?: string, options?: HighlightOptions): Promise<HighlightResult> {
    return highlight(code, language, { ...this.options_, ...options })
  }

  highlightSync(code: string, language?: string, options?: HighlightOptions): HighlightResult {
    return highlightSync(code, language, { ...this.options_, ...options })
  }

  detectLanguage(code: string): string {
    return detectLanguage(code)
  }

  supportedLanguages(): string[] {
    return supportedLanguages()
  }

  clearCache(): void {
    clearHighlightCache()
  }
}
