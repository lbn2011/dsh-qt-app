/**
 * Pure-TypeScript Markdown parser (Phase 2a fallback).
 *
 * Purpose: when the native cmark N-API addon is missing, ABI-incompatible or
 * simply not built yet (the normal state during development), the Qt profile
 * must still render readable chat bubbles. This parser is the second line of
 * defence behind the addon and the reference implementation of the AST
 * contract verified by the unit tests.
 *
 * Supported GitHub-flavoured subset:
 *   - paragraphs, ATX (`#`) and setext (`===` / `---`) headings
 *   - fenced code blocks (``` and ~~~, with an info string) and inline code
 *   - emphasis, strong, strikethrough, backslash escapes
 *   - inline links `[label](href "title")` and autolinks `<https://…>`,
 *     `<mailto:…>`, `<user@host>`
 *   - unordered and ordered lists with nesting and multi-block items
 *   - blockquotes (nested)
 *   - thematic breaks
 *   - GFM pipe tables (unless `enableTables: false`)
 *
 * Deliberate limitations, documented rather than hidden:
 *   - no reference links (`[a][b]`), no HTML blocks (raw HTML stays text and is
 *     escaped by the renderer), no tables without a delimiter row, no indented
 *     code blocks (`    code` becomes paragraph text), no footnotes, no math.
 *
 * Robustness contract: `parseMarkdown()` never throws, whatever the input —
 * unbalanced delimiters, unterminated fences, huge single lines and control
 * characters all degrade to literal text. No DOM access, no regular expression
 * with nested quantifiers, and nesting is bounded by `maxNesting`.
 */

import type { MarkdownOptions } from '../types.js'
import {
  BLOCKQUOTE,
  CODE,
  DOCUMENT,
  EMPHASIS,
  HEADING,
  LINK,
  LIST,
  LIST_ITEM,
  MarkdownNode,
  PARAGRAPH,
  STRONG,
  STRIKETHROUGH,
  TABLE,
  TABLE_CELL,
  TABLE_ROW,
  TEXT,
  THEMATIC_BREAK,
  type MarkdownDocument,
  type MarkdownTableCellAlignment,
  type MarkdownTokenType,
} from './types.js'

/** Options accepted by `parseMarkdown()`: the shared render options plus local limits. */
export interface FallbackParserOptions extends MarkdownOptions {
  /** Hard cap on block/inline nesting; deeper content degrades to plain text. */
  maxNesting?: number
}

/** Default nesting cap; keeps pathological input linear. */
export const DEFAULT_MAX_NESTING = 32

/** Inputs longer than this are truncated: a chat transcript is never 5 MB. */
export const MAX_INPUT_LENGTH = 5_000_000

interface ResolvedOptions {
  enableTables: boolean
  maxNesting: number
}

/** Result of a sub-parser that consumes input lines. */
interface ConsumeResult {
  node: MarkdownNode
  next: number
}

/** Result of a sub-parser that consumes inline characters. */
interface InlineResult {
  node: MarkdownNode
  next: number
}

// ---------------------------------------------------------------------------
// Block-level patterns. All are anchored and free of nested quantifiers so that
// matching stays linear in the line length.
// ---------------------------------------------------------------------------

const BLANK_LINE = /^[ \t]*$/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`~]*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const QUOTE_PREFIX = /^ {0,3}>/
const LIST_MARKER = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+(.*))?$/
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

/** Characters that a backslash may escape in Markdown. */
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!>~|]/

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse Markdown into a `MarkdownNode` document tree.
 *
 * @param text Raw Markdown; non-string input is treated as empty (never throws).
 * @param options Shared render options plus the parser's own limits.
 */
export function parseMarkdown(text: string, options: FallbackParserOptions = {}): MarkdownDocument {
  const opts = resolveOptions(options)
  const document = new MarkdownNode(DOCUMENT)
  if (typeof text !== 'string' || text.length === 0) return document

  const bounded = text.length > MAX_INPUT_LENGTH ? text.slice(0, MAX_INPUT_LENGTH) : text
  const lines = normalizeInput(bounded).split('\n')
  for (const block of parseBlocks(lines, 0, opts)) document.appendChild(block)
  return document
}

/**
 * Parse an inline fragment into nodes.
 *
 * Exposed because the QML renderer (t12) and plugin contributions may need to
 * format single-line strings (labels, status text) without a block wrapper.
 */
export function parseInlineMarkdown(text: string, options: FallbackParserOptions = {}): MarkdownNode[] {
  const opts = resolveOptions(options)
  if (typeof text !== 'string' || text.length === 0) return []
  const bounded = text.length > MAX_INPUT_LENGTH ? text.slice(0, MAX_INPUT_LENGTH) : text
  return parseInline(bounded, 0, opts)
}

/** Wrap a plain string in a single paragraph of text. */
export function textToParagraph(text: string): MarkdownNode {
  const paragraph = new MarkdownNode(PARAGRAPH)
  if (text.length > 0) paragraph.appendChild(new MarkdownNode(TEXT, { content: text }))
  return paragraph
}

function resolveOptions(options: FallbackParserOptions): ResolvedOptions {
  const maxNesting = options.maxNesting
  return {
    enableTables: options.enableTables !== false,
    maxNesting:
      typeof maxNesting === 'number' && Number.isFinite(maxNesting) && maxNesting >= 1
        ? Math.floor(maxNesting)
        : DEFAULT_MAX_NESTING,
  }
}

/** Normalise line endings and expand tabs so indentation maths stays simple. */
function normalizeInput(input: string): string {
  return input.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
}

// ---------------------------------------------------------------------------
// Block-level parsing
// ---------------------------------------------------------------------------

function parseBlocks(lines: string[], depth: number, opts: ResolvedOptions): MarkdownNode[] {
  const blocks: MarkdownNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (BLANK_LINE.test(line)) {
      index += 1
      continue
    }

    // 1. Fenced code block.
    const fence = FENCE_OPEN.exec(line)
    if (fence !== null) {
      const result = consumeFence(lines, index, fence)
      blocks.push(result.node)
      index = result.next
      continue
    }

    // 2. ATX heading.
    const atx = ATX.exec(line)
    if (atx !== null) {
      const level = (atx[1] ?? '#').length
      const raw = (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim()
      const heading = new MarkdownNode(HEADING, { level })
      appendInline(heading, raw, depth + 1, opts)
      blocks.push(heading)
      index += 1
      continue
    }

    // 3. Thematic break (checked before lists so `* * *` is a rule, not a list).
    if (THEMATIC.test(line)) {
      blocks.push(new MarkdownNode(THEMATIC_BREAK))
      index += 1
      continue
    }

    // 4. Blockquote.
    if (QUOTE_PREFIX.test(line)) {
      const result = consumeBlockquote(lines, index, depth, opts)
      blocks.push(result.node)
      index = result.next
      continue
    }

    // 5. GFM table: a header line plus a delimiter row.
    if (opts.enableTables && line.includes('|')) {
      const result = tryConsumeTable(lines, index, depth, opts)
      if (result !== null) {
        blocks.push(result.node)
        index = result.next
        continue
      }
    }

    // 6. List (before setext, so `- item` followed by `---` stays a list).
    if (LIST_MARKER.test(line)) {
      const result = consumeList(lines, index, depth, opts)
      blocks.push(result.node)
      index = result.next
      continue
    }

    // 7. Setext heading: one text line underlined by `===` or `---`.
    const underline = lines[index + 1]
    if (underline !== undefined && SETEXT.test(underline)) {
      const level = (underline.trim().charAt(0) === '=' ? 1 : 2) as number
      const heading = new MarkdownNode(HEADING, { level })
      appendInline(heading, line.trim(), depth + 1, opts)
      blocks.push(heading)
      index += 2
      continue
    }

    // 8. Paragraph: consume until a blank line or the start of another block.
    const paragraphLines = [line.trim()]
    let cursor = index + 1
    while (cursor < lines.length) {
      const current = lines[cursor] ?? ''
      if (BLANK_LINE.test(current) || isBlockStartLine(current) || SETEXT.test(current)) break
      paragraphLines.push(current.trim())
      cursor += 1
    }
    const paragraph = new MarkdownNode(PARAGRAPH)
    appendInline(paragraph, paragraphLines.join('\n'), depth + 1, opts)
    blocks.push(paragraph)
    index = cursor
  }

  return blocks
}

/** `true` when `line` starts a block other than a paragraph. */
function isBlockStartLine(line: string): boolean {
  return (
    FENCE_OPEN.test(line) ||
    ATX.test(line) ||
    THEMATIC.test(line) ||
    QUOTE_PREFIX.test(line) ||
    LIST_MARKER.test(line)
  )
}

/** Consume a fenced code block; an unterminated fence runs to end of input. */
function consumeFence(lines: string[], start: number, fence: RegExpExecArray): ConsumeResult {
  const marker = fence[1] ?? '```'
  const info = (fence[2] ?? '').trim()
  const markerChar = marker.charAt(0)
  const body: string[] = []
  let index = start + 1

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const close = FENCE_CLOSE.exec(line)
    if (close !== null) {
      const run = close[1] ?? ''
      if (run.charAt(0) === markerChar && run.length >= marker.length) {
        index += 1
        break
      }
    }
    body.push(line)
    index += 1
  }

  const node = new MarkdownNode(CODE, { content: body.join('\n'), inline: false })
  if (info.length > 0) node.language = info.split(/\s+/)[0] ?? info
  return { node, next: index }
}

/** Consume a `>` blockquote, recursively parsing the stripped inner lines. */
function consumeBlockquote(lines: string[], start: number, depth: number, opts: ResolvedOptions): ConsumeResult {
  const inner: string[] = []
  let index = start

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (QUOTE_PREFIX.test(line)) {
      inner.push(line.replace(/^ {0,3}> ?/, ''))
      index += 1
      continue
    }
    if (BLANK_LINE.test(line)) {
      const next = lines[index + 1]
      if (next !== undefined && QUOTE_PREFIX.test(next)) {
        inner.push('')
        index += 1
        continue
      }
    }
    break
  }

  const node = new MarkdownNode(BLOCKQUOTE)
  const children =
    depth < opts.maxNesting ? parseBlocks(inner, depth + 1, opts) : [textToParagraph(inner.join('\n').trim())]
  for (const child of children) node.appendChild(child)
  return { node, next: index }
}

/** Build a table block when the header/delimiter pair is valid, else `null`. */
function tryConsumeTable(
  lines: string[],
  start: number,
  depth: number,
  opts: ResolvedOptions,
): ConsumeResult | null {
  const headerLine = lines[start] ?? ''
  const delimiterLine = lines[start + 1]
  if (delimiterLine === undefined || !TABLE_DELIMITER.test(delimiterLine)) return null

  const headerCells = splitTableRow(headerLine)
  const delimiterCells = splitTableRow(delimiterLine)
  // A delimiter row without dashes, or a width mismatch, is not a table.
  if (headerCells.length === 0 || delimiterCells.length !== headerCells.length) return null
  if (!delimiterCells.every((cell) => /^:?-+:?$/.test(cell))) return null

  const align = delimiterCells.map(parseAlignment)
  const table = new MarkdownNode(TABLE)
  const headerRow = new MarkdownNode(TABLE_ROW)
  headerCells.forEach((cellText, cellIndex) => {
    const cell = makeTableCell(cellText, align[cellIndex], depth, opts)
    headerRow.appendChild(cell)
  })
  table.appendChild(headerRow)

  const width = headerCells.length
  let index = start + 2
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (BLANK_LINE.test(line) || !line.includes('|') || isBlockStartLine(line)) break
    const cells = splitTableRow(line)
    const row = new MarkdownNode(TABLE_ROW)
    for (let cellIndex = 0; cellIndex < width; cellIndex += 1) {
      row.appendChild(makeTableCell(cells[cellIndex] ?? '', align[cellIndex], depth, opts))
    }
    table.appendChild(row)
    index += 1
  }

  return { node: table, next: index }
}

function makeTableCell(
  text: string,
  align: MarkdownTableCellAlignment | null | undefined,
  depth: number,
  opts: ResolvedOptions,
): MarkdownNode {
  const cell = new MarkdownNode(TABLE_CELL, align == null ? {} : { align })
  appendInline(cell, text, depth + 1, opts)
  return cell
}

/** Split a pipe-table row, honouring `\|` escapes and trimming padding. */
function splitTableRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)

  const cells: string[] = []
  let current = ''
  let index = 0
  while (index < row.length) {
    const char = row.charAt(index)
    if (char === '\\' && row.charAt(index + 1) === '|') {
      current += '|'
      index += 2
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      index += 1
      continue
    }
    current += char
    index += 1
  }
  cells.push(current.trim())
  return cells
}

function parseAlignment(cell: string): MarkdownTableCellAlignment | null {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (left) return 'left'
  if (right) return 'right'
  return null
}

/** Consume a list (and, through the recursive call, its nested sublists). */
function consumeList(lines: string[], start: number, depth: number, opts: ResolvedOptions): ConsumeResult {
  const first = LIST_MARKER.exec(lines[start] ?? '')
  const firstMarker = first?.[2] ?? '-'
  const ordered = /^\d/.test(firstMarker)
  const list = new MarkdownNode(LIST, { ordered })
  if (ordered) {
    const startOrdinal = Number.parseInt(firstMarker, 10)
    if (Number.isFinite(startOrdinal) && startOrdinal !== 1) list.start = startOrdinal
  }

  let index = start
  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (BLANK_LINE.test(line)) {
      // A blank line only continues the list if another item follows.
      const next = lines[index + 1]
      if (next !== undefined && sameListKind(LIST_MARKER.exec(next), ordered)) {
        index += 1
        continue
      }
      break
    }

    const match = LIST_MARKER.exec(line)
    if (match === null || !sameListKind(match, ordered)) break

    const markerIndent = (match[1] ?? '').length
    const marker = match[2] ?? '-'
    const spacing = match[3] === undefined ? 1 : Math.min(4, Math.max(1, match[3].length - (match[4] ?? '').length))
    const contentIndent = markerIndent + marker.length + spacing

    const itemLines: string[] = [(match[4] ?? '').trim()]
    index += 1

    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (BLANK_LINE.test(current)) {
        const next = lines[index + 1]
        const continues =
          next !== undefined && (indentOf(next) >= contentIndent || LIST_MARKER.test(next))
        if (continues) {
          itemLines.push('')
          index += 1
          continue
        }
        break
      }
      if (indentOf(current) >= contentIndent) {
        itemLines.push(dedent(current, contentIndent))
        index += 1
        continue
      }
      if (LIST_MARKER.test(current) || isBlockStartLine(current)) break
      // Lazy continuation: an unindented line still belongs to the item.
      itemLines.push(current.trim())
      index += 1
    }

    const item = new MarkdownNode(LIST_ITEM)
    const children =
      depth < opts.maxNesting
        ? parseBlocks(itemLines, depth + 1, opts)
        : [textToParagraph(itemLines.join('\n').trim())]
    for (const child of children) item.appendChild(child)
    list.appendChild(item)
  }

  return { node: list, next: index }
}

/** Does `match` continue a list of the same ordered/unordered kind? */
function sameListKind(match: RegExpExecArray | null, ordered: boolean): boolean {
  if (match === null) return false
  return /^\d/.test(match[2] ?? '') === ordered
}

// ---------------------------------------------------------------------------
// Inline-level parsing
// ---------------------------------------------------------------------------

/** Parse `text` into inline nodes, appending them to `parent`. */
function appendInline(parent: MarkdownNode, text: string, depth: number, opts: ResolvedOptions): void {
  for (const node of parseInline(text, depth, opts)) parent.appendChild(node)
}

function parseInline(text: string, depth: number, opts: ResolvedOptions): MarkdownNode[] {
  const nodes: MarkdownNode[] = []
  if (text.length === 0) return nodes
  if (depth > opts.maxNesting) {
    nodes.push(new MarkdownNode(TEXT, { content: text }))
    return nodes
  }

  let buffer = ''
  const flush = (): void => {
    if (buffer.length > 0) {
      nodes.push(new MarkdownNode(TEXT, { content: buffer }))
      buffer = ''
    }
  }

  let index = 0
  while (index < text.length) {
    const char = text.charAt(index)

    if (char === '\\') {
      const escaped = text.charAt(index + 1)
      if (escaped.length > 0 && ESCAPABLE.test(escaped)) {
        buffer += escaped
        index += 2
        continue
      }
      buffer += char
      index += 1
      continue
    }

    if (char === '`') {
      const run = countRun(text, index, '`')
      const result = parseCodeSpan(text, index, run)
      if (result !== null) {
        flush()
        nodes.push(result.node)
        index = result.next
      } else {
        // Unterminated run: emit it literally and move past it in one step
        // (keeps the scanner linear on adversarial input).
        buffer += text.slice(index, index + run)
        index += run
      }
      continue
    }

    if (char === '*' || char === '_') {
      const run = countRun(text, index, char)
      const result = parseEmphasis(text, index, char, run, depth, opts)
      if (result !== null) {
        flush()
        nodes.push(result.node)
        index = result.next
      } else {
        buffer += text.slice(index, index + run)
        index += run
      }
      continue
    }

    if (char === '~') {
      const run = countRun(text, index, '~')
      const result = parseStrikethrough(text, index, run, depth, opts)
      if (result !== null) {
        flush()
        nodes.push(result.node)
        index = result.next
      } else {
        buffer += text.slice(index, index + run)
        index += run
      }
      continue
    }

    if (char === '[') {
      const result = parseLink(text, index, depth, opts)
      if (result !== null) {
        flush()
        nodes.push(result.node)
        index = result.next
        continue
      }
      buffer += char
      index += 1
      continue
    }

    if (char === '<') {
      const result = parseAutolink(text, index)
      if (result !== null) {
        flush()
        nodes.push(result.node)
        index = result.next
        continue
      }
      buffer += char
      index += 1
      continue
    }

    buffer += char
    index += 1
  }

  flush()
  return nodes
}

/** Inline code span; `null` when the backtick run is not closed. */
function parseCodeSpan(text: string, start: number, run: number): InlineResult | null {
  let index = start + run
  while (index < text.length) {
    if (text.charAt(index) === '`') {
      const closing = countRun(text, index, '`')
      if (closing === run) {
        let content = text.slice(start + run, index)
        // CommonMark strips one space of padding when both ends have one.
        if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim().length > 0) {
          content = content.slice(1, -1)
        }
        return { node: new MarkdownNode(CODE, { content, inline: true }), next: index + closing }
      }
      index += closing
      continue
    }
    index += 1
  }
  return null
}

/**
 * Emphasis / strong / combined emphasis.
 *
 * `run` is the length of the opening delimiter run. Runs of three or more are
 * treated as strong+emphasis (`***x***`), two as strong, one as emphasis.
 * Closing runs must have a compatible length for the opener, which is what
 * keeps `*a **b** c*` correctly nested without a full CommonMark delimiter
 * stack.
 */
function parseEmphasis(
  text: string,
  start: number,
  char: string,
  run: number,
  depth: number,
  opts: ResolvedOptions,
): InlineResult | null {
  const need = run >= 3 ? 3 : run
  if (need < 1) return null

  // Underscore emphasis cannot open inside a word (`snake_case_name`).
  if (char === '_') {
    const previous = start > 0 ? text.charAt(start - 1) : ''
    if (previous.length > 0 && isWordChar(previous)) return null
  }

  const closeStart = findClosingRun(text, start + need, char, need)
  if (closeStart === -1) return null

  const inner = text.slice(start + need, closeStart)
  if (inner.trim().length === 0) return null

  const children = parseInline(inner, depth + 1, opts)
  const next = closeStart + need

  if (need === 3) {
    const strong = new MarkdownNode(STRONG)
    const emphasis = new MarkdownNode(EMPHASIS)
    for (const child of children) emphasis.appendChild(child)
    strong.appendChild(emphasis)
    return { node: strong, next }
  }

  const node = new MarkdownNode(need === 2 ? STRONG : EMPHASIS)
  for (const child of children) node.appendChild(child)
  return { node, next }
}

/**
 * Find a closing delimiter run of `char` at least `need` characters long.
 * Runs of exactly two are skipped when the opener is single, so `**bold**`
 * inside `*em*` does not terminate the outer emphasis early.
 */
function findClosingRun(text: string, from: number, char: string, need: number): number {
  let index = from
  while (index < text.length) {
    const current = text.charAt(index)
    if (current === '\\') {
      index += 2
      continue
    }
    if (current !== char) {
      index += 1
      continue
    }
    const run = countRun(text, index, char)
    const acceptable =
      need === 1 ? run !== 2 : need === 2 ? run >= 2 : run >= need
    if (acceptable) {
      if (char === '_') {
        const after = text.charAt(index + run)
        if (after.length > 0 && isWordChar(after)) {
          index += run
          continue
        }
      }
      return index
    }
    index += run
  }
  return -1
}

/** `~~strikethrough~~`; needs an exact double tilde on both sides. */
function parseStrikethrough(
  text: string,
  start: number,
  run: number,
  depth: number,
  opts: ResolvedOptions,
): InlineResult | null {
  if (run < 2) return null
  const need = 2
  const closeStart = findClosingRun(text, start + need, '~', need)
  if (closeStart === -1) return null
  const inner = text.slice(start + need, closeStart)
  if (inner.length === 0) return null
  const node = new MarkdownNode(STRIKETHROUGH)
  for (const child of parseInline(inner, depth + 1, opts)) node.appendChild(child)
  return { node, next: closeStart + need }
}

/** `[label](href "title")`; `null` when the fragment is not a complete link. */
function parseLink(text: string, start: number, depth: number, opts: ResolvedOptions): InlineResult | null {
  const labelEnd = findClosingBracket(text, start)
  if (labelEnd === -1) return null
  if (text.charAt(labelEnd + 1) !== '(') return null

  const destinationEnd = findClosingParen(text, labelEnd + 1)
  if (destinationEnd === -1) return null

  const label = text.slice(start + 1, labelEnd)
  // `[](href)` has no clickable text: treat it as literal input, not a link.
  if (label.trim().length === 0) return null

  const parsed = parseDestination(text.slice(labelEnd + 2, destinationEnd))
  if (parsed === null) return null

  const node = new MarkdownNode(LINK, { href: parsed.href })
  if (parsed.title !== undefined && parsed.title.length > 0) node.title = parsed.title
  for (const child of parseInline(label, depth + 1, opts)) node.appendChild(child)
  return { node, next: destinationEnd + 1 }
}

/** Index of the `]` matching the `[` at `start`, or `-1`. */
function findClosingBracket(text: string, start: number): number {
  let depth = 0
  let index = start
  while (index < text.length) {
    const char = text.charAt(index)
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) return index
    }
    index += 1
  }
  return -1
}

/** Index of the `)` matching the `(` at `start`, or `-1`. */
function findClosingParen(text: string, start: number): number {
  let depth = 0
  let index = start
  while (index < text.length) {
    const char = text.charAt(index)
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
    index += 1
  }
  return -1
}

/** Split an inline-link destination into `href` and optional `title`. */
function parseDestination(raw: string): { href: string; title?: string } | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  let href: string
  let rest: string
  if (trimmed.startsWith('<')) {
    const end = trimmed.indexOf('>')
    if (end === -1) return null
    href = trimmed.slice(1, end)
    rest = trimmed.slice(end + 1).trim()
  } else {
    const match = /^(\S*)([\s\S]*)$/.exec(trimmed)
    if (match === null) return null
    href = match[1] ?? ''
    rest = (match[2] ?? '').trim()
  }

  href = unescapeMarkdown(href)
  if (rest.length === 0) return { href }
  const titleMatch = /^"(.*)"$|^'(.*)'$|^\((.*)\)$/.exec(rest)
  if (titleMatch === null) return { href }
  const title = titleMatch[1] ?? titleMatch[2] ?? titleMatch[3] ?? ''
  return { href, title: unescapeMarkdown(title) }
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')
}

/** `<https://example.com>`, `<mailto:a@b>`, `<user@example.com>` → link. */
function parseAutolink(text: string, start: number): InlineResult | null {
  const end = text.indexOf('>', start + 1)
  if (end === -1) return null
  const body = text.slice(start + 1, end)
  if (body.length === 0 || /\s/.test(body)) return null

  if (/^(?:https?|mailto):[^<>]+$/.test(body)) {
    const node = new MarkdownNode(LINK, { href: body })
    node.appendChild(new MarkdownNode(TEXT, { content: body.replace(/^mailto:/, '') }))
    return { node, next: end + 1 }
  }
  if (/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(body)) {
    const node = new MarkdownNode(LINK, { href: `mailto:${body}` })
    node.appendChild(new MarkdownNode(TEXT, { content: body }))
    return { node, next: end + 1 }
  }
  return null
}

// ---------------------------------------------------------------------------
// Small scanners shared by block and inline parsing
// ---------------------------------------------------------------------------

/** Length of the run of `char` starting at `start`. */
function countRun(text: string, start: number, char: string): number {
  let length = 0
  while (text.charAt(start + length) === char) length += 1
  return length
}

function isWordChar(char: string): boolean {
  return /[0-9A-Za-z]/.test(char)
}

/** Number of leading spaces of `line`. */
function indentOf(line: string): number {
  let length = 0
  while (line.charAt(length) === ' ') length += 1
  return length
}

/** Remove up to `count` leading spaces from `line`. */
function dedent(line: string, count: number): string {
  let index = 0
  while (index < count && line.charAt(index) === ' ') index += 1
  return line.slice(index)
}

/** Re-exported for consumers that only need the token of a node. */
export type { MarkdownTokenType }
