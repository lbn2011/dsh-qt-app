/**
 * Unit tests for the tool-event projection (I2, RQ-03/RQ-04).
 *
 * The projection is the only place that turns official `session/event` records
 * (`tool/call`, `tool/result`) plus live `tool.args` deltas into the row DTO the
 * QML side renders. It is a pure, synchronous value transformer: no bridge, no
 * timers, no I/O — so every rule below is pinned without a Qt process.
 *
 * Pinned rules (docs/PHASE-3-IMPLEMENTATION-PLAN.md §3.2/§3.4/§3.7, S5/P6):
 *   1. Five states, no sixth: preparing → running → {ok, error, stopped}.
 *   2. Terminal states never regress; a rejected transition is dropped AND counted.
 *   3. `seq` is strictly monotonic per session: duplicates and older events are
 *      dropped, never replayed.
 *   4. One session at a time (P6): switching sessions rebuilds from a snapshot,
 *      and events from any other session are dropped.
 *   5. Three-layer truncation: variant preview lines, 2000 lines, 200 KB.
 *   6. Charts render only from explicit structured data (`meta.chart`); content
 *      text that merely looks like JSON is never parsed into a chart (§3.7).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  TOOL_CHART_MAX_POINTS,
  TOOL_PREVIEW_LINES,
  TOOL_RESULT_MAX_BYTES,
  TOOL_RESULT_MAX_LINES,
} from '../src/tools/dto.js'
import type { ToolRowDTO } from '../src/tools/dto.js'
import { ToolProjection } from '../src/tools/projection.js'
import type { SessionEventLike } from '../src/tools/projection.js'

const SESSION = 's-1'
const EPOCH = 'e-1'

/** Build one official `tool/call` event (types.d.ts:362). */
function callEvent(seq: number, callId: string, name: string, args: string, turn = 1, step = 1): SessionEventLike {
  return { type: 'tool/call', seq, time: 1_700_000_000_000 + seq, data: { turn, step, callId, name, arguments: args } }
}

/** Build one official `tool/result` event (types.d.ts:382). */
function resultEvent(
  seq: number,
  callId: string,
  content: readonly unknown[],
  extra: { isError?: boolean; error?: { name: string; code: string; reason?: string }; meta?: unknown } = {},
  turn = 1,
  step = 1,
): SessionEventLike {
  const message: Record<string, unknown> = {
    role: 'tool',
    source: { kind: 'tool', callId },
    toolCallId: callId,
    content,
  }
  if (extra.isError === true) message['isError'] = true
  const data: Record<string, unknown> = { turn, step, message }
  if (extra.error !== undefined) data['error'] = extra.error
  if (extra.meta !== undefined) data['meta'] = extra.meta
  return { type: 'tool/result', seq, time: 1_700_000_000_000 + seq, data }
}

function textBlock(text: string): unknown {
  return { type: 'text', text }
}

/** Fresh projection pinned to one session. */
function projection(options?: ConstructorParameters<typeof ToolProjection>[0]): ToolProjection {
  const p = new ToolProjection(options)
  p.beginSession(SESSION, EPOCH)
  return p
}

function only(rows: readonly ToolRowDTO[]): ToolRowDTO {
  assert.equal(rows.length, 1, `expected exactly one row, got ${rows.length}`)
  const row = rows[0]
  assert.ok(row !== undefined)
  return row
}

// ---------------------------------------------------------------------------
// 1. The five-state ladder.
// ---------------------------------------------------------------------------

test('tool/call runs then tool/result settles to ok', () => {
  const p = projection()

  const running = only(p.applyEvent(callEvent(1, 'c1', 'bash', '{"command":"ls"}')))
  assert.equal(running.state, 'running')
  assert.equal(running.callId, 'c1')
  assert.equal(running.name, 'bash')
  assert.equal(running.variant, 'bash')
  assert.equal(running.argsRaw, '{"command":"ls"}')

  const settled = only(p.applyEvent(resultEvent(2, 'c1', [textBlock('a.txt\nb.txt')])))
  assert.equal(settled.state, 'ok')
  assert.equal(settled.resultText, 'a.txt\nb.txt')
  assert.equal(settled.error, null)
  assert.equal(p.watermark, 2)
})

test('a streaming args delta opens a preparing row without a settled call', () => {
  const p = projection()

  const preparing = p.applyArgsDelta({ callId: 'c1', argsDelta: '{"command":', seq: 1 })
  assert.ok(preparing !== null)
  assert.equal(preparing.state, 'preparing')
  assert.equal(preparing.argsRaw, '{"command":')
  assert.equal(preparing.argsComplete, false)
  assert.equal(preparing.variant, 'others', 'no tool name yet, so the variant is the generic one')

  const grown = p.applyArgsDelta({ callId: 'c1', argsDelta: '"ls"}', seq: 2 })
  assert.ok(grown !== null)
  assert.equal(grown.argsRaw, '{"command":"ls"}')
  assert.equal(grown.state, 'preparing')

  const running = only(p.applyEvent(callEvent(3, 'c1', 'bash', '{"command":"ls"}')))
  assert.equal(running.state, 'running')
  assert.equal(running.argsComplete, true)
  assert.equal(running.variant, 'bash')
})

test('an interrupted result settles to stopped, not error', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'c1', 'bash', '{"command":"sleep 99"}'))

  const stopped = only(
    p.applyEvent(
      resultEvent(2, 'c1', [], { isError: true, error: { name: 'ToolInterruptedError', code: 'interrupted' } }),
    ),
  )
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.error?.code, 'interrupted')
  assert.match(stopped.resultText, /ToolInterruptedError: interrupted/, 'empty content falls back to the error identity')
})

test('a meta.stopped result degrades to error, not stopped (official parity)', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'c1', 'bash', '{"command":"ls"}'))

  const row = only(p.applyEvent(resultEvent(2, 'c1', [textBlock('partial')], { meta: { stopped: true } })))
  assert.equal(row.state, 'error')
})

// ---------------------------------------------------------------------------
// 2. Terminal states never regress; rejected transitions are counted.
// ---------------------------------------------------------------------------

test('terminal state never regresses and the regression is counted', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'c1', 'bash', '{"command":"ls"}'))
  p.applyEvent(resultEvent(2, 'c1', [textBlock('done')]))

  // A later tool/call for the same callId (replayed/duplicated wire event).
  assert.deepEqual(p.applyEvent(callEvent(3, 'c1', 'bash', '{"command":"ls"}')), [])
  assert.equal(p.row('c1')?.state, 'ok', 'the settled row survives')
  assert.equal(p.row('c1')?.resultText, 'done')

  // A second result for the same call must not overwrite the first.
  assert.deepEqual(p.applyEvent(resultEvent(4, 'c1', [textBlock('late')])), [])
  assert.equal(p.row('c1')?.resultText, 'done')

  assert.equal(p.stats.rejectedTransitions, 2)
})

test('a terminal row cannot be reopened by a later args delta', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'c1', 'bash', '{"command":"ls"}'))
  p.applyEvent(resultEvent(2, 'c1', [textBlock('done')]))

  assert.equal(p.applyArgsDelta({ callId: 'c1', argsDelta: '{"more":', seq: 3 }), null)
  assert.equal(p.row('c1')?.state, 'ok')
  assert.equal(p.stats.rejectedTransitions, 1)
})

// ---------------------------------------------------------------------------
// 3. Out-of-order and duplicate seq.
// ---------------------------------------------------------------------------

test('a duplicate seq is dropped and counted', () => {
  const p = projection()
  p.applyEvent(callEvent(5, 'c1', 'bash', '{"command":"ls"}'))

  assert.deepEqual(p.applyEvent(callEvent(5, 'c1', 'bash', '{"command":"rm -rf /"}')), [])
  assert.equal(p.row('c1')?.argsRaw, '{"command":"ls"}')
  assert.equal(p.stats.duplicates, 1)
  assert.equal(p.watermark, 5)
})

test('an older seq arriving late is dropped, never replayed', () => {
  const p = projection()
  p.applyEvent(callEvent(9, 'c1', 'bash', '{"command":"ls"}'))

  assert.deepEqual(p.applyEvent(callEvent(3, 'c2', 'read', '{"path":"a"}')), [])
  assert.equal(p.row('c2'), null, 'the late row never appears')
  assert.equal(p.stats.outOfOrder, 1)
  assert.equal(p.watermark, 9)
})

// ---------------------------------------------------------------------------
// 4. One session at a time (P6) and snapshot reconciliation.
// ---------------------------------------------------------------------------

test('switching sessions clears rows and rebuilds from the snapshot', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'c1', 'bash', '{"command":"ls"}'))
  assert.equal(p.rows().length, 1)

  const snapshot = p.applySnapshot({
    sessionKey: 's-2',
    epoch: EPOCH,
    seq: 7,
    events: [callEvent(6, 'x1', 'read', '{"path":"b"}'), resultEvent(7, 'x1', [textBlock('contents')])],
  })

  assert.equal(p.sessionKey, 's-2')
  assert.equal(p.watermark, 7)
  assert.equal(p.row('c1'), null, 'the previous session is gone, not aggregated')
  assert.equal(snapshot.rows.length, 1)
  const rebuilt = only(snapshot.rows)
  assert.equal(rebuilt.callId, 'x1')
  assert.equal(rebuilt.state, 'ok')
})

test('events from another session are dropped and counted', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'c1', 'bash', '{"command":"ls"}'))

  assert.deepEqual(p.applyEvent(callEvent(2, 'z1', 'bash', '{"command":"whoami"}'), { sessionKey: 's-9' }), [])
  assert.equal(p.row('z1'), null)
  assert.equal(p.stats.foreignSession, 1)
})

test('an epoch change asks for a resync instead of trusting the seq watermark', () => {
  const p = projection()
  p.applyEvent(callEvent(10, 'c1', 'bash', '{"command":"ls"}'))
  assert.equal(p.needsResync(), false)

  // A restarted host replays seq 1; the watermark alone would drop it.
  p.applyEvent(callEvent(1, 'c9', 'read', '{"path":"a"}'), { epoch: 'e-2' })
  assert.equal(p.needsResync(), true)

  p.applySnapshot({ sessionKey: SESSION, epoch: 'e-2', seq: 1, events: [callEvent(1, 'c9', 'read', '{"path":"a"}')] })
  assert.equal(p.needsResync(), false)
  assert.equal(p.epoch, 'e-2')
  assert.equal(p.rows().length, 1, 'the rebuild replaces, it does not append')
})

test('history and live events end up in one ordered list', () => {
  const p = projection()
  // Historical slice from the snapshot, then a live event on top of it.
  p.applySnapshot({
    sessionKey: SESSION,
    epoch: EPOCH,
    seq: 2,
    events: [callEvent(1, 'h1', 'read', '{"path":"a"}'), resultEvent(2, 'h1', [textBlock('a')])],
  })
  p.applyEvent(callEvent(3, 'l1', 'bash', '{"command":"ls"}'))

  assert.deepEqual(
    p.rows().map((row) => row.callId),
    ['h1', 'l1'],
  )
})

// ---------------------------------------------------------------------------
// 5. Arguments and results: verbatim, truncated, never guessed.
// ---------------------------------------------------------------------------

test('incomplete JSON arguments are kept verbatim, never repaired or hidden', () => {
  const p = projection()
  const row = only(p.applyEvent(callEvent(1, 'c1', 'write', '{"path": "src/a.ts", "content": "unterminated')))

  assert.equal(row.argsRaw, '{"path": "src/a.ts", "content": "unterminated')
  assert.equal(row.argsComplete, false)
  assert.equal(row.state, 'running')
})

test('complete JSON arguments are flagged complete but never field-rendered', () => {
  const p = projection()
  const row = only(p.applyEvent(callEvent(1, 'c1', 'read', '{"path":"src/a.ts"}')))

  assert.equal(row.argsComplete, true)
  assert.equal(row.summary, 'src/a.ts', 'the known-variant summary key is the only field ever read')
  assert.equal(row.titleKey, 'tool.title.read')
})

test('a result larger than the byte cap is truncated with an explicit marker', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'c1', 'bash', '{"command":"cat big"}'))

  const huge = 'x'.repeat(TOOL_RESULT_MAX_BYTES + 5_000)
  const row = only(p.applyEvent(resultEvent(2, 'c1', [textBlock(huge)])))

  assert.equal(row.resultTruncated, true)
  assert.equal(row.resultBytes, huge.length)
  assert.ok(Buffer.byteLength(row.resultText, 'utf8') <= TOOL_RESULT_MAX_BYTES + 64, 'the stored text respects the cap')
  assert.match(row.resultText, /\[truncated\]$/)
  assert.equal(p.stats.truncatedResults, 1)
})

test('a result larger than the line cap keeps the head and says so', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'c1', 'bash', '{"command":"seq"}'))

  const lines = Array.from({ length: TOOL_RESULT_MAX_LINES + 10 }, (_, i) => `line ${i}`)
  const row = only(p.applyEvent(resultEvent(2, 'c1', [textBlock(lines.join('\n'))])))

  assert.equal(row.resultLines, TOOL_RESULT_MAX_LINES + 10)
  assert.equal(row.resultTruncated, true)
  assert.match(row.resultText, /\[truncated\]$/)
  assert.equal(row.resultText.split('\n').length, TOOL_RESULT_MAX_LINES + 1, 'head lines plus the marker line')
})

test('the preview is the first variant-specific lines of the result', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'c1', 'read', '{"path":"a"}'))

  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`)
  const row = only(p.applyEvent(resultEvent(2, 'c1', [textBlock(lines.join('\n'))])))

  assert.equal(row.resultPreview, lines.slice(0, TOOL_PREVIEW_LINES).join('\n'))
  assert.equal(row.resultPreview.split('\n').length, TOOL_PREVIEW_LINES)
  assert.equal(row.resultTruncated, false, 'a short-of-cap result is not reported as truncated')
})

test('non-text result blocks are preserved as pretty JSON, text blocks verbatim', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'c1', 'read_image', '{"path":"a.png"}'))

  const row = only(
    p.applyEvent(resultEvent(2, 'c1', [textBlock('caption'), { type: 'image', mimeType: 'image/png' }])),
  )
  assert.equal(row.state, 'ok')
  assert.match(row.resultText, /^caption\n\{\n {2}"type": "image"/)
})

// ---------------------------------------------------------------------------
// 6. Explicit charts only (§3.7).
// ---------------------------------------------------------------------------

const VALID_CHART = {
  chart: {
    type: 'bar',
    title: 'Requests per day',
    series: [{ name: 'api', points: [{ x: 1, y: 10 }, { x: 2, y: 20 }] }],
  },
}

test('an explicit valid bar chart is projected into the row', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'c1', 'run_code', '{"description":"plot"}'))
  const row = only(p.applyEvent(resultEvent(2, 'c1', [textBlock('done')], { meta: VALID_CHART })))

  assert.ok(row.chart !== null)
  assert.equal(row.chart.type, 'bar')
  assert.equal(row.chart.title, 'Requests per day')
  assert.equal(row.chart.series.length, 1)
  assert.equal(row.chart.series[0]?.points.length, 2)
  assert.equal(row.chartRejected, null)
  assert.equal(p.stats.chartsRendered, 1)
})

test('an explicit valid line chart with multiple series is projected', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'c1', 'run_code', '{"description":"plot"}'))
  const row = only(
    p.applyEvent(
      resultEvent(2, 'c1', [textBlock('done')], {
        meta: {
          chart: {
            type: 'line',
            series: [
              { name: 'a', points: [{ x: 0, y: 1 }, { x: 1, y: 0 }] },
              { name: 'b', points: [{ x: 0, y: 2 }, { x: 1, y: 3 }] },
            ],
          },
        },
      }),
    ),
  )

  assert.equal(row.chart?.type, 'line')
  assert.equal(row.chart?.series.length, 2)
})

test('invalid explicit chart data degrades with a reason instead of guessing', () => {
  const cases: { name: string; meta: unknown; reason: string }[] = [
    { name: 'unknown type', meta: { chart: { type: 'pie', series: [{ points: [{ x: 0, y: 1 }] }] } }, reason: 'type-mismatch' },
    { name: 'no series', meta: { chart: { type: 'bar', series: [] } }, reason: 'empty-series' },
    { name: 'non-numeric point', meta: { chart: { type: 'bar', series: [{ points: [{ x: 0, y: 'high' }] }] } }, reason: 'non-numeric' },
    { name: 'not an object', meta: { chart: 'nope' }, reason: 'type-mismatch' },
    {
      name: 'too many points',
      meta: {
        chart: {
          type: 'line',
          series: [{ points: Array.from({ length: TOOL_CHART_MAX_POINTS + 1 }, (_, i) => ({ x: i, y: i })) }],
        },
      },
      reason: 'too-many-points',
    },
  ]

  for (const testCase of cases) {
    const p = projection()
    p.applyEvent(callEvent(1, 'c1', 'run_code', '{"description":"plot"}'))
    const row = only(p.applyEvent(resultEvent(2, 'c1', [textBlock('done')], { meta: testCase.meta })))

    assert.equal(row.chart, null, `${testCase.name}: no chart is fabricated`)
    assert.equal(row.chartRejected, testCase.reason, `${testCase.name}: the reason is explicit`)
    assert.equal(row.resultText, 'done', `${testCase.name}: the raw text still renders`)
    assert.equal(p.stats.chartsRejected, 1)
  }
})

test('chart JSON appearing in result text is never parsed into a chart', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'c1', 'bash', '{"command":"cat chart.json"}'))
  const row = only(
    p.applyEvent(resultEvent(2, 'c1', [textBlock(JSON.stringify(VALID_CHART))])),
  )

  assert.equal(row.chart, null, 'guessing a chart from arbitrary JSON is forbidden')
  assert.equal(row.chartRejected, null, 'nothing was "rejected" — no chart was ever declared')
  assert.equal(row.resultText, JSON.stringify(VALID_CHART))
  assert.equal(p.stats.chartsRendered, 0)
})

test('chart data in the arguments is never read as a chart either', () => {
  const p = projection()
  const row = only(p.applyEvent(callEvent(1, 'c1', 'run_code', JSON.stringify({ description: 'plot', ...VALID_CHART }))))

  assert.equal(row.chart, null)
  assert.equal(row.state, 'running')
})

test('an explicit table is passed through with its headers', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'c1', 'run_code', '{"description":"table"}'))
  const row = only(
    p.applyEvent(
      resultEvent(2, 'c1', [textBlock('done')], {
        meta: { table: { headers: ['day', 'requests'], rows: [['mon', '10'], ['tue', '20']] } },
      }),
    ),
  )

  assert.equal(row.table?.headers.length, 2)
  assert.equal(row.table?.rows.length, 2)
  assert.equal(row.chart, null, 'a table is not silently turned into a chart')
})

// ---------------------------------------------------------------------------
// 7. Nested calls (subagents) keep their parent link and stable order.
// ---------------------------------------------------------------------------

test('a nested subagent call keeps its parent link and sorts after the parent', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'p1', 'subagent', '{"description":"explore"}'))
  p.applyEvent(callEvent(2, 'child1', 'bash', '{"command":"ls"}', 1, 1))
  p.applyEvent(resultEvent(3, 'child1', [textBlock('ok')], { meta: { parentCallId: 'p1' } }))

  const child = p.row('child1')
  assert.ok(child !== undefined && child !== null)
  if (child === undefined || child === null) throw new Error('the child row must exist')
  assert.equal(child.parentCallId, 'p1')
  assert.equal(child.state, 'ok')

  const ids = p.rows().map((row) => row.callId)
  assert.equal(ids[0], 'p1', 'the parent keeps first-seen order')
  assert.ok(ids.includes('child1'))
})

test('unknown event types are ignored without touching the watermark', () => {
  const p = projection()
  p.applyEvent(callEvent(4, 'c1', 'bash', '{"command":"ls"}'))

  assert.deepEqual(p.applyEvent({ type: 'assistant/message', seq: 5, data: {} }), [])
  assert.equal(p.stats.unknownEvents, 1)
  assert.equal(p.watermark, 4, 'a non-tool event is not the projection watermark')
})

test('malformed tool events are dropped and counted, never thrown', () => {
  const p = projection()

  assert.deepEqual(p.applyEvent({ type: 'tool/call', seq: 1, data: null }), [])
  assert.deepEqual(p.applyEvent({ type: 'tool/call', seq: 2, data: { callId: '' } }), [])
  assert.deepEqual(p.applyEvent({ type: 'tool/result', seq: 3, data: { message: { toolCallId: 'x' } } }), [])
  assert.equal(p.stats.malformed, 3)
  assert.equal(p.rows().length, 0)
})

test('the snapshot watermark is the highest applied seq, not the last call time', () => {
  const p = projection()
  p.applyEvent(callEvent(1, 'c1', 'bash', '{"command":"ls"}'))
  p.applyEvent(resultEvent(6, 'c1', [textBlock('ok')]))

  const snapshot = p.snapshot()
  assert.equal(snapshot.sessionKey, SESSION)
  assert.equal(snapshot.seq, 6)
  assert.equal(snapshot.rows.length, 1)
  assert.equal(snapshot.truncated, false)
})
