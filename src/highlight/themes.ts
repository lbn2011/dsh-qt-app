// themes.ts — token colours for the two schemes.
//
// The palette is the same one the QML Theme uses (t16), so a code block sits in
// the message bubble instead of looking like a foreign widget: comments take the
// muted text colour, keywords the accent, strings the success colour, numbers the
// warning colour. Values are plain hex so the highlighter needs no theme service.
import type { HighlightScheme, HighlightTokenType } from './types.js'

/** token type → #rrggbb */
export type HighlightPalette = Record<HighlightTokenType, string>

/** Dark scheme: matches qml/components/Theme.qml (dark built-in). */
export const DARK_PALETTE: HighlightPalette = {
  plain: '#e6e6e6',
  keyword: '#6ba1ff',
  string: '#3fb950',
  comment: '#8a8f98',
  number: '#d29922',
  function: '#4c8dff',
  type: '#c9a3ff',
  operator: '#e6e6e6',
  punctuation: '#a8b1bd',
  variable: '#e6e6e6',
  property: '#6ba1ff',
  tag: '#e5534b',
  attribute: '#d29922',
  literal: '#d29922',
}

/** Light scheme: matches the light built-in theme, darker for AA contrast. */
export const LIGHT_PALETTE: HighlightPalette = {
  plain: '#1b1c1f',
  keyword: '#2559ad',
  string: '#1f7f36',
  comment: '#5c626d',
  number: '#8a5d00',
  function: '#2f6fd0',
  type: '#7a3fb5',
  operator: '#1b1c1f',
  punctuation: '#4a4f58',
  variable: '#1b1c1f',
  property: '#2559ad',
  tag: '#c93c34',
  attribute: '#8a5d00',
  literal: '#8a5d00',
}

/** Palette for a scheme. */
export function paletteFor(scheme: HighlightScheme): HighlightPalette {
  return scheme === 'light' ? LIGHT_PALETTE : DARK_PALETTE
}

/** Colour for one token type, falling back to the scheme's body colour. */
export function colourFor(scheme: HighlightScheme, type: HighlightTokenType): string {
  const palette = paletteFor(scheme)
  return palette[type] ?? (scheme === 'light' ? '#1b1c1f' : '#e6e6e6')
}
