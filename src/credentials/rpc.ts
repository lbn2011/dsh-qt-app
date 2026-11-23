// credentials/rpc.ts — the API-key surface for the Qt settings page.
//
// The Host owns credentials (`ctx.credentials`: describe/set/unset/listRecords).
// This module is a thin, deliberately lossy projection of that service:
//
//   * no method returns a secret. `describe` reads `CredentialInfo`
//     (`configured`, `source`, `writable`) which has no value slot by design;
//     `list` returns record keys and kinds; `set` answers with the same safe
//     shape as `describe`.
//   * a value is checked, handed to the official `set(ref, value)` once, and
//     dropped. It is not stored on the service object, not logged, and scrubbed
//     from any provider error message before that message is thrown.
//   * an existing key is never read back to fill a form field: there is no
//     `get` method at all, so a QML page cannot ask for one.
//
// The ref namespace (`ref`) is the Host's credential reference name, e.g.
// `DEEPSEEK_API_KEY`; it is validated here with the same POSIX-ish rule the
// Host applies, so bad refs fail before the provider is touched.

import type { Logger } from '@deepseek-ai/cordis'
import type { RpcErrorCode } from '../bridge/protocol.js'

/** Safe projection of `CredentialInfo`; there is no value field. */
export interface CredentialStatus {
  ref: string
  configured: boolean
  source: string | null
  writable: boolean
}

export interface CredentialRecordView {
  key: string
  scope: string
  id: string
  kind: string
}

/** Structural copy of the `CredentialInfo` returned by `describe(ref)`. */
export interface CredentialInfoLike {
  configured: boolean
  source?: string
  writable: boolean
}

/** Structural copy of one `listRecords()` entry. */
export interface CredentialRecordLike {
  key: string
  kind: string
}

/** The slice of `CredentialProvider` this bridge consumes. */
export interface CredentialsServiceLike {
  describe(ref: string): Promise<CredentialInfoLike>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  listRecords(): Promise<readonly CredentialRecordLike[]>
}

export class CredentialRpcError extends Error {
  readonly code: RpcErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: RpcErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'CredentialRpcError'
    this.code = code
    this.details = details
  }
}

export interface CredentialsRpcDeps {
  /** Absent at runtime means the profile has no credential provider. */
  credentials?: CredentialsServiceLike
  logger?: Logger
}

export interface CredentialsRpc {
  describe(params: unknown): Promise<CredentialStatus>
  set(params: unknown): Promise<CredentialStatus>
  unset(params: unknown): Promise<CredentialStatus>
  list(): Promise<{ records: CredentialRecordView[] }>
}

export const CREDENTIAL_METHODS = {
  describe: 'cred.describe',
  set: 'cred.set',
  unset: 'cred.unset',
  list: 'cred.list',
} as const

export type CredentialMethod = (typeof CREDENTIAL_METHODS)[keyof typeof CREDENTIAL_METHODS]

export interface MethodRegistrar {
  register(method: string, handler: (params: unknown) => unknown | Promise<unknown>): () => void
}

const MAX_VALUE_LENGTH = 8192
const MAX_RECORDS = 512
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

function badParams(message: string): CredentialRpcError {
  return new CredentialRpcError('bad-params', message)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function readRef(value: unknown): string {
  if (typeof value !== 'string' || !REF_PATTERN.test(value)) {
    throw badParams('credential ref must be a POSIX-style identifier (letters, digits, underscore)')
  }
  return value
}

function readParams(params: unknown): Record<string, unknown> {
  const record = asRecord(params)
  if (record === undefined) throw badParams('credential params must be an object')
  return record
}

/**
 * Read a secret once. The caller keeps it in a local for the duration of one
 * provider call; nothing else may retain it.
 */
function readValue(value: unknown): string {
  if (typeof value !== 'string') throw badParams('credential value must be a string')
  if (value.length === 0) throw badParams('credential value must not be empty')
  if (value.length > MAX_VALUE_LENGTH) {
    throw badParams(`credential value is longer than ${MAX_VALUE_LENGTH} characters`)
  }
  if (value.trim().length === 0) throw badParams('credential value must not be blank')
  return value
}

function scrub(text: string, value: string): string {
  if (value === '') return text
  return text.split(value).join('[redacted]')
}

function project(ref: string, info: CredentialInfoLike): CredentialStatus {
  // `source` describes where the value comes from (env/config), never the value.
  const source = typeof info.source === 'string' && info.source !== '' ? info.source : null
  return { ref, configured: info.configured === true, source, writable: info.writable === true }
}

function credentialsService(deps: CredentialsRpcDeps): CredentialsServiceLike {
  const service = deps.credentials
  if (service === undefined) {
    throw new CredentialRpcError('unavailable', 'the Host credential provider is not available in this profile')
  }
  return service
}

function splitRecordKey(key: string): { scope: string; id: string } {
  const slash = key.indexOf('/')
  if (slash <= 0 || slash === key.length - 1) return { scope: '', id: key }
  return { scope: key.slice(0, slash), id: key.slice(slash + 1) }
}

export function createCredentialsRpc(deps: CredentialsRpcDeps): CredentialsRpc {
  const logger = deps.logger

  async function describeRef(service: CredentialsServiceLike, ref: string): Promise<CredentialStatus> {
    try {
      const info = await service.describe(ref)
      return project(ref, info)
    } catch (error) {
      if (error instanceof CredentialRpcError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new CredentialRpcError('internal', `reading credential ${ref} failed: ${message}`)
    }
  }

  return {
    async describe(params: unknown): Promise<CredentialStatus> {
      const ref = readRef(readParams(params)['ref'])
      return describeRef(credentialsService(deps), ref)
    },

    async set(params: unknown): Promise<CredentialStatus> {
      const record = readParams(params)
      const ref = readRef(record['ref'])
      const value = readValue(record['value'])
      const service = credentialsService(deps)
      const before = await describeRef(service, ref)
      if (!before.writable) {
        throw new CredentialRpcError('refused', `credential ${ref} is read-only in this deployment`, { ref })
      }
      try {
        await service.set(ref, value)
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error)
        throw new CredentialRpcError('internal', `writing credential ${ref} failed: ${scrub(raw, value)}`, { ref })
      }
      logger?.debug?.(`cred.set: ${ref} updated`) // never the value
      try {
        return await describeRef(service, ref)
      } catch {
        // The write succeeded; a failed follow-up describe must not turn it into
        // an error the user would retry.
        return { ref, configured: true, source: null, writable: true }
      }
    },

    async unset(params: unknown): Promise<CredentialStatus> {
      const ref = readRef(readParams(params)['ref'])
      const service = credentialsService(deps)
      const before = await describeRef(service, ref)
      if (!before.writable) {
        throw new CredentialRpcError('refused', `credential ${ref} is read-only in this deployment`, { ref })
      }
      try {
        await service.unset(ref)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new CredentialRpcError('internal', `removing credential ${ref} failed: ${message}`, { ref })
      }
      logger?.debug?.(`cred.unset: ${ref} removed`)
      try {
        return await describeRef(service, ref)
      } catch {
        return { ref, configured: false, source: null, writable: before.writable }
      }
    },

    async list(): Promise<{ records: CredentialRecordView[] }> {
      const service = credentialsService(deps)
      let records: readonly CredentialRecordLike[]
      try {
        records = await service.listRecords()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new CredentialRpcError('internal', `listing credentials failed: ${message}`)
      }
      if (!Array.isArray(records)) {
        throw new CredentialRpcError('internal', 'the Host credential provider returned a non-array record list')
      }
      const views: CredentialRecordView[] = []
      for (const record of records.slice(0, MAX_RECORDS)) {
        const split = splitRecordKey(record.key)
        views.push({ key: record.key, scope: split.scope, id: split.id, kind: record.kind })
      }
      views.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      return { records: views }
    },
  }
}

/** Register every credential method; returns unregister functions in order. */
export function registerCredentialMethods(registrar: MethodRegistrar, deps: CredentialsRpcDeps): Array<() => void> {
  const rpc = createCredentialsRpc(deps)
  return [
    registrar.register(CREDENTIAL_METHODS.describe, (params) => rpc.describe(params)),
    registrar.register(CREDENTIAL_METHODS.set, (params) => rpc.set(params)),
    registrar.register(CREDENTIAL_METHODS.unset, (params) => rpc.unset(params)),
    registrar.register(CREDENTIAL_METHODS.list, () => rpc.list()),
  ]
}