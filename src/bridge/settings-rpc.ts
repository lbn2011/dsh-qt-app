// settings-rpc.ts — the settings half of the Qt bridge.
//
// This module projects the *official* Host `settings` service
// (`@deepseek-ai/dsh-settings` 0.2.2-rc.1) onto the five-line method surface the
// Qt settings page needs:
//
//   settings.describe { ns? }              → namespaces (redacted) + revision
//   settings.mutate   { ns, ops, expectedRevision }
//                                          → mutation + fresh revision
//
// Three rules are load-bearing here and are checked by tests:
//
//   * writes are **path operations only**. The official service also exposes
//     `update(ns, patch)` and `replace(ns, section)`, but both can drop sibling
//     keys; this bridge never forwards either, and rejects them with
//     `bad-params` if a caller sends an `update`/`replace` op.
//   * revisions are **transparent**. `expectedRevision` is forwarded verbatim;
//     `SETTINGS_CONFLICT` keeps its own `conflict` code and carries the
//     expected/actual pair in `details` (the message is human-readable; the
//     caller never has to parse it).
//   * secrets never cross the wire. The official service is asked to redact,
//     and the redaction is then enforced again here: every path listed in
//     `descriptor.secrets` is deleted from the value copy before it can be
//     serialised. A provider that forgot to redact cannot leak through this
//     boundary.
//
// Nothing in this file writes a second settings document: the app's own
// `src/settings/` store stays the owner of renderer preferences.

import type { Logger } from '@deepseek-ai/cordis'
import type { RpcErrorCode } from './protocol.js'

/** Namespace id as the official service spells it. */
export type SettingsNamespace = string

/** One secret position reported by the service (`redact.d.ts`). */
export interface RedactedSecret {
  path: string[]
  set: boolean
}

/**
 * Structural copy of `SettingsDescriptor` from `dsh-settings`.
 *
 * Declared locally on purpose: the app does not depend on the Host packages at
 * build time, so the bridge stays a structural consumer of the runtime service.
 */
export interface SettingsDescriptor {
  ns: string
  autoGenerate: boolean
  schema: unknown
  value: unknown
  revision: number
  base?: unknown
  user?: unknown
  applies: 'live'
  secrets?: RedactedSecret[]
}

/** Copy of `SettingsPathOp`: no `update`/`replace` variant exists here. */
export type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

export interface SettingsDescribeOptions {
  redactSecrets?: boolean
}

/**
 * The slice of `SettingsForms` this bridge consumes.
 *
 * `update`/`replace` are deliberately absent from the type: a bridge that
 * cannot call them cannot be refactored into calling them by accident.
 */
export interface SettingsServiceLike {
  readonly writable: boolean
  describe(options?: SettingsDescribeOptions): SettingsDescriptor[]
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/** What QML receives for one namespace: JSON-safe, secret-free. */
export interface SettingsNamespaceView {
  ns: SettingsNamespace
  autoGenerate: boolean
  revision: number
  applies: 'live'
  value: unknown
  secrets: Array<{ path: string[]; set: boolean }>
}

export interface SettingsDescribeResult {
  /** Highest revision across the returned namespaces (0 when none). */
  revision: number
  namespaces: SettingsNamespaceView[]
}

export interface SettingsMutateResult {
  ns: SettingsNamespace
  /** Revision after the write; null only if the namespace vanished. */
  revision: number | null
  /** Number of path operations applied. */
  applied: number
}

export class SettingsRpcError extends Error {
  readonly code: RpcErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: RpcErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'SettingsRpcError'
    this.code = code
    this.details = details
  }
}

export interface SettingsRpcDeps {
  /** Missing at runtime means the profile has no settings service. */
  settings?: SettingsServiceLike
  logger?: Logger
}

export interface SettingsRpc {
  describe(params: unknown): SettingsDescribeResult
  mutate(params: unknown): Promise<SettingsMutateResult>
}

/** Method names as they appear in the protocol v1 `req` frames. */
export const SETTINGS_METHODS = {
  describe: 'settings.describe',
  mutate: 'settings.mutate',
} as const

export type SettingsMethod = (typeof SETTINGS_METHODS)[keyof typeof SETTINGS_METHODS]

/** Minimal registrar shape shared with `HostBridgeService.register`. */
export interface MethodRegistrar {
  register(method: string, handler: (params: unknown) => unknown | Promise<unknown>): () => void
}

const MAX_MUTATION_OPS = 128
const MAX_PATH_SEGMENTS = 32
const NS_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/

function badParams(message: string): SettingsRpcError {
  return new SettingsRpcError('bad-params', message)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function requireNamespace(value: unknown): SettingsNamespace {
  if (typeof value !== 'string' || !NS_PATTERN.test(value)) {
    throw badParams('settings namespace must be a dotted identifier')
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value === '') throw badParams(`${field} must be a non-empty string`)
  return value
}

function readPath(value: unknown, index: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATH_SEGMENTS) {
    throw badParams(`ops[${index}].path must be a non-empty array of at most ${MAX_PATH_SEGMENTS} segments`)
  }
  const path: string[] = []
  for (const segment of value) {
    if (typeof segment !== 'string' || segment === '') {
      throw badParams(`ops[${index}].path segments must be non-empty strings`)
    }
    path.push(segment)
  }
  return path
}

/**
 * Read one `settings.mutate` operation.
 *
 * The check is intentionally narrow: `replace`, `update`, `merge` and anything
 * else are not part of the contract, and silently degrading them to a whole-key
 * `set` would make a typo destructive.
 */
function readOp(value: unknown, index: number): SettingsPathOp {
  const record = asRecord(value)
  if (record === undefined) throw badParams(`ops[${index}] must be an object`)
  const op = record['op']
  if (op === 'set') {
    if (!('value' in record)) throw badParams(`ops[${index}] set requires a value`)
    const writeValue = record['value']
    if (writeValue === undefined) throw badParams(`ops[${index}].value must be defined`)
    return { op: 'set', path: readPath(record['path'], index), value: writeValue }
  }
  if (op === 'unset') {
    return { op: 'unset', path: readPath(record['path'], index) }
  }
  if (op === 'replace' || op === 'update') {
    throw badParams(`ops[${index}].op "${String(op)}" is not supported; settings writes use set/unset paths only`)
  }
  throw badParams(`ops[${index}].op must be "set" or "unset"`)
}

function readExpectedRevision(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw badParams('expectedRevision must be a non-negative integer')
  }
  return value
}

/** Deep copy that survives non-JSON values where structuredClone does. */
function deepCopy(value: unknown): unknown {
  try {
    return structuredClone(value)
  } catch {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return value
    }
  }
}

function deleteAtPath(target: unknown, path: readonly string[]): void {
  if (path.length === 0) return
  let cursor = target
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]
    if (segment === undefined) return
    if (typeof cursor !== 'object' || cursor === null) return
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  const last = path[path.length - 1]
  if (last === undefined || typeof cursor !== 'object' || cursor === null) return
  const container = cursor as Record<string, unknown>
  if (Array.isArray(container)) {
    const index = Number(last)
    if (Number.isInteger(index) && index >= 0 && index < container.length) delete container[index]
    return
  }
  delete container[last]
}

/**
 * Remove every secret the service reported before the descriptor can be
 * serialised. Redaction is existential, not cosmetic: the key is gone from the
 * payload, not replaced by a placeholder that a later layer might mistake for a
 * real value.
 */
function stripSecrets(value: unknown, secrets: readonly RedactedSecret[]): unknown {
  if (secrets.length === 0) return value
  const copy = deepCopy(value)
  for (const secret of secrets) deleteAtPath(copy, secret.path)
  return copy
}

function projectNamespace(descriptor: SettingsDescriptor): SettingsNamespaceView {
  const secrets = descriptor.secrets ?? []
  return {
    ns: descriptor.ns,
    autoGenerate: descriptor.autoGenerate,
    revision: descriptor.revision,
    applies: descriptor.applies,
    value: stripSecrets(descriptor.value, secrets),
    secrets: secrets.map((secret) => ({ path: [...secret.path], set: secret.set })),
  }
}

function settingsService(deps: SettingsRpcDeps): SettingsServiceLike {
  const service = deps.settings
  if (service === undefined) {
    throw new SettingsRpcError('unavailable', 'the Host settings service is not available in this profile')
  }
  return service
}

function conflictDetails(error: unknown): { expected: number; actual: number } | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as { code?: unknown; expected?: unknown; actual?: unknown }
  if (candidate.code !== 'SETTINGS_CONFLICT') return undefined
  const expected = typeof candidate.expected === 'number' ? candidate.expected : -1
  const actual = typeof candidate.actual === 'number' ? candidate.actual : -1
  return { expected, actual }
}

function describeParams(params: unknown): { ns?: string } {
  if (params === undefined || params === null) return {}
  const record = asRecord(params)
  if (record === undefined) throw badParams('settings.describe params must be an object')
  const ns = optionalString(record['ns'], 'ns')
  if (ns !== undefined) requireNamespace(ns)
  if (ns !== undefined) return { ns }
  return {}
}

function mutateParams(params: unknown): { ns: string; ops: SettingsPathOp[]; expectedRevision?: number } {
  const record = asRecord(params)
  if (record === undefined) throw badParams('settings.mutate params must be an object')
  const ns = requireNamespace(record['ns'])
  if (!Array.isArray(record['ops']) || record['ops'].length === 0) {
    throw badParams('settings.mutate requires a non-empty ops array')
  }
  if (record['ops'].length > MAX_MUTATION_OPS) {
    throw badParams(`settings.mutate accepts at most ${MAX_MUTATION_OPS} operations at once`)
  }
  const ops = record['ops'].map((op, index) => readOp(op, index))
  const expectedRevision = readExpectedRevision(record['expectedRevision'])
  return expectedRevision === undefined ? { ns, ops } : { ns, ops, expectedRevision }
}

export function createSettingsRpc(deps: SettingsRpcDeps): SettingsRpc {
  const logger = deps.logger

  return {
    describe(params: unknown): SettingsDescribeResult {
      const service = settingsService(deps)
      const filter = describeParams(params)
      // Redaction is requested unconditionally: a `redactSecrets:false` from the
      // UI is not a supported opt-out, so the parameter is not read at all.
      const descriptors = service.describe({ redactSecrets: true })
      if (!Array.isArray(descriptors)) {
        throw new SettingsRpcError('internal', 'the Host settings service returned a non-array descriptor list')
      }
      const selected = filter.ns === undefined
        ? descriptors
        : descriptors.filter((descriptor) => descriptor.ns === filter.ns)
      const namespaces = selected.map(projectNamespace)
      let revision = 0
      for (const namespace of namespaces) {
        if (namespace.revision > revision) revision = namespace.revision
      }
      logger?.debug?.(`settings.describe: ${namespaces.length} namespace(s), revision ${revision}`)
      return { revision, namespaces }
    },

    async mutate(params: unknown): Promise<SettingsMutateResult> {
      const service = settingsService(deps)
      const request = mutateParams(params)
      if (!service.writable) {
        throw new SettingsRpcError('refused', 'the settings document is read-only in this deployment')
      }
      try {
        if (request.expectedRevision === undefined) {
          await service.mutate(request.ns, request.ops)
        } else {
          await service.mutate(request.ns, request.ops, request.expectedRevision)
        }
      } catch (error) {
        const conflict = conflictDetails(error)
        if (conflict !== undefined) {
          throw new SettingsRpcError(
            'conflict',
            `settings namespace "${request.ns}" changed under us: expected revision ${conflict.expected}, actual ${conflict.actual}`,
            { namespace: request.ns, expected: conflict.expected, actual: conflict.actual },
          )
        }
        if (error instanceof SettingsRpcError) throw error
        const message = error instanceof Error ? error.message : String(error)
        throw new SettingsRpcError('internal', `settings.mutate failed: ${message}`)
      }
      const fresh = service
        .describe({ redactSecrets: true })
        .find((descriptor) => descriptor.ns === request.ns)
      logger?.debug?.(`settings.mutate: ${request.ops.length} op(s) in ${request.ns}`)
      return {
        ns: request.ns,
        revision: fresh?.revision ?? null,
        applied: request.ops.length,
      }
    },
  }
}

/**
 * Register both methods against a Host bridge.
 *
 * Returns the unregister functions in registration order so the owner can drop
 * them in `ctx.effect` cleanup without knowing the method names twice.
 */
export function registerSettingsMethods(registrar: MethodRegistrar, deps: SettingsRpcDeps): Array<() => void> {
  const rpc = createSettingsRpc(deps)
  return [
    registrar.register(SETTINGS_METHODS.describe, (params) => rpc.describe(params)),
    registrar.register(SETTINGS_METHODS.mutate, (params) => rpc.mutate(params)),
  ]
}