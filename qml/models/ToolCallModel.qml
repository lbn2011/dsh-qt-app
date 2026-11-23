// ToolCallModel.qml — the tool row list the chat flow renders.
//
// One row per tool call. The rows come from `ToolProjection` in src/tools/,
// which is the authoritative state machine: it owns event ordering, session
// isolation, truncation and chart validation. This model is a thin, in-place
// mirror of that output — it never re-derives state from raw events, so there is
// exactly one place where the five-state ladder is decided.
//
// Why a ListModel and not a plain array: a tool result can arrive while the
// panel is scrolled, and a full array swap would rebuild every delegate and lose
// the scroll position. `applyRow()` therefore updates one row in place and emits
// `rowChanged(callId)`; only a session switch (`applySnapshot`) rebuilds.
//
// Roles (one-to-one with ToolRowDTO in src/tools/dto.ts):
//
//   callId string parentCallId string|null name string titleKey string
//   variant "search"|"read"|"bash"|"write"|"edit"|"code"|"others"
//   state "preparing"|"running"|"ok"|"error"|"stopped"
//   turn int step int
//   argsRaw string argsComplete bool argsBytes int summary string|null
//   resultText string resultPreview string resultLines int resultBytes int
//   resultTruncated bool exitCode int|null
//   errorName string errorCode string errorReason string
//   chart object|null chartRejected string table object|null
//   seq int time real
//   expanded bool               (view state: collapsed by default)
import QtQuick

ListModel {
    id: model

    // ---- The five states, as constants so no view hard-codes a string ------
    readonly property string statePreparing: "preparing"
    readonly property string stateRunning: "running"
    readonly property string stateOk: "ok"
    readonly property string stateError: "error"
    readonly property string stateStopped: "stopped"

    /** States a row may never leave (plan S5). */
    readonly property var terminalStates: [model.stateOk, model.stateError, model.stateStopped]

    /** Session the rows belong to (single-session view, plan P6). */
    property string sessionKey: ""
    /** Host epoch the rows were projected under. */
    property string epoch: ""
    /** Highest session seq applied so far; -1 before the first snapshot. */
    property int watermark: -1
    /** True when the projection capped its row list. */
    property bool snapshotTruncated: false
    /**
     * Rows whose update was refused because it would have left a terminal state.
     *
     * The projection already refuses these, so a non-zero count here means the
     * wire sent something the model and the projection disagree about — worth
     * surfacing instead of hiding.
     */
    property int ignoredRegressions: 0

    /** Emitted after a row is appended. */
    signal rowAdded(string callId)
    /** Emitted after an existing row is updated in place. */
    signal rowChanged(string callId)
    /** Emitted after a full rebuild (session switch / resync). */
    signal reset()

    /** True when `state` is one of the three terminal states. */
    function isTerminal(state) {
        return model.terminalStates.indexOf(state) >= 0
    }

    /** Row index for a call id, or -1. */
    function indexOfCall(callId) {
        const key = model.text(callId)
        for (let i = 0; i < model.count; ++i) {
            if (model.get(i).callId === key)
                return i
        }
        return -1
    }

    /**
     * Insert or update one row.
     *
     * A terminal row is never overwritten by a different state: the late wire
     * event is counted in `ignoredRegressions` and dropped. Everything else is
     * written in place so the delegate, its scroll position and the expanded
     * flag all survive.
     *
     * @param row a ToolRowDTO-shaped object
     * @returns the row index, or -1 when the argument was unusable
     */
    function applyRow(row) {
        if (row === null || row === undefined)
            return -1
        const callId = model.text(row.callId)
        if (callId === "")
            return -1

        const incomingState = model.text(row.state === undefined || row.state === null
                                         ? model.stateRunning : row.state)
        const existing = model.indexOfCall(callId)
        if (existing >= 0) {
            const current = model.get(existing)
            if (model.isTerminal(current.state) && current.state !== incomingState) {
                model.ignoredRegressions += 1
                return existing
            }
            const patch = model.roleValues(row)
            // `expanded` is view state: an update must not collapse an open row.
            delete patch.expanded
            for (const key in patch)
                model.setProperty(existing, key, patch[key])
            model.rowChanged(callId)
            return existing
        }

        model.append(model.roleValues(row))
        model.rowAdded(callId)
        return model.count - 1
    }

    /** Apply a list of rows, preserving their order. */
    function applyRows(rows) {
        if (rows === null || rows === undefined)
            return
        for (let i = 0; i < rows.length; ++i)
            model.applyRow(rows[i])
    }

    /**
     * Replace every row from a `tool.snapshot` payload.
     *
     * This is the only path that clears: a session switch and an epoch change
     * both go through here, so rows from two sessions can never be mixed.
     *
     * @param snapshot `{ sessionKey, epoch, seq, rows, truncated }`
     * @returns true when the snapshot was applied
     */
    function applySnapshot(snapshot) {
        if (snapshot === null || snapshot === undefined)
            return false
        model.clear()
        model.sessionKey = model.text(snapshot.sessionKey)
        model.epoch = model.text(snapshot.epoch)
        model.watermark = model.number(snapshot.seq, -1)
        model.snapshotTruncated = snapshot.truncated === true
        model.ignoredRegressions = 0
        model.applyRows(snapshot.rows)
        model.reset()
        return true
    }

    /**
     * Read one row back as a plain object; null when the index is invalid.
     *
     * The model itself can only hold strings, numbers and booleans (a ListModel
     * role cannot be created from a null or an arbitrary object), so the stored
     * row is decoded here: optional text becomes `null` again, `exitCode`
     * becomes a number, and `chart`/`table` are parsed back from their JSON text.
     */
    function rowAt(index) {
        if (index < 0 || index >= model.count)
            return null
        return model.decode(model.get(index))
    }

    /** Storage row -> DTO-shaped object (nulls restored, JSON decoded). */
    function decode(item) {
        const errorName = model.text(item.errorName)
        return {
            "callId": model.text(item.callId),
            "parentCallId": model.text(item.parentCallId) === "" ? null : model.text(item.parentCallId),
            "name": model.text(item.name),
            "titleKey": model.text(item.titleKey),
            "variant": model.text(item.variant),
            "state": model.text(item.state),
            "turn": model.number(item.turn, 0),
            "step": model.number(item.step, 0),
            "argsRaw": model.text(item.argsRaw),
            "argsComplete": item.argsComplete === true,
            "argsBytes": model.number(item.argsBytes, 0),
            "summary": model.text(item.summary),
            "resultText": model.text(item.resultText),
            "resultPreview": model.text(item.resultPreview),
            "resultLines": model.number(item.resultLines, 0),
            "resultBytes": model.number(item.resultBytes, 0),
            "resultTruncated": item.resultTruncated === true,
            "exitCode": model.text(item.exitCode) === "" ? null : Number(item.exitCode),
            "error": errorName === "" ? null : {
                         "name": errorName,
                         "code": model.text(item.errorCode),
                         "reason": model.text(item.errorReason) === "" ? null : model.text(item.errorReason)
                     },
            "errorName": errorName,
            "errorCode": model.text(item.errorCode),
            "errorReason": model.text(item.errorReason),
            "chart": model.decodeJson(item.chart),
            "chartRejected": model.text(item.chartRejected),
            "table": model.decodeJson(item.table),
            "seq": model.number(item.seq, 0),
            "time": model.number(item.time, 0),
            "expanded": item.expanded === true
        }
    }

    /** Serialise an optional payload for storage; null/undefined become "". */
    function encode(value) {
        if (value === null || value === undefined)
            return ""
        return JSON.stringify(value)
    }

    /** Parse a stored payload back into an object; "" and bad JSON become null. */
    function decodeJson(value) {
        const text = model.text(value)
        if (text === "")
            return null
        try {
            return JSON.parse(text)
        } catch (error) {
            return null
        }
    }

    /** Read one row by call id; null when it is unknown. */
    function rowFor(callId) {
        return model.rowAt(model.indexOfCall(callId))
    }

    /** Expand or collapse one row. */
    function setExpanded(callId, expanded) {
        const index = model.indexOfCall(callId)
        if (index < 0)
            return false
        model.setProperty(index, "expanded", expanded === true)
        return true
    }

    /** Flip one row's expanded state; returns the new value (-1 when unknown). */
    function toggleExpanded(callId) {
        const index = model.indexOfCall(callId)
        if (index < 0)
            return false
        const next = model.get(index).expanded !== true
        model.setProperty(index, "expanded", next)
        return next
    }

    /** Drop every row without touching the session identity. */
    function clearRows() {
        model.clear()
        model.reset()
    }

    // ---- Internal normalisation -------------------------------------------

    /** Coerce to string; null/undefined become "". */
    function text(value) {
        return value === null || value === undefined ? "" : String(value)
    }

    /** Coerce to number with a fallback. */
    function number(value, fallback) {
        return typeof value === "number" && isFinite(value) ? value : fallback
    }

    /** Coerce to an optional object (chart / table payloads). */
    function objectOrNull(value) {
        return value === null || value === undefined ? null : value
    }

    /**
     * Build the complete role object for one DTO.
     *
     * Every role is present on append — a missing role in the first append would
     * make the role unknown to the whole model.
     */
    function roleValues(row) {
        const error = model.objectOrNull(row.error)
        const errorName = model.text(row.errorName) !== ""
                          ? model.text(row.errorName)
                          : (error === null ? "" : model.text(error.name))
        const errorCode = model.text(row.errorCode) !== ""
                          ? model.text(row.errorCode)
                          : (error === null ? "" : model.text(error.code))
        const errorReason = model.text(row.errorReason) !== ""
                            ? model.text(row.errorReason)
                            : (error === null ? "" : model.text(error.reason))

        return {
            "callId": model.text(row.callId),
            "parentCallId": model.text(row.parentCallId),
            "name": model.text(row.name),
            "titleKey": model.text(row.titleKey),
            "variant": model.text(row.variant) === "" ? "others" : model.text(row.variant),
            "state": model.text(row.state) === "" ? model.stateRunning : model.text(row.state),
            "turn": model.number(row.turn, 0),
            "step": model.number(row.step, 0),
            "argsRaw": model.text(row.argsRaw),
            "argsComplete": row.argsComplete === true,
            "argsBytes": model.number(row.argsBytes, 0),
            "summary": model.text(row.summary),
            "resultText": model.text(row.resultText),
            "resultPreview": model.text(row.resultPreview),
            "resultLines": model.number(row.resultLines, 0),
            "resultBytes": model.number(row.resultBytes, 0),
            "resultTruncated": row.resultTruncated === true,
            "exitCode": typeof row.exitCode === "number" && isFinite(row.exitCode)
                        ? String(row.exitCode)
                        : "",
            "errorName": errorName,
            "errorCode": errorCode,
            "errorReason": errorReason,
            "chart": model.encode(row.chart),
            "chartRejected": model.text(row.chartRejected),
            "table": model.encode(row.table),
            "seq": model.number(row.seq, 0),
            "time": model.number(row.time, 0),
            "expanded": row.expanded === true
        }
    }
}
