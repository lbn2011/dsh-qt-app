import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  classifyWord,
  clearHighlightCache,
  colourFor,
  DARK_PALETTE,
  detectLanguage,
  escapeHighlightText,
  highlight,
  Highlighter,
  highlightSync,
  isKnownLanguage,
  LANGUAGES,
  LIGHT_PALETTE,
  paletteFor,
  plainMarkup,
  probeShiki,
  resetShikiProbe,
  resolveLanguage,
  shikiHtmlToMarkup,
  supportedLanguages,
  tokenize,
  tokensToMarkup,
} from '../src/highlight/index.js'
import { DEFAULT_MAX_HIGHLIGHT_CHARS, PLAINTEXT_LANGUAGE } from '../src/highlight/types.js'

// ---------------------------------------------------------------------------
// language resolution
// ---------------------------------------------------------------------------

test('resolveLanguage maps aliases to a canonical id', () => {
  assert.equal(resolveLanguage('js'), 'javascript')
  assert.equal(resolveLanguage('JSX'), 'javascript')
  assert.equal(resolveLanguage('ts'), 'typescript')
  assert.equal(resolveLanguage('py'), 'python')
  assert.equal(resolveLanguage('sh'), 'bash')
  assert.equal(resolveLanguage('JSON'), 'json')
  assert.equal(resolveLanguage('text'), 'plaintext')
})

test('resolveLanguage strips the braces a fence info string can carry', () => {
  assert.equal(resolveLanguage('{.python}'), 'python')
  assert.equal(resolveLanguage('.js'), 'javascript')
  assert.equal(resolveLanguage('  ts  '), 'typescript')
})

test('resolveLanguage returns null for junk, empty and unknown info strings', () => {
  assert.equal(resolveLanguage(''), null)
  assert.equal(resolveLanguage('   '), null)
  assert.equal(resolveLanguage(null), null)
  assert.equal(resolveLanguage(undefined), null)
  assert.equal(resolveLanguage('brainfuck'), null)
})

test('isKnownLanguage rejects plaintext and unknown ids', () => {
  assert.equal(isKnownLanguage('javascript'), true)
  assert.equal(isKnownLanguage('plaintext'), false)
  assert.equal(isKnownLanguage('cobol'), false)
  assert.equal(isKnownLanguage(null), false)
})

test('supportedLanguages lists every modelled language exactly once', () => {
  const ids = supportedLanguages()
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ['javascript', 'typescript', 'python', 'bash', 'json', PLAINTEXT_LANGUAGE])
    assert.ok(ids.includes(id), `missing ${id}`)
  // every non-plaintext id must actually have a spec
  for (const id of ids) {
    if (id !== PLAINTEXT_LANGUAGE)
      assert.ok(LANGUAGES[id] !== undefined, `no spec for ${id}`)
  }
})

// ---------------------------------------------------------------------------
// language detection (5+ cases as the acceptance requires)
// ---------------------------------------------------------------------------

test('detectLanguage recognises python', () => {
  assert.equal(detectLanguage('def main(argv):\n    return 0\n'), 'python')
  assert.equal(detectLanguage('from pathlib import Path\n\nprint(Path.cwd())\n'), 'python')
  assert.equal(detectLanguage('async def fetch(url):\n    pass\n'), 'python')
})

test('detectLanguage recognises javascript', () => {
  assert.equal(detectLanguage('console.log("hello")\n'), 'javascript')
  assert.equal(detectLanguage('const x = items.map(i => i.id)\n'), 'javascript')
  assert.equal(detectLanguage('export function render(node) {\n  return node\n}\n'), 'javascript')
})

test('detectLanguage recognises typescript over javascript', () => {
  assert.equal(detectLanguage('interface User {\n  id: string\n}\n'), 'typescript')
  assert.equal(detectLanguage('const count: number = 3\n'), 'typescript')
})

test('detectLanguage recognises bash', () => {
  assert.equal(detectLanguage('#!/usr/bin/env bash\nset -euo pipefail\n'), 'bash')
  assert.equal(detectLanguage('echo "building"\nnpm run build\n'), 'bash')
  assert.equal(detectLanguage('sudo apt-get install -y cmake\n'), 'bash')
})

test('detectLanguage recognises json', () => {
  assert.equal(detectLanguage('{\n  "name": "dsh-qt-app",\n  "version": "0.1.0"\n}\n'), 'json')
})

test('detectLanguage falls back to plaintext for prose and fragments', () => {
  assert.equal(detectLanguage(''), PLAINTEXT_LANGUAGE)
  assert.equal(detectLanguage('just some words about nothing in particular'), PLAINTEXT_LANGUAGE)
  assert.equal(detectLanguage('42'), PLAINTEXT_LANGUAGE)
})

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

test('tokenize splits javascript into keyword, function, string and punctuation runs', () => {
  const spec = LANGUAGES.javascript
  assert.ok(spec !== undefined)
  const tokens = tokenize('const x = greet("hi")', spec)
  const byValue = (value: string) => tokens.find(t => t.value === value)
  assert.equal(byValue('const')?.type, 'keyword')
  assert.equal(byValue('greet')?.type, 'function')
  assert.equal(byValue('"hi"')?.type, 'string')
  assert.equal(byValue('=')?.type, 'operator')
  assert.equal(byValue('(')?.type, 'punctuation')
})

test('tokenize marks python comments and keywords', () => {
  const spec = LANGUAGES.python
  assert.ok(spec !== undefined)
  const tokens = tokenize('# note\ndef go():\n    return None\n', spec)
  assert.equal(tokens[0]?.type, 'comment')
  assert.equal(tokens[0]?.value, '# note')
  assert.ok(tokens.some(t => t.type === 'keyword' && t.value === 'def'))
  assert.ok(tokens.some(t => t.type === 'literal' && t.value === 'None'))
})

test('tokenize handles an unterminated string without consuming the rest of the file', () => {
  const spec = LANGUAGES.javascript
  assert.ok(spec !== undefined)
  const tokens = tokenize('const a = "unclosed\nconst b = 1\n', spec)
  const strings = tokens.filter(t => t.type === 'string')
  assert.equal(strings.length, 1)
  assert.equal(strings[0]?.value, '"unclosed')
  // the second line is still tokenized
  assert.ok(tokens.some(t => t.value === 'b'))
})

test('tokenize handles multi-line strings and block comments', () => {
  const js = LANGUAGES.javascript
  const py = LANGUAGES.python
  assert.ok(js !== undefined && py !== undefined)
  const withComment = tokenize('/* a\n b */\nconst x = 1', js)
  assert.equal(withComment[0]?.type, 'comment')
  assert.ok(withComment[0]?.value.startsWith('/*'))

  const triple = tokenize('x = """a\nb"""\n', py)
  assert.ok(triple.some(t => t.type === 'string' && t.value.includes('b')))
})

test('tokenize emits bash variable references as variables', () => {
  const spec = LANGUAGES.bash
  assert.ok(spec !== undefined)
  // Unquoted so the variable rule sees them; inside quotes bash semantics make
  // the whole quoted run a single string token.
  const tokens = tokenize('echo $HOME and ${PATH}\n', spec)
  assert.ok(tokens.some(t => t.type === 'variable' && t.value === '$HOME'))
  assert.ok(tokens.some(t => t.type === 'variable' && t.value === '${PATH}'))
})

test('tokenize numbers in every shape the spec claims', () => {
  const spec = LANGUAGES.javascript
  assert.ok(spec !== undefined)
  const tokens = tokenize('0xff 0b1010 1_000 3.14 1e10 2.5e-3', spec)
  const numbers = tokens.filter(t => t.type === 'number').map(t => t.value)
  assert.deepEqual(numbers, ['0xff', '0b1010', '1_000', '3.14', '1e10', '2.5e-3'])
})

test('tokenize merges uncoloured runs into a single plain token', () => {
  const spec = LANGUAGES.javascript
  assert.ok(spec !== undefined)
  const tokens = tokenize('   \n\t  ', spec)
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0]?.type, 'plain')
})

test('tokenize never throws on adversarial input', () => {
  const spec = LANGUAGES.javascript
  assert.ok(spec !== undefined)
  const samples = ['', '"', '`'.repeat(500), '/'.repeat(200), '/*', '\\', '\u0000\uFFFF', '${'.repeat(300)]
  for (const sample of samples)
    assert.doesNotThrow(() => tokenize(sample, spec))
})

test('classifyWord separates keywords, literals, types and plain identifiers', () => {
  const spec = LANGUAGES.typescript
  assert.ok(spec !== undefined)
  assert.equal(classifyWord('interface', spec), 'keyword')
  assert.equal(classifyWord('true', spec), 'literal')
  assert.equal(classifyWord('number', spec), 'type')
  assert.equal(classifyWord('whatever', spec), 'variable')
})

// ---------------------------------------------------------------------------
// markup
// ---------------------------------------------------------------------------

test('escapeHighlightText escapes the three markup-significant characters', () => {
  assert.equal(escapeHighlightText('<b>a & b</b>'), '&lt;b&gt;a &amp; b&lt;/b&gt;')
})

test('plainMarkup escapes without adding any tag', () => {
  assert.equal(plainMarkup('if (a < b) x & y'), 'if (a &lt; b) x &amp; y')
})

test('tokensToMarkup colours non-plain tokens and leaves plain text bare', () => {
  const markup = tokensToMarkup(
    [
      { type: 'plain', value: 'const ' },
      { type: 'keyword', value: 'let' },
      { type: 'plain', value: ' ' },
      { type: 'string', value: '"x"' },
    ],
    'dark',
  )
  assert.equal(markup, `const <font color="${DARK_PALETTE.keyword}">let</font> <font color="${DARK_PALETTE.string}">&quot;x&quot;</font>`.replace(/&quot;/g, '"'))
})

test('tokensToMarkup never emits an unescaped angle bracket', () => {
  const markup = tokensToMarkup([{ type: 'string', value: '<script>' }], 'dark')
  assert.ok(!markup.includes('<script>'))
  assert.ok(markup.includes('&lt;script&gt;'))
})

test('shikiHtmlToMarkup drops the pre/code wrappers and rewrites colours', () => {
  const html = '<pre class="shiki" style="background:#000"><code><span style="color:#6BA1FF">const</span> x</code></pre>'
  const markup = shikiHtmlToMarkup(html)
  assert.ok(!markup.includes('<pre'))
  assert.ok(!markup.includes('<code'))
  assert.ok(!markup.includes('<span'))
  assert.equal(markup, '<font color="#6BA1FF">const</font> x')
})

test('shikiHtmlToMarkup keeps a colourless span from swallowing later text', () => {
  const html = '<span>plain <span style="color:#fff">white</span> tail</span>'
  assert.equal(shikiHtmlToMarkup(html), 'plain <font color="#fff">white</font> tail')
})

test('shikiHtmlToMarkup closes an unbalanced font and keeps allowed inline tags', () => {
  const markup = shikiHtmlToMarkup('<span style="color:#abc">x<i>y</i>')
  assert.equal(markup, '<font color="#abc">x<i>y</i></font>')
})

test('shikiHtmlToMarkup leaves ordinary text untouched', () => {
  assert.equal(shikiHtmlToMarkup('a &lt; b'), 'a &lt; b')
})

test('paletteFor returns the palette matching the scheme', () => {
  assert.deepEqual(paletteFor('dark'), DARK_PALETTE)
  assert.deepEqual(paletteFor('light'), LIGHT_PALETTE)
  assert.equal(colourFor('light', 'keyword'), LIGHT_PALETTE.keyword)
  assert.equal(colourFor('dark', 'keyword'), DARK_PALETTE.keyword)
})

// ---------------------------------------------------------------------------
// highlight()
// ---------------------------------------------------------------------------

test('highlight returns nothing to draw for empty input', async () => {
  const result = await highlight('')
  assert.equal(result.html, '')
  assert.equal(result.engine, 'none')
  assert.equal(result.highlighted, false)
  assert.equal(result.skipReason, 'empty')
})

test('highlight treats a non-string as empty instead of throwing', async () => {
  const result = await highlight(null as unknown as string)
  assert.equal(result.html, '')
  assert.equal(result.skipReason, 'empty')
})

test('highlight colours a javascript block and reports its engine', async () => {
  resetShikiProbe()
  clearHighlightCache()
  const result = await highlight('const x = 1\n', 'js')
  assert.equal(result.language, 'javascript')
  assert.equal(result.highlighted, true)
  // Shiki is not installed in this workspace, so the built-in tokenizer answers.
  assert.equal(result.engine, 'builtin')
  assert.ok(result.html.includes('<font color="'))
  assert.ok(result.html.includes('const'))
})

test('highlight always offers an uncoloured plainHtml alongside the markup', async () => {
  const result = await highlight('if (a < b) {}\n', 'typescript')
  assert.equal(result.plainHtml, 'if (a &lt; b) {}\n')
  assert.ok(!result.plainHtml.includes('<font'))
})

test('highlight honours the size cap and refuses to tokenize a huge block', async () => {
  const huge = 'x'.repeat(DEFAULT_MAX_HIGHLIGHT_CHARS + 1)
  const result = await highlight(huge, 'javascript')
  assert.equal(result.skipReason, 'too-large')
  assert.equal(result.engine, 'none')
  assert.equal(result.highlighted, false)
  assert.equal(result.html.length, huge.length)
  assert.equal(result.tokens, undefined)
})

test('highlight accepts a smaller custom cap', async () => {
  const result = await highlight('const x = 1', 'javascript', { maxHighlightChars: 4 })
  assert.equal(result.skipReason, 'too-large')
})

test('highlight renders plaintext without colouring', async () => {
  const result = await highlight('plain words <here>', 'text')
  assert.equal(result.language, PLAINTEXT_LANGUAGE)
  assert.equal(result.engine, 'none')
  assert.equal(result.skipReason, 'plaintext')
  assert.equal(result.html, 'plain words &lt;here&gt;')
})

test('highlight treats an unknown language as plaintext', async () => {
  const result = await highlight('SOME COBOL', 'cobol')
  assert.equal(result.skipReason, 'plaintext')
  assert.equal(result.highlighted, false)
})

test('highlight detects the language when the fence carries no info string', async () => {
  const result = await highlight('def go():\n    pass\n')
  assert.equal(result.language, 'python')
  assert.equal(result.highlighted, true)
})

test('highlight picks the palette from the requested scheme', async () => {
  clearHighlightCache()
  const dark = await highlight('let a = 1', 'javascript', { scheme: 'dark' })
  const light = await highlight('let a = 1', 'javascript', { scheme: 'light' })
  assert.ok(dark.html.includes(DARK_PALETTE.keyword))
  assert.ok(light.html.includes(LIGHT_PALETTE.keyword))
  assert.notEqual(dark.html, light.html)
})

test('highlight can be forced to skip Shiki', async () => {
  const result = await highlight('const x = 1', 'javascript', { engine: 'builtin' })
  assert.equal(result.engine, 'builtin')
})

test('highlight caches a repeated block', async () => {
  clearHighlightCache()
  const first = await highlight('const cached = 1', 'javascript')
  const second = await highlight('const cached = 1', 'javascript')
  assert.equal(first.html, second.html)
  // The first call tokenizes (and hands the tokens back); the cached answer keeps
  // only the markup, because that is all the renderer needs.
  assert.ok(first.tokens !== undefined)
  assert.equal(second.tokens, undefined)
  assert.equal(second.engine, 'builtin')
})

test('highlight never throws across a deterministic fuzz run', async () => {
  let seed = 987654321
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed
  }
  const alphabet = 'abc{}()[]<>"\'`/*#\n\t 0123456789-+='
  for (let round = 0; round < 60; round += 1) {
    let sample = ''
    const length = next() % 120
    for (let i = 0; i < length; i += 1)
      sample += alphabet[next() % alphabet.length] ?? 'a'
    const language = ['js', 'python', 'bash', 'json', 'text', 'nope'][next() % 6] ?? 'js'
    const result = await highlight(sample, language)
    assert.equal(typeof result.html, 'string')
    assert.ok(!result.html.includes('<script>'))
  }
})

// ---------------------------------------------------------------------------
// highlightSync and the Highlighter class
// ---------------------------------------------------------------------------

test('highlightSync mirrors highlight for the built-in engine', () => {
  const sync = highlightSync('const x = 1', 'javascript')
  assert.equal(sync.engine, 'builtin')
  assert.equal(sync.language, 'javascript')
  assert.ok(sync.html.includes('<font color="'))
})

test('highlightSync returns the empty result for empty input', () => {
  assert.equal(highlightSync('').skipReason, 'empty')
})

test('Highlighter exposes the same behaviour with default options baked in', async () => {
  const highlighter = new Highlighter({ scheme: 'light' })
  const result = await highlighter.highlight('const x = 1', 'javascript')
  assert.ok(result.html.includes(LIGHT_PALETTE.keyword))
  assert.equal(highlighter.highlightSync('const y = 2', 'javascript').engine, 'builtin')
  assert.equal(highlighter.detectLanguage('echo hi'), 'bash')
  assert.ok(highlighter.supportedLanguages().includes('python'))
  assert.doesNotThrow(() => highlighter.clearCache())
})

test('a per-call option overrides the Highlighter default', async () => {
  const highlighter = new Highlighter({ scheme: 'light' })
  const result = await highlighter.highlight('const x = 1', 'javascript', { scheme: 'dark' })
  assert.ok(result.html.includes(DARK_PALETTE.keyword))
})

// ---------------------------------------------------------------------------
// Shiki probe (decision D1: optional and lazy)
// ---------------------------------------------------------------------------

test('probeShiki reports unavailable when shiki is not installed, without throwing', async () => {
  resetShikiProbe()
  const probe = await probeShiki()
  assert.equal(typeof probe.available, 'boolean')
  if (!probe.available)
    assert.equal(typeof probe.reason, 'string')
  // probing twice returns the cached answer
  const again = await probeShiki()
  assert.equal(again.available, probe.available)
})
