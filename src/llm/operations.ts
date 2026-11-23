// llm/operations.ts — the model page's operations: list, discover (cancellable),
// and the default selection.
//
// Three Host services are involved and they are kept strictly separate:
//
//   * provider/model discovery belongs to `ctx.llm.discoverModels(settingsNs,
//     request, signal)` — native cancellation via AbortSignal, and the apiKey is
//     used for that one interrogation only;
//   * the default selection belongs to `ctx.agentDefaultModel`
//     (`currentSelection` / `saveSelection`), which persists through the profile
//     configuration editor — not through a settings namespace and not through a
//     second writer of our own;
//   * the provider directory is `directory.ts`'s job.
//
// Secret hygiene: an apiKey passed to `discover` is never stored in the
// operation registry, never logged, and never echoed in an error message. The
// one-shot nature is enforced by not keeping a reference past the call.

import type { Logger } from '@deepseek-ai/cordis'
import type { RpcErrorCode } from '../bridge/protocol.js'
import {
  createLlmDirectory,
  type LlmDiscoveredModel,
  type LlmDirectory,
  type LlmModelDiscoveryRequest,
  type LlmProviderView,
  type LlmServiceLike,
} from './directory.js'

/** Detached default selection, as `agentDefaultModel.currentSelection()` returns it. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The slice of `AgentDefaultModelConfig` this module consumes. */
export interface DefaultModelLike {
  currentSelection(): ModelSelection
  saveSelection(next: ModelSelection): Promise<void>
}

export interface LlmOperationsDeps {
  /** Absent at runtime means the profile has no llm service. */
  llm?: LlmServiceLike
  /** Absent at runtime means the profile has no default-model service. */
  defaultModel?: DefaultModelLike
  logger?: Logger
}

export class LlmOperationError extends Error {
  readonly code: RpcErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: RpcErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'LlmOperationError'
    this.code = code
    this.details = details
  }
}

export interface DiscoverOutcome {
  operationId: string
  models: LlmDiscoveredModel[]
}

export interface CancelOutcome {
  operationId: string
  cancelled: boolean
}

export interface DefaultSelectionOutcome {
  selection: ModelSelection
  /** True when the write landed; a mismatch raises `unsupported` instead. */
  applied: boolean
}

export interface LlmOperations {
  providers(): { providers: LlmProviderView[] }
  discover(params: unknown): Promise<DiscoverOutcome>
  cancel(params: unknown): CancelOutcome
  defaultGet(): DefaultSelectionOutcome
  defaultSet(params: unknown): Promise<DefaultSelectionOutcome>
}

export const LLM_METHODS = {
  providers: 'llm.providers.list',
  discover: 'llm.models.discover',
  cancel: 'llm.models.cancel',
  defaultGet: 'llm.default.get',
  defaultSet: 'llm.default.set',
} as const

export type LlmMethod = (typeof LLM_METHODS)[keyof typeof LLM_METHODS]

export interface MethodRegistrar {
  register(method: string, handler: (params: unknown) => unknown | Promise<unknown>): () => void
}

const MAX_OPERATIONS = 8
const MAX_DISCOVERED_MODELS = 512
const OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

interface PendingDiscovery {
  controller: AbortController
  cancelled: boolean
}

function badParams(message: string): LlmOperationError {
  return new LlmOperationError('bad-params', message)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; code?: unknown }
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR'
}

/**
 * A rejected-on-abort promise that lets `cancel` settle a discovery immediately
 * even when the Host call never observes its AbortSignal. `dispose` detaches the
 * listener once the race is over so a late abort cannot reject anything.
 */
function abortRejection(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let listener: (() => void) | undefined
  const promise = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new LlmOperationError('cancelled', 'model discovery cancelled'))
    if (signal.aborted) {
      fail()
      return
    }
    listener = fail
    signal.addEventListener('abort', fail, { once: true })
  })
  return {
    promise,
    dispose() {
      if (listener !== undefined) signal.removeEventListener('abort', listener)
      listener = undefined
    },
  }
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw badParams(`${field} must be a string`)
  return value
}

function readSettingsNs(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw badParams('llm.models.discover requires settingsNs (a provider settings namespace)')
  }
  return value
}

/**
 * Validate a discovery request and build the official request object.
 *
 * Undefined fields are omitted rather than set to `undefined` so the Host's
 * exact-optional contract sees a request that says exactly what the user asked.
 */
function readDiscoveryRequest(params: Record<string, unknown>): {
  settingsNs: string
  request: LlmModelDiscoveryRequest
  apiKey: string | undefined
} {
  const settingsNs = readSettingsNs(params['settingsNs'])
  const provider = readOptionalString(params['provider'], 'provider')
  const baseURL = readOptionalString(params['baseURL'], 'baseURL')
  const api = readOptionalString(params['api'], 'api')
  const apiKey = readOptionalString(params['apiKey'], 'apiKey')
  if (baseURL !== undefined && !/^https?:\/\//.test(baseURL)) {
    throw badParams('baseURL must be an http(s) URL')
  }
  if (apiKey !== undefined && apiKey.length > 8192) {
    throw badParams('apiKey is longer than 8192 characters')
  }
  const request: LlmModelDiscoveryRequest = {}
  if (provider !== undefined) request.provider = provider
  if (baseURL !== undefined) request.baseURL = baseURL
  if (api !== undefined) request.api = api
  if (apiKey !== undefined) request.apiKey = apiKey
  return { settingsNs, request, apiKey }
}

function readOperationId(params: unknown): string {
  const record = asRecord(params)
  if (record === undefined) throw badParams('params must be an object')
  const value = record['operationId']
  if (typeof value !== 'string' || !OPERATION_ID_PATTERN.test(value)) {
    throw badParams('operationId must be a 1-128 character identifier of [A-Za-z0-9._:-]')
  }
  return value
}

function readSelection(value: unknown): ModelSelection {
  const record = asRecord(value)
  if (record === undefined) throw badParams('selection params must be an object')
  const provider = record['provider']
  const model = record['model']
  if (typeof provider !== 'string' || provider === '') throw badParams('provider must be a non-empty string')
  if (typeof model !== 'string' || model === '') throw badParams('model must be a non-empty string')
  const reasoningEffort = record['reasoningEffort']
  if (reasoningEffort === undefined || reasoningEffort === null || reasoningEffort === '') {
    return { provider, model }
  }
  if (typeof reasoningEffort !== 'string') throw badParams('reasoningEffort must be a string')
  return { provider, model, reasoningEffort }
}

function redactKey(text: string, apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey === '') return text
  return text.split(apiKey).join('[redacted]')
}

function sameSelection(a: ModelSelection, b: ModelSelection): boolean {
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

export function createLlmOperations(deps: LlmOperationsDeps): LlmOperations {
  const logger = deps.logger
  const pending = new Map<string, PendingDiscovery>()
  let sequence = 0

  function llmService(): LlmServiceLike {
    if (deps.llm === undefined) {
      throw new LlmOperationError('unavailable', 'the Host llm service is not available in this profile')
    }
    return deps.llm
  }

  function directory(): LlmDirectory {
    return createLlmDirectory(llmService())
  }

  function defaultModel(): DefaultModelLike {
    if (deps.defaultModel === undefined) {
      throw new LlmOperationError('unavailable', 'the Host default-model service is not available in this profile')
    }
    return deps.defaultModel
  }

  function mintOperationId(): string {
    sequence += 1
    return `discover-${sequence}`
  }

  return {
    providers(): { providers: LlmProviderView[] } {
      return { providers: directory().providers() }
    },

    async discover(params: unknown): Promise<DiscoverOutcome> {
      const record = asRecord(params)
      if (record === undefined) throw badParams('llm.models.discover params must be an object')
      const { settingsNs, request, apiKey } = readDiscoveryRequest(record)
      if (pending.size >= MAX_OPERATIONS) {
        throw new LlmOperationError('busy', `at most ${MAX_OPERATIONS} model discoveries may run at once`)
      }
      // The caller may supply the operation id (QML hands its request id over so
      // both layers cancel the same thing); otherwise the registry mints one.
      const supplied = record['operationId']
      const operationId = supplied === undefined ? mintOperationId() : readOperationId(params)
      if (pending.has(operationId)) {
        throw new LlmOperationError('duplicate-id', `model discovery ${operationId} is already running`)
      }
      const controller = new AbortController()
      const entry: PendingDiscovery = { controller, cancelled: false }
      pending.set(operationId, entry)
      // Cancellation must settle the RPC even if the Host call ignores the
      // signal, so the abort rejection races the provider promise instead of
      // waiting for it.
      const aborted = abortRejection(controller.signal)
      try {
        const models = await Promise.race([
          llmService().discoverModels(settingsNs, request, controller.signal),
          aborted.promise,
        ])
        if (entry.cancelled) {
          throw new LlmOperationError('cancelled', 'model discovery cancelled')
        }
        if (!Array.isArray(models)) {
          throw new LlmOperationError('internal', 'the Host llm service returned a non-array model list')
        }
        const limited = models.length > MAX_DISCOVERED_MODELS ? models.slice(0, MAX_DISCOVERED_MODELS) : models
        logger?.debug?.(`llm.models.discover: ${limited.length} model(s) from ${settingsNs}`)
        return { operationId, models: limited }
      } catch (error) {
        if (entry.cancelled || isAbortError(error)) {
          throw new LlmOperationError('cancelled', 'model discovery cancelled', { operationId })
        }
        if (error instanceof LlmOperationError) throw error
        const message = redactKey(error instanceof Error ? error.message : String(error), apiKey)
        throw new LlmOperationError('internal', `model discovery failed: ${message}`, { operationId })
      } finally {
        aborted.dispose()
        pending.delete(operationId)
      }
    },

    cancel(params: unknown): CancelOutcome {
      const operationId = readOperationId(params)
      const entry = pending.get(operationId)
      if (entry === undefined) return { operationId, cancelled: false }
      entry.cancelled = true
      entry.controller.abort()
      return { operationId, cancelled: true }
    },

    defaultGet(): DefaultSelectionOutcome {
      return { selection: defaultModel().currentSelection(), applied: true }
    },

    async defaultSet(params: unknown): Promise<DefaultSelectionOutcome> {
      const service = defaultModel()
      const next = readSelection(params)
      const before = service.currentSelection()
      if (sameSelection(before, next)) return { selection: before, applied: true }
      try {
        await service.saveSelection(next)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new LlmOperationError('internal', `saving the default model failed: ${message}`)
      }
      // `saveSelection` is a no-op in a deployment without a configuration
      // editor. Report that as `unsupported` rather than pretending the write
      // landed and letting the next page load disagree with the user.
      const after = service.currentSelection()
      if (!sameSelection(after, next)) {
        throw new LlmOperationError(
          'unsupported',
          'this profile does not persist a default model (no configuration editor is mounted)',
          { requested: { ...next }, actual: { ...after } },
        )
      }
      logger?.debug?.(`llm.default.set: ${next.provider}/${next.model}`)
      return { selection: after, applied: true }
    },
  }
}

/** Register every LLM method against a Host bridge; returns unregister functions. */
export function registerLlmMethods(registrar: MethodRegistrar, deps: LlmOperationsDeps): Array<() => void> {
  const operations = createLlmOperations(deps)
  return [
    registrar.register(LLM_METHODS.providers, () => operations.providers()),
    registrar.register(LLM_METHODS.discover, (params) => operations.discover(params)),
    registrar.register(LLM_METHODS.cancel, (params) => operations.cancel(params)),
    registrar.register(LLM_METHODS.defaultGet, () => operations.defaultGet()),
    registrar.register(LLM_METHODS.defaultSet, (params) => operations.defaultSet(params)),
  ]
}