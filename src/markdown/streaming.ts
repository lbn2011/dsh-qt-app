// streaming.ts — incremental Markdown parsing for a reply that arrives in pieces.
//
// An LLM answer reaches the UI as a stream of small deltas. Re-parsing the whole
// accumulated text on every delta and handing the QML side a brand-new tree would
// make the delegate rebuild its entire block list several times per second, which
// is both wasteful and visibly jumpy (scroll position, text selection and any
// hover state die on every rebuild).
//
// `DeltaMarkdownParser` therefore keeps two things:
//
//   * the source text so far, and
//   * a list of top-level blocks with **stable ids**.
//
// On each chunk it appends the text, re-parses only the part that can still
// change, and reports the difference as a small set of node updates:
//
//   { type: 'append',  nodeId, index, node }   a block appeared
//   { type: 'replace', nodeId, index, node }   an existing block grew/changed
//   { type: 'remove',  nodeId, index }         a block disappeared
//
// The QML side applies those updates to a single delegate instead of rebuilding
// the document, which is what makes streaming feel like typing rather than
// flickering.
//
// Incremental boundary
// --------------------
// A fenced code block can span many lines, so a blank line inside one is not a
// block boundary. Outside a fence, the *last* blank line separates the final,
// still-open block from everything before it — and everything before it can no
// longer change, because a block only ever grows forward. That prefix is frozen
// and reused; only the trailing region is parsed again.
//
// The freeze is only taken when the trailing region starts a block that cannot
// attach backwards (a paragraph, heading, fence, table header or thematic break).
// A trailing list item, blockquote line or indented continuation is deliberately
// *not* a freeze point: those constructs absorb what follows them, so the parser
// re-parses from the previous frozen point instead. Correctness first; the
// savings are still real because a streaming paragraph is the common case.
import { MarkdownNode } from './types.js'
import type { MarkdownJSON } from './types.js'
import { parseMarkdown } from './fallback-parser.js'
import type { FallbackParserOptions } from './fallback-parser.js'

/** One in-place update for the renderer. */
export interface StreamNodeUpdate {
  type: 'append' | 'replace' | 'remove'
  /** Stable id of the block this update refers to. */
  nodeId: string
  /** Position of the block in the document. */
  index: number
  /** New node, absent for `remove`. */
  node?: MarkdownJSON
}

/** What one `onChunk()` call produced. */
export interface StreamSnapshot {
  /** Every character received so far. */
  text: string
  /** The complete document, for callers that want to re-render wholesale. */
  document: MarkdownJSON
  /** The updates to apply, in order. Empty when the chunk changed nothing. */
  updates: StreamNodeUpdate[]
  /** Number of top-level blocks in `document`. */
  blockCount: number
  /** True while a fenced code block is still open (the UI can show a caret). */
  openFence: boolean
  /** Stable ids, parallel to the blocks of `document`. */
  blockIds: string[]
  /** Total number of full re-parses performed; 0 means every chunk was incremental. */
  fullReparses: number
}

/** Options for {@link DeltaMarkdownParser}. */
export interface DeltaMarkdownParserOptions extends FallbackParserOptions {
  /** Called with each snapshot, for push-style consumers. */
  onUpdate?: (snapshot: StreamSnapshot) => void
  /** Hard cap on the accumulated text; further chunks are ignored. Default 1e6. */
  maxLength?: number
  /**
   * Re-parse the whole text as well and compare, reverting to the full result on
   * any mismatch. Off by default (it doubles the cost); the test suite turns it on
   * to prove the incremental path agrees with a from-scratch parse.
   */
  verifyIntegrity?: boolean
}

/** Default cap on accumulated text (1 MB of Markdown is already enormous). */
export const DEFAULT_MAX_STREAM_LENGTH = 1_000_000

const BLANK_LINE = /^[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const QUOTE_PREFIX = /^ {0,3}>/
const INDENTED = /^ {4,}/

/**
 * Offset of the trailing region that may still change.
 *
 * Scans lines from the top, tracking fence state, and returns the offset just
 * after the last run of blank lines that is outside a fence **and** followed by a
 * line that starts a fresh block. Returns 0 when there is no safe freeze point,
 * which simply means "parse everything".
 */
export function findFreezeOffset(source: string): number {
  let fence: { char: string; length: number } | null = null
  let boundary = 0
  // Offset just past the last blank line outside a fence, or -1 when the previous
  // line was not blank.
  let afterBlank = -1

  let lineStart = 0
  while (lineStart <= source.length) {
    let lineEnd = source.indexOf('\n', lineStart)
    const isLast = lineEnd === -1
    if (isLast)
      lineEnd = source.length
    const line = source.slice(lineStart, lineEnd)
    const nextStart = lineEnd + 1
    const blank = BLANK_LINE.test(line)

    if (fence !== null) {
      const close = FENCE.exec(line)
      if (close !== null && (close[1] ?? '')[0] === fence.char && (close[1] ?? '').length >= fence.length)
        fence = null
      afterBlank = -1
    } else if (blank) {
      afterBlank = nextStart
    } else {
      const open = FENCE.exec(line)
      if (open !== null) {
        fence = { char: (open[1] ?? '`')[0] ?? '`', length: (open[1] ?? '```').length }
        afterBlank = -1
      } else {
        // A non-blank line directly after a blank run starts a new block. It is a
        // safe freeze point only when the block cannot absorb what came before it.
        if (afterBlank > 0) {
          const startsFresh = !LIST_MARKER.test(line) && !QUOTE_PREFIX.test(line) && !INDENTED.test(line)
          if (startsFresh)
            boundary = afterBlank
        }
        afterBlank = -1
      }
    }

    if (isLast)
      break
    lineStart = nextStart
  }

  // A boundary at the very end of the buffer is useless: there is nothing after it.
  return boundary > 0 && boundary < source.length ? boundary : 0
}

/** True when the source ends inside an unterminated fenced code block. */
export function hasOpenFence(source: string): boolean {
  let fence: { char: string; length: number } | null = null
  let lineStart = 0
  while (lineStart <= source.length) {
    let lineEnd = source.indexOf('\n', lineStart)
    if (lineEnd === -1)
      lineEnd = source.length
    const line = source.slice(lineStart, lineEnd)
    if (fence === null) {
      const open = FENCE.exec(line)
      if (open !== null)
        fence = { char: (open[1] ?? '`')[0] ?? '`', length: (open[1] ?? '```').length }
    } else {
      const close = FENCE.exec(line)
      if (close !== null && (close[1] ?? '')[0] === fence.char && (close[1] ?? '').length >= fence.length)
        fence = null
    }
    if (lineEnd === source.length)
      break
    lineStart = lineEnd + 1
  }
  return fence !== null
}

/** Serialise a node for change detection. */
function fingerprint(node: MarkdownNode): string {
  return JSON.stringify(node.toJSON())
}

/**
 * Incremental Markdown parser for a streaming reply.
 *
 * Feed it with {@link onChunk}; it answers with the updates the renderer needs.
 * The parser never throws: a chunk that is not a string is ignored, and text
 * beyond `maxLength` is dropped rather than buffered forever.
 */
export class DeltaMarkdownParser {
  private readonly options_: DeltaMarkdownParserOptions
  private readonly maxLength_: number
  private readonly verify_: boolean
  private readonly onUpdate_: ((snapshot: StreamSnapshot) => void) | undefined

  /** Source text that has been committed to the frozen prefix. */
  private frozenText_ = ''
  /** Source text of the still-open trailing region. */
  private tailText_ = ''
  /** Blocks of the frozen prefix, with their ids. */
  private frozenBlocks_: MarkdownNode[] = []
  private frozenIds_: string[] = []
  /** Blocks of the trailing region, with their ids. */
  private tailBlocks_: MarkdownNode[] = []
  private tailIds_: string[] = []
  /** Fingerprints parallel to the current block list, for cheap diffing. */
  private fingerprints_: string[] = []
  /** Block types parallel to the current block list, for id reuse. */
  private types_: string[] = [] = []

  private idCounter_ = 0
  private fullReparses_ = 0
  /** A high surrogate held back because its pair has not arrived yet. */
  private heldSurrogate_ = ''
  /** Set when the accumulated text hit the cap. */
  private truncated_ = false

  constructor(options: DeltaMarkdownParserOptions = {}) {
    this.options_ = options
    this.maxLength_ = typeof options.maxLength === 'number' && options.maxLength > 0
      ? Math.floor(options.maxLength)
      : DEFAULT_MAX_STREAM_LENGTH
    this.verify_ = options.verifyIntegrity === true
    this.onUpdate_ = options.onUpdate
  }

  /** Every character received so far (excluding a held lone surrogate). */
  get text(): string {
    return this.frozenText_ + this.tailText_
  }

  /** True when the accumulated text hit the length cap. */
  get truncated(): boolean {
    return this.truncated_
  }

  /** Number of full re-parses performed. */
  get fullReparses(): number {
    return this.fullReparses_
  }

  /** Stable ids of the current top-level blocks. */
  get blockIds(): string[] {
    return [...this.frozenIds_, ...this.tailIds_]
  }

  /** The document as it stands. */
  get document(): MarkdownJSON {
    return this.documentNode().toJSON()
  }

  /** Number of top-level blocks. */
  get blockCount(): number {
    return this.frozenBlocks_.length + this.tailBlocks_.length
  }

  /** Feed one delta and receive the updates to apply. */
  onChunk(delta: string): StreamSnapshot {
    if (typeof delta !== 'string' || delta === '')
      return this.snapshot_([], true)

    let text = delta
    // A chunk boundary can split a surrogate pair (an emoji, a rare CJK glyph).
    // Holding the lone high surrogate back keeps the accumulated text valid UTF-16
    // and stops a half-character from ever reaching the renderer.
    if (this.heldSurrogate_ !== '') {
      text = this.heldSurrogate_ + text
      this.heldSurrogate_ = ''
    }
    if (text.length > 0) {
      const lastCode = text.charCodeAt(text.length - 1)
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        this.heldSurrogate_ = text.slice(-1)
        text = text.slice(0, -1)
      }
    }
    if (text === '')
      return this.snapshot_([], true)

    const room = this.maxLength_ - this.text.length
    if (room <= 0) {
      this.truncated_ = true
      return this.snapshot_([], true)
    }
    if (text.length > room) {
      text = text.slice(0, room)
      this.truncated_ = true
    }

    return this.append_(text)
  }

  /** Alias for {@link onChunk}, for callers that think in appends. */
  append(delta: string): StreamSnapshot {
    return this.onChunk(delta)
  }

  /** Feed several deltas and return the last snapshot. */
  onChunks(deltas: readonly string[]): StreamSnapshot {
    let snapshot = this.snapshot_([], true)
    for (const delta of deltas)
      snapshot = this.onChunk(delta)
    return snapshot
  }

  /**
   * Release a held lone surrogate.
   *
   * Call this when the stream ends: a truncated emoji is better shown as the
   * replacement character than silently dropped.
   */
  flush(): StreamSnapshot {
    if (this.heldSurrogate_ === '')
      return this.snapshot_([], true)
    const held = this.heldSurrogate_
    this.heldSurrogate_ = ''
    return this.append_(held)
  }

  /** Forget everything, ready for a new reply. */
  reset(): void {
    this.frozenText_ = ''
    this.tailText_ = ''
    this.frozenBlocks_ = []
    this.frozenIds_ = []
    this.tailBlocks_ = []
    this.tailIds_ = []
    this.fingerprints_ = []
    this.types_ = []
    this.idCounter_ = 0
    this.fullReparses_ = 0
    this.heldSurrogate_ = ''
    this.truncated_ = false
  }

  /** Replace the whole text at once (a completed message, or a correction). */
  setText(text: string): StreamSnapshot {
    this.reset()
    return this.onChunk(typeof text === 'string' ? text : '')
  }

  // ---- internals ---------------------------------------------------------

  private documentNode(): MarkdownNode {
    const document = new MarkdownNode('document')
    for (const block of this.frozenBlocks_)
      document.appendChild(block)
    for (const block of this.tailBlocks_)
      document.appendChild(block)
    return document
  }

  private nextId_(): string {
    this.idCounter_ += 1
    return `md-${this.idCounter_}`
  }

  private parseBlocks_(text: string): MarkdownNode[] {
    if (text === '')
      return []
    // Copy: `appendChild` detaches a node from its previous parent, so iterating
    // the parser's own children array while re-parenting would skip entries.
    return [...parseMarkdown(text, this.options_).children]
  }

  private append_(delta: string): StreamSnapshot {
    const previousCount = this.blockCount
    const previousIds = this.blockIds
    const previousPrints = this.fingerprints_
    const previousTypes = this.types_

    const combined = this.frozenText_ + this.tailText_ + delta

    // Decide the freeze point on the *combined* text.
    const freeze = findFreezeOffset(combined)
    const canFreeze = freeze > this.frozenText_.length

    if (canFreeze) {
      const frozenText = combined.slice(0, freeze)
      const tailText = combined.slice(freeze)
      const frozenBlocks = this.parseBlocks_(frozenText)
      const tailBlocks = this.parseBlocks_(tailText)
      this.frozenText_ = frozenText
      this.tailText_ = tailText
      this.frozenBlocks_ = frozenBlocks
      this.tailBlocks_ = tailBlocks
      // Ids: keep the old id when the block at that position is the same type.
      this.frozenIds_ = frozenBlocks.map((block, index) => {
        const old = previousIds[index]
        return old !== undefined && previousTypes[index] === block.type
          ? old
          : this.nextId_()
      })
      this.tailIds_ = tailBlocks.map((block, index) => {
        const slot = frozenBlocks.length + index
        const old = previousIds[slot]
        return old !== undefined && previousTypes[slot] === block.type
          ? old
          : this.nextId_()
      })
    } else {
      // No safe boundary: re-parse the whole trailing region in one go.
      this.tailText_ = combined.slice(this.frozenText_.length)
      this.tailBlocks_ = this.parseBlocks_(this.tailText_)
      this.tailIds_ = this.tailBlocks_.map((block, index) => {
        const slot = this.frozenBlocks_.length + index
        const old = previousIds[slot]
        return old !== undefined && previousTypes[slot] === block.type
          ? old
          : this.nextId_()
      })
    }

    const blocks = [...this.frozenBlocks_, ...this.tailBlocks_]
    let prints = blocks.map(fingerprint)

    // Optional integrity check: does the incremental answer match a clean parse?
    if (this.verify_) {
      this.fullReparses_ += 1
      const reference = this.parseBlocks_(this.text)
      const referencePrints = reference.map(fingerprint)
      const same = referencePrints.length === prints.length
        && referencePrints.every((print, index) => print === prints[index])
      if (!same) {
        // Discard the frozen prefix and adopt the reference result wholesale.
        this.frozenText_ = ''
        this.frozenBlocks_ = []
        this.frozenIds_ = []
        this.tailText_ = this.text
        this.tailBlocks_ = reference
        this.tailIds_ = reference.map(() => this.nextId_())
        prints = referencePrints
        blocks.length = 0
        blocks.push(...reference)
      }
    }

    const finalIds = [...this.frozenIds_, ...this.tailIds_]
    const updates = this.diff_(previousIds, finalIds, blocks, previousPrints, prints)
    this.fingerprints_ = prints
    this.types_ = blocks.map(block => block.type)
    return this.snapshot_(updates, false, previousCount)
  }

  private diff_(
    previousIds: string[],
    ids: string[],
    blocks: MarkdownNode[],
    previousPrints: string[],
    prints: string[],
  ): StreamNodeUpdate[] {
    const updates: StreamNodeUpdate[] = []
    const limit = Math.max(previousIds.length, ids.length)
    for (let index = 0; index < limit; index += 1) {
      const id = ids[index]
      const oldId = previousIds[index]
      if (id === undefined) {
        if (oldId !== undefined)
          updates.push({ type: 'remove', nodeId: oldId, index })
        continue
      }
      const block = blocks[index]
      if (block === undefined)
        continue
      if (oldId === undefined || oldId !== id) {
        updates.push({ type: 'append', nodeId: id, index, node: block.toJSON() })
        continue
      }
      if (previousPrints[index] !== prints[index])
        updates.push({ type: 'replace', nodeId: id, index, node: block.toJSON() })
    }
    return updates
  }

  private snapshot_(updates: StreamNodeUpdate[], empty: boolean, previousCount = 0): StreamSnapshot {
    const ids = [...this.frozenIds_, ...this.tailIds_]
    const snapshot: StreamSnapshot = {
      text: this.text,
      document: this.documentNode().toJSON(),
      updates,
      blockCount: this.blockCount,
      openFence: hasOpenFence(this.text),
      blockIds: ids,
      fullReparses: this.fullReparses_,
    }
    if (empty && previousCount !== this.blockCount)
      snapshot.updates = updates
    if (this.onUpdate_ !== undefined && !empty) {
      try {
        this.onUpdate_(snapshot)
      } catch {
        // A misbehaving listener must not break the stream.
      }
    }
    return snapshot
  }
}

/** Convenience factory. */
export function createDeltaMarkdownParser(options: DeltaMarkdownParserOptions = {}): DeltaMarkdownParser {
  return new DeltaMarkdownParser(options)
}

/**
 * Split text into fixed-size chunks.
 *
 * Used by the tests and by any host that receives a whole message at once but
 * wants to exercise the streaming path; the split never cuts a surrogate pair.
 */
export function chunkText(text: string, size = 100): string[] {
  if (typeof text !== 'string' || text === '')
    return []
  const width = size > 0 ? Math.floor(size) : 100
  const chunks: string[] = []
  let index = 0
  while (index < text.length) {
    let end = Math.min(index + width, text.length)
    // Do not end a chunk between a high and a low surrogate.
    if (end < text.length) {
      const code = text.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff)
        end -= 1
    }
    if (end <= index) {
      // The chunk would be empty because its only character is a high surrogate:
      // widen by one so the pair travels together.
      end = Math.min(index + width + 1, text.length)
    }
    chunks.push(text.slice(index, end))
    index = end
  }
  return chunks
}
