// types.ts — the contract for syntax highlighting.
//
// Phase 2d (t13) renders code blocks with colour. Decision D1 fixes the shape of
// this module: the highlighter is pure TypeScript, it never lives in the N-API
// addon, and Shiki is an *optional* lazily-imported backend behind a size cap.
// The built-in tokenizer is therefore the default engine and the fallback.
//
// The output is deliberately markup rather than a token tree at the boundary:
// CodeBlock.qml only needs a string it can hand to a rich-text item.

/** Token classes the built-in tokenizer can emit. */
export type HighlightTokenType =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  | 'type'
  | 'operator'
  | 'punctuation'
  | 'variable'
  | 'property'
  | 'tag'
  | 'attribute'
  | 'literal'

/** One coloured run of source text. */
export interface HighlightToken {
  type: HighlightTokenType
  /** Source text, unescaped. */
  value: string
}

/** Colour scheme name; mirrors the theme system's `appearance`. */
export type HighlightScheme = 'dark' | 'light'

/** Backend that produced a result. */
export type HighlightEngine = 'builtin' | 'shiki' | 'none'

/** Why a block was not highlighted. */
export type HighlightSkipReason = 'empty' | 'too-large' | 'plaintext'

/** Result of one highlight call. */
export interface HighlightResult {
  /** Rich-text markup (QML-safe) ready to be rendered. */
  html: string
  /** Escaped source with no colour; always valid markup. */
  plainHtml: string
  /** Language actually used, after alias resolution and detection. */
  language: string
  /** Engine that produced `html`. */
  engine: HighlightEngine
  /** True when `html` carries at least one coloured run. */
  highlighted: boolean
  /** Set when the block was rendered without colour. */
  skipReason?: HighlightSkipReason
  /** Tokens, when the built-in engine ran (useful for tests and export). */
  tokens?: HighlightToken[]
}

/** Options accepted by `highlight()`. */
export interface HighlightOptions {
  /**
   * Blocks longer than this are rendered as plain text (decision D1).
   * Defaults to `DEFAULT_MAX_HIGHLIGHT_CHARS`.
   */
  maxHighlightChars?: number
  /** Colour scheme; defaults to 'dark'. */
  scheme?: HighlightScheme
  /**
   * Force an engine. `auto` (default) uses Shiki when it can be imported and the
   * block is within the cap, and the built-in tokenizer otherwise.
   */
  engine?: 'auto' | 'builtin'
  /** Language hint from the fence info string; may be empty or unknown. */
  language?: string
}

/** Default cap: 20 000 characters, matching decision D1. */
export const DEFAULT_MAX_HIGHLIGHT_CHARS = 20_000

/** Language id used when nothing better is known. */
export const PLAINTEXT_LANGUAGE = 'plaintext'
