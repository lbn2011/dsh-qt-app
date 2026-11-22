// Public surface of the syntax-highlighting module.
export {
  clearHighlightCache,
  detectLanguage,
  highlight,
  highlightSync,
  Highlighter,
  supportedLanguages,
} from './highlighter.js'

export {
  DEFAULT_MAX_HIGHLIGHT_CHARS,
  PLAINTEXT_LANGUAGE,
} from './types.js'

export type {
  HighlightEngine,
  HighlightOptions,
  HighlightResult,
  HighlightScheme,
  HighlightSkipReason,
  HighlightToken,
  HighlightTokenType,
} from './types.js'

export {
  classifyWord,
  isKnownLanguage,
  LANGUAGE_IDS,
  LANGUAGES,
  resolveLanguage,
} from './languages.js'
export type { LanguageSpec, StringRule } from './languages.js'

export { colourFor, DARK_PALETTE, LIGHT_PALETTE, paletteFor } from './themes.js'
export type { HighlightPalette } from './themes.js'

export { escapeHighlightText, plainMarkup, shikiHtmlToMarkup, tokensToMarkup } from './markup.js'
export { tokenize } from './tokenizer.js'

export {
  highlightWithShiki,
  probeShiki,
  resetShikiProbe,
  shikiAvailable,
  shikiThemeFor,
} from './shiki-loader.js'
export type { ShikiProbe } from './shiki-loader.js'
