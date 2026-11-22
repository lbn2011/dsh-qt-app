/**
 * Markdown AST → HTML renderer (Phase 2a fallback).
 *
 * This is the "no addon" rendering path: it consumes the `MarkdownNode` tree
 * produced by `fallback-parser.ts` (or any producer speaking the same contract,
 * including the future cmark N-API binding) and emits plain HTML that the Qt
 * side can either show in a rich-text control or convert further.
 *
 * Safety rules, in order of importance:
 *   1. Every text payload is HTML-escaped exactly once, at render time, through
 *      the same `escapeHtml()` the degraded N-API bridge uses.
 *   2. Raw HTML nodes are escaped, never passed through. Markdown may never
 *      inject markup into the native UI.
 *   3. Link destinations are sanitised: `javascript:`, `data:`, `vbscript:` and
 *      unknown schemes are dropped (the link degrades to plain text).
 *   4. Rendering never throws: an unexpected token type or a runaway tree is
 *      rendered as escaped text instead.
 */

import type { MarkdownOptions } from '../types.js'
import { escapeHtml } from '../qt-bridge/napi-loader.js'
import {
  BLOCKQUOTE,
  CODE,
  DOCUMENT,
  EMPHASIS,
  HEADING,
  HTML,
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
  type MarkdownJSON,
} from './types.js'
import { parseMarkdown } from './fallback-parser.js'

/** Options accepted by `renderMarkdownToHtml()`. */
export interface HtmlRenderOptions extends MarkdownOptions {
  /** Reject `javascript:`/`data:`/unknown-scheme link destinations. Default `true`. */
  sanitizeLinks?: boolean
  /** Maximum tree depth rendered before content degrades to escaped text. */
  maxDepth?: number
  /** Emit a soft line break as `<br />` instead of a newline. */
  breaksAsBr?: boolean
}

/**
 * C0 control characters (except tab/newline) and DEL.
 *
 * They are legal in a JS string but not in HTML text; stripping them here means
 * a paste from a terminal or a broken stream cannot corrupt the native view.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** Default depth cap; deeper subtrees are flattened to escaped text. */
export const DEFAULT_MAX_RENDER_DEPTH = 64

/** Schemes a rendered link may use when sanitising is enabled. */
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto'])

interface RenderContext {
  sanitizeLinks: boolean
  breaksAsBr: boolean
  maxDepth: number
}

/**
 * Render Markdown (or an AST) to HTML.
 *
 * A string input is parsed with the fallback parser first, which makes this the
 * single entry point for the degraded render path used by
 * `QtRendererService.renderMarkdown()`.
 */
export function renderMarkdownToHtml(
  input: string | MarkdownNode | MarkdownJSON,
  options: HtmlRenderOptions = {},
): string {
  const context: RenderContext = {
    sanitizeLinks: options.sanitizeLinks !== false,
    breaksAsBr: options.breaksAsBr === true,
    maxDepth:
      typeof options.maxDepth === 'number' && Number.isFinite(options.maxDepth) && options.maxDepth > 0
        ? Math.floor(options.maxDepth)
        : DEFAULT_MAX_RENDER_DEPTH,
  }

  try {
    const root = toNode(input, options)
    return renderNode(root, context, 0).replace(/\n+$/, '')
  } catch (error) {
    // Absolute last resort: never let a render panic reach the UI thread.
    const detail = error instanceof Error ? error.message : String(error)
    return `<pre class="dsh-qt-render-error" data-reason="${escapeHtml(detail)}">${escapeHtml(
      typeof input === 'string' ? input : '',
    )}</pre>`
  }
}

/** Convenience alias matching the plan's wording ("MarkdownNode → HTML"). */
export const renderMarkdownNode = renderMarkdownToHtml

/** Strip characters that are not allowed in HTML text nodes. */
function stripControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARACTERS, '')
}

/** Escape a text payload for HTML, honouring the soft-break option. */
export function escapeMarkdownText(text: string, options: HtmlRenderOptions = {}): string {
  const escaped = escapeHtml(stripControlCharacters(text))
  return options.breaksAsBr === true ? escaped.replace(/\n/g, '<br />\n') : escaped
}

function toNode(input: string | MarkdownNode | MarkdownJSON, options: HtmlRenderOptions): MarkdownNode {
  if (typeof input === 'string') return parseMarkdown(input, options)
  if (input instanceof MarkdownNode) return input
  return MarkdownNode.fromJSON(input)
}

function renderNode(node: MarkdownNode, context: RenderContext, depth: number): string {
  if (depth > context.maxDepth) return escapeMarkdownText(node.textContent())

  switch (node.type) {
    case DOCUMENT:
      return renderChildren(node, context, depth)

    case PARAGRAPH:
      return `<p>${renderChildren(node, context, depth)}</p>\n`

    case HEADING: {
      const level = clampHeadingLevel(node.level)
      return `<h${level}>${renderChildren(node, context, depth)}</h${level}>\n`
    }

    case TEXT:
      return escapeMarkdownText(node.content, { breaksAsBr: context.breaksAsBr })

    case HTML:
      // Raw HTML is never trusted: show it as text (plan § 3.1 / t10 contract).
      return escapeMarkdownText(node.content)

    case CODE:
      return renderCode(node)

    case STRONG:
      return `<strong>${renderChildren(node, context, depth)}</strong>`

    case EMPHASIS:
      return `<em>${renderChildren(node, context, depth)}</em>`

    case STRIKETHROUGH:
      return `<del>${renderChildren(node, context, depth)}</del>`

    case LINK:
      return renderLink(node, context, depth)

    case LIST: {
      const tag = node.ordered === true ? 'ol' : 'ul'
      const startAttribute =
        node.ordered === true && node.start !== undefined && node.start !== 1 ? ` start="${node.start}"` : ''
      return `<${tag}${startAttribute}>\n${renderChildren(node, context, depth)}</${tag}>\n`
    }

    case LIST_ITEM:
      return `<li>${renderListItemBody(node, context, depth)}</li>\n`

    case BLOCKQUOTE:
      return `<blockquote>\n${renderChildren(node, context, depth)}</blockquote>\n`

    case THEMATIC_BREAK:
      return `<hr />\n`

    case TABLE:
      return renderTable(node, context, depth)

    case TABLE_ROW:
      return `<tr>${renderChildren(node, context, depth)}</tr>\n`

    case TABLE_CELL:
      return `<td>${renderChildren(node, context, depth)}</td>`

    default:
      // Unknown token from a newer producer: keep the payload, lose the styling.
      return escapeMarkdownText(node.content.length > 0 ? node.content : node.textContent())
  }
}

function renderChildren(node: MarkdownNode, context: RenderContext, depth: number): string {
  let html = ''
  for (const child of node.children) html += renderNode(child, context, depth + 1)
  return html
}

function renderCode(node: MarkdownNode): string {
  if (node.inline === true) return `<code>${escapeMarkdownText(node.content)}</code>`
  const language =
    node.language !== undefined && node.language.length > 0
      ? ` class="language-${escapeHtml(node.language)}"`
      : ''
  return `<pre><code${language}>${escapeMarkdownText(node.content)}</code></pre>\n`
}

function renderLink(node: MarkdownNode, context: RenderContext, depth: number): string {
  const href = sanitizeHref(node.href ?? '', context.sanitizeLinks)
  const label = renderChildren(node, context, depth)
  if (href === null) return `<span class="dsh-qt-link-blocked">${label}</span>`
  const title = node.title !== undefined && node.title.length > 0 ? ` title="${escapeHtml(node.title)}"` : ''
  return `<a href="${escapeHtml(href)}"${title}>${label}</a>`
}

function renderListItemBody(node: MarkdownNode, context: RenderContext, depth: number): string {
  // Tight items (a single paragraph) drop the `<p>` wrapper, matching common
  // HTML renderers and keeping list output compact.
  const children = node.children
  const only = children[0]
  if (children.length === 1 && only !== undefined && only.type === PARAGRAPH) {
    return renderChildren(only, context, depth + 1)
  }
  // Loose/multi-block items keep their `<p>` wrappers: valid HTML and no
  // tag surgery (stripping closing tags produced malformed output).
  return renderChildren(node, context, depth)
}

function renderTable(node: MarkdownNode, context: RenderContext, depth: number): string {
  const rows = node.children
  if (rows.length === 0) return ''

  const headerRow = rows[0]
  const head =
    headerRow === undefined
      ? ''
      : `<thead>\n<tr>${headerRow.children
          .map((cell) => `<th${alignAttribute(cell)}>${renderChildren(cell, context, depth + 2)}</th>`)
          .join('')}</tr>\n</thead>\n`

  const bodyRows = rows.slice(1)
  const body =
    bodyRows.length === 0
      ? ''
      : `<tbody>\n${bodyRows
          .map(
            (row) =>
              `<tr>${row.children
                .map((cell) => `<td${alignAttribute(cell)}>${renderChildren(cell, context, depth + 2)}</td>`)
                .join('')}</tr>`,
          )
          .join('\n')}\n</tbody>\n`

  return `<table>\n${head}${body}</table>\n`
}

function alignAttribute(cell: MarkdownNode): string {
  if (cell.type !== TABLE_CELL || cell.align === undefined) return ''
  return ` align="${cell.align}"`
}

function clampHeadingLevel(level: number | undefined): number {
  if (typeof level !== 'number' || !Number.isFinite(level)) return 1
  return Math.min(6, Math.max(1, Math.floor(level)))
}

/**
 * Normalise and vet a link destination.
 *
 * Returns `null` when the destination must not become a clickable link.
 * Relative paths, fragments and the allow-listed schemes pass through
 * unchanged; control characters are stripped before the scheme test so that
 * `java\tscript:` cannot smuggle a scheme past it.
 */
export function sanitizeHref(href: string, enabled = true): string | null {
  const trimmed = href.trim()
  if (trimmed.length === 0) return null
  if (!enabled) return trimmed

  const normalised = trimmed.replace(/[\u0000-\u0020\u007f]/g, '')
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalised)
  if (schemeMatch === null) return trimmed // relative path, `/abs` or `#fragment`
  const scheme = (schemeMatch[1] ?? '').toLowerCase()
  return ALLOWED_SCHEMES.has(scheme) ? trimmed : null
}

