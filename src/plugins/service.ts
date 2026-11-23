/**
 * Plugin-manager bridge and slot host (I4, plan §3.3 + §I4).
 *
 * This layer is a *pass-through* with three jobs the official manager does not
 * do for us:
 *
 *  1. Expose the manager's methods over the Qt bridge under the plan's method
 *     names, and only the ones this build actually has. A button that can only
 *     fail is worse than an absent button, so an older or trimmed manager
 *     produces a smaller surface instead of runtime errors.
 *  2. Turn long operations (install / update / remove) into `opId` + progress
 *     events. `pnpm` can take a minute; a synchronous bridge call would freeze
 *     the UI thread it is waiting on.
 *  3. Converge failures into a settled `ChangeResult` with
 *     `application: 'failed'`. A rejected install must never escape as an
 *     exception: one broken plugin would otherwise take down the whole settings
 *     panel (P1, failure isolation).
 *
 * Nothing here re-derives `application`, `restartReason` or the `ManagementError`
 * codes — those belong to the official manager, and a second opinion in this
 * layer would show the user two disagreeing answers.
 */
import {
  CONVERSION_REASON_NAMES,
  convertSlotTree,
  type ConversionReasonCode,
  type ConversionResult,
} from '../ui/converter.js'
import { isSupportedUiType, UNSUPPORTED_CONTROL_NOTICE } from '../ui/controls.js'
import {
  readWebEntry,
  type SlotContribution,
  type SlotRegistry,
  createSlotRegistry,
} from './slot-contract.js'

/** The subset of the host bridge this service needs; kept structural for tests. */
export interface MethodHostPort {
  register(method: string, handler: (params: unknown) => unknown | Promise<unknown>): () => void
  emitEvent(name: string, payload?: unknown): void
}

/**
 * The official manager, structurally typed. Everything is optional: a host may
 * run a build without `listBundles` or `setPluginEnabled`, and the bridge must
 * then simply not offer those methods.
 */
export interface PluginManagerPort {
  readonly listPlugins?: (() => unknown) | undefined
  readonly listBundles?: (() => unknown) | undefined
  readonly setPluginEnabled?: ((id: string, enabled: boolean) => unknown) | undefined
  readonly setBundleEnabled?: ((name: string, enabled: boolean) => unknown) | undefined
  readonly installBundle?:
    | ((spec: string, options?: Record<string, unknown>) => unknown)
    | undefined
  readonly removeBundle?: ((name: string) => unknown) | undefined
  readonly updateBundle?:
    | ((name: string, version: string, options?: Record<string, unknown>) => unknown)
    | undefined
  readonly cancelInstall?: ((requestId: string) => unknown) | undefined
  readonly inspect?: ((spec: string, options?: unknown) => unknown) | undefined
  readonly listVersions?: ((name: string, options?: unknown) => unknown) | undefined
}

/** The official result shape, mirrored only so the bridge can read it. */
export interface ManagementError {
  readonly code: string
  readonly diagnostic?: string
  readonly incompatible?: unknown
}

export interface ChangeResult {
  readonly changed: boolean
  readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  readonly stage: 'install' | 'enable' | 'remove'
  readonly target: string
  readonly restartReason?: string
  readonly enabled?: boolean
  readonly error?: ManagementError
  readonly warnings?: readonly string[]
  readonly pendingBuilds?: readonly string[]
  readonly approvedBuilds?: readonly string[]
}

export type OperationPhase = 'installing' | 'cancelling' | 'settled'

export interface PluginOperationSnapshot {
  readonly opId: string
  readonly phase: OperationPhase
  readonly result?: unknown
  readonly update?: {
    readonly from: unknown
    readonly to: unknown
    readonly step: unknown
    readonly restore?: unknown
  }
}

export interface PluginServiceOptions {
  readonly manager: PluginManagerPort
  readonly host: MethodHostPort
  /** Injected so the settings panel and this service share one registry. */
  readonly slots?: SlotRegistry | undefined
  /** How many settled operations stay queryable; the oldest are dropped. */
  readonly maxRetainedOps?: number | undefined
}

export interface PluginService {
  /** The registry `slot.list` / `ui.render` read from. */
  readonly slots: SlotRegistry
  attach(): void
  dispose(): void
  ops(): PluginOperationSnapshot[]
  waitForOp(opId: string): Promise<PluginOperationSnapshot>
}

/** Every method name this bridge can register, in plan-table order. */
export const PLUGIN_SERVICE_METHODS = [
  'plugin.list',
  'plugin.bundles',
  'plugin.setEnabled',
  'plugin.bundle.setEnabled',
  'plugin.install',
  'plugin.update',
  'plugin.remove',
  'plugin.op.cancel',
  'plugin.inspect',
  'plugin.versions',
  'slot.list',
  'ui.register',
  'ui.render',
  'ui.action',
] as const

const DEFAULT_MAX_RETAINED_OPS = 20

/** A request the caller got wrong; the message carries the machine code. */
export class PluginServiceError extends Error {
  readonly code: string

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'PluginServiceError'
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PluginServiceError('bad-params', `${field} must be a non-empty string`)
  }
  return value
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new PluginServiceError('bad-params', `${field} must be a boolean`)
  }
  return value
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new PluginServiceError('bad-params', `${field} must be an object`)
  return value
}

/**
 * Converge anything thrown by the manager into the official failure shape.
 * The manager's own errors already carry `code` (a `ManagementError` code) and
 * sometimes `diagnostic`; anything else becomes `operation-error` so the caller
 * always has a stable code to switch on.
 */
function converge(error: unknown, stage: ChangeResult['stage'], target: string): ChangeResult {
  const record = isRecord(error) ? error : undefined
  const code = typeof record?.['code'] === 'string' ? record['code'] : 'operation-error'
  const message = error instanceof Error ? error.message : String(error)
  const diagnostic =
    typeof record?.['diagnostic'] === 'string' && record['diagnostic'].length > 0
      ? record['diagnostic']
      : message
  return {
    changed: false,
    application: 'failed',
    stage,
    target,
    error: { code, diagnostic },
  }
}

/** Read a `ChangeResult` out of whatever the manager returned, without inventing one. */
function readChangeResult(value: unknown, stage: ChangeResult['stage'], target: string): ChangeResult {
  if (isRecord(value) && typeof value['application'] === 'string') {
    return value as unknown as ChangeResult
  }
  return {
    changed: false,
    application: 'failed',
    stage,
    target,
    error: {
      code: 'operation-error',
      diagnostic: 'the plugin manager returned no ChangeResult',
    },
  }
}

interface OperationRecord {
  readonly opId: string
  phase: OperationPhase
  snapshot: PluginOperationSnapshot
  readonly settled: Promise<PluginOperationSnapshot>
  resolve: (snapshot: PluginOperationSnapshot) => void
}

/** Project a slot for QML: functions cannot cross the bridge, so flag them. */
function projectSlot(slot: SlotContribution): Record<string, unknown> {
  return {
    id: slot.id,
    surface: slot.surface,
    order: slot.order,
    hasRender: typeof slot.render === 'function',
    hasComponent: slot.component !== undefined,
    hasUrl: typeof slot.url === 'string' && slot.url.length > 0,
    hasSchema: slot.schema !== undefined,
    webEntry: readWebEntry(slot),
    ...(slot.title === undefined ? {} : { title: slot.title }),
    ...(slot.description === undefined ? {} : { description: slot.description }),
    ...(slot.section === undefined ? {} : { section: slot.section }),
    ...(slot.label === undefined ? {} : { label: slot.label }),
    ...(slot.icon === undefined ? {} : { icon: slot.icon }),
    ...(slot.uiType === undefined ? {} : { uiType: slot.uiType }),
    ...(slot.properties === undefined ? {} : { properties: slot.properties }),
  }
}

class PluginServiceImplementation implements PluginService {
  readonly slots: SlotRegistry

  private readonly manager: PluginManagerPort
  private readonly host: MethodHostPort
  private readonly maxRetainedOps: number
  private readonly disposers: Array<() => void> = []
  private readonly operations = new Map<string, OperationRecord>()
  private readonly order: string[] = []
  private readonly props = new Map<string, Record<string, unknown>>()
  private unsubscribe: (() => void) | undefined
  private attached = false
  private active = false
  private counter = 0

  constructor(options: PluginServiceOptions) {
    this.manager = options.manager
    this.host = options.host
    this.maxRetainedOps = options.maxRetainedOps ?? DEFAULT_MAX_RETAINED_OPS
    this.slots = options.slots ?? createSlotRegistry()
    this.unsubscribe = this.slots.subscribe(() => {
      this.emit('slot.changed', {})
    })
  }

  // -- lifecycle ------------------------------------------------------------

  attach(): void {
    if (this.attached) return
    this.attached = true
    this.active = true

    this.disposers.push(
      this.host.register('plugin.list', () => this.listPlugins()),
      this.host.register('plugin.install', (params) => this.startInstall(params)),
      this.host.register('plugin.update', (params) => this.startUpdate(params)),
      this.host.register('plugin.remove', (params) => this.startRemove(params)),
      this.host.register('plugin.op.cancel', (params) => this.cancelOp(params)),
      this.host.register('slot.list', (params) => this.listSlots(params)),
      this.host.register('ui.register', (params) => this.registerSlot(params)),
      this.host.register('ui.render', (params) => this.renderSlot(params)),
      this.host.register('ui.action', (params) => this.dispatchAction(params)),
    )

    // Optional methods: registered only when this manager build really has them.
    if (this.manager.listBundles !== undefined) {
      this.disposers.push(this.host.register('plugin.bundles', () => this.listBundles()))
    }
    if (this.manager.setPluginEnabled !== undefined) {
      this.disposers.push(
        this.host.register('plugin.setEnabled', (params) => this.setPluginEnabled(params)),
      )
    }
    if (this.manager.setBundleEnabled !== undefined) {
      this.disposers.push(
        this.host.register('plugin.bundle.setEnabled', (params) => this.setBundleEnabled(params)),
      )
    }
    if (this.manager.inspect !== undefined) {
      this.disposers.push(
        this.host.register('plugin.inspect', (params) => {
          const record = requireRecord(params, 'params')
          const spec = requireString(record['spec'], 'spec')
          return this.manager.inspect?.(spec)
        }),
      )
    }
    if (this.manager.listVersions !== undefined) {
      this.disposers.push(
        this.host.register('plugin.versions', (params) => {
          const record = requireRecord(params, 'params')
          const name = requireString(record['name'], 'name')
          return this.manager.listVersions?.(name)
        }),
      )
    }
  }

  dispose(): void {
    if (!this.attached && !this.active) return
    this.active = false
    this.attached = false
    while (this.disposers.length > 0) {
      const disposer = this.disposers.pop()
      try {
        disposer?.()
      } catch {
        // A failing disposer must not keep the rest registered.
      }
    }
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  ops(): PluginOperationSnapshot[] {
    return this.order.map((opId) => this.operations.get(opId)?.snapshot ?? {
      opId,
      phase: 'settled' as const,
    })
  }

  waitForOp(opId: string): Promise<PluginOperationSnapshot> {
    const record = this.operations.get(opId)
    if (record === undefined) {
      return Promise.reject(new PluginServiceError('unknown-op', `no operation ${opId}`))
    }
    return record.settled
  }

  // -- emission -------------------------------------------------------------

  private emit(name: string, payload: unknown): void {
    // A disposed service stays silent: Qt may already be tearing the panel down.
    if (!this.active) return
    this.host.emitEvent(name, payload)
  }

  private emitChanged(result: ChangeResult): void {
    if (result.changed !== true) return
    this.emit('plugin.changed', { target: result.target, application: result.application })
  }

  // -- read methods ---------------------------------------------------------

  private async listPlugins(): Promise<unknown> {
    if (this.manager.listPlugins === undefined) {
      throw new PluginServiceError('unavailable', 'this build has no listPlugins()')
    }
    return await this.manager.listPlugins()
  }

  private async listBundles(): Promise<unknown> {
    if (this.manager.listBundles === undefined) {
      throw new PluginServiceError('unavailable', 'this build has no listBundles()')
    }
    return await this.manager.listBundles()
  }

  private async setPluginEnabled(params: unknown): Promise<unknown> {
    const record = requireRecord(params, 'params')
    const id = requireString(record['id'], 'id')
    const enabled = requireBoolean(record['enabled'], 'enabled')
    const manager = this.manager.setPluginEnabled
    if (manager === undefined) {
      throw new PluginServiceError('unavailable', 'this build has no setPluginEnabled()')
    }
    let value: unknown
    try {
      value = await manager(id, enabled)
    } catch (error) {
      return converge(error, 'enable', id)
    }
    const result = readChangeResult(value, 'enable', id)
    this.emitChanged(result)
    return value
  }

  private async setBundleEnabled(params: unknown): Promise<unknown> {
    const record = requireRecord(params, 'params')
    const name = requireString(record['name'], 'name')
    const enabled = requireBoolean(record['enabled'], 'enabled')
    const manager = this.manager.setBundleEnabled
    if (manager === undefined) {
      throw new PluginServiceError('unavailable', 'this build has no setBundleEnabled()')
    }
    let value: unknown
    try {
      value = await manager(name, enabled)
    } catch (error) {
      return converge(error, 'enable', name)
    }
    const result = readChangeResult(value, 'enable', name)
    this.emitChanged(result)
    return value
  }

  // -- long operations ------------------------------------------------------

  private openOperation(): OperationRecord {
    this.counter += 1
    const opId = `op-${this.counter}`
    let resolve: (snapshot: PluginOperationSnapshot) => void = () => {}
    const settled = new Promise<PluginOperationSnapshot>((inner) => {
      resolve = inner
    })
    const snapshot: PluginOperationSnapshot = { opId, phase: 'installing' }
    const record: OperationRecord = { opId, phase: 'installing', snapshot, settled, resolve }
    this.operations.set(opId, record)
    this.order.push(opId)
    this.emit('plugin.op.progress', { opId, phase: 'installing' })
    return record
  }

  private settleOperation(record: OperationRecord, next: PluginOperationSnapshot): void {
    record.phase = 'settled'
    record.snapshot = next
    // Resolve even when disposed: the caller may still be awaiting this op.
    record.resolve(next)
    if (this.active) this.emit('plugin.op.progress', next)
    while (this.order.length > this.maxRetainedOps) {
      const dropped = this.order.shift()
      if (dropped !== undefined) this.operations.delete(dropped)
    }
  }

  private async startInstall(params: unknown): Promise<{ opId: string }> {
    const record = requireRecord(params, 'params')
    const spec = requireString(record['spec'], 'spec')
    const manager = this.manager.installBundle
    if (manager === undefined) {
      throw new PluginServiceError('unavailable', 'this build has no installBundle()')
    }
    const registry = record['registry']
    const approvedBuilds = record['approvedBuilds']
    const operation = this.openOperation()
    const options: Record<string, unknown> = { requestId: operation.opId }
    if (typeof registry === 'string') options['registry'] = registry
    if (Array.isArray(approvedBuilds)) options['approvedBuilds'] = approvedBuilds

    void (async () => {
      let result: ChangeResult
      try {
        const value = await manager(spec, options)
        result = readChangeResult(value, 'install', spec)
      } catch (error) {
        result = converge(error, 'install', spec)
      }
      this.emitChanged(result)
      this.settleOperation(operation, { opId: operation.opId, phase: 'settled', result })
    })()
    return { opId: operation.opId }
  }

  private async startUpdate(params: unknown): Promise<{ opId: string }> {
    const record = requireRecord(params, 'params')
    const name = requireString(record['name'], 'name')
    const version = requireString(record['version'], 'version')
    const manager = this.manager.updateBundle
    if (manager === undefined) {
      throw new PluginServiceError('unavailable', 'this build has no updateBundle()')
    }
    const operation = this.openOperation()

    void (async () => {
      let result: ChangeResult
      let update: PluginOperationSnapshot['update']
      try {
        const value = await manager(name, version, { requestId: operation.opId })
        const outer = isRecord(value) ? value : undefined
        const inner = outer?.['result']
        result = readChangeResult(inner ?? value, 'install', name)
        if (outer !== undefined) {
          update = {
            from: outer['from'],
            to: outer['to'],
            step: outer['step'],
            ...(outer['restore'] === undefined ? {} : { restore: outer['restore'] }),
          }
        }
      } catch (error) {
        result = converge(error, 'install', name)
      }
      this.emitChanged(result)
      this.settleOperation(operation, {
        opId: operation.opId,
        phase: 'settled',
        result,
        ...(update === undefined ? {} : { update }),
      })
    })()
    return { opId: operation.opId }
  }

  private async startRemove(params: unknown): Promise<{ opId: string }> {
    const record = requireRecord(params, 'params')
    const name = requireString(record['name'], 'name')
    const manager = this.manager.removeBundle
    if (manager === undefined) {
      throw new PluginServiceError('unavailable', 'this build has no removeBundle()')
    }
    const operation = this.openOperation()

    void (async () => {
      let result: ChangeResult
      try {
        const value = await manager(name)
        result = readChangeResult(value, 'remove', name)
      } catch (error) {
        result = converge(error, 'remove', name)
      }
      this.emitChanged(result)
      this.settleOperation(operation, { opId: operation.opId, phase: 'settled', result })
    })()
    return { opId: operation.opId }
  }

  private async cancelOp(params: unknown): Promise<{ opId: string; cancelling: boolean }> {
    const record = requireRecord(params, 'params')
    const opId = requireString(record['opId'], 'opId')
    const operation = this.operations.get(opId)
    if (operation === undefined || operation.phase === 'settled') {
      return { opId, cancelling: false }
    }
    operation.phase = 'cancelling'
    this.emit('plugin.op.progress', { opId, phase: 'cancelling' })
    try {
      await this.manager.cancelInstall?.(opId)
    } catch {
      // The manager refusing to cancel is not the caller's error; the op settles
      // when the install really finishes.
    }
    return { opId, cancelling: true }
  }

  // -- slots ----------------------------------------------------------------

  private async listSlots(params: unknown): Promise<{ contributions: Record<string, unknown>[] }> {
    const record = isRecord(params) ? params : {}
    const surface = record['surface']
    const contributions =
      typeof surface === 'string' && surface.length > 0 ? this.slots.contributions(surface) : this.slots.all()
    return { contributions: contributions.map(projectSlot) }
  }

  private async registerSlot(params: unknown): Promise<unknown> {
    const record = requireRecord(params, 'params')
    const surface = requireString(record['surface'], 'surface')
    const spec = requireRecord(record['spec'], 'spec')
    const slotId = record['slotId']
    const input = typeof slotId === 'string' && slotId.length > 0 ? { ...spec, id: slotId } : spec
    const result = this.slots.register(surface, input)
    if (!result.ok) {
      throw new PluginServiceError(
        result.refusal.reason === 'duplicate' ? 'duplicate-slot' : 'invalid-slot',
        result.refusal.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      )
    }
    return { ok: true, contribution: projectSlot(result.registration.contribution) }
  }

  private renderSlot(params: unknown): ConversionResult {
    const record = requireRecord(params, 'params')
    const slotId = requireString(record['slotId'], 'slotId')
    const slot = this.slots.byId(slotId)
    if (slot === undefined) {
      throw new PluginServiceError('unknown-slot', `no slot is registered as ${slotId}`)
    }
    const props = record['props']
    return this.renderContribution(slot, isRecord(props) ? props : undefined)
  }

  private async dispatchAction(params: unknown): Promise<ConversionResult> {
    const record = requireRecord(params, 'params')
    const slotId = requireString(record['slotId'], 'slotId')
    const event = requireString(record['event'], 'event')
    const slot = this.slots.byId(slotId)
    if (slot === undefined) {
      throw new PluginServiceError('unknown-slot', `no slot is registered as ${slotId}`)
    }
    if (typeof slot.action !== 'function') {
      throw new PluginServiceError('no-action', `slot ${slotId} does not handle ${event}`)
    }
    const current = this.props.get(slotId) ?? {}
    const next = slot.action(event, record['payload'], current)
    if (isRecord(next)) this.props.set(slotId, next)
    return this.renderContribution(slot, isRecord(next) ? next : current)
  }

  private renderContribution(
    slot: SlotContribution,
    props: Record<string, unknown> | undefined,
  ): ConversionResult {
    if (slot.uiType !== undefined && !isSupportedUiType(slot.uiType)) {
      // P1: name the control, offer the fallback, never render blank.
      this.emit('ui.unsupported', { slotId: slot.id, type: slot.uiType })
      return {
        status: 'text',
        reason: reason('F1', `ui.type "${slot.uiType}" has no Qt control`, '$'),
        text: UNSUPPORTED_CONTROL_NOTICE,
      }
    }
    if (typeof slot.render !== 'function') {
      return {
        status: 'text',
        reason: reason('F5', 'this slot ships its own QML view, not a render function', '$'),
        text: slot.title ?? slot.id,
      }
    }
    const effective = props ?? this.props.get(slot.id) ?? {}
    let tree: unknown
    try {
      tree = slot.render(effective)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        status: 'text',
        reason: reason('F5', `the slot renderer threw: ${detail}`, '$'),
        text: slot.title ?? slot.id,
      }
    }
    return convertSlotTree(tree, { slotId: slot.id, webEntry: readWebEntry(slot) })
  }
}

function reason(code: ConversionReasonCode, detail: string, path: string) {
  return { code, name: CONVERSION_REASON_NAMES[code], detail, path }
}

export function createPluginService(options: PluginServiceOptions): PluginService {
  return new PluginServiceImplementation(options)
}
