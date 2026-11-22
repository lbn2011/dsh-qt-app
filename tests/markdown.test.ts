/**
 * Unit tests for the Phase 2a Markdown AST, fallback parser and HTML renderer.
 *
 * The suite is intentionally behavioural: it asserts on the AST contract
 * (`toJSON()`) and on rendered HTML rather than on parser internals, because
 * those two are what task t11 (native cmark binding) and t12 (QML renderer)
 * consume.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

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
  MARKDOWN_TOKENS,
  MarkdownNode,
  PARAGRAPH,
  STRONG,
  STRIKETHROUGH,
  TABLE,
  TEXT,
  THEMATIC_BREAK,
  isMarkdownNode,
  isMarkdownTokenType,
  type MarkdownJSON,
} from '../src/markdown/types.js'
import {
  DEFAULT_MAX_NESTING,
  MAX_INPUT_LENGTH,
  parseInlineMarkdown,
  parseMarkdown,
  textToParagraph,
} from '../src/markdown/fallback-parser.js'
import { escapeMarkdownText, renderMarkdownToHtml, sanitizeHref } from '../src/markdown/renderer.js'
import { escapeHtml } from '../src/qt-bridge/napi-loader.js'

/** Compact `type` projection of a subtree, for structural assertions. */
function shape(node: MarkdownNode): string {
  if (node.isLeaf) return `${node.type}(${node.content})`
  return `${node.type}[${node.children.map((child) => shape(child)).join(',')}]`
}

function blocks(markdown: string): MarkdownNode[] {
  return parseMarkdown(markdown).children
}

function onlyBlock(markdown: string): MarkdownNode {
  const children = blocks(markdown)
  assert.ok(children.length >= 1, `expected at least one block for ${JSON.stringify(markdown)}`)
  const first = children[0]
  assert.ok(first !== undefined)
  return first
}

// ---------------------------------------------------------------------------
// AST contract
// ---------------------------------------------------------------------------

test('markdown tokens are exported and validated', () => {
  assert.deepEqual(Object.keys(MARKDOWN_TOKENS).sort(), [
    'BLOCKQUOTE',
    'CODE',
    'DOCUMENT',
    'EMPHASIS',
    'HEADING',
    'HTML',
    'LINK',
    'LIST',
    'LIST_ITEM',
    'PARAGRAPH',
    'STRIKETHROUGH',
    'STRONG',
    'TABLE',
    'TABLE_CELL',
    'TABLE_ROW',
    'TEXT',
    'THEMATIC_BREAK',
  ])
  assert.equal(MARKDOWN_TOKENS.CODE, CODE)
  assert.equal(MARKDOWN_TOKENS.STRONG, STRONG)
  assert.equal(MARKDOWN_TOKENS.EMPHASIS, EMPHASIS)
  assert.equal(MARKDOWN_TOKENS.LINK, LINK)
  assert.ok(isMarkdownTokenType(CODE))
  assert.ok(!isMarkdownTokenType('not-a-token'))
  assert.ok(!isMarkdownTokenType(42))
})

test('MarkdownNode exposes type/content/parent/children and keeps the tree consistent', () => {
  const root = new MarkdownNode(DOCUMENT)
  const paragraph = new MarkdownNode(PARAGRAPH)
  const text = new MarkdownNode(TEXT, { content: 'hello' })

  root.appendChild(paragraph)
  paragraph.appendChild(text)

  assert.equal(root.type, DOCUMENT)
  assert.equal(root.parent, null)
  assert.equal(paragraph.parent, root)
  assert.equal(text.parent, paragraph)
  assert.deepEqual(root.children, [paragraph])
  assert.equal(text.content, 'hello')
  assert.equal(text.depth, 2)
  assert.equal(text.root, root)
  assert.ok(text.isLeaf)
  assert.ok(text.isValueToken)
  assert.ok(!paragraph.isLeaf)
  assert.ok(isMarkdownNode(root))
  assert.ok(!isMarkdownNode({ type: DOCUMENT }))

  // Re-parenting detaches from the previous parent (no node appears twice).
  const other = new MarkdownNode(PARAGRAPH)
  other.appendChild(text)
  assert.deepEqual(paragraph.children, [])
  assert.equal(paragraph.removeChild(text), false)
  assert.equal(other.removeChild(text), true)
  assert.equal(text.parent, null)

  // replaceChild keeps document order and fixes both parents.
  const a = new MarkdownNode(TEXT, { content: 'a' })
  const b = new MarkdownNode(TEXT, { content: 'b' })
  const c = new MarkdownNode(TEXT, { content: 'c' })
  const holder = new MarkdownNode(PARAGRAPH)
  holder.appendChild(a)
  holder.appendChild(b)
  assert.equal(holder.replaceChild(a, c), true)
  assert.deepEqual(holder.children, [c, b])
  assert.equal(a.parent, null)
  assert.equal(c.parent, holder)
})

test('walk/find/textContent traverse the tree in document order', () => {
  const document = parseMarkdown('## Title\n\ntext **bold** [link](https://example.com)')
  const types: string[] = []
  document.walk((node) => {
    types.push(node.type)
    return undefined
  })
  assert.deepEqual(types, [DOCUMENT, HEADING, TEXT, PARAGRAPH, TEXT, STRONG, TEXT, TEXT, LINK, TEXT])

  const bold = document.find((node) => node.type === STRONG)
  assert.ok(bold !== undefined)
  assert.equal(bold.textContent(), 'bold')
  assert.equal(document.findAll((node) => node.type === TEXT).length, 5)
  assert.equal(document.textContent(), 'Titletext bold link')
})

test('toJSON/fromJSON round trip preserves the § 3.1 contract', () => {
  const document = parseMarkdown('# T\n\n- a *b*\n- c\n\n| x | y |\n| :- | -: |\n| 1 | 2 |\n\n```ts\nconst a = 1\n```')
  const json = document.toJSON()
  assert.equal(json.type, DOCUMENT)
  if (json.type !== DOCUMENT) assert.fail('expected a document root')
  const restored = MarkdownNode.fromJSON(json)

  assert.deepEqual(restored.toJSON(), json)
  assert.equal(restored.children.length, 4)
  assert.equal(restored.children[0]?.type, HEADING)

  const list = json.children[1]
  assert.equal(list?.type, LIST)
  if (list?.type === LIST) {
    assert.equal(list.ordered, false)
    assert.equal(list.items.length, 2)
    assert.equal(list.items[0]?.[0]?.type, PARAGRAPH)
  }

  const table = json.children[2]
  assert.equal(table?.type, TABLE)
  if (table?.type === TABLE) {
    assert.equal(table.header.length, 2)
    assert.deepEqual(table.align, ['left', 'right'])
    assert.equal(table.rows.length, 1)
  }

  const code = json.children[3]
  assert.equal(code?.type, CODE)
  if (code?.type === CODE) {
    assert.equal(code.inline, false)
    assert.equal(code.language, 'ts')
    assert.equal(code.value, 'const a = 1')
  }
})

test('structural helper tokens degrade to paragraphs when serialised directly', () => {
  const item = new MarkdownNode(LIST_ITEM)
  item.appendChild(new MarkdownNode(TEXT, { content: 'x' }))
  const json = item.toJSON()
  assert.equal(json.type, PARAGRAPH)
  if (json.type === PARAGRAPH) assert.equal(json.children[0]?.type, TEXT)
})

test('fromJSON tolerates an unknown token type from a newer producer', () => {
  const json = { type: 'somethingNew', children: [] } as unknown as MarkdownJSON
  const node = MarkdownNode.fromJSON(json)
  assert.equal(node.type, PARAGRAPH)
})

// ---------------------------------------------------------------------------
// Parser robustness: empty / degenerate input
// ---------------------------------------------------------------------------

test('empty and whitespace-only input produce an empty document', () => {
  for (const input of ['', '   ', '\n\n\n', '\t\t', '\r\n\r\n']) {
    const document = parseMarkdown(input)
    assert.equal(document.type, DOCUMENT)
    assert.deepEqual(document.children, [])
    assert.equal(renderMarkdownToHtml(input), '')
  }
})

test('non-string input is treated as empty instead of throwing', () => {
  const document = parseMarkdown(undefined as unknown as string)
  assert.deepEqual(document.children, [])
})

test('input beyond MAX_INPUT_LENGTH is truncated rather than rejected', () => {
  assert.equal(MAX_INPUT_LENGTH, 5_000_000)
  const document = parseMarkdown('a'.repeat(MAX_INPUT_LENGTH + 10))
  assert.equal(document.children.length, 1)
  assert.equal(document.children[0]?.textContent().length, MAX_INPUT_LENGTH)
})

// ---------------------------------------------------------------------------
// Block-level parsing
// ---------------------------------------------------------------------------

test('ATX headings parse levels 1-6 and reject a missing space', () => {
  for (let level = 1; level <= 6; level += 1) {
    const heading = onlyBlock(`${'#'.repeat(level)} Title`)
    assert.equal(heading.type, HEADING)
    assert.equal(heading.level, level)
    assert.equal(heading.textContent(), 'Title')
  }
  // `#hashtag` and `#######` are not headings.
  assert.equal(onlyBlock('#hashtag').type, PARAGRAPH)
  assert.equal(onlyBlock('####### seven').type, PARAGRAPH)
  // Closing hashes are stripped.
  assert.equal(onlyBlock('## Closed ##').textContent(), 'Closed')
})

test('setext headings honour = and - underlines', () => {
  const h1 = onlyBlock('Title\n=====')
  assert.equal(h1.type, HEADING)
  assert.equal(h1.level, 1)

  const h2 = onlyBlock('Subtitle\n---')
  assert.equal(h2.type, HEADING)
  assert.equal(h2.level, 2)
})

test('paragraphs join soft line breaks and split on blank lines', () => {
  const children = blocks('line one\nline two\n\nsecond paragraph')
  assert.equal(children.length, 2)
  assert.equal(children[0]?.textContent(), 'line one\nline two')
  assert.equal(children[1]?.textContent(), 'second paragraph')
})

test('fenced code blocks capture content and language', () => {
  const code = onlyBlock('```ts\nconst a = 1\nconst b = 2\n```')
  assert.equal(code.type, CODE)
  assert.equal(code.inline, false)
  assert.equal(code.language, 'ts')
  assert.equal(code.content, 'const a = 1\nconst b = 2')

  const tilde = onlyBlock('~~~python\nprint(1)\n~~~')
  assert.equal(tilde.language, 'python')

  const plain = onlyBlock('```\nno language\n```')
  assert.equal(plain.language, undefined)
})

test('an unterminated code fence consumes to end of input without throwing', () => {
  const code = onlyBlock('```js\nlet a = 1\n\nlet b = 2')
  assert.equal(code.type, CODE)
  assert.equal(code.content, 'let a = 1\n\nlet b = 2')
  assert.equal(renderMarkdownToHtml('```js\nlet a = 1'), '<pre><code class="language-js">let a = 1</code></pre>')
})

test('markdown inside a fence is not interpreted', () => {
  const code = onlyBlock('```\n**not bold** [x](y)\n```')
  assert.equal(code.type, CODE)
  assert.equal(code.content, '**not bold** [x](y)')
})

test('thematic breaks accept ---, *** and ___', () => {
  for (const rule of ['---', '***', '___', '- - -', ' * * * ']) {
    assert.equal(onlyBlock(rule).type, THEMATIC_BREAK, rule)
  }
  assert.equal(renderMarkdownToHtml('---'), '<hr />')
})

test('unordered lists support nesting through indentation', () => {
  const list = onlyBlock('- a\n- b\n  - b1\n  - b2\n- c')
  assert.equal(list.type, LIST)
  assert.equal(list.ordered, false)
  assert.equal(list.children.length, 3)

  const second = list.children[1]
  assert.ok(second !== undefined)
  assert.equal(second.type, LIST_ITEM)
  assert.equal(second.children.length, 2)
  assert.equal(second.children[0]?.type, PARAGRAPH)
  const nested = second.children[1]
  assert.equal(nested?.type, LIST)
  assert.equal(nested?.children.length, 2)
})

test('ordered lists keep the start ordinal', () => {
  const list = onlyBlock('3. three\n4. four')
  assert.equal(list.type, LIST)
  assert.equal(list.ordered, true)
  assert.equal(list.start, 3)
  assert.equal(list.children.length, 2)
  assert.equal(renderMarkdownToHtml('3. three\n4. four'), '<ol start="3">\n<li>three</li>\n<li>four</li>\n</ol>')

  const fromOne = onlyBlock('1. one')
  assert.equal(fromOne.start, undefined)
  assert.equal(renderMarkdownToHtml('1. one'), '<ol>\n<li>one</li>\n</ol>')
})

test('list items may contain several block children', () => {
  const list = onlyBlock('- first paragraph\n\n  second paragraph')
  const item = list.children[0]
  assert.ok(item !== undefined)
  assert.equal(item.children.length, 2)
  assert.deepEqual(
    item.children.map((child) => child.type),
    [PARAGRAPH, PARAGRAPH],
  )
  assert.match(renderMarkdownToHtml('- first\n\n  second'), /<li><p>first<\/p>\n<p>second<\/p>\n<\/li>/)
})

test('ordered and unordered items do not merge into one list', () => {
  const children = blocks('- a\n1. b')
  assert.equal(children.length, 2)
  assert.equal(children[0]?.ordered, false)
  assert.equal(children[1]?.ordered, true)
})

test('blockquotes nest and may contain any block', () => {
  const quote = onlyBlock('> quote\n> > nested')
  assert.equal(quote.type, BLOCKQUOTE)
  assert.equal(quote.children.length, 2)
  assert.equal(quote.children[1]?.type, BLOCKQUOTE)

  const withList = onlyBlock('> - a\n> - b')
  assert.equal(withList.type, BLOCKQUOTE)
  assert.equal(withList.children[0]?.type, LIST)
})

test('lazy continuation ends the blockquote and starts a paragraph', () => {
  const children = blocks('> quoted\ncontinued')
  assert.equal(children.length, 2)
  assert.equal(children[0]?.type, BLOCKQUOTE)
  assert.equal(children[1]?.type, PARAGRAPH)
  assert.equal(children[1]?.textContent(), 'continued')
})

test('GFM tables parse header, alignment and body rows', () => {
  const table = onlyBlock('| a | b |\n| :-- | :-: |\n| 1 | 2 |\n| 3 | 4 |')
  assert.equal(table.type, TABLE)
  assert.equal(table.children.length, 3)

  const header = table.children[0]
  assert.ok(header !== undefined)
  assert.equal(header.children.length, 2)
  assert.equal(header.children[0]?.align, 'left')
  assert.equal(header.children[1]?.align, 'center')

  const html = renderMarkdownToHtml('| a | b |\n| :-- | :-: |\n| 1 | 2 |')
  assert.match(html, /<th align="left">a<\/th>/)
  assert.match(html, /<th align="center">b<\/th>/)
  assert.match(html, /<td align="left">1<\/td>/)
})

test('a pipe row without a delimiter row stays a paragraph', () => {
  const paragraph = onlyBlock('a | b\nnot a table')
  assert.equal(paragraph.type, PARAGRAPH)
  assert.equal(paragraph.textContent(), 'a | b\nnot a table')
  // Wide delimiter mismatch is not a table either.
  assert.equal(onlyBlock('| a | b |\n| --- |').type, PARAGRAPH)
})

test('tables can be disabled through enableTables', () => {
  const document = parseMarkdown('| a |\n| --- |\n| 1 |', { enableTables: false })
  assert.equal(document.children[0]?.type, PARAGRAPH)
})

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

test('emphasis, strong, strikethrough and inline code parse', () => {
  const paragraph = onlyBlock('a *em* b **strong** c ~~gone~~ d `code`')
  const types = paragraph.children.map((child) => child.type)
  assert.deepEqual(types, [TEXT, EMPHASIS, TEXT, STRONG, TEXT, STRIKETHROUGH, TEXT, CODE])

  const code = paragraph.children[7]
  assert.ok(code !== undefined)
  assert.equal(code.inline, true)
  assert.equal(code.content, 'code')
  assert.equal(
    renderMarkdownToHtml('a *em* b **strong** c ~~gone~~ d `code`'),
    '<p>a <em>em</em> b <strong>strong</strong> c <del>gone</del> d <code>code</code></p>',
  )
})

test('nested emphasis keeps the inner delimiter intact', () => {
  const paragraph = onlyBlock('*a **b** c*')
  assert.equal(shape(paragraph), 'paragraph[emphasis[text(a ),strong[text(b)],text( c)]]')
  assert.equal(renderMarkdownToHtml('*a **b** c*'), '<p><em>a <strong>b</strong> c</em></p>')
})

test('triple delimiters produce strong+emphasis and unclosed ones stay literal', () => {
  assert.equal(shape(onlyBlock('***both***')), 'paragraph[strong[emphasis[text(both)]]]')
  assert.equal(onlyBlock('**not closed').textContent(), '**not closed')
  assert.equal(onlyBlock('*a _b_ c*').children.length, 1)
})

test('underscore emphasis does not fire inside a word', () => {
  const paragraph = onlyBlock('snake_case_name and _em_')
  assert.equal(shape(paragraph), 'paragraph[text(snake_case_name and ),emphasis[text(em)]]')
})

test('inline code spans strip one padding space and keep markup literal', () => {
  const padded = onlyBlock('` code `')
  assert.equal(padded.children[0]?.content, 'code')

  const markup = onlyBlock('`**not bold**`')
  assert.equal(markup.children[0]?.type, CODE)
  assert.equal(markup.children[0]?.content, '**not bold**')

  // Double-backtick spans may contain single backticks.
  const nested = onlyBlock('``a `b` c``')
  assert.equal(nested.children[0]?.content, 'a `b` c')
})

test('an unterminated backtick run stays literal text', () => {
  const paragraph = onlyBlock('`unterminated')
  assert.equal(paragraph.children.length, 1)
  assert.equal(paragraph.children[0]?.type, TEXT)
  assert.equal(paragraph.children[0]?.content, '`unterminated')
})

test('links parse label, href and title', () => {
  const paragraph = onlyBlock('[label](https://example.com "Title")')
  const link = paragraph.children[0]
  assert.ok(link !== undefined)
  assert.equal(link.type, LINK)
  assert.equal(link.href, 'https://example.com')
  assert.equal(link.title, 'Title')
  assert.equal(link.textContent(), 'label')
  assert.equal(
    renderMarkdownToHtml('[label](https://example.com "Title")'),
    '<p><a href="https://example.com" title="Title">label</a></p>',
  )
})

test('autolinks parse http(s), mailto and bare e-mail addresses', () => {
  const paragraph = onlyBlock('<https://example.com> <mailto:a@b.com> <c@d.org>')
  const links = paragraph.children.filter((child) => child.type === LINK)
  assert.equal(links.length, 3)
  assert.deepEqual(
    links.map((link) => link.href),
    ['https://example.com', 'mailto:a@b.com', 'mailto:c@d.org'],
  )
})

test('incomplete links degrade to text instead of consuming the line', () => {
  for (const input of ['[a](', '[a]', '[a](b', '[](x)', '[a](<>)']) {
    const rendered = renderMarkdownToHtml(input)
    assert.equal(typeof rendered, 'string')
    assert.ok(!rendered.includes('<a href'), input)
  }
})

test('backslash escapes win over inline syntax', () => {
  assert.equal(onlyBlock('\\*not em\\*').textContent(), '*not em*')
  assert.equal(onlyBlock('\\\\').textContent(), '\\')
  assert.equal(onlyBlock('\\`not code\\`').textContent(), '`not code`')
})

test('parseInlineMarkdown exposes inline parsing without a block wrapper', () => {
  const nodes = parseInlineMarkdown('a **b**')
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0]?.type, TEXT)
  assert.equal(nodes[1]?.type, STRONG)
  assert.deepEqual(parseInlineMarkdown(''), [])
})

// ---------------------------------------------------------------------------
// Renderer safety
// ---------------------------------------------------------------------------

test('all raw HTML is escaped, never rendered', () => {
  const html = renderMarkdownToHtml('<script>alert(1)</script> <b>tag</b>')
  assert.equal(html, '<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;b&gt;tag&lt;/b&gt;</p>')
  assert.ok(!html.includes('<script>'))

  // An HTML token produced by any producer is escaped too.
  const node = new MarkdownNode(HTML, { content: '<img onerror=x>' })
  assert.equal(renderMarkdownToHtml(node), '&lt;img onerror=x&gt;')
})

test('dangerous link schemes are dropped, safe ones survive', () => {
  assert.equal(sanitizeHref('javascript:alert(1)'), null)
  assert.equal(sanitizeHref('Java\nScript:alert(1)'), null)
  assert.equal(sanitizeHref('data:text/html;base64,PHNjcmlwdD4='), null)
  assert.equal(sanitizeHref('vbscript:msgbox'), null)
  assert.equal(sanitizeHref('file:///etc/passwd'), null)
  assert.equal(sanitizeHref('https://example.com/a?b=c'), 'https://example.com/a?b=c')
  assert.equal(sanitizeHref('mailto:a@b.com'), 'mailto:a@b.com')
  assert.equal(sanitizeHref('/relative/path'), '/relative/path')
  assert.equal(sanitizeHref('#fragment'), '#fragment')
  assert.equal(sanitizeHref(''), null)
  assert.equal(sanitizeHref('javascript:alert(1)', false), 'javascript:alert(1)')

  const html = renderMarkdownToHtml('[evil](javascript:alert(1))')
  assert.equal(html, '<p><span class="dsh-qt-link-blocked">evil</span></p>')
})

test('control characters are stripped from rendered text', () => {
  const html = renderMarkdownToHtml('a\u0000b\u0007c')
  assert.equal(html, '<p>abc</p>')
  assert.equal(escapeMarkdownText('x\u0000y'), 'xy')
})

test('escapeMarkdownText matches the shared escapeHtml contract', () => {
  assert.equal(escapeMarkdownText('<&>"\''), escapeHtml('<&>"\''))
  assert.equal(escapeMarkdownText('a\nb', { breaksAsBr: true }), 'a<br />\nb')
})

test('renderMarkdownToHtml accepts an AST and a JSON document', () => {
  const document = parseMarkdown('hello **world**')
  const fromNode = renderMarkdownToHtml(document)
  const fromJson = renderMarkdownToHtml(document.toJSON())
  assert.equal(fromNode, '<p>hello <strong>world</strong></p>')
  assert.equal(fromJson, fromNode)
})

test('the renderer never throws on malformed input or unknown tokens', () => {
  const junk = ['````', '~~~', '[[[', '(((', '***', '____', '>>>>>', '|---|---|', '\\', '<>', '<a', '[a](', '`']
  for (const input of junk) {
    assert.equal(typeof renderMarkdownToHtml(input), 'string')
  }

  // A node whose type was tampered with falls back to escaped text.
  const weird = new MarkdownNode('mystery' as unknown as typeof TEXT, { content: '<x>' })
  assert.equal(renderMarkdownToHtml(weird), '&lt;x&gt;')

  // Depth cap: an artificially deep tree is flattened, not exploded.
  let root = new MarkdownNode(PARAGRAPH)
  let cursor = root
  for (let depth = 0; depth < 200; depth += 1) {
    const child = new MarkdownNode(EMPHASIS)
    cursor.appendChild(child)
    cursor = child
  }
  cursor.appendChild(new MarkdownNode(TEXT, { content: 'deep' }))
  const html = renderMarkdownToHtml(root, { maxDepth: 4 })
  assert.ok(html.includes('deep'))
})

// ---------------------------------------------------------------------------
// Limits and performance
// ---------------------------------------------------------------------------

test('pathological nesting degrades to literal text instead of recursing forever', () => {
  const deepQuote = `${'> '.repeat(DEFAULT_MAX_NESTING + 8)}bottom`
  const document = parseMarkdown(deepQuote)
  assert.equal(document.children[0]?.type, BLOCKQUOTE)
  assert.ok(document.textContent().includes('bottom'))

  const manyStars = `${'*'.repeat(64)}x${'*'.repeat(64)}`
  const rendered = renderMarkdownToHtml(manyStars)
  assert.equal(typeof rendered, 'string')
  assert.ok(rendered.length > 0)
})

test('large inputs parse quickly and never throw', () => {
  const started = Date.now()

  const longLine = parseMarkdown('x'.repeat(10_000))
  assert.equal(longLine.children.length, 1)

  parseMarkdown('*'.repeat(20_000))
  parseMarkdown('`'.repeat(5_000))

  const mixed = '**a* _b_ `c` [d](e) ~~f~~ '.repeat(2_000)
  const rendered = renderMarkdownToHtml(mixed)
  assert.ok(rendered.length > 0)

  const listLines = Array.from({ length: 2_000 }, (_, index) => `- item ${index}`).join('\n')
  const list = parseMarkdown(listLines).children[0]
  assert.equal(list?.type, LIST)
  assert.equal(list?.children.length, 2_000)

  const elapsed = Date.now() - started
  assert.ok(elapsed < 5_000, `parse budget exceeded: ${elapsed}ms`)
})

test('parser fuzz: random punctuation soup never throws', () => {
  const alphabet = '*_~`[]()<>|\\#>-+ .\nab1'
  let seed = 123456789
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed
  }
  for (let iteration = 0; iteration < 200; iteration += 1) {
    let input = ''
    const length = next() % 120
    for (let index = 0; index < length; index += 1) {
      input += alphabet.charAt(next() % alphabet.length)
    }
    const document = parseMarkdown(input)
    assert.equal(document.type, DOCUMENT)
    const json = document.toJSON()
    assert.equal(MarkdownNode.fromJSON(json).toJSON().type, DOCUMENT)
    assert.equal(typeof renderMarkdownToHtml(document), 'string')
  }
})

test('textToParagraph wraps plain strings', () => {
  assert.equal(textToParagraph('x').type, PARAGRAPH)
  assert.equal(textToParagraph('x').textContent(), 'x')
  assert.deepEqual(textToParagraph('').children, [])
})
