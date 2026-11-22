import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseMarkdown } from '../src/markdown/fallback-parser.js'
import {
  DEFAULT_MAX_STREAM_LENGTH,
  DeltaMarkdownParser,
  chunkText,
  createDeltaMarkdownParser,
  findFreezeOffset,
  hasOpenFence,
} from '../src/markdown/streaming.js'
import type { MarkdownJSON } from '../src/markdown/types.js'

// ---- helpers -------------------------------------------------------------

function childrenOf(document: MarkdownJSON): MarkdownJSON[] {
  return (document as { children?: MarkdownJSON[] }).children ?? []
}

function types(document: MarkdownJSON): string[] {
  return childrenOf(document).map(child => child.type)
}

function canonical(document: MarkdownJSON): string {
  return JSON.stringify(document)
}

/** Feed `text` in chunks and return the last snapshot. */
function stream(text: string, size = 7, options = {}): DeltaMarkdownParser {
  const parser = createDeltaMarkdownParser(options)
  for (const chunk of chunkText(text, size))
    parser.onChunk(chunk)
  return parser
}

/** A document that exercises every block kind the streaming path can meet. */
const SAMPLE = [
  '# Streaming title',
  '',
  'A paragraph with *emphasis*, **strong**, `code` and a [link](https://example.com).',
  '',
  '```js',
  'const value = 1',
  '',
  'console.log(value)',
  '```',
  '',
  '> A quote',
  '> spanning lines',
  '',
  '- first item',
  '- second item',
  '',
  '1. one',
  '2. two',
  '',
  '| a | b |',
  '| --- | ---: |',
  '| 1 | 2 |',
  '',
  '---',
  '',
  'Trailing paragraph.',
].join('\n')

// ---- contract ------------------------------------------------------------

test('the module exposes the streaming contract', () => {
  assert.equal(typeof DeltaMarkdownParser, 'function')
  assert.equal(typeof createDeltaMarkdownParser, 'function')
  assert.equal(typeof chunkText, 'function')
  assert.equal(typeof findFreezeOffset, 'function')
  assert.equal(typeof hasOpenFence, 'function')
  assert.equal(DEFAULT_MAX_STREAM_LENGTH, 1_000_000)
})

test('an empty stream yields an empty document and no updates', () => {
  const parser = createDeltaMarkdownParser()
  const snapshot = parser.onChunk('')
  assert.equal(snapshot.text, '')
  assert.deepEqual(snapshot.updates, [])
  assert.equal(snapshot.blockCount, 0)
  assert.equal(snapshot.openFence, false)
  assert.deepEqual(types(snapshot.document), [])
})

test('a single chunk parses exactly like the batch parser', () => {
  const parser = createDeltaMarkdownParser()
  const snapshot = parser.onChunk(SAMPLE)
  assert.equal(canonical(snapshot.document), canonical(parseMarkdown(SAMPLE).toJSON()))
  assert.ok(snapshot.updates.length > 0)
  assert.deepEqual(snapshot.updates.map(update => update.type), snapshot.updates.map(() => 'append'))
  assert.equal(snapshot.updates.length, snapshot.blockCount)
  assert.deepEqual(snapshot.updates.map(update => update.index), snapshot.updates.map((_, index) => index))
  assert.equal(snapshot.blockIds.length, snapshot.blockCount)
})

test('a non-string delta is ignored instead of throwing', () => {
  const parser = createDeltaMarkdownParser()
  // Deliberately bypass the types: a host may hand over junk.
  parser.onChunk(undefined as unknown as string)
  parser.onChunk(null as unknown as string)
  parser.onChunk(42 as unknown as string)
  assert.equal(parser.text, '')
  assert.equal(parser.blockCount, 0)
})

// ---- chunked equivalence -------------------------------------------------

test('100-character chunks produce the same document as one parse', () => {
  const parser = stream(SAMPLE, 100)
  assert.equal(parser.text, SAMPLE)
  assert.equal(canonical(parser.document), canonical(parseMarkdown(SAMPLE).toJSON()))
})

test('every chunk size from 1 to 40 converges on the reference document', () => {
  const reference = canonical(parseMarkdown(SAMPLE).toJSON())
  for (let size = 1; size <= 40; size += 1) {
    const parser = stream(SAMPLE, size)
    assert.equal(parser.text, SAMPLE, `size ${size} lost text`)
    assert.equal(canonical(parser.document), reference, `size ${size} diverged`)
  }
})

test('character-at-a-time streaming matches the batch parser', () => {
  const parser = stream(SAMPLE, 1)
  assert.equal(canonical(parser.document), canonical(parseMarkdown(SAMPLE).toJSON()))
})

// ---- incremental behaviour ----------------------------------------------

test('appending to a paragraph emits a replace for the same node id', () => {
  const parser = createDeltaMarkdownParser()
  const first = parser.onChunk('Hello')
  assert.equal(first.blockCount, 1)
  const id = first.blockIds[0]
  assert.ok(id)

  const second = parser.onChunk(' world')
  assert.equal(second.blockCount, 1)
  assert.equal(second.blockIds[0], id, 'the paragraph kept its id')
  assert.equal(second.updates.length, 1)
  assert.equal(second.updates[0]?.type, 'replace')
  assert.equal(second.updates[0]?.nodeId, id)
  assert.equal(second.updates[0]?.index, 0)
})

test('a new block after a blank line is appended, not a full rebuild', () => {
  const parser = createDeltaMarkdownParser()
  parser.onChunk('# Title')
  const snapshot = parser.onChunk('\n\nFirst paragraph')
  assert.deepEqual(types(snapshot.document), ['heading', 'paragraph'])
  const appended = snapshot.updates.filter(update => update.type === 'append')
  assert.equal(appended.length, 1)
  assert.equal(appended[0]?.index, 1)
  assert.equal(appended[0]?.node?.type, 'paragraph')
})

test('emphasis completed across two chunks lands in the final text', () => {
  const parser = createDeltaMarkdownParser()
  parser.onChunk('This is *very')
  const snapshot = parser.onChunk(' important* text')
  const paragraph = childrenOf(snapshot.document)[0]
  assert.equal(paragraph?.type, 'paragraph')
  const inline = ((paragraph as { children?: MarkdownJSON[] } | undefined)?.children ?? []).map(child => child.type)
  assert.ok(inline.includes('emphasis'), `expected emphasis, got ${inline.join(',')}`)
  assert.equal(snapshot.text, 'This is *very important* text')
})

test('an open fenced code block is reported until it closes', () => {
  const parser = createDeltaMarkdownParser()
  const opened = parser.onChunk('```js\nconst a = 1')
  assert.equal(opened.openFence, true)
  const stillOpen = parser.onChunk('\nconst b = 2')
  assert.equal(stillOpen.openFence, true)
  const closed = parser.onChunk('\n```')
  assert.equal(closed.openFence, false)
  assert.deepEqual(types(closed.document), ['code'])
})

test('a blank line inside a fence is not treated as a block boundary', () => {
  const parser = createDeltaMarkdownParser()
  parser.onChunk('```js\nconst a = 1\n\nconst b = 2')
  assert.equal(parser.blockCount, 1, 'the fence stays one block')
  const snapshot = parser.onChunk('\n```')
  assert.deepEqual(types(snapshot.document), ['code'])
})

test('prepending a code block then adding paragraphs keeps order', () => {
  const parser = createDeltaMarkdownParser()
  parser.onChunk('```py\nprint(1)\n```')
  const snapshot = parser.onChunk('\n\nAfter the block')
  assert.deepEqual(types(snapshot.document), ['code', 'paragraph'])
  const code = childrenOf(snapshot.document)[0]
  assert.equal(code?.type, 'code')
  assert.equal((code as { language?: string }).language, 'py')
})

test('interspersed updates keep untouched blocks at their ids', () => {
  const parser = createDeltaMarkdownParser()
  const first = parser.onChunk('# Title\n\nBody')
  assert.equal(first.blockCount, 2)
  const titleId = first.blockIds[0]
  const bodyId = first.blockIds[1]

  const second = parser.onChunk(' grows')
  assert.equal(second.blockIds[0], titleId, 'the heading was not touched')
  assert.equal(second.blockIds[1], bodyId, 'the paragraph kept its id')
  const touched = second.updates.map(update => update.nodeId)
  assert.deepEqual(touched, [bodyId])
})

test('replacing a paragraph with a list changes the node id', () => {
  const parser = createDeltaMarkdownParser()
  const first = parser.onChunk('plain text')
  const id = first.blockIds[0]
  const second = parser.onChunk('\n\n- one\n- two')
  assert.deepEqual(types(second.document), ['paragraph', 'list'])
  assert.notEqual(second.blockIds[1], id)
})

// ---- unicode -------------------------------------------------------------

test('an emoji split between chunks is never broken', () => {
  const parser = createDeltaMarkdownParser()
  const emoji = '😀' // surrogate pair
  parser.onChunk(`before ${emoji[0]}`)
  assert.ok(!parser.text.includes('\ud83d'), 'the lone high surrogate was held back')
  const snapshot = parser.onChunk(`${emoji[1]} after`)
  assert.equal(snapshot.text, `before ${emoji} after`)
  assert.equal(childrenOf(snapshot.document)[0]?.type, 'paragraph')
})

test('flush releases a held lone surrogate at end of stream', () => {
  const parser = createDeltaMarkdownParser()
  parser.onChunk('tail \ud83d')
  assert.equal(parser.text, 'tail ')
  const flushed = parser.flush()
  assert.equal(flushed.text, 'tail \ud83d')
})

test('chunkText never splits a surrogate pair', () => {
  const text = 'a😀b😀c'
  for (let size = 1; size <= text.length; size += 1) {
    const chunks = chunkText(text, size)
    assert.equal(chunks.join(''), text, `size ${size} lost text`)
    for (const chunk of chunks) {
      const first = chunk.charCodeAt(0)
      const last = chunk.charCodeAt(chunk.length - 1)
      assert.ok(!(last >= 0xd800 && last <= 0xdbff), `size ${size} ended a chunk on a high surrogate`)
      assert.ok(!(first >= 0xdc00 && first <= 0xdfff), `size ${size} started a chunk on a low surrogate`)
    }
  }
})

test('unicode-heavy documents stream correctly at a tiny chunk size', () => {
  const text = '# 标题\n\n日本語のテキストと絵文字 😀🎉 と *強調*。\n\n- 項目一\n- 項目二'
  const parser = stream(text, 3)
  assert.equal(parser.text, text)
  assert.equal(canonical(parser.document), canonical(parseMarkdown(text).toJSON()))
})

// ---- corrections ---------------------------------------------------------

test('a correction that rewrites an earlier block is reflected', () => {
  const parser = createDeltaMarkdownParser()
  parser.onChunk('The value is 1.\n\nSecond paragraph.')
  // A real host would resend the whole text when the model corrects itself.
  const snapshot = parser.setText('The value is 2.\n\nSecond paragraph.')
  assert.equal(snapshot.text, 'The value is 2.\n\nSecond paragraph.')
  const paragraph = childrenOf(snapshot.document)[0]
  const rendered = JSON.stringify(paragraph)
  assert.ok(rendered.includes('2'), `expected the correction to land: ${rendered}`)
})

test('back-and-forth between two shapes converges each time', () => {
  const parser = createDeltaMarkdownParser()
  const variants = [
    'plain',
    'plain\n\n- a',
    'plain',
    '# heading\n\n- a\n- b',
    'plain',
  ]
  for (const variant of variants) {
    const snapshot = parser.setText(variant)
    assert.equal(canonical(snapshot.document), canonical(parseMarkdown(variant).toJSON()), variant)
  }
})

test('reset clears text, ids and counters', () => {
  const parser = stream('some text\n\nmore', 3)
  parser.reset()
  assert.equal(parser.text, '')
  assert.equal(parser.blockCount, 0)
  assert.deepEqual(parser.blockIds, [])
  assert.equal(parser.fullReparses, 0)
  const snapshot = parser.onChunk('# fresh')
  assert.deepEqual(types(snapshot.document), ['heading'])
})

// ---- integrity -----------------------------------------------------------

test('verifyIntegrity agrees with a from-scratch parse on every chunk', () => {
  const parser = createDeltaMarkdownParser({ verifyIntegrity: true })
  const chunks = chunkText(SAMPLE, 11)
  for (const chunk of chunks) {
    const snapshot = parser.onChunk(chunk)
    assert.equal(
      canonical(snapshot.document),
      canonical(parseMarkdown(parser.text).toJSON()),
      `diverged at ${JSON.stringify(parser.text.slice(-30))}`,
    )
  }
  assert.ok(parser.fullReparses >= chunks.length)
})

test('verifyIntegrity survives a deterministic fuzz run', () => {
  let seed = 987654321
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const alphabet = ['#', ' ', '\n', '-', '*', '`', '>', '|', 'a', 'b', '1', '.', '~', '[', ']', '(', ')', '😀']
  for (let run = 0; run < 40; run += 1) {
    const parser = createDeltaMarkdownParser({ verifyIntegrity: true })
    for (let step = 0; step < 12; step += 1) {
      const length = 1 + Math.floor(random() * 6)
      let delta = ''
      for (let index = 0; index < length; index += 1)
        delta += alphabet[Math.floor(random() * alphabet.length)] ?? 'a'
      const snapshot = parser.onChunk(delta)
      assert.equal(
        canonical(snapshot.document),
        canonical(parseMarkdown(parser.text).toJSON()),
        `run ${run} step ${step}`,
      )
    }
  }
})

// ---- limits and options --------------------------------------------------

test('the length cap stops the stream instead of buffering forever', () => {
  const parser = createDeltaMarkdownParser({ maxLength: 20 })
  parser.onChunk('x'.repeat(15))
  const snapshot = parser.onChunk('y'.repeat(15))
  assert.equal(snapshot.text.length, 20)
  assert.equal(parser.truncated, true)
  parser.onChunk('more')
  assert.equal(parser.text.length, 20)
})

test('the onUpdate callback receives every non-empty snapshot', () => {
  const seen: number[] = []
  const parser = createDeltaMarkdownParser({ onUpdate: snapshot => seen.push(snapshot.blockCount) })
  parser.onChunk('one')
  parser.onChunk('\n\ntwo')
  assert.equal(seen.length, 2)
  assert.equal(seen[1], 2)
})

test('a throwing onUpdate listener does not break the stream', () => {
  const parser = createDeltaMarkdownParser({
    onUpdate: () => {
      throw new Error('listener exploded')
    },
  })
  const snapshot = parser.onChunk('still works')
  assert.equal(snapshot.blockCount, 1)
  assert.equal(parser.text, 'still works')
})

test('chunkText handles degenerate sizes and empty input', () => {
  assert.deepEqual(chunkText('', 10), [])
  assert.deepEqual(chunkText('abc', 0), ['abc'])
  assert.deepEqual(chunkText('abc', -5), ['abc'])
  assert.deepEqual(chunkText('abc', 100), ['abc'])
  assert.deepEqual(chunkText('abcdef', 2), ['ab', 'cd', 'ef'])
})

test('onChunks returns the last snapshot', () => {
  const parser = createDeltaMarkdownParser()
  const snapshot = parser.onChunks(['# a', '\n\n', 'body'])
  assert.equal(snapshot.text, '# a\n\nbody')
  assert.deepEqual(types(snapshot.document), ['heading', 'paragraph'])
})

// ---- freeze helper -------------------------------------------------------

test('findFreezeOffset only reports boundaries that cannot change', () => {
  assert.equal(findFreezeOffset('no boundary yet'), 0)
  assert.equal(findFreezeOffset('text\n\n'), 0, 'a trailing blank run is not a boundary')
  assert.ok(findFreezeOffset('one\n\ntwo') > 0)
  assert.equal(findFreezeOffset('```\ncode\n\ncode\n```'), 0, 'blank lines inside a fence are not boundaries')
  assert.equal(findFreezeOffset('- item\n\n- item'), 0, 'a following list item can still attach backwards')
  assert.equal(findFreezeOffset('> quote\n\n> more'), 0, 'a following quote line can still attach backwards')
  assert.ok(findFreezeOffset('para\n\n# heading') > 0)
})

test('hasOpenFence tracks fence state', () => {
  assert.equal(hasOpenFence('plain'), false)
  assert.equal(hasOpenFence('```'), true)
  assert.equal(hasOpenFence('```js\ncode'), true)
  assert.equal(hasOpenFence('```js\ncode\n```'), false)
  assert.equal(hasOpenFence('~~~\nx\n~~~'), false)
})
