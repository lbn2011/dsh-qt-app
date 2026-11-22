/**
 * Markdown AST contract (Phase 2a).
 *
 * This module defines the single boundary contract shared by every Markdown
 * producer and consumer in the DSH Qt profile:
 *
 *   - `fallback-parser.ts` (this phase, pure TypeScript, no addon required)
 *   - the native cmark N-API binding (Phase 2 task t11)
 *   - the QML renderer (Phase 2 task t12)
 *
 * The AST is deliberately small and JSON-serialisable: a `MarkdownNode` tree is
 * turned into the discriminated-union shape documented in
 * `docs/PHASE-2-PLAN.md` § 3.1 through `toJSON()`, so the native side never has
 * to know about JavaScript class instances. See also `fromJSON()` to travel in
 * the opposite direction.
 *
 * Design constraints:
 *   - no DOM, no external dependencies (the Qt profile ships no browser engine
 *     for chat bubbles; N-API addon absence must degrade, not crash);
 *   - `parent`/`children` links are maintained by `appendChild()` /
 *     `removeChild()` only, so a node belongs to exactly one tree;
 *   - the module is side-effect free and import-safe from both Node and a
 *     worker thread.
 */

/** Root of a parsed document. */
export const DOCUMENT = 'document' as const
/** A run of block-level inline content. */
export const PARAGRAPH = 'paragraph' as const
/** ATX/setext heading (`level` carries 1..6). */
export const HEADING = 'heading' as const
/** Literal text. `content` carries the raw (unescaped) string. */
export const TEXT = 'text' as const
/** `**strong**` / `__strong__`. */
export const STRONG = 'strong' as const
/** `*emphasis*` / `_emphasis_`. */
export const EMPHASIS = 'emphasis' as const
/** `~~strikethrough~~` (GFM). */
export const STRIKETHROUGH = 'strikethrough' as const
/**
 * Code, inline or fenced.
 *
 * Both forms share one token type; `inline` distinguishes `` `x` `` from a
 * fenced block and `language` carries the fence info string.
 */
export const CODE = 'code' as const
/** `[label](href "title")` and friends. */
export const LINK = 'link' as const
/** Ordered (`1.`) or unordered (`-`, `*`, `+`) list. */
export const LIST = 'list' as const
/** A single list item; hosts block children (including nested lists). */
export const LIST_ITEM = 'listItem' as const
/** `> quoted` block. */
export const BLOCKQUOTE = 'blockquote' as const
/** `---`, `***`, `___`. */
export const THEMATIC_BREAK = 'thematicBreak' as const
/** GFM pipe table. */
export const TABLE = 'table' as const
/** A table row (header or body); flattened by `toJSON()`. */
export const TABLE_ROW = 'tableRow' as const
/** A single table cell; flattened by `toJSON()`. */
export const TABLE_CELL = 'tableCell' as const
/**
 * Raw HTML.
 *
 * The fallback parser never emits this token (raw HTML is treated as plain
 * text there, see `fallback-parser.ts`). It exists because the native cmark
 * binding can produce HTML blocks, and because consumers must be able to round
 * trip the token without losing data. Renderers must treat the payload as
 * untrusted text and escape it.
 */
export const HTML = 'html' as const

/**
 * Every token type, exported both individually (above) and as a lookup table so
 * callers can validate untrusted input without importing each constant.
 */
export const MARKDOWN_TOKENS = {
  DOCUMENT,
  PARAGRAPH,
  HEADING,
  TEXT,
  STRONG,
  EMPHASIS,
  STRIKETHROUGH,
  CODE,
  LINK,
  LIST,
  LIST_ITEM,
  BLOCKQUOTE,
  THEMATIC_BREAK,
  TABLE,
  TABLE_ROW,
  TABLE_CELL,
  HTML,
} as const

/** Union of every token type name. */
export type MarkdownTokenType = (typeof MARKDOWN_TOKENS)[keyof typeof MARKDOWN_TOKENS]

/** Column alignment of a GFM table cell. */
export type MarkdownTableCellAlignment = 'left' | 'center' | 'right'

/** JSON form of the document root. */
export interface MarkdownDocumentJSON {
  type: typeof DOCUMENT
  children: MarkdownJSON[]
}

/** JSON form of `TEXT`. */
export interface MarkdownTextJSON {
  type: typeof TEXT
  value: string
}

/** JSON form of `CODE` (inline and fenced). */
export interface MarkdownCodeJSON {
  type: typeof CODE
  value: string
  inline: boolean
  language?: string
}

/** JSON form of `HTML`. */
export interface MarkdownHtmlJSON {
  type: typeof HTML
  value: string
}

/** JSON form of `HEADING`. */
export interface MarkdownHeadingJSON {
  type: typeof HEADING
  level: number
  children: MarkdownJSON[]
}

/** JSON form of tokens that are pure inline/block containers. */
export interface MarkdownContainerJSON {
  type: typeof PARAGRAPH | typeof STRONG | typeof EMPHASIS | typeof STRIKETHROUGH | typeof BLOCKQUOTE
  children: MarkdownJSON[]
}

/** JSON form of `LINK`. */
export interface MarkdownLinkJSON {
  type: typeof LINK
  href: string
  title?: string
  children: MarkdownJSON[]
}

/** JSON form of `LIST`; each item is a run of block/inline children. */
export interface MarkdownListJSON {
  type: typeof LIST
  ordered: boolean
  start?: number
  items: MarkdownJSON[][]
}

/** JSON form of `TABLE`; cells are runs of inline children. */
export interface MarkdownTableJSON {
  type: typeof TABLE
  align?: (MarkdownTableCellAlignment | null)[]
  header: MarkdownJSON[][]
  rows: MarkdownJSON[][][]
}

/** JSON form of `THEMATIC_BREAK`. */
export interface MarkdownThematicBreakJSON {
  type: typeof THEMATIC_BREAK
}

/** The complete JSON contract (plan § 3.1). */
export type MarkdownJSON =
  | MarkdownDocumentJSON
  | MarkdownTextJSON
  | MarkdownCodeJSON
  | MarkdownHtmlJSON
  | MarkdownHeadingJSON
  | MarkdownContainerJSON
  | MarkdownLinkJSON
  | MarkdownListJSON
  | MarkdownTableJSON
  | MarkdownThematicBreakJSON

/** Optional payload accepted by the `MarkdownNode` constructor. */
export interface MarkdownNodeInit {
  content?: string
  /** Link destination (`LINK` only). */
  href?: string
  /** Link title (`LINK` only). */
  title?: string
  /** Fence info string (`CODE` with `inline: false`). */
  language?: string
  /** Heading level 1..6 (`HEADING` only). */
  level?: number
  /** Ordered vs unordered (`LIST` only). */
  ordered?: boolean
  /** First ordinal of an ordered list (`LIST` only). */
  start?: number
  /** Inline vs fenced code (`CODE` only). */
  inline?: boolean
  /** Column alignment (`TABLE_CELL` only). */
  align?: MarkdownTableCellAlignment
}

/** Visitor used by `MarkdownNode.walk()`; return `false` to stop descending. */
export type MarkdownNodeVisitor = (node: MarkdownNode) => boolean | void

/**
 * A node of the Markdown AST.
 *
 * The class is intentionally mutable (the parser builds trees bottom-up) but
 * the tree invariants are enforced here rather than by the callers:
 * `appendChild()` detaches the child from its previous parent first, so a node
 * can never appear twice in one tree.
 */
export class MarkdownNode {
  /** Token type; see the constants above. */
  readonly type: MarkdownTokenType

  /** Raw payload for leaf tokens (`TEXT`, `CODE`, `HTML`); `''` otherwise. */
  content: string

  /** Child nodes, in document order. */
  readonly children: MarkdownNode[] = []

  /** Owning node, or `null` for the document root. */
  parent: MarkdownNode | null = null

  href: string | undefined
  title: string | undefined
  language: string | undefined
  level: number | undefined
  ordered: boolean | undefined
  start: number | undefined
  inline: boolean | undefined
  align: MarkdownTableCellAlignment | undefined

  constructor(type: MarkdownTokenType, init: MarkdownNodeInit = {}) {
    this.type = type
    this.content = init.content ?? ''
    this.href = init.href
    this.title = init.title
    this.language = init.language
    this.level = init.level
    this.ordered = init.ordered
    this.start = init.start
    this.inline = init.inline
    this.align = init.align
  }

  /** Convenience factory, mostly used by the parser and by tests. */
  static create(type: MarkdownTokenType, init: MarkdownNodeInit = {}): MarkdownNode {
    return new MarkdownNode(type, init)
  }

  /** `true` when the node has no children (leaf tokens such as `TEXT`/`CODE`). */
  get isLeaf(): boolean {
    return this.children.length === 0
  }

  /** `true` when the node is a leaf whose payload lives in `content`. */
  get isValueToken(): boolean {
    return this.type === TEXT || this.type === CODE || this.type === HTML
  }

  /** Distance from the root (the root itself is `0`). */
  get depth(): number {
    let d = 0
    let cursor: MarkdownNode | null = this.parent
    while (cursor !== null) {
      d += 1
      cursor = cursor.parent
    }
    return d
  }

  /** Topmost node of the tree this node belongs to. */
  get root(): MarkdownNode {
    let cursor: MarkdownNode = this
    while (cursor.parent !== null) cursor = cursor.parent
    return cursor
  }

  /**
   * Append `child` as the last child, detaching it from a previous parent.
   * Returns the child to allow `parent.appendChild(new MarkdownNode(...))`
   * chains. Throws only for the real programming error of self-insertion.
   */
  appendChild(child: MarkdownNode): MarkdownNode {
    if (child === this) throw new Error('MarkdownNode.appendChild: cannot append a node to itself')
    if (child.parent !== null) child.parent.removeChild(child)
    child.parent = this
    this.children.push(child)
    return child
  }

  /** Remove `child` from this node; returns `true` when it was present. */
  removeChild(child: MarkdownNode): boolean {
    const index = this.children.indexOf(child)
    if (index === -1) return false
    this.children.splice(index, 1)
    child.parent = null
    return true
  }

  /** Replace `oldChild` with `newChild`, preserving position. */
  replaceChild(oldChild: MarkdownNode, newChild: MarkdownNode): boolean {
    const index = this.children.indexOf(oldChild)
    if (index === -1) return false
    if (newChild.parent !== null) newChild.parent.removeChild(newChild)
    this.children.splice(index, 1, newChild)
    newChild.parent = this
    oldChild.parent = null
    return true
  }

  /**
   * Depth-first (pre-order) traversal including this node.
   * Returning `false` from `visit` skips that node's subtree.
   */
  walk(visit: MarkdownNodeVisitor): void {
    if (visit(this) === false) return
    // Copy: visitors are allowed to mutate the tree while walking.
    for (const child of [...this.children]) child.walk(visit)
  }

  /** First node (pre-order) matching `predicate`, or `undefined`. */
  find(predicate: (node: MarkdownNode) => boolean): MarkdownNode | undefined {
    let found: MarkdownNode | undefined
    this.walk((node) => {
      if (found !== undefined) return false
      if (predicate(node)) found = node
      return undefined
    })
    return found
  }

  /** Every node (pre-order) matching `predicate`. */
  findAll(predicate: (node: MarkdownNode) => boolean): MarkdownNode[] {
    const matches: MarkdownNode[] = []
    this.walk((node) => {
      if (predicate(node)) matches.push(node)
      return undefined
    })
    return matches
  }

  /** Concatenated textual payload of the subtree, in document order. */
  textContent(): string {
    let out = ''
    this.walk((node) => {
      if (node.isValueToken) out += node.content
      else if (node.type === THEMATIC_BREAK) out += '\n'
      return undefined
    })
    return out
  }

  /**
   * Convert to the JSON contract of plan § 3.1.
   *
   * `LIST_ITEM`, `TABLE_ROW` and `TABLE_CELL` are structural helpers with no
   * standalone JSON form (they are flattened into `items` / `header` / `rows`);
   * should one be serialised directly it degrades to a `paragraph` container so
   * that no information is silently dropped.
   */
  toJSON(): MarkdownJSON {
    switch (this.type) {
      case DOCUMENT:
        return { type: DOCUMENT, children: this.children.map((child) => child.toJSON()) }
      case TEXT:
        return { type: TEXT, value: this.content }
      case HTML:
        return { type: HTML, value: this.content }
      case CODE: {
        const json: MarkdownCodeJSON = { type: CODE, value: this.content, inline: this.inline === true }
        if (this.language !== undefined && this.language.length > 0) json.language = this.language
        return json
      }
      case HEADING:
        return { type: HEADING, level: this.level ?? 1, children: this.children.map((child) => child.toJSON()) }
      case PARAGRAPH:
      case STRONG:
      case EMPHASIS:
      case STRIKETHROUGH:
      case BLOCKQUOTE:
        return { type: this.type, children: this.children.map((child) => child.toJSON()) }
      case LINK: {
        const json: MarkdownLinkJSON = {
          type: LINK,
          href: this.href ?? '',
          children: this.children.map((child) => child.toJSON()),
        }
        if (this.title !== undefined) json.title = this.title
        return json
      }
      case LIST: {
        const json: MarkdownListJSON = {
          type: LIST,
          ordered: this.ordered === true,
          items: this.children.map((item) => item.children.map((child) => child.toJSON())),
        }
        if (this.ordered === true && this.start !== undefined) json.start = this.start
        return json
      }
      case TABLE: {
        const rows = this.children
        const headerRow = rows[0]
        const bodyRows = rows.slice(1)
        const align = headerRow === undefined ? [] : headerRow.children.map((cell) => cell.align ?? null)
        const json: MarkdownTableJSON = {
          type: TABLE,
          header: headerRow === undefined ? [] : headerRow.children.map((cell) => cell.children.map((n) => n.toJSON())),
          rows: bodyRows.map((row) => row.children.map((cell) => cell.children.map((n) => n.toJSON()))),
        }
        if (align.length > 0) json.align = align
        return json
      }
      case THEMATIC_BREAK:
        return { type: THEMATIC_BREAK }
      case LIST_ITEM:
      case TABLE_ROW:
      case TABLE_CELL:
        // Structural helper without a standalone JSON form: degrade to a
        // paragraph so that serialising it directly stays lossless enough.
        return { type: PARAGRAPH, children: this.children.map((child) => child.toJSON()) }
      default:
        // Exhaustiveness guard: a future token type must be handled explicitly.
        return { type: PARAGRAPH, children: this.children.map((child) => child.toJSON()) }
    }
  }

  /** Rebuild a node tree from the JSON contract of plan § 3.1. */
  static fromJSON(json: MarkdownJSON): MarkdownNode {
    switch (json.type) {
      case DOCUMENT: {
        const node = new MarkdownNode(DOCUMENT)
        for (const child of json.children) node.appendChild(MarkdownNode.fromJSON(child))
        return node
      }
      case TEXT:
        return new MarkdownNode(TEXT, { content: json.value })
      case HTML:
        return new MarkdownNode(HTML, { content: json.value })
      case CODE:
        return new MarkdownNode(CODE, {
          content: json.value,
          inline: json.inline,
          ...(json.language !== undefined ? { language: json.language } : {}),
        })
      case HEADING: {
        const node = new MarkdownNode(HEADING, { level: json.level })
        for (const child of json.children) node.appendChild(MarkdownNode.fromJSON(child))
        return node
      }
      case PARAGRAPH:
      case STRONG:
      case EMPHASIS:
      case STRIKETHROUGH:
      case BLOCKQUOTE: {
        const node = new MarkdownNode(json.type)
        for (const child of json.children) node.appendChild(MarkdownNode.fromJSON(child))
        return node
      }
      case LINK: {
        const node = new MarkdownNode(LINK, {
          href: json.href,
          ...(json.title !== undefined ? { title: json.title } : {}),
        })
        for (const child of json.children) node.appendChild(MarkdownNode.fromJSON(child))
        return node
      }
      case LIST: {
        const node = new MarkdownNode(LIST, {
          ordered: json.ordered,
          ...(json.start !== undefined ? { start: json.start } : {}),
        })
        for (const item of json.items) {
          const itemNode = new MarkdownNode(LIST_ITEM)
          for (const child of item) itemNode.appendChild(MarkdownNode.fromJSON(child))
          node.appendChild(itemNode)
        }
        return node
      }
      case TABLE: {
        const node = new MarkdownNode(TABLE)
        const headerRow = new MarkdownNode(TABLE_ROW)
        json.header.forEach((cell, index) => {
          const cellNode = new MarkdownNode(TABLE_CELL, {
            ...(json.align?.[index] != null ? { align: json.align[index] as MarkdownTableCellAlignment } : {}),
          })
          for (const child of cell) cellNode.appendChild(MarkdownNode.fromJSON(child))
          headerRow.appendChild(cellNode)
        })
        node.appendChild(headerRow)
        for (const row of json.rows) {
          const rowNode = new MarkdownNode(TABLE_ROW)
          for (const cell of row) {
            const cellNode = new MarkdownNode(TABLE_CELL)
            for (const child of cell) cellNode.appendChild(MarkdownNode.fromJSON(child))
            rowNode.appendChild(cellNode)
          }
          node.appendChild(rowNode)
        }
        return node
      }
      case THEMATIC_BREAK:
        return new MarkdownNode(THEMATIC_BREAK)
      default:
        // Unknown token from a newer producer: keep the payload, lose the shape.
        return new MarkdownNode(PARAGRAPH)
    }
  }
}

/**
 * A parsed Markdown document.
 *
 * § 3.1 of the plan declares `MarkdownDocument` as an interface with
 * `type: 'document'` and `children`; the class-based contract satisfies that
 * shape structurally while giving consumers tree helpers, so the alias is the
 * intended reading of the plan.
 */
export type MarkdownDocument = MarkdownNode

/** `true` when `value` is a `MarkdownNode` instance. */
export function isMarkdownNode(value: unknown): value is MarkdownNode {
  return value instanceof MarkdownNode
}

/** `true` when `value` is one of the known token type strings. */
export function isMarkdownTokenType(value: unknown): value is MarkdownTokenType {
  if (typeof value !== 'string') return false
  return Object.prototype.hasOwnProperty.call(MARKDOWN_TOKENS_BY_VALUE, value)
}

const MARKDOWN_TOKENS_BY_VALUE: Record<string, true> = Object.fromEntries(
  Object.values(MARKDOWN_TOKENS).map((token) => [token, true as const]),
)
