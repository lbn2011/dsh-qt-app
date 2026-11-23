/**
 * Tool event projection (I2).
 *
 * Turns official `session/event` records into the flat row DTOs the QML side
 * renders. This module is pure and synchronous: it owns no bridge, no timers
 * and no QML — the host handler feeds it events and serializes the result, and
 * the tests pin every rule without a Qt process.
 *
 * Pinned behaviour (plan §3.2/§3.4/§3.7, decisions S5 + P6):
 *   - Five states only, terminal states never regress.
 *   - One session at a time; another session's event is dropped and counted.
 *   - `seq` is monotonic per session: duplicates and late events are dropped.
 *   - An epoch change invalidates the watermark: the caller must resync from a
 *     `tool.snapshot` instead of trusting seq ordering across a host restart.
 *   - Arguments and results are shown verbatim and truncated by explicit caps;
 *     charts appear only from an explicit `meta.chart` payload.
 *
 * Nothing here guesses. Unknown tool names keep the `others` variant, unknown
 * JSON shapes stay text, and every dropped event increments a counter.
 */
import {
  TERMINAL_TOOL_STATES,
  TOOL_CHART_MAX_POINTS,
  TOOL_DIFF_PREVIEW_LINES,
  TOOL_MAX_ROWS,
  TOOL_PREVIEW_LINES,
  TOOL_RESULT_MAX_BYTES,
  TOOL_RESULT_MAX_LINES,
} from './dto.js'
import type {
  ToolChartDTO,
  ToolChartRejection,
  ToolErrorDTO,
  ToolPointDTO,
  ToolProjectionStats,
  ToolRowDTO,
  ToolRowState,
  ToolRowVariant,
  ToolSeriesDTO,
  ToolSnapshot,
  ToolTableDTO,
} from './dto.js'

/**
 * The subset of an official session event this projection needs.
 *
 * `data` stays `unknown` on purpose: it is validated field-by-field below, so a
 * malformed or forward-compatible event can never crash the renderer.
 */
export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly time?: number
  readonly data?: unknown
}

/** Where an event came from. Omitted fields are assumed to be the current session/epoch. */
export interface ToolEventContext {
  readonly sessionKey?: string
  readonly epoch?: string
}

/** One streaming `tool.args` delta (plan §3.2: raw text, Qt never parses it). */
export interface ToolArgsDeltaInput {
  readonly callId: string
  readonly argsDelta: string
  readonly seq?: number
  readonly turn?: number
  readonly step?: number
}

export interface ToolProjectionOptions {
  readonly maxResultLines?: number
  readonly maxResultBytes?: number
  readonly maxChartPoints?: number
  readonly previewLines?: number
  readonly diffPreviewLines?: number
  readonly maxRows?: number
  readonly maxSummaryChars?: number
}

/** Official variant classification (dsh-client-ui-tool `classifyTool`), copied verbatim. */
export const TOOL_VARIANTS: Readonly<Record<string, ToolRowVariant>> = {
  bash: 'bash',
  pwsh: 'bash',
  read: 'read',
  read_image: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  apply_patch: 'edit',
  run_code: 'code',
  cordis_package_inspect: 'read',
  cordis_runtime_inspect: 'read',
  cordis_run: 'others',
  cordis_stop: 'others',
  cordis_undefine: 'others',
}

/** Fallback title key per variant (official VARIANT_TITLE_KEYS). */
export const VARIANT_TITLE_KEYS: Readonly<Record<ToolRowVariant, string>> = {
  search: 'tool.title.search',
  read: 'tool.title.read',
  bash: 'tool.title.bash',
  write: 'tool.title.write',
  edit: 'tool.title.edit',
  code: 'tool.title.code',
  others: 'tool.title.generic',
}

/** Name-specific title keys that refine the variant title without changing it. */
export const TOOL_TITLE_KEYS: Readonly<Record<string, string>> = {
  apply_patch: 'tool.title.applyPatch',
  pwsh: 'tool.title.pwsh',
  read_image: 'tool.title.readImage',
  web_search: 'tool.title.webSearch',
  web_fetch: 'tool.title.webFetch',
  grep: 'tool.title.grep',
  glob: 'tool.title.glob',
  run_code: 'tool.title.code',
  subagent: 'tool.title.subagent',
  workflow: 'tool.title.workflow',
  ralph: 'tool.title.ralph',
}

/**
 * Which argument fields may be shown as the collapsed one-line summary.
 *
 * This is a closed allow-list per tool name — the same list the official
 * renderer uses. It is the ONLY place an argument field is ever read by name;
 * everything else is shown as raw text.
 */
export const TOOL_SUMMARY_KEYS: Readonly<Record<string, readonly string[]>> = {
  bash: ['description', 'command'],
  pwsh: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  read_image: ['path', 'file_path'],
  web_fetch: ['url'],
  web_search: ['query'],
  grep: ['pattern', 'query'],
  glob: ['pattern', 'query'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  apply_patch: ['path', 'file_path'],
  run_code: ['description'],
  subagent: ['description'],
}

/** Variant lookup: unknown tools degrade to `others`, never to a guess. */
export function classifyTool(name: string): ToolRowVariant {
  return TOOL_VARIANTS[name] ?? 'others'
}

/** Localization key for a row title. */
export function toolTitleKey(name: string): string {
  return TOOL_TITLE_KEYS[name] ?? VARIANT_TITLE_KEYS[classifyTool(name)]
}

/** Preview line budget for a variant. */
function previewBudget(variant: ToolRowVariant, options: Required<ToolProjectionOptions>): number {
  return variant === 'write' || variant === 'edit' ? options.diffPreviewLines : options.previewLines
}

/** A JSON object, as opposed to an array or a scalar. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Project an explicit chart payload (§3.7).
 *
 * `null` chart + `null` rejection means "no chart was declared": the caller
 * must render text. `null` chart + a rejection means "a chart WAS declared and
 * is invalid": the caller renders the raw text plus a "cannot plot" notice.
 */
export function projectChart(
  meta: unknown,
  maxPoints: number = TOOL_CHART_MAX_POINTS,
): { chart: ToolChartDTO | null; rejected: ToolChartRejection | null } {
  if (!isPlainObject(meta)) return { chart: null, rejected: null }
  const raw = meta['chart']
  if (raw === undefined || raw === null) return { chart: null, rejected: null }
  if (!isPlainObject(raw)) return { chart: null, rejected: 'type-mismatch' }

  const type = raw['type']
  if (type !== 'bar' && type !== 'line') return { chart: null, rejected: 'type-mismatch' }

  const seriesRaw = raw['series']
  if (!Array.isArray(seriesRaw) || seriesRaw.length === 0) return { chart: null, rejected: 'empty-series' }

  const series: ToolSeriesDTO[] = []
  let total = 0
  for (const seriesValue of seriesRaw) {
    if (!isPlainObject(seriesValue)) return { chart: null, rejected: 'type-mismatch' }
    const pointsRaw = seriesValue['points']
    if (!Array.isArray(pointsRaw) || pointsRaw.length === 0) return { chart: null, rejected: 'empty-series' }

    const points: ToolPointDTO[] = []
    for (const pointValue of pointsRaw) {
      if (!isPlainObject(pointValue)) return { chart: null, rejected: 'type-mismatch' }
      const x = pointValue['x']
      const y = pointValue['y']
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
        return { chart: null, rejected: 'non-numeric' }
      }
      points.push({ x, y })
      total += 1
    }

    const nameValue = seriesValue['name']
    series.push({ name: typeof nameValue === 'string' ? nameValue : null, points })
  }

  if (total > maxPoints) return { chart: null, rejected: 'too-many-points' }

  const titleValue = raw['title']
  return {
    chart: { type, title: typeof titleValue === 'string' ? titleValue : null, series },
    rejected: null,
  }
}

/** Project an explicit table payload: a header row plus equally-wide rows. */
export function projectTable(meta: unknown): ToolTableDTO | null {
  if (!isPlainObject(meta)) return null
  const raw = meta['table']
  if (!isPlainObject(raw)) return null

  const headersRaw = raw['headers']
  const rowsRaw = raw['rows']
  if (!Array.isArray(headersRaw) || !Array.isArray(rowsRaw) || headersRaw.length === 0 || rowsRaw.length === 0) {
    return null
  }

  const headers: string[] = []
  for (const header of headersRaw) {
    if (typeof header !== 'string') return null
    headers.push(header)
  }

  const rows: string[][] = []
  for (const rowValue of rowsRaw) {
    if (!Array.isArray(rowValue) || rowValue.length !== headers.length) return null
    const row: string[] = []
    for (const cell of rowValue) {
      if (typeof cell === 'string') row.push(cell)
      else if (typeof cell === 'number' || typeof cell === 'boolean') row.push(String(cell))
      else return null
    }
    rows.push(row)
  }

  return { headers, rows }
}

/** The collapsed one-line summary, from the allow-listed keys only. */
export function summarizeArguments(name: string, argsRaw: string, maxChars = 200): string | null {
  const keys = TOOL_SUMMARY_KEYS[name]
  if (keys === undefined) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null

  for (const key of keys) {
    const value = parsed[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed === '') continue
    return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed
  }
  return null
}

/** Flatten result content the way the official renderer does. */
export function flattenResultContent(content: unknown, error: ToolErrorDTO | null): string {
  const parts: string[] = []
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isPlainObject(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
        parts.push(block['text'])
      } else if (block !== null && block !== undefined) {
        parts.push(JSON.stringify(block, null, 2) ?? '')
      }
    }
  }
  if (parts.length === 0 && error !== null) parts.push(`${error.name}: ${error.code}`)
  return parts.join('\n')
}

/** Cut a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function headBytes(text: string, maxBytes: number): string {
  let used = 0
  let end = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    used += size
    end += char.length
  }
  return text.slice(0, end)
}

const TRUNCATION_MARKER = '…[truncated]'

/** Apply the line cap and then the byte cap, marking the cut when it happens. */
function truncateResult(
  text: string,
  maxLines: number,
  maxBytes: number,
): { text: string; truncated: boolean } {
  let out = text
  let truncated = false

  const lines = out.split('\n')
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join('\n')
    truncated = true
  }
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = headBytes(out, maxBytes)
    truncated = true
  }
  if (truncated) out = `${out}\n${TRUNCATION_MARKER}`
  return { text: out, truncated }
}

/** Collapsed-state excerpt: the first N lines of the (already truncated) text. */
function previewOf(text: string, lines: number): string {
  const all = text.split('\n')
  return all.length <= lines ? text : all.slice(0, lines).join('\n')
}

interface ParsedCall {
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly name: string
  readonly argsRaw: string
}

interface ParsedResult {
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly content: unknown
  readonly isError: boolean
  readonly error: ToolErrorDTO | null
  readonly meta: unknown
}

function parseError(value: unknown): ToolErrorDTO | null {
  if (!isPlainObject(value)) return null
  const name = value['name']
  const code = value['code']
  if (typeof name !== 'string' || typeof code !== 'string' || name === '' || code === '') return null
  const reason = value['reason']
  return { name, code, reason: typeof reason === 'string' ? reason : null }
}

function parseCall(data: unknown): ParsedCall | null {
  if (!isPlainObject(data)) return null
  const turn = data['turn']
  const step = data['step']
  const callId = data['callId']
  const name = data['name']
  const argsRaw = data['arguments']
  if (typeof turn !== 'number' || typeof step !== 'number') return null
  if (typeof callId !== 'string' || callId === '') return null
  if (typeof name !== 'string' || name === '') return null
  if (typeof argsRaw !== 'string') return null
  return { turn, step, callId, name, argsRaw }
}

function parseResult(data: unknown): ParsedResult | null {
  if (!isPlainObject(data)) return null
  const turn = data['turn']
  const step = data['step']
  const message = data['message']
  if (typeof turn !== 'number' || typeof step !== 'number') return null
  if (!isPlainObject(message)) return null

  let callId = message['toolCallId']
  if (typeof callId !== 'string' || callId === '') {
    const source = message['source']
    callId = isPlainObject(source) ? source['callId'] : undefined
  }
  if (typeof callId !== 'string' || callId === '') return null

  return {
    turn,
    step,
    callId,
    content: message['content'],
    isError: message['isError'] === true,
    error: parseError(data['error']),
    meta: data['meta'],
  }
}

/** Official state derivation (dsh-client-ui-tool lib/client.js:330-336). */
function deriveState(
  input: { readonly isError: boolean; readonly error: ToolErrorDTO | null; readonly meta: unknown },
): ToolRowState {
  if (input.error !== null && input.error.code === 'interrupted') return 'stopped'
  const stoppedFlag = isPlainObject(input.meta) && input.meta['stopped'] === true
  if (input.isError || stoppedFlag) return 'error'
  return 'ok'
}

function isTerminal(state: ToolRowState): boolean {
  return TERMINAL_TOOL_STATES.includes(state)
}

/** Mutable row while events are applied; converted to a DTO on the way out. */
interface RowDraft {
  callId: string
  parentCallId: string | null
  name: string
  titleKey: string
  variant: ToolRowVariant
  state: ToolRowState
  turn: number
  step: number
  argsRaw: string
  argsComplete: boolean
  summary: string | null
  resultText: string
  resultPreview: string
  resultLines: number
  resultBytes: number
  resultTruncated: boolean
  exitCode: number | null
  error: ToolErrorDTO | null
  chart: ToolChartDTO | null
  chartRejected: ToolChartRejection | null
  table: ToolTableDTO | null
  seq: number
  time: number
}

/**
 * Projects one session's tool events into rows.
 *
 * Use `beginSession` (fresh) or `applySnapshot` (resync) before feeding live
 * events; both are idempotent resets, which is what makes a session switch and
 * an epoch change safe.
 */
export class ToolProjection {
  private readonly limit: Required<ToolProjectionOptions>
  private readonly rows_ = new Map<string, RowDraft>()
  private order_: string[] = []
  private sessionKey_: string | null = null
  private epoch_: string | null = null
  private watermark_ = -1
  private pendingResync_ = false
  private readonly stats_: ToolProjectionStats = {
    applied: 0,
    duplicates: 0,
    outOfOrder: 0,
    rejectedTransitions: 0,
    foreignSession: 0,
    unknownEvents: 0,
    malformed: 0,
    orphanResults: 0,
    droppedWhileResyncing: 0,
    truncatedResults: 0,
    chartsRendered: 0,
    chartsRejected: 0,
  }

  constructor(options: ToolProjectionOptions = {}) {
    this.limit = {
      maxResultLines: options.maxResultLines ?? TOOL_RESULT_MAX_LINES,
      maxResultBytes: options.maxResultBytes ?? TOOL_RESULT_MAX_BYTES,
      maxChartPoints: options.maxChartPoints ?? TOOL_CHART_MAX_POINTS,
      previewLines: options.previewLines ?? TOOL_PREVIEW_LINES,
      diffPreviewLines: options.diffPreviewLines ?? TOOL_DIFF_PREVIEW_LINES,
      maxRows: options.maxRows ?? TOOL_MAX_ROWS,
      maxSummaryChars: options.maxSummaryChars ?? 200,
    }
  }

  get sessionKey(): string | null {
    return this.sessionKey_
  }

  get epoch(): string | null {
    return this.epoch_
  }

  /** Highest session seq that has been consumed. */
  get watermark(): number {
    return this.watermark_
  }

  get stats(): ToolProjectionStats {
    return this.stats_
  }

  /** True after an epoch change until a snapshot rebuild happens. */
  needsResync(): boolean {
    return this.pendingResync_
  }

  /** Start projecting a session from scratch (session switch, or first attach). */
  beginSession(sessionKey: string, epoch: string): void {
    this.rows_.clear()
    this.order_ = []
    this.sessionKey_ = sessionKey
    this.epoch_ = epoch
    this.watermark_ = -1
    this.pendingResync_ = false
  }

  /**
   * Rebuild from a full history slice plus its watermark.
   *
   * This is the ONLY way to move a projection to another session or epoch: it
   * clears first, so the result never mixes two sessions' rows (P6).
   */
  applySnapshot(input: {
    readonly sessionKey: string
    readonly epoch: string
    readonly seq: number
    readonly events: readonly SessionEventLike[]
  }): ToolSnapshot {
    this.beginSession(input.sessionKey, input.epoch)
    for (const event of input.events) this.applyEvent(event)
    if (Number.isFinite(input.seq) && input.seq > this.watermark_) this.watermark_ = input.seq
    return this.snapshot()
  }

  /**
   * Apply one official session event.
   *
   * Returns the rows that changed (empty when the event was dropped or was not
   * a tool event at all). Never throws on malformed data.
   */
  applyEvent(event: SessionEventLike, context: ToolEventContext = {}): ToolRowDTO[] {
    const type = event.type
    if (type !== 'tool/call' && type !== 'tool/result') {
      this.stats_.unknownEvents += 1
      return []
    }

    if (this.sessionKey_ === null || this.epoch_ === null) {
      this.stats_.malformed += 1
      return []
    }

    const sessionKey = context.sessionKey
    if (sessionKey !== undefined && sessionKey !== this.sessionKey_) {
      this.stats_.foreignSession += 1
      return []
    }

    const epoch = context.epoch
    if (epoch !== undefined && epoch !== this.epoch_) {
      // The host restarted or the epoch rotated: seq ordering is void.
      this.pendingResync_ = true
    }
    if (this.pendingResync_) {
      this.stats_.droppedWhileResyncing += 1
      return []
    }

    const seq = event.seq
    if (!Number.isFinite(seq) || seq < 0) {
      this.stats_.malformed += 1
      return []
    }
    if (seq < this.watermark_) {
      this.stats_.outOfOrder += 1
      return []
    }
    if (seq === this.watermark_) {
      this.stats_.duplicates += 1
      return []
    }

    const time = typeof event.time === 'number' ? event.time : 0
    const changed = type === 'tool/call' ? this.applyCall(event.data, seq, time) : this.applyResult(event.data, seq, time)
    this.watermark_ = seq
    return changed
  }

  /** Apply one `tool.args` streaming delta. Returns the touched row, or null when dropped. */
  applyArgsDelta(input: ToolArgsDeltaInput): ToolRowDTO | null {
    if (this.sessionKey_ === null || this.pendingResync_) {
      this.stats_.droppedWhileResyncing += 1
      return null
    }
    if (typeof input.callId !== 'string' || input.callId === '' || typeof input.argsDelta !== 'string') {
      this.stats_.malformed += 1
      return null
    }

    const seq = input.seq
    if (seq !== undefined) {
      if (!Number.isFinite(seq) || seq < 0) {
        this.stats_.malformed += 1
        return null
      }
      if (seq < this.watermark_) {
        this.stats_.outOfOrder += 1
        return null
      }
      if (seq === this.watermark_) {
        this.stats_.duplicates += 1
        return null
      }
    }

    const existing = this.rows_.get(input.callId)
    if (existing !== undefined) {
      if (isTerminal(existing.state)) {
        this.stats_.rejectedTransitions += 1
        return null
      }
      existing.argsRaw += input.argsDelta
      existing.argsComplete = parsesAsJson(existing.argsRaw)
      existing.summary = summarizeArguments(existing.name, existing.argsRaw, this.limit.maxSummaryChars)
      existing.seq = seq ?? existing.seq
      this.stats_.applied += 1
      if (seq !== undefined) this.watermark_ = seq
      return this.toDTO(existing)
    }

    const turn = input.turn ?? 0
    const step = input.step ?? 0
    const draft = this.createDraft({
      callId: input.callId,
      name: '',
      argsRaw: input.argsDelta,
      turn,
      step,
      state: 'preparing',
      seq: seq ?? this.watermark_,
      time: 0,
    })
    this.stats_.applied += 1
    if (seq !== undefined) this.watermark_ = seq
    return this.toDTO(draft)
  }

  /** All rows in first-seen order. */
  rows(): ToolRowDTO[] {
    return this.order_.map((callId) => {
      const draft = this.rows_.get(callId)
      // Unreachable: order_ and rows_ are kept in lockstep.
      if (draft === undefined) throw new Error(`tool row ${callId} lost from the projection`)
      return this.toDTO(draft)
    })
  }

  row(callId: string): ToolRowDTO | null {
    const draft = this.rows_.get(callId)
    return draft === undefined ? null : this.toDTO(draft)
  }

  /** The snapshot payload for `tool.snapshot` (`sessionKey` defaults to the current one). */
  snapshot(sessionKey?: string): ToolSnapshot {
    const all = this.rows()
    const truncated = all.length > this.limit.maxRows
    const rows = truncated ? all.slice(all.length - this.limit.maxRows) : all
    return {
      sessionKey: sessionKey ?? this.sessionKey_ ?? '',
      epoch: this.epoch_ ?? '',
      seq: this.watermark_,
      rows,
      truncated,
    }
  }

  /** Forget every row but keep the session identity. */
  clear(): void {
    this.rows_.clear()
    this.order_ = []
  }

  private applyCall(data: unknown, seq: number, time: number): ToolRowDTO[] {
    const parsed = parseCall(data)
    if (parsed === null) {
      this.stats_.malformed += 1
      return []
    }

    const existing = this.rows_.get(parsed.callId)
    if (existing !== undefined) {
      if (isTerminal(existing.state)) {
        // A settled call never reopens, however the wire replays it.
        this.stats_.rejectedTransitions += 1
        return []
      }
      existing.name = parsed.name
      existing.titleKey = toolTitleKey(parsed.name)
      existing.variant = classifyTool(parsed.name)
      existing.argsRaw = parsed.argsRaw
      existing.argsComplete = parsesAsJson(parsed.argsRaw)
      existing.summary = summarizeArguments(parsed.name, parsed.argsRaw, this.limit.maxSummaryChars)
      existing.state = 'running'
      existing.turn = parsed.turn
      existing.step = parsed.step
      existing.seq = seq
      existing.time = time
      this.stats_.applied += 1
      return [this.toDTO(existing)]
    }

    const draft = this.createDraft({
      callId: parsed.callId,
      name: parsed.name,
      argsRaw: parsed.argsRaw,
      turn: parsed.turn,
      step: parsed.step,
      state: 'running',
      seq,
      time,
    })
    this.stats_.applied += 1
    return [this.toDTO(draft)]
  }

  private applyResult(data: unknown, seq: number, time: number): ToolRowDTO[] {
    const parsed = parseResult(data)
    if (parsed === null) {
      this.stats_.malformed += 1
      return []
    }

    const existing = this.rows_.get(parsed.callId)
    if (existing !== undefined && isTerminal(existing.state)) {
      this.stats_.rejectedTransitions += 1
      return []
    }

    const draft =
      existing ??
      this.createDraft({
        callId: parsed.callId,
        name: '',
        argsRaw: '',
        turn: parsed.turn,
        step: parsed.step,
        state: 'running',
        seq,
        time,
      })
    if (existing === undefined) this.stats_.orphanResults += 1

    this.settle(draft, parsed, seq, time)
    this.stats_.applied += 1
    return [this.toDTO(draft)]
  }

  /** Write a settled result onto a row, in one place, once. */
  private settle(draft: RowDraft, parsed: ParsedResult, seq: number, time: number): void {
    const flattened = flattenResultContent(parsed.content, parsed.error)
    const { text, truncated } = truncateResult(flattened, this.limit.maxResultLines, this.limit.maxResultBytes)
    const chart = projectChart(parsed.meta, this.limit.maxChartPoints)

    draft.state = deriveState({ isError: parsed.isError, error: parsed.error, meta: parsed.meta })
    draft.turn = parsed.turn
    draft.step = parsed.step
    draft.error = parsed.error
    draft.resultText = text
    draft.resultTruncated = truncated
    draft.resultLines = flattened.split('\n').length
    draft.resultBytes = Buffer.byteLength(flattened, 'utf8')
    draft.resultPreview = previewOf(text, previewBudget(draft.variant, this.limit))
    draft.chart = chart.chart
    draft.chartRejected = chart.rejected
    draft.table = projectTable(parsed.meta)
    draft.seq = seq
    draft.time = time

    const exitCode = isPlainObject(parsed.meta) ? parsed.meta['exitCode'] : undefined
    draft.exitCode = typeof exitCode === 'number' && Number.isFinite(exitCode) ? exitCode : null

    const parentCallId = isPlainObject(parsed.meta) ? parsed.meta['parentCallId'] : undefined
    draft.parentCallId = typeof parentCallId === 'string' && parentCallId !== '' ? parentCallId : null

    if (chart.chart !== null) this.stats_.chartsRendered += 1
    if (chart.rejected !== null) this.stats_.chartsRejected += 1
    if (truncated) this.stats_.truncatedResults += 1
  }

  private createDraft(input: {
    readonly callId: string
    readonly name: string
    readonly argsRaw: string
    readonly turn: number
    readonly step: number
    readonly state: ToolRowState
    readonly seq: number
    readonly time: number
  }): RowDraft {
    const draft: RowDraft = {
      callId: input.callId,
      parentCallId: null,
      name: input.name,
      titleKey: toolTitleKey(input.name),
      variant: classifyTool(input.name),
      state: input.state,
      turn: input.turn,
      step: input.step,
      argsRaw: input.argsRaw,
      argsComplete: parsesAsJson(input.argsRaw),
      summary: summarizeArguments(input.name, input.argsRaw, this.limit.maxSummaryChars),
      resultText: '',
      resultPreview: '',
      resultLines: 0,
      resultBytes: 0,
      resultTruncated: false,
      exitCode: null,
      error: null,
      chart: null,
      chartRejected: null,
      table: null,
      seq: input.seq,
      time: input.time,
    }
    this.rows_.set(input.callId, draft)
    this.order_.push(input.callId)
    return draft
  }

  private toDTO(draft: RowDraft): ToolRowDTO {
    return {
      callId: draft.callId,
      parentCallId: draft.parentCallId,
      name: draft.name,
      titleKey: draft.titleKey,
      variant: draft.variant,
      state: draft.state,
      turn: draft.turn,
      step: draft.step,
      argsRaw: draft.argsRaw,
      argsComplete: draft.argsComplete,
      argsBytes: Buffer.byteLength(draft.argsRaw, 'utf8'),
      summary: draft.summary,
      resultText: draft.resultText,
      resultPreview: draft.resultPreview,
      resultLines: draft.resultLines,
      resultBytes: draft.resultBytes,
      resultTruncated: draft.resultTruncated,
      exitCode: draft.exitCode,
      error: draft.error,
      chart: draft.chart,
      chartRejected: draft.chartRejected,
      table: draft.table,
      seq: draft.seq,
      time: draft.time,
    }
  }
}

/** True when the raw arguments text is complete, parseable JSON. */
function parsesAsJson(raw: string): boolean {
  if (raw.trim() === '') return false
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}
