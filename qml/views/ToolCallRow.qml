// ToolCallRow.qml — one tool call, from `preparing` to a settled result.
//
// Layout, collapsed:
//
//   ● Search · pattern "timeout"                                         Copy ▸
//     3 matches in 2 files
//
// Expanded, the same row appends the raw arguments, the result (or its head plus
// a truncation notice), an error line, and — only when the tool declared one —
// a table or a bar/line chart.
//
// Every string rendered here is raw text from the projection except the state
// badge and the section labels; nothing is parsed, re-formatted or "pretty
// printed" from an arbitrary JSON payload. A result that happens to contain JSON
// is shown as the JSON text it is.
//
// The row is deliberately presentational: it owns expansion (a view concern) and
// emits `copyRequested`, but it never mutates the model and never talks to the
// bridge. Wiring lives with the integrator.
pragma ComponentBehavior: Bound

import QtQuick
import "../markdown"
import "../components"

Item {
    id: toolRow

    // ---- Input ------------------------------------------------------------

    /**
     * The row to render: a `ToolRowDTO` (src/tools/dto.ts) or a `ToolCallModel`
     * row object. Both shapes are accepted, so a test can hand in a literal and
     * a delegate can hand in the model row.
     */
    property var row: null

    /**
     * Optional pull-mode wiring for a ListView delegate:
     *
     *     delegate: ToolCallRow { rowModel: toolModel; rowIndex: index; revision: seq }
     *
     * `revision` exists only to re-read the row when the model changes it: a
     * ListModel write does not re-evaluate a plain `rowAt(index)` call otherwise.
     */
    property var rowModel: null
    property int rowIndex: -1
    property int revision: 0

    /** Expanded state. The collapsed row shows the title and the result preview. */
    property bool expanded: false

    /** Emitted when the user asks for a copy; the integrator owns the clipboard. */
    signal copyRequested(string text, string label)
    /** Emitted when the user expands or collapses this row. */
    signal expansionChanged(string callId, bool expanded)

    onRevisionChanged: toolRow.refresh()

    /** Re-read the row from `rowModel` (no-op when pull-mode is not wired). */
    function refresh() {
        if (toolRow.rowModel === null || toolRow.rowModel === undefined || toolRow.rowIndex < 0)
            return
        toolRow.row = toolRow.rowModel.rowAt(toolRow.rowIndex)
    }

    // ---- Styling ----------------------------------------------------------
    /**
     * Live theme source published by native/main.cpp as `ctx.theme`.
     *
     * Declared locally (same pattern as MessageDelegate) so a QML test or a
     * settings preview can instantiate this row on its own and still follow the
     * palette.
     */
    // qmllint disable unqualified
    readonly property QtObject themeBridge: (typeof ctx !== "undefined" && ctx.theme) ? ctx.theme : null
    // qmllint enable unqualified
    property Theme theme: Theme { bridge: toolRow.themeBridge }

    /**
     * Monospace family for arguments and output.
     *
     * Phase 1's token set has no monospace token (see docs/PHASE-3-TOOL-VIZ.md
     * C4). Rather than invent a token here — which would need a schema change in
     * theme/ — the row uses the same platform-agnostic fallback stack the
     * markdown CodeBlock uses. When a `monoFamily` token lands, this is the only
     * line that changes.
     */
    readonly property string monoFamily: "monospace"

    /** True when a row was supplied at all (a bare shell is a legal state). */
    readonly property bool hasRow: toolRow.row !== null && toolRow.row !== undefined

    // ---- Row fields -------------------------------------------------------
    /**
     * The row object, guaranteed non-null.
     *
     * Not called `data`: `Item` already owns a read-only `data` list property.
     */
    readonly property var fields: (toolRow.row === null || toolRow.row === undefined) ? ({}) : toolRow.row

    readonly property string callId: toolRow.field("callId", "")
    readonly property string toolName: toolRow.field("name", "")
    readonly property string titleKey: toolRow.field("titleKey", "")
    readonly property string variant: toolRow.field("variant", "others")
    readonly property string state: toolRow.field("state", "running")
    readonly property string summary: toolRow.field("summary", "")
    readonly property string argsRaw: toolRow.field("argsRaw", "")
    readonly property bool argsComplete: toolRow.fields.argsComplete === true
    readonly property int argsBytes: toolRow.numberField("argsBytes", 0)

    readonly property string resultText: toolRow.field("resultText", "")
    readonly property string resultPreview: toolRow.field("resultPreview", "")
    readonly property int resultLines: toolRow.numberField("resultLines", 0)
    readonly property bool resultTruncated: toolRow.fields.resultTruncated === true

    /**
     * The error payload, either flattened (`errorName`/`errorCode`/`errorReason`
     * as the model stores them) or nested (`error: {name, code, reason}` as the
     * projection's DTO carries it). Both shapes are accepted so a caller can hand
     * over either and this row never has to guess.
     */
    readonly property var errorPayload: (typeof toolRow.fields.error === "object"
                                         && toolRow.fields.error !== null) ? toolRow.fields.error : null
    readonly property string errorName: toolRow.field("errorName",
                                                      toolRow.payloadText("name"))
    readonly property string errorCode: toolRow.field("errorCode",
                                                      toolRow.payloadText("code"))
    readonly property string errorReason: toolRow.field("errorReason",
                                                        toolRow.payloadText("reason"))
    readonly property var exitCode: typeof toolRow.fields.exitCode === "number" ? toolRow.fields.exitCode : null

    readonly property var chart: toolRow.fields.chart === undefined ? null : toolRow.fields.chart
    readonly property string chartRejected: toolRow.field("chartRejected", "")
    readonly property var table: toolRow.fields.table === undefined ? null : toolRow.fields.table

    // ---- Derived presentation --------------------------------------------

    readonly property bool settled: state === "ok" || state === "error" || state === "stopped"
    readonly property bool failed: state === "error"
    readonly property bool stopped: state === "stopped"
    readonly property bool running: state === "preparing" || state === "running"

    /** Stable color per state; the only place a state maps to a color. */
    readonly property color stateColor: {
        if (toolRow.state === "ok")
            return toolRow.theme.success
        if (toolRow.state === "error")
            return toolRow.theme.danger
        if (toolRow.state === "stopped")
            return toolRow.theme.warning
        if (toolRow.state === "preparing")
            return toolRow.theme.textMuted
        return toolRow.theme.accent
    }

    /** Localized state text; `ok` states no word because the row reads as done. */
    readonly property string stateLabel: {
        if (!toolRow.hasRow)
            return ""
        if (toolRow.state === "preparing")
            return qsTr("Preparing")
        if (toolRow.state === "running")
            return qsTr("Running")
        if (toolRow.state === "error")
            return qsTr("Failed")
        if (toolRow.state === "stopped")
            return qsTr("Stopped")
        return qsTr("Done")
    }

    /** Human title from the localization key, falling back to the raw tool name. */
    readonly property string title: {
        switch (toolRow.titleKey) {
        case "tool.title.search": return qsTr("Search")
        case "tool.title.read": return qsTr("Read")
        case "tool.title.bash": return qsTr("Run command")
        case "tool.title.write": return qsTr("Write")
        case "tool.title.edit": return qsTr("Edit")
        case "tool.title.applyPatch": return qsTr("Apply patch")
        case "tool.title.code": return qsTr("Code")
        case "tool.title.pwsh": return qsTr("Run command")
        case "tool.title.readImage": return qsTr("Read image")
        case "tool.title.webSearch": return qsTr("Web search")
        case "tool.title.webFetch": return qsTr("Web fetch")
        case "tool.title.grep": return qsTr("Search contents")
        case "tool.title.glob": return qsTr("Find files")
        case "tool.title.subagent": return qsTr("Subagent")
        case "tool.title.workflow": return qsTr("Workflow")
        case "tool.title.ralph": return qsTr("Ralph")
        default:
            return toolRow.toolName !== "" ? toolRow.toolName : qsTr("Tool call")
        }
    }

    /** The one-line header: title, summary and — while streaming — a byte count. */
    readonly property string headerText: {
        let text = toolRow.title
        if (toolRow.summary !== "")
            text += " · " + toolRow.summary
        else if (toolRow.state === "preparing" && toolRow.argsBytes > 0)
            // The official preparing row shows how much of the argument payload
            // has arrived; a running or settled row shows the summary instead.
            text += " · " + qsTr("%1 KB").arg((toolRow.argsBytes / 1024).toFixed(1))
        if (toolRow.exitCode !== null && toolRow.exitCode !== 0)
            text += " · " + qsTr("exit %1").arg(toolRow.exitCode)
        return text
    }

    /** Body text: the full result when expanded, its head when collapsed. */
    readonly property string bodyText: toolRow.expanded ? toolRow.resultText : toolRow.resultPreview

    /** Collapsed-only preview line; hidden once expanded. */
    readonly property bool showPreview: !toolRow.expanded && toolRow.resultPreview !== ""

    /** True when a settled row produced no output at all — said, not hidden. */
    readonly property bool showEmptyNotice: toolRow.expanded && toolRow.settled
                                           && toolRow.resultText === "" && toolRow.errorName === ""

    /** Error text, including the official "tool was not executed" shape. */
    readonly property string errorText: {
        if (toolRow.errorName === "")
            return ""
        if (toolRow.errorReason !== "")
            return toolRow.errorName + " (" + toolRow.errorCode + "): " + toolRow.errorReason
        if (toolRow.errorCode !== "")
            return toolRow.errorName + " (" + toolRow.errorCode + ")"
        return toolRow.errorName
    }

    /** What "Copy" puts on the clipboard for this row. */
    readonly property string copyPayload: toolRow.resultText !== "" ? toolRow.resultText : toolRow.argsRaw
    readonly property string copyLabel: toolRow.resultText !== "" ? qsTr("Tool output") : qsTr("Tool arguments")

    /**
     * The declared table as a markdown table AST node, so the existing
     * `qml/markdown/Table.qml` renders it. Null when no table was declared.
     */
    readonly property var tableNode: {
        if (toolRow.table === null || toolRow.table === undefined)
            return null
        const headers = toolRow.table.headers
        const rows = toolRow.table.rows
        if (headers === undefined || headers === null || rows === undefined || rows === null)
            return null
        const toCells = function (values) {
            const cells = []
            for (let i = 0; i < values.length; ++i)
                cells.push([{ "type": "text", "text": String(values[i]) }])
            return cells
        }
        const body = []
        for (let r = 0; r < rows.length; ++r)
            body.push(toCells(rows[r]))
        return { "type": "table", "header": toCells(headers), "rows": body, "align": [] }
    }

    readonly property bool hasChart: toolRow.chart !== null && toolRow.chart !== undefined
                                     && (toolRow.chart.series === undefined
                                         || toolRow.chart.series.length > 0)

    implicitWidth: 0
    implicitHeight: card.height

    Rectangle {
        id: card
        objectName: "toolRowCard"
        width: toolRow.width
        height: content.implicitHeight + 2 * toolRow.theme.spacing
        radius: toolRow.theme.radius
        color: toolRow.theme.surface
        border.width: 1
        border.color: toolRow.failed ? toolRow.theme.danger
                    : toolRow.stopped ? toolRow.theme.warning
                    : toolRow.theme.border

        Column {
            id: content
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.margins: toolRow.theme.spacing
            spacing: toolRow.theme.spacing / 2

            // ---- Header ---------------------------------------------------
            Item {
                id: header
                objectName: "toolRowHeader"
                width: parent.width
                height: headerTitle.implicitHeight

                Rectangle {
                    id: stateDot
                    objectName: "toolRowStateDot"
                    width: 8
                    height: 8
                    radius: 4
                    color: toolRow.stateColor
                    anchors.left: parent.left
                    anchors.verticalCenter: headerTitle.verticalCenter
                }

                Text {
                    id: headerTitle
                    objectName: "toolRowTitle"
                    anchors.left: stateDot.right
                    anchors.leftMargin: toolRow.theme.spacing
                    anchors.right: actions.left
                    anchors.rightMargin: toolRow.theme.spacing
                    text: toolRow.headerText
                    elide: Text.ElideRight
                    textFormat: Text.PlainText
                    font.family: toolRow.theme.fontFamily
                    font.pixelSize: toolRow.theme.fontNormal
                    font.bold: true
                    color: toolRow.theme.text
                }

                Row {
                    id: actions
                    anchors.right: parent.right
                    anchors.verticalCenter: headerTitle.verticalCenter
                    spacing: toolRow.theme.spacing

                    Text {
                        id: stateText
                        objectName: "toolRowStateText"
                        text: toolRow.stateLabel
                        font.family: toolRow.theme.fontFamily
                        font.pixelSize: toolRow.theme.fontSmall
                        color: toolRow.stateColor
                    }

                    Text {
                        id: copyText
                        objectName: "toolRowCopyButton"
                        text: qsTr("Copy")
                        font.family: toolRow.theme.fontFamily
                        font.pixelSize: toolRow.theme.fontSmall
                        color: toolRow.theme.textMuted

                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: toolRow.copyRequested(toolRow.copyPayload, toolRow.copyLabel)
                        }
                    }

                    Text {
                        id: toggleText
                        objectName: "toolRowToggleButton"
                        text: toolRow.expanded ? qsTr("Collapse") : qsTr("Expand")
                        font.family: toolRow.theme.fontFamily
                        font.pixelSize: toolRow.theme.fontSmall
                        color: toolRow.theme.accent

                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                toolRow.expanded = !toolRow.expanded
                                toolRow.expansionChanged(toolRow.callId, toolRow.expanded)
                            }
                        }
                    }
                }
            }

            // ---- Collapsed preview ---------------------------------------
            Text {
                objectName: "toolRowPreview"
                width: parent.width
                visible: toolRow.showPreview
                text: toolRow.resultPreview
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                maximumLineCount: 3
                elide: Text.ElideRight
                font.family: toolRow.monoFamily
                font.pixelSize: toolRow.theme.fontSmall
                color: toolRow.theme.textMuted
            }

            // ---- Error ----------------------------------------------------
            Text {
                objectName: "toolRowError"
                width: parent.width
                visible: toolRow.errorText !== ""
                text: toolRow.errorText
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                font.family: toolRow.theme.fontFamily
                font.pixelSize: toolRow.theme.fontSmall
                color: toolRow.theme.danger
            }

            // ---- Arguments ------------------------------------------------
            Column {
                objectName: "toolRowArgsSection"
                width: parent.width
                visible: toolRow.expanded && toolRow.argsRaw !== ""
                spacing: 2

                Text {
                    objectName: "toolRowArgsLabel"
                    text: qsTr("Arguments")
                    font.family: toolRow.theme.fontFamily
                    font.pixelSize: toolRow.theme.fontSmall
                    color: toolRow.theme.textMuted
                }

                Text {
                    objectName: "toolRowArgsBody"
                    width: parent.width
                    text: toolRow.argsRaw
                    textFormat: Text.PlainText
                    wrapMode: Text.Wrap
                    font.family: toolRow.monoFamily
                    font.pixelSize: toolRow.theme.fontSmall
                    color: toolRow.theme.text
                }

                Text {
                    objectName: "toolRowArgsStreaming"
                    visible: !toolRow.argsComplete
                    text: qsTr("Arguments are still streaming")
                    font.family: toolRow.theme.fontFamily
                    font.pixelSize: toolRow.theme.fontSmall
                    color: toolRow.theme.warning
                }
            }

            // ---- Result ---------------------------------------------------
            Column {
                objectName: "toolRowResultSection"
                width: parent.width
                visible: toolRow.expanded
                spacing: 2

                Text {
                    objectName: "toolRowResultLabel"
                    text: qsTr("Output")
                    font.family: toolRow.theme.fontFamily
                    font.pixelSize: toolRow.theme.fontSmall
                    color: toolRow.theme.textMuted
                }

                Text {
                    objectName: "toolRowResultBody"
                    width: parent.width
                    visible: toolRow.bodyText !== ""
                    text: toolRow.bodyText
                    textFormat: Text.PlainText
                    wrapMode: Text.Wrap
                    font.family: toolRow.monoFamily
                    font.pixelSize: toolRow.theme.fontSmall
                    color: toolRow.theme.text
                }

                Text {
                    objectName: "toolRowTruncationNotice"
                    width: parent.width
                    visible: toolRow.resultTruncated
                    text: qsTr("Output truncated · showing the head of %1 lines").arg(toolRow.resultLines)
                    wrapMode: Text.Wrap
                    font.family: toolRow.theme.fontFamily
                    font.pixelSize: toolRow.theme.fontSmall
                    color: toolRow.theme.warning
                }

                Text {
                    objectName: "toolRowEmptyNotice"
                    visible: toolRow.showEmptyNotice
                    text: qsTr("No output")
                    font.family: toolRow.theme.fontFamily
                    font.pixelSize: toolRow.theme.fontSmall
                    color: toolRow.theme.textMuted
                }
            }

            // ---- Chart (only ever from an explicit payload) ---------------
            Column {
                objectName: "toolRowChartSection"
                width: parent.width
                visible: toolRow.expanded && (toolRow.hasChart || toolRow.chartRejected !== "")
                spacing: toolRow.theme.spacing / 2

                ToolChart {
                    objectName: "toolRowChart"
                    width: parent.width
                    visible: toolRow.hasChart
                    chart: toolRow.hasChart ? toolRow.chart : null
                    theme: toolRow.theme
                }

                Text {
                    objectName: "toolRowChartNotice"
                    width: parent.width
                    visible: toolRow.chartRejected !== ""
                    text: qsTr("This data cannot be plotted (%1)").arg(toolRow.chartRejected)
                    wrapMode: Text.Wrap
                    font.family: toolRow.theme.fontFamily
                    font.pixelSize: toolRow.theme.fontSmall
                    color: toolRow.theme.warning
                }
            }

            // ---- Table (only ever from an explicit payload) ---------------
            Column {
                objectName: "toolRowTableSection"
                width: parent.width
                visible: toolRow.expanded && toolRow.tableNode !== null
                spacing: 2

                Table {
                    objectName: "toolRowTable"
                    width: parent.width
                    node: toolRow.tableNode
                    theme: toolRow.theme
                }
            }
        }
    }

    // ---- Field helpers (tolerate both DTO and model-row shapes) -----------

    /** Read a string field, empty when absent. */
    function field(name, fallback) {
        const value = toolRow.fields[name]
        if (value === null || value === undefined || value === "")
            return fallback
        return String(value)
    }

    /** Read one string member of the nested error payload; "" when absent. */
    function payloadText(key) {
        if (toolRow.errorPayload === null)
            return ""
        const value = toolRow.errorPayload[key]
        return (value === null || value === undefined) ? "" : String(value)
    }

    /** Read a numeric field, `fallback` when absent or not finite. */
    function numberField(name, fallback) {
        const value = toolRow.fields[name]
        return typeof value === "number" && isFinite(value) ? value : fallback
    }
}
