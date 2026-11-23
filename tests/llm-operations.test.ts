// Tests for the models page operations (src/llm/directory.ts and
// src/llm/operations.ts).
//
// Claims under test:
//
//   1. the provider directory merges live and configurable registries without
//      dropping either fact
//   2. discovery forwards the request verbatim, mints or honours an operation
//      id, and bounds concurrency
//   3. cancellation actually aborts the Host call, reports `cancelled`, and a
//      late success after cancellation is still reported as cancelled
//   4. the default selection is read from and written through
//      `agentDefaultModel`; a profile that cannot persist says so
//   5. an apiKey is one-shot: it reaches the Host call, never the logger, never
//      a registry, and never an error message

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Logger } from '@deepseek-ai/cordis'

import {
  createLlmDirectory,
  type LlmConfigurableProvider,
  type LlmDiscoveredModel,
  type LlmModelDiscoveryRequest,
  type LlmProviderInfo,
  type LlmServiceLike,
} from '../src/llm/directory.js'
import {
  createLlmOperations,
  LLM_METHODS,
  registerLlmMethods,
  LlmOperationError,
  type DefaultModelLike,
  type ModelSelection,
} from '../src/llm/operations.js'

const KEY_SENTINEL = 'sk-live-DISCOVERY-ONLY-4c7b'

type DiscoverHandler = (
  settingsNs: string,
  request: LlmModelDiscoveryRequest,
  signal: AbortSignal,
) => Promise<LlmDiscoveredModel[]>

interface DiscoverCall {
  settingsNs: string
  request: LlmModelDiscoveryRequest
  signal: AbortSignal
}

class FakeLlm implements LlmServiceLike {
  live: LlmProviderInfo[] = []
  configurable: LlmConfigurableProvider[] = []
  calls: DiscoverCall[] = []
  handler: DiscoverHandler = async () => []

  listProviders(): LlmProviderInfo[] {
    return this.live.map((entry) => ({ ...entry }))
  }

  listConfigurableProviders(): LlmConfigurableProvider[] {
    return this.configurable.map((entry) => ({ ...entry, settingsPath: [...entry.settingsPath] }))
  }

  discoverModels(
    settingsNs: string,
    request: LlmModelDiscoveryRequest,
    signal?: AbortSignal,
  ): Promise<LlmDiscoveredModel[]> {
    const controller = signal ?? new AbortController().signal
    this.calls.push({ settingsNs, request: { ...request }, signal: controller })
    return this.handler(settingsNs, { ...request }, controller)
  }
}

class FakeDefaultModel implements DefaultModelLike {
  selection: ModelSelection = { provider: 'deepseek', model: 'deepseek-chat' }
  persist = true
  readonly saves: ModelSelection[] = []

  currentSelection(): ModelSelection {
    return { ...this.selection }
  }

  async saveSelection(next: ModelSelection): Promise<void> {
    this.saves.push({ ...next })
    if (this.persist) this.selection = { ...next }
  }
}

function abortError(): Error {
  const error = new Error('the operation was aborted')
  error.name = 'AbortError'
  return error
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface LoggedCall {
  level: string
  args: unknown[]
}

function recordingLogger(): { logger: Logger; calls: LoggedCall[] } {
  const calls: LoggedCall[] = []
  const push = (level: string) => (...args: unknown[]) => {
    calls.push({ level, args })
  }
  const logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  } as unknown as Logger
  return { logger, calls }
}

function directoryFixture(): FakeLlm {
  const llm = new FakeLlm()
  llm.live = [
    { id: 'deepseek', name: 'DeepSeek' },
    { id: 'local', name: 'Local models' },
  ]
  llm.configurable = [
    { provider: 'deepseek', displayName: 'DeepSeek (API)', settingsNs: 'llm.deepseek', settingsPath: ['apiKey'] },
    { provider: 'ollama', displayName: 'Ollama', settingsNs: 'llm.ollama', settingsPath: ['baseURL'] },
  ]
  return llm
}

test('provider directory merges live and configurable registries, sorted by id', () => {
  const directory = createLlmDirectory(directoryFixture())

  const providers = directory.providers()

  assert.deepEqual(providers.map((entry) => entry.id), ['deepseek', 'local', 'ollama'])
  assert.deepEqual(providers[0], {
    id: 'deepseek',
    name: 'DeepSeek (API)',
    configurable: true,
    settingsNs: 'llm.deepseek',
    settingsPath: ['apiKey'],
  })
  assert.deepEqual(providers[1], {
    id: 'local',
    name: 'Local models',
    configurable: false,
    settingsNs: null,
    settingsPath: null,
  })
})

test('discover forwards the request, returns models, and honours a supplied operation id', async () => {
  const llm = new FakeLlm()
  llm.handler = async () => [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 65536 },
    { id: 'deepseek-reasoner' },
  ]
  const operations = createLlmOperations({ llm })

  const outcome = await operations.discover({
    operationId: 'req-42',
    settingsNs: 'llm.deepseek',
    provider: 'deepseek',
    baseURL: 'https://api.example.test',
    api: 'openai',
    apiKey: KEY_SENTINEL,
  })

  assert.equal(outcome.operationId, 'req-42')
  assert.equal(outcome.models.length, 2)
  assert.deepEqual(llm.calls[0]?.request, {
    provider: 'deepseek',
    baseURL: 'https://api.example.test',
    api: 'openai',
    apiKey: KEY_SENTINEL,
  })
  assert.equal(llm.calls[0]?.settingsNs, 'llm.deepseek')
})

test('discover mints an operation id when the caller sends none', async () => {
  const llm = new FakeLlm()
  const operations = createLlmOperations({ llm })

  const outcome = await operations.discover({ settingsNs: 'llm.deepseek' })

  assert.match(outcome.operationId, /^discover-\d+$/)
})

test('discover validates its parameters before calling the Host', async () => {
  const llm = new FakeLlm()
  const operations = createLlmOperations({ llm })

  const invalid: unknown[] = [
    undefined,
    { settingsNs: '' },
    { settingsNs: 'llm.deepseek', baseURL: 'ftp://example.test' },
    { settingsNs: 'llm.deepseek', operationId: 'has space' },
    { settingsNs: 'llm.deepseek', apiKey: 'x'.repeat(9000) },
    { settingsNs: 'llm.deepseek', provider: 7 },
  ]
  for (const params of invalid) {
    await assert.rejects(
      operations.discover(params),
      (error: unknown) => error instanceof LlmOperationError && error.code === 'bad-params',
      `expected bad-params for ${JSON.stringify(params)}`,
    )
  }
  assert.equal(llm.calls.length, 0)
})

test('cancel aborts the Host signal and reports cancelled exactly once', async () => {
  const llm = new FakeLlm()
  let seenSignal: AbortSignal | undefined
  llm.handler = (_settingsNs, _request, signal) => {
    seenSignal = signal
    return new Promise<LlmDiscoveredModel[]>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(abortError()), { once: true })
    })
  }
  const operations = createLlmOperations({ llm })
  const running = operations.discover({ operationId: 'op-cancel', settingsNs: 'llm.deepseek' })

  assert.equal(operations.cancel({ operationId: 'op-cancel' }).cancelled, true)
  assert.equal(seenSignal?.aborted, true)

  await assert.rejects(
    running,
    (error: unknown) => error instanceof LlmOperationError && error.code === 'cancelled',
  )
  assert.equal(operations.cancel({ operationId: 'op-cancel' }).cancelled, false, 'the entry is gone after settle')
})

test('a late success after cancellation is still reported as cancelled', async () => {
  const llm = new FakeLlm()
  const gate = deferred<LlmDiscoveredModel[]>()
  llm.handler = () => gate.promise // deliberately ignores the abort signal
  const operations = createLlmOperations({ llm })
  const running = operations.discover({ operationId: 'op-late', settingsNs: 'llm.deepseek' })

  operations.cancel({ operationId: 'op-late' })
  gate.resolve([{ id: 'late-model' }])

  await assert.rejects(
    running,
    (error: unknown) => error instanceof LlmOperationError && error.code === 'cancelled',
  )
})

test('two discoveries cannot share an operation id', async () => {
  const llm = new FakeLlm()
  const gate = deferred<LlmDiscoveredModel[]>()
  llm.handler = () => gate.promise
  const operations = createLlmOperations({ llm })
  const first = operations.discover({ operationId: 'op-shared', settingsNs: 'llm.deepseek' })

  await assert.rejects(
    operations.discover({ operationId: 'op-shared', settingsNs: 'llm.deepseek' }),
    (error: unknown) => error instanceof LlmOperationError && error.code === 'duplicate-id',
  )
  operations.cancel({ operationId: 'op-shared' })
  await assert.rejects(first, (error: unknown) => error instanceof LlmOperationError && error.code === 'cancelled')
})

test('a provider failure is internal and its message is scrubbed of the apiKey', async () => {
  const llm = new FakeLlm()
  llm.handler = async () => {
    throw new Error(`upstream rejected the key ${KEY_SENTINEL}`)
  }
  const operations = createLlmOperations({ llm })

  await assert.rejects(
    operations.discover({ settingsNs: 'llm.deepseek', apiKey: KEY_SENTINEL }),
    (error: unknown) => {
      assert.ok(error instanceof LlmOperationError)
      assert.equal(error.code, 'internal')
      assert.equal(error.message.includes(KEY_SENTINEL), false, 'apiKey leaked into the error message')
      assert.match(error.message, /\[redacted\]/)
      return true
    },
  )
})

test('the apiKey never reaches the logger', async () => {
  const llm = new FakeLlm()
  const { logger, calls } = recordingLogger()
  const operations = createLlmOperations({ llm, logger })

  await operations.discover({ settingsNs: 'llm.deepseek', apiKey: KEY_SENTINEL })
  operations.cancel({ operationId: 'missing' })

  const rendered = JSON.stringify(calls)
  assert.equal(rendered.includes(KEY_SENTINEL), false, 'logger saw the apiKey')
})

test('providers and discovery without an llm service are unavailable', async () => {
  const operations = createLlmOperations({})

  assert.throws(
    () => operations.providers(),
    (error: unknown) => error instanceof LlmOperationError && error.code === 'unavailable',
  )
  await assert.rejects(
    operations.discover({ settingsNs: 'llm.deepseek' }),
    (error: unknown) => error instanceof LlmOperationError && error.code === 'unavailable',
  )
})

test('the default selection is read through agentDefaultModel', () => {
  const defaultModel = new FakeDefaultModel()
  const operations = createLlmOperations({ defaultModel })

  const outcome = operations.defaultGet()

  assert.deepEqual(outcome, { selection: { provider: 'deepseek', model: 'deepseek-chat' }, applied: true })
})

test('default.set writes through saveSelection and reads the landed value back', async () => {
  const defaultModel = new FakeDefaultModel()
  const operations = createLlmOperations({ defaultModel })

  const outcome = await operations.defaultSet({
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  })

  assert.deepEqual(defaultModel.saves, [{ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' }])
  assert.deepEqual(outcome, {
    selection: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    applied: true,
  })
})

test('default.set on a profile without a configuration editor reports unsupported', async () => {
  const defaultModel = new FakeDefaultModel()
  defaultModel.persist = false
  const operations = createLlmOperations({ defaultModel })

  await assert.rejects(
    operations.defaultSet({ provider: 'deepseek', model: 'deepseek-reasoner' }),
    (error: unknown) => {
      assert.ok(error instanceof LlmOperationError)
      assert.equal(error.code, 'unsupported')
      assert.deepEqual(error.details, {
        requested: { provider: 'deepseek', model: 'deepseek-reasoner' },
        actual: { provider: 'deepseek', model: 'deepseek-chat' },
      })
      return true
    },
  )
})

test('default.set to the current selection is a no-op success', async () => {
  const defaultModel = new FakeDefaultModel()
  const operations = createLlmOperations({ defaultModel })

  const outcome = await operations.defaultSet({ provider: 'deepseek', model: 'deepseek-chat' })

  assert.equal(defaultModel.saves.length, 0)
  assert.equal(outcome.applied, true)
})

test('default.set validates provider/model/reasoningEffort', async () => {
  const defaultModel = new FakeDefaultModel()
  const operations = createLlmOperations({ defaultModel })

  for (const params of [undefined, {}, { provider: '', model: 'x' }, { provider: 'p', model: '' }, { provider: 'p', model: 'm', reasoningEffort: 3 }]) {
    await assert.rejects(
      operations.defaultSet(params),
      (error: unknown) => error instanceof LlmOperationError && error.code === 'bad-params',
      `expected bad-params for ${JSON.stringify(params)}`,
    )
  }
  assert.equal(defaultModel.saves.length, 0)
})

test('default operations without the service are unavailable', () => {
  const operations = createLlmOperations({})

  assert.throws(
    () => operations.defaultGet(),
    (error: unknown) => error instanceof LlmOperationError && error.code === 'unavailable',
  )
})

test('registerLlmMethods exposes the five LLM methods', async () => {
  const llm = directoryFixture()
  const defaultModel = new FakeDefaultModel()
  const registered = new Map<string, (params: unknown) => unknown | Promise<unknown>>()
  const unregisters = registerLlmMethods(
    {
      register(method, handler) {
        registered.set(method, handler)
        return () => registered.delete(method)
      },
    },
    { llm, defaultModel },
  )

  assert.deepEqual([...registered.keys()].sort(), Object.values(LLM_METHODS).sort())
  const providers = registered.get(LLM_METHODS.providers)
  assert.ok(providers !== undefined)
  const result = (await providers(undefined)) as { providers: Array<{ id: string }> }
  assert.deepEqual(result.providers.map((entry) => entry.id), ['deepseek', 'local', 'ollama'])

  for (const unregister of unregisters) unregister()
  assert.equal(registered.size, 0)
})