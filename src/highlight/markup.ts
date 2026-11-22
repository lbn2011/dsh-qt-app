// markup.ts — tokens to rich-text markup.
//
// Qt Quick's Text/TextEdit rich text understands a *subset* of HTML: b, i, u, s,
// a, br, img, and font with color/face/size. It does not reliably honour
// `<span style="color:…">`, and it has no CSS classes, so the highlighter emits
// `<font color="#rrggbb">` runs — the one colouring primitive that works in both
// Text (StyledText) and TextEdit (RichText).
//
// Every character of source text is escaped on the way through; the only tags in
// the output are the ones this file writes.
import type { HighlightScheme, HighlightToken } from './types.js'
import { colourFor } from './themes.js'

/** Escape text for rich-text markup. */
export function escapeHighlightText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Escape text and keep line breaks as literal newlines (rich text keeps them). */
export function plainMarkup(code: string): string {
  return escapeHighlightText(code)
}

/**
 * Render tokens as QML-safe rich text.
 *
 * `plain` runs are emitted without a tag: they carry the body colour already, and
 * skipping the wrapper keeps the markup small.
 */
export function tokensToMarkup(tokens: HighlightToken[], scheme: HighlightScheme): string {
  let out = ''
  for (const token of tokens) {
    const escaped = escapeHighlightText(token.value)
    if (token.type === 'plain' || token.value.trim() === '') {
      out += escaped
      continue
    }
    out += `<font color="${colourFor(scheme, token.type)}">${escaped}</font>`
  }
  return out
}

/**
 * Convert Shiki's HTML into QML-safe markup.
 *
 * Shiki emits `<pre class="shiki" style="…"><code><span style="color:#abc">…</span>`.
 * This keeps the text and the colours, drops the wrapper elements, and rewrites
 * `span style="color:…"` as `<font color="…">`. Spans without a colour are dropped
 * together with their closing tag (tracked on a stack, so a colour never leaks
 * past the span that introduced it). Any tag this function does not know is
 * dropped, so nothing Shiki adds can break the QML text item.
 */
export function shikiHtmlToMarkup(html: string): string {
  const KEEP = new Set(['b', 'i', 'u', 's', 'br', 'font'])
  let out = ''
  // One entry per open <span>: true when it was converted to <font>.
  const spanStack: boolean[] = []
  let i = 0
  const n = html.length

  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, lt)

    const gt = html.indexOf('>', lt)
    if (gt === -1) {
      // A stray '<' with no closing bracket is literal text.
      out += html.slice(lt)
      break
    }
    const tag = html.slice(lt, gt + 1)
    i = gt + 1

    const nameMatch = /^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)
    const name = nameMatch?.[1]?.toLowerCase() ?? ''
    const isClosing = /^<\//.test(tag)

    if (name === 'pre' || name === 'code' || name === 'div')
      continue

    if (name === 'span') {
      if (isClosing) {
        const converted = spanStack.pop() === true
        out += converted ? '</font>' : ''
        continue
      }
      const styleMatch = /style\s*=\s*"([^"]*)"/i.exec(tag)
      const colour = styleMatch === null
        ? null
        : /color\s*:\s*(#[0-9a-fA-F]{3,8})/.exec(styleMatch[1] ?? '')
      if (colour !== null && colour[1] !== undefined) {
        spanStack.push(true)
        out += `<font color="${colour[1]}">`
      } else {
        spanStack.push(false)
      }
      continue
    }

    if (KEEP.has(name))
      out += tag
  }

  // Close any font that was never closed, so the markup stays balanced.
  while (spanStack.length > 0) {
    if (spanStack.pop() === true)
      out += '</font>'
  }
  return out
}
