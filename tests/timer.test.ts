/**
 * Unit tests for the 10 ms event-loop bridge.
 *
 * These cover the invariants the Qt host relies on: bounded queue with
 * drop-oldest overflow, batched draining, re-entrancy protection, idempotent
 * start/stop, and per-listener error isolation.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { EVENT_LOOP_TICK_MS, MESSAGE_QUEUE_MAX } from '../src/constants.js'
import { EventLoopBridge, MessageQueue, createEventLoopBridge } from '../src/event-loop/timer.js'
import type { EventLoopMessage } from '../src/event-loop/timer.js'

test('MessageQueue drops the oldest entries once full', () => {
  const queue = new MessageQueue<number>(2)
  assert.equal(queue.push(1), true)
  assert.equal(queue.push(2), true)
  // Third push evicts the oldest message and reports backpressure.
  assert.equal(queue.push(3), false)
  assert.equal(queue.size, 2)
  assert.equal(queue.dropped, 1)
  assert.deepEqual(queue.drain(), [2, 3])
  assert.equal(queue.isEmpty, true)
})

test('MessageQueue rejects a non-positive capacity', () => {
  assert.throws(() => new MessageQueue<number>(0), RangeError)
  assert.throws(() => new MessageQueue<number>(-1), RangeError)
  assert.throws(() => new MessageQueue<number>(1.5), RangeError)
})

test('MessageQueue drain honours the limit and keeps the remainder', () => {
  const queue = new MessageQueue<number>(10)
  for (const value of [1, 2, 3, 4, 5]) queue.push(value)
  assert.deepEqual(queue.drain(2), [1, 2])
  assert.equal(queue.size, 3)
  assert.equal(queue.peek(), 3)
  assert.deepEqual(queue.drain(0), [])
})

test('defaults match the design budget (10 ms tick, 4096 message cap)', () => {
  const bridge = createEventLoopBridge()
  assert.equal(bridge.tickMs, EVENT_LOOP_TICK_MS)
  assert.equal(bridge.tickMs, 10)
  assert.equal(bridge.queue.maxSize, MESSAGE_QUEUE_MAX)
  assert.equal(bridge.running, false)
  assert.equal(bridge.stats.pending, 0)
})

test('EventLoopBridge rejects a non-positive tick', () => {
  assert.throws(() => new EventLoopBridge({ tickMs: 0 }), RangeError)
  assert.throws(() => new EventLoopBridge({ tickMs: Number.NaN }), RangeError)
})

test('post() stamps a timestamp and preserves an explicit one', () => {
  const bridge = new EventLoopBridge()
  bridge.post({ type: 'composer.submit', payload: { text: 'hi' } })
  bridge.post({ type: 'dialog.open', timestamp: 1234 })
  const [first, second] = bridge.queue.drain()
  assert.equal(first?.type, 'composer.submit')
  assert.deepEqual(first?.payload, { text: 'hi' })
  assert.equal(typeof first?.timestamp, 'number')
  assert.equal(second?.timestamp, 1234)
  // A missing payload stays absent instead of becoming `undefined`.
  assert.equal('payload' in (second as EventLoopMessage), false)
})

test('tick() drains at most maxBatchPerTick messages', () => {
  const bridge = new EventLoopBridge({ maxBatchPerTick: 2 })
  const seen: string[] = []
  bridge.subscribe((message) => seen.push(message.type))
  for (let index = 0; index < 5; index += 1) bridge.post({ type: `m${index}` })

  assert.equal(bridge.tick(), 2)
  assert.deepEqual(seen, ['m0', 'm1'])
  assert.equal(bridge.queue.size, 3)

  assert.equal(bridge.tick(), 2)
  assert.equal(bridge.tick(), 1)
  assert.equal(bridge.tick(), 0)
  assert.equal(bridge.stats.ticks, 4)
  assert.equal(bridge.stats.processed, 5)
})

test('tick() is re-entrancy guarded so a listener cannot recurse', () => {
  const bridge = new EventLoopBridge({ maxBatchPerTick: 10 })
  let nested = -1
  bridge.subscribe((message) => {
    if (message.type === 'outer') nested = bridge.tick()
    bridge.post({ type: 'inner' })
  })
  bridge.post({ type: 'outer' })

  assert.equal(bridge.tick(), 1)
  assert.equal(nested, 0, 'nested tick must not drain')
  // The message posted from inside the listener is delivered on the next tick.
  assert.equal(bridge.tick(), 1)
})

test('listener errors are isolated and routed to onError', () => {
  const failures: unknown[] = []
  const bridge = new EventLoopBridge({ onError: (error) => failures.push(error) })
  const seen: string[] = []
  bridge.subscribe(() => {
    throw new Error('boom')
  })
  bridge.subscribe((message) => seen.push(message.type))
  bridge.post({ type: 'ping' })

  assert.equal(bridge.tick(), 1)
  assert.deepEqual(seen, ['ping'], 'a broken listener must not stop the others')
  assert.equal(failures.length, 1)
  assert.equal((failures[0] as Error).message, 'boom')
})

test('start()/stop() are idempotent and the timer really fires', async () => {
  const bridge = new EventLoopBridge({ tickMs: 5, maxBatchPerTick: 32 })
  const seen: string[] = []
  bridge.subscribe((message) => seen.push(message.type))

  bridge.start()
  bridge.start()
  assert.equal(bridge.running, true)

  bridge.post({ type: 'tick-me' })
  await delay(60)
  assert.deepEqual(seen, ['tick-me'])

  bridge.stop()
  bridge.stop()
  assert.equal(bridge.running, false)

  // Messages posted while stopped are retained, not dropped.
  bridge.post({ type: 'later' })
  await delay(40)
  assert.deepEqual(seen, ['tick-me'])
  assert.equal(bridge.queue.size, 1)
  assert.equal(bridge.tick(), 1)
  assert.deepEqual(seen, ['tick-me', 'later'])
})

test('unsubscribe removes a listener', () => {
  const bridge = new EventLoopBridge()
  const seen: string[] = []
  const unsubscribe = bridge.subscribe((message) => seen.push(message.type))
  bridge.post({ type: 'first' })
  bridge.tick()
  unsubscribe()
  bridge.post({ type: 'second' })
  bridge.tick()
  assert.deepEqual(seen, ['first'])
  assert.equal(bridge.stats.listeners, 0)
})

test('dispose() stops the timer like stop()', () => {
  const bridge = new EventLoopBridge()
  bridge.start()
  bridge.dispose()
  assert.equal(bridge.running, false)
})
