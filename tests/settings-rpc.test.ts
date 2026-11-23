// Tests for the settings bridge (src/bridge/settings-rpc.ts).
//
// Organised by the claims the I3 contract makes:
//
//   1. `settings.describe` reports revisions and never a secret byte
//   2. `settings.mutate` is path-operation-only (no update/replace) and forwards
//      `expectedRevision` verbatim
//   3. a revision conflict keeps its own code and its expected/actual pair
//   4. a read-only document is refused before the provider is touched
//   5. registration exposes exactly settings.describe / settings.mutate
//
// The fake service is a structural `SettingsServiceLike`; it also carries the
// `update`/`replace` methods the official service has, so the "never called"
// assertions mean something.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createSettingsRpc,
  registerSettingsMethods,
  SETTINGS_METHODS,
  SettingsRpcError,
  type SettingsDescriptor,
  type SettingsDescribeOptions,
  type SettingsPathOp,
  type SettingsServiceLike,
} from '../src/bridge/settings-rpc.js'

const SECRET_SENTINEL = 'sk-live-THIS-MUST-NEVER-ESCAPE-9f3a'

interface MutateCall {
  ns: string
  ops: readonly SettingsPathOp[]
  expectedRevision: number | undefined
}

class ConflictError extends Error {
  readonly code = 'SETTINGS_CONFLICT'
  readonly expected: number
  readonly actual: number

  constructor(expected: number, actual: number) {
    super(`revision conflict: expected ${expected}, actual ${actual}`)
    this.name = 'SettingsConflictError'
    this.expected = expected
    this.actual = actual
  }
}

class FakeSettings implements SettingsServiceLike {
  writable = true
  descriptors: SettingsDescriptor[] = []
  readonly describeCalls: Array<SettingsDescribeOptions | undefined> = []
  readonly mutateCalls: MutateCall[] = []
  replaceCalls = 0
  updateCalls = 0
  failWith: Error | undefined

  describe(options?: SettingsDescribeOptions): SettingsDescriptor[] {
    this.describeCalls.push(options)
    return this.descriptors.map((descriptor) => structuredClone(descriptor))
  }

  async mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void> {
    this.mutateCalls.push({ ns, ops: structuredClone(ops), expectedRevision })
    if (this.failWith !== undefined) throw this.failWith
  }

  // Present on the official service; the bridge must never reach them.
  async replace(): Promise<void> {
    this.replaceCalls += 1
  }

  async update(): Promise<void> {
    this.updateCalls += 1
  }
}

function descriptor(overrides: Partial<SettingsDescriptor> = {}): SettingsDescriptor {
  return {
    ns: 'llm.deepseek',
    autoGenerate: false,
    schema: { type: 'object' },
    value: { provider: 'deepseek', model: 'deepseek-chat' },
    revision: 4,
    applies: 'live',
    ...overrides,
  }
}

test('describe asks for redaction and reports the highest revision', () => {
  const settings = new FakeSettings()
  settings.descriptors = [
    descriptor({ ns: 'llm.deepseek', revision: 7 }),
    descriptor({ ns: 'ui.theme', revision: 3, value: { mode: 'dark' } }),
  ]
  const rpc = createSettingsRpc({ settings })

  const result = rpc.describe(undefined)

  assert.equal(result.revision, 7)
  assert.equal(result.namespaces.length, 2)
  assert.deepEqual(settings.describeCalls, [{ redactSecrets: true }])
  assert.equal(result.namespaces[0]?.ns, 'llm.deepseek')
  assert.equal(result.namespaces[0]?.applies, 'live')
  assert.equal(result.namespaces[1]?.value && (result.namespaces[1]?.value as { mode: string }).mode, 'dark')
})

test('describe filters by namespace without changing the redaction request', () => {
  const settings = new FakeSettings()
  settings.descriptors = [descriptor(), descriptor({ ns: 'ui.theme' })]
  const rpc = createSettingsRpc({ settings })

  const result = rpc.describe({ ns: 'ui.theme' })

  assert.equal(result.namespaces.length, 1)
  assert.equal(result.namespaces[0]?.ns, 'ui.theme')
  assert.equal(result.revision, 4)
  assert.deepEqual(settings.describeCalls, [{ redactSecrets: true }])
})

test('describe with an unknown namespace is empty, not an error', () => {
  const settings = new FakeSettings()
  settings.descriptors = [descriptor()]
  const rpc = createSettingsRpc({ settings })

  const result = rpc.describe({ ns: 'no.such.namespace' })

  assert.deepEqual(result, { revision: 0, namespaces: [] })
})

test('describe deletes every reported secret path even if the provider forgot to', () => {
  const settings = new FakeSettings()
  settings.descriptors = [
    descriptor({
      value: { provider: 'deepseek', apiKey: SECRET_SENTINEL, nested: { token: SECRET_SENTINEL } },
      secrets: [
        { path: ['apiKey'], set: true },
        { path: ['nested', 'token'], set: true },
      ],
    }),
  ]
  const rpc = createSettingsRpc({ settings })

  const result = rpc.describe({})
  const serialised = JSON.stringify(result)

  assert.equal(serialised.includes(SECRET_SENTINEL), false, 'secret sentinel escaped describe')
  const value = result.namespaces[0]?.value as Record<string, unknown>
  assert.equal('apiKey' in value, false)
  assert.deepEqual(result.namespaces[0]?.secrets, [
    { path: ['apiKey'], set: true },
    { path: ['nested', 'token'], set: true },
  ])
})

test('describe rejects a malformed namespace', () => {
  const settings = new FakeSettings()
  const rpc = createSettingsRpc({ settings })

  for (const ns of ['', 'has space', 7, '..']) {
    assert.throws(
      () => rpc.describe({ ns }),
      (error: unknown) => error instanceof SettingsRpcError && error.code === 'bad-params',
      `namespace ${String(ns)} should be rejected`,
    )
  }
})

test('describe without a settings service is unavailable, not an empty list', () => {
  const rpc = createSettingsRpc({})

  assert.throws(
    () => rpc.describe({}),
    (error: unknown) => error instanceof SettingsRpcError && error.code === 'unavailable',
  )
})

test('mutate forwards path operations and expectedRevision verbatim', async () => {
  const settings = new FakeSettings()
  settings.descriptors = [descriptor()]
  const rpc = createSettingsRpc({ settings })

  const result = await rpc.mutate({
    ns: 'llm.deepseek',
    ops: [
      { op: 'set', path: ['apiKey'], value: 'placeholder-not-a-real-key' },
      { op: 'unset', path: ['model'] },
    ],
    expectedRevision: 4,
  })

  assert.deepEqual(settings.mutateCalls, [
    {
      ns: 'llm.deepseek',
      ops: [
        { op: 'set', path: ['apiKey'], value: 'placeholder-not-a-real-key' },
        { op: 'unset', path: ['model'] },
      ],
      expectedRevision: 4,
    },
  ])
  assert.equal(settings.replaceCalls, 0, 'replace must never be called')
  assert.equal(settings.updateCalls, 0, 'update must never be called')
  assert.equal(result.ns, 'llm.deepseek')
  assert.equal(result.revision, 4, 'revision comes from the fresh describe')
  assert.equal(result.applied, 2)
})

test('mutate omits expectedRevision when the caller does not provide one', async () => {
  const settings = new FakeSettings()
  const rpc = createSettingsRpc({ settings })

  await rpc.mutate({ ns: 'ui.theme', ops: [{ op: 'set', path: ['mode'], value: 'dark' }] })

  assert.equal(settings.mutateCalls[0]?.expectedRevision, undefined)
})

test('mutate maps SETTINGS_CONFLICT to a conflict with expected/actual details', async () => {
  const settings = new FakeSettings()
  settings.failWith = new ConflictError(4, 9)
  const rpc = createSettingsRpc({ settings })

  await assert.rejects(
    rpc.mutate({ ns: 'llm.deepseek', ops: [{ op: 'set', path: ['model'], value: 'x' }], expectedRevision: 4 }),
    (error: unknown) => {
      assert.ok(error instanceof SettingsRpcError)
      assert.equal(error.code, 'conflict')
      assert.deepEqual(error.details, { namespace: 'llm.deepseek', expected: 4, actual: 9 })
      assert.match(error.message, /expected revision 4, actual 9/)
      return true
    },
  )
  assert.equal(settings.updateCalls, 0)
  assert.equal(settings.replaceCalls, 0)
})

test('mutate rejects replace/update operations before touching the provider', async () => {
  const settings = new FakeSettings()
  const rpc = createSettingsRpc({ settings })

  for (const op of [
    { op: 'replace', path: ['model'], value: 'x' },
    { op: 'update', path: ['model'], value: 'x' },
    { op: 'delete', path: ['model'] },
  ]) {
    await assert.rejects(
      rpc.mutate({ ns: 'llm.deepseek', ops: [op] }),
      (error: unknown) => error instanceof SettingsRpcError && error.code === 'bad-params',
    )
  }
  assert.equal(settings.mutateCalls.length, 0)
  assert.equal(settings.replaceCalls, 0)
  assert.equal(settings.updateCalls, 0)
})

test('mutate validates the operation shape strictly', async () => {
  const settings = new FakeSettings()
  const rpc = createSettingsRpc({ settings })

  const invalid: unknown[] = [
    { ns: 'llm.deepseek', ops: [] },
    { ns: 'llm.deepseek', ops: 'nope' },
    { ns: 'llm.deepseek', ops: [{ op: 'set', path: [], value: 'x' }] },
    { ns: 'llm.deepseek', ops: [{ op: 'set', path: ['a', ''], value: 'x' }] },
    { ns: 'llm.deepseek', ops: [{ op: 'set', path: ['a'] }] },
    { ns: 'llm.deepseek', ops: [{ op: 'set', path: ['a'], value: undefined }] },
    { ns: 'llm.deepseek', ops: [{ op: 'set', path: ['a'], value: 'x' }], expectedRevision: -1 },
    { ns: 'llm.deepseek', ops: [{ op: 'set', path: ['a'], value: 'x' }], expectedRevision: 1.5 },
    { ops: [{ op: 'set', path: ['a'], value: 'x' }] },
  ]
  for (const params of invalid) {
    await assert.rejects(
      rpc.mutate(params),
      (error: unknown) => error instanceof SettingsRpcError && error.code === 'bad-params',
      `expected bad-params for ${JSON.stringify(params)}`,
    )
  }
  assert.equal(settings.mutateCalls.length, 0)
})

test('mutate on a read-only document is refused without a provider call', async () => {
  const settings = new FakeSettings()
  settings.writable = false
  const rpc = createSettingsRpc({ settings })

  await assert.rejects(
    rpc.mutate({ ns: 'ui.theme', ops: [{ op: 'set', path: ['mode'], value: 'dark' }] }),
    (error: unknown) => error instanceof SettingsRpcError && error.code === 'refused',
  )
  assert.equal(settings.mutateCalls.length, 0)
})

test('mutate wraps an unexpected provider failure as internal', async () => {
  const settings = new FakeSettings()
  settings.failWith = new Error('disk full')
  const rpc = createSettingsRpc({ settings })

  await assert.rejects(
    rpc.mutate({ ns: 'ui.theme', ops: [{ op: 'set', path: ['mode'], value: 'dark' }] }),
    (error: unknown) => {
      assert.ok(error instanceof SettingsRpcError)
      assert.equal(error.code, 'internal')
      assert.match(error.message, /disk full/)
      return true
    },
  )
})

test('registerSettingsMethods exposes exactly the two settings methods', async () => {
  const settings = new FakeSettings()
  settings.descriptors = [descriptor()]
  const registered = new Map<string, (params: unknown) => unknown | Promise<unknown>>()
  const unregisters = registerSettingsMethods(
    {
      register(method, handler) {
        registered.set(method, handler)
        return () => registered.delete(method)
      },
    },
    { settings },
  )

  assert.deepEqual([...registered.keys()].sort(), [SETTINGS_METHODS.describe, SETTINGS_METHODS.mutate].sort())
  const describe = registered.get(SETTINGS_METHODS.describe)
  assert.ok(describe !== undefined)
  const result = await describe({ ns: 'llm.deepseek' })
  assert.equal((result as { revision: number }).revision, 4)

  for (const unregister of unregisters) unregister()
  assert.equal(registered.size, 0)
})