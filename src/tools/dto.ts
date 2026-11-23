/**
 * Wire-level DTOs for the tool row projection (I2).
 *
 * Everything the QML side renders about a tool call travels through these
 * types. They are deliberately flat and JSON-shaped: `ToolProjection` produces
 * them from official `session/event` records, the host handler forwards them as
 * `tool.row` / `tool.snapshot` payloads, and `ToolCallModel.qml` maps them onto
 * roles one-to-one. No field here is optional-by-omission: absence is always
 * `null`, so a QML `role` never has to distinguish "missing" from "null".
 *
 * Limits are exported because the tests and the QML side both need the exact
 * numbers (plan §7 three-layer truncation, §3.7 chart bounds).
 */

/** The five row states. Plan S5: no sixth state, terminal states never regress. */
export type ToolRowState = 'preparing' | 'running' | 'ok' | 'error' | 'stopped'

/**
 * Row variants, copied verbatim from the official renderer
 * (dsh-client-ui-tool `classifyTool`). The variant only picks the summary key
 * and the preview budget — it never changes the row's identity.
 */
export type ToolRowVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others'

/** States after which a row may never transition again. */
export const TERMINAL_TOOL_STATES: readonly ToolRowState[] = ['ok', 'error', 'stopped']

/** Result preview budget for ordinary variants (official CHAT_*_MAX_LINES = 8). */
export const TOOL_PREVIEW_LINES = 8
/** Diff-shaped variants (write/edit) get one extra preview line (official = 9). */
export const TOOL_DIFF_PREVIEW_LINES = 9
/** Hard cap on stored result lines. */
export const TOOL_RESULT_MAX_LINES = 2000
/** Hard cap on stored result bytes (UTF-8). */
export const TOOL_RESULT_MAX_BYTES = 200_000
/** Hard cap on total chart points across all series (§3.7: 1000). */
export const TOOL_CHART_MAX_POINTS = 1000
/** Default cap on retained rows per session snapshot. */
export const TOOL_MAX_ROWS = 500

/** Why an explicitly-declared chart was refused instead of guessed. */
export type ToolChartRejection =
  | 'type-mismatch'
  | 'empty-series'
  | 'non-numeric'
  | 'too-many-points'

export interface ToolErrorDTO {
  readonly name: string
  readonly code: string
  readonly reason: string | null
}

export interface ToolPointDTO {
  readonly x: number
  readonly y: number
}

export interface ToolSeriesDTO {
  readonly name: string | null
  readonly points: readonly ToolPointDTO[]
}

/**
 * An explicitly declared chart. Only ever produced from `meta.chart` (§3.7);
 * never inferred from arbitrary JSON text.
 */
export interface ToolChartDTO {
  readonly type: 'bar' | 'line'
  readonly title: string | null
  readonly series: readonly ToolSeriesDTO[]
}

/** An explicitly declared table: a header row plus equally-wide rows. */
export interface ToolTableDTO {
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

/**
 * One tool row, in the exact shape the QML model consumes.
 *
 * `resultText` is already truncated and safe to render; `resultPreview` is the
 * collapsed-state excerpt; `resultLines` / `resultBytes` describe the ORIGINAL
 * result so the UI can say "showing 2000 of 12345 lines" truthfully.
 */
export interface ToolRowDTO {
  readonly callId: string
  readonly parentCallId: string | null
  readonly name: string
  /** Localization key for the row title (e.g. `tool.title.bash`). */
  readonly titleKey: string
  readonly variant: ToolRowVariant
  readonly state: ToolRowState
  readonly turn: number
  readonly step: number
  /** Raw model-emitted JSON text, verbatim, never repaired. */
  readonly argsRaw: string
  /** True only when `argsRaw` parses as JSON. Partial text stays `false`. */
  readonly argsComplete: boolean
  readonly argsBytes: number
  readonly summary: string | null
  readonly resultText: string
  readonly resultPreview: string
  readonly resultLines: number
  readonly resultBytes: number
  readonly resultTruncated: boolean
  readonly exitCode: number | null
  readonly error: ToolErrorDTO | null
  readonly chart: ToolChartDTO | null
  readonly chartRejected: ToolChartRejection | null
  readonly table: ToolTableDTO | null
  /** Session seq of the event that last touched this row. */
  readonly seq: number
  /** Wall-clock ms of the last event that touched this row. */
  readonly time: number
}

/** Full row list for one session, as returned by `tool.snapshot`. */
export interface ToolSnapshot {
  readonly sessionKey: string
  readonly epoch: string
  /** Highest applied session seq; the watermark the client resumes from. */
  readonly seq: number
  readonly rows: readonly ToolRowDTO[]
  /** True when the row list was capped at `TOOL_MAX_ROWS`. */
  readonly truncated: boolean
}

/** Drop counters. Anything dropped is counted — silence is a bug. */
export interface ToolProjectionStats {
  /** Events that changed at least one row. */
  applied: number
  /** Same seq as the watermark: a duplicate delivery, never replayed. */
  duplicates: number
  /** Seq below the watermark: late delivery, never replayed. */
  outOfOrder: number
  /** Transitions out of a terminal state, or other illegal moves. */
  rejectedTransitions: number
  /** Events belonging to a session other than the projected one. */
  foreignSession: number
  /** Non-tool session events, ignored on purpose. */
  unknownEvents: number
  /** Structurally invalid tool events. */
  malformed: number
  /**
   * Settled results whose `tool/call` was never seen (a history slice that
   * starts mid-turn). The row is still created — losing a finished call would
   * be worse than showing it without its arguments.
   */
  orphanResults: number
  /** Events dropped while waiting for a `tool.snapshot` after an epoch change. */
  droppedWhileResyncing: number
  /** Rows whose result was truncated by a cap. */
  truncatedResults: number
  /** Charts actually handed to the renderer. */
  chartsRendered: number
  /** Explicit chart payloads refused with a reason (§3.7 degradation). */
  chartsRejected: number
}
