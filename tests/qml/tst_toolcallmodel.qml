// tst_toolcallmodel.qml — Qt Quick Test suite for the tool-row view layer.
//
// Covers the QML half of RQ-04 (plan §I2): the five row states, in-place
// updates, the "a settled row never regresses" guard, snapshot rebuilds, the
// expansion toggle, and the rendering contract of ToolCallRow/ToolChart —
// including that a payload the projection refused to plot degrades to a notice
// instead of a chart.
//
// The projection itself (event decoding, ordering, truncation, chart
// validation) is covered by tests/tools-projection.test.ts; this suite assumes a
// ToolRowDTO and only checks what the view does with it.
import QtQuick
import QtTest
import "../../qml/models"
import "../../qml/views"
import "../../qml/components"

TestCase {
    id: testCase

    name: "ToolCallModel"
    when: windowShown
    // qmltestrunner keeps its own window hidden, and Item.visible propagates from
    // the parent, so the suite has to declare itself visible before any
    // `visible` assertion can mean anything (same idiom as tst_formcontrol).
    visible: true

    SignalSpy { id: rowAddedSpy; target: model; signalName: "rowAdded" }
    SignalSpy { id: rowChangedSpy; target: model; signalName: "rowChanged" }
    SignalSpy { id: resetSpy; target: model; signalName: "reset" }
    SignalSpy { id: copySpy; target: rowView; signalName: "copyRequested" }
    SignalSpy { id: expandSpy; target: rowView; signalName: "expansionChanged" }

    // ---- Fixtures ---------------------------------------------------------

    /** A row in the shape src/tools/dto.ts produces (all keys present). */
    function makeRow(overrides) {
        const row = {
            "callId": "call-1",
            "parentCallId": null,
            "name": "read",
            "titleKey": "tool.title.read",
            "variant": "read",
            "state": "running",
            "turn": 1,
            "step": 1,
            "argsRaw": "{\"path\":\"src/a.ts\"}",
            "argsComplete": true,
            "argsBytes": 20,
            "summary": "src/a.ts",
            "resultText": "line one\nline two",
            "resultPreview": "line one\nline two",
            "resultLines": 2,
            "resultBytes": 18,
            "resultTruncated": false,
            "exitCode": null,
            "error": null,
            "chart": null,
            "chartRejected": null,
            "table": null,
            "seq": 1,
            "time": 1732000000000,
            "expanded": false
        }
        if (overrides !== undefined) {
            const keys = Object.keys(overrides)
            for (let i = 0; i < keys.length; ++i)
                row[keys[i]] = overrides[keys[i]]
        }
        return row
    }

    function errorRow() {
        return makeRow({
            "state": "error",
            "error": { "name": "ToolError", "code": "EACCES", "reason": "permission denied" },
            "resultText": "",
            "resultPreview": ""
        })
    }

    function chartRow() {
        return makeRow({
            "state": "ok",
            "chart": {
                "type": "bar",
                "title": "Requests",
                "series": [{ "name": "hits", "points": [{ "x": 0, "y": 3 }, { "x": 1, "y": 5 }] }]
            }
        })
    }

    function rejectedChartRow() {
        return makeRow({ "state": "ok", "chartRejected": "non-numeric" })
    }

    function tableRow() {
        return makeRow({
            "state": "ok",
            "table": { "headers": ["file", "lines"], "rows": [["a.ts", 12], ["b.ts", 3]] }
        })
    }

    // ---- Items under test -------------------------------------------------

    ToolCallModel { id: model }

    ToolCallRow {
        id: rowView
        width: 600
        height: implicitHeight
    }

    ToolChart {
        id: chartView
        width: 320
        height: 200
        theme: Theme { }
    }

    function init() {
        model.clearRows()
        model.sessionKey = ""
        model.epoch = ""
        model.watermark = -1
        model.ignoredRegressions = 0
        rowView.row = null
        rowView.expanded = false
        chartView.chart = null
    }

    // ---- Model: states ----------------------------------------------------

    function test_stateConstants() {
        compare(model.statePreparing, "preparing")
        compare(model.stateRunning, "running")
        compare(model.stateOk, "ok")
        compare(model.stateError, "error")
        compare(model.stateStopped, "stopped")
        compare(model.terminalStates.length, 3)
        verify(model.isTerminal("ok"))
        verify(model.isTerminal("error"))
        verify(model.isTerminal("stopped"))
        verify(!model.isTerminal("running"))
        verify(!model.isTerminal("preparing"))
        verify(!model.isTerminal("bogus"))
    }

    function test_applyRowWalksFiveStates() {
        const states = ["preparing", "running", "ok"]
        for (let i = 0; i < states.length; ++i) {
            model.applyRow(makeRow({ "state": states[i], "seq": i + 1 }))
            compare(model.count, 1, "one row across every state")
            compare(model.rowAt(0).state, states[i])
        }

        model.clearRows()
        model.applyRow(makeRow({ "state": "stopped" }))
        compare(model.rowAt(0).state, "stopped")

        model.clearRows()
        model.applyRow(errorRow())
        compare(model.rowAt(0).state, "error")
        compare(model.rowAt(0).errorCode, "EACCES")
        compare(model.rowAt(0).errorReason, "permission denied")
    }

    function test_applyRowInsertsThenUpdatesInPlace() {
        rowAddedSpy.clear()
        rowChangedSpy.clear()

        compare(model.applyRow(makeRow({ "state": "running" })), 0)
        compare(rowAddedSpy.count, 1)
        compare(rowChangedSpy.count, 0)

        // Same call id, next state: updated in place, no second row.
        compare(model.applyRow(makeRow({ "state": "ok", "resultText": "done" })), 0)
        compare(model.count, 1)
        compare(rowAddedSpy.count, 1, "an update does not insert")
        compare(rowChangedSpy.count, 1, "an update announces itself")
        compare(model.rowAt(0).state, "ok")
        compare(model.rowAt(0).resultText, "done")
    }

    function test_terminalStateNeverRegresses() {
        model.applyRow(makeRow({ "state": "ok" }))
        compare(model.ignoredRegressions, 0)

        // A late duplicate, a stale run state and a spent error all bounce.
        const ignored = ["running", "preparing", "error"]
        for (let i = 0; i < ignored.length; ++i) {
            model.applyRow(makeRow({ "state": ignored[i] }))
            compare(model.rowAt(0).state, "ok", "settled rows keep their verdict")
        }
        compare(model.ignoredRegressions, 3)

        // A refreshed payload for the same settled state is still accepted.
        model.applyRow(makeRow({ "state": "ok", "resultText": "refreshed" }))
        compare(model.rowAt(0).resultText, "refreshed")
        compare(model.ignoredRegressions, 3)
    }

    function test_stoppedRowAlsoRefusesToRegress() {
        model.applyRow(makeRow({ "state": "stopped" }))
        model.applyRow(makeRow({ "state": "ok" }))
        compare(model.rowAt(0).state, "stopped", "a stopped row is terminal too")
        compare(model.ignoredRegressions, 1)
    }

    function test_expandedFlagSurvivesUpdates() {
        model.applyRow(makeRow({ "state": "running" }))
        compare(model.setExpanded("call-1", true), true)
        compare(model.rowAt(0).expanded, true)

        model.applyRow(makeRow({ "state": "ok" }))
        compare(model.rowAt(0).state, "ok")
        compare(model.rowAt(0).expanded, true, "an update must not collapse the row")

        compare(model.toggleExpanded("call-1"), false)
        compare(model.rowAt(0).expanded, false)

        compare(model.setExpanded("nope", true), false, "unknown call ids are refused")
    }

    function test_snapshotRebuildsAndSwitchesSession() {
        model.applyRow(makeRow({ "callId": "stale", "state": "running" }))
        resetSpy.clear()

        const applied = model.applySnapshot({
            "sessionKey": "s-1",
            "epoch": "e-7f3a",
            "seq": 42,
            "truncated": false,
            "rows": [
                makeRow({ "callId": "call-a", "state": "ok", "seq": 40 }),
                makeRow({ "callId": "call-b", "state": "running", "seq": 42 })
            ]
        })

        compare(applied, true)
        compare(resetSpy.count, 1, "a snapshot is the one path that clears")
        compare(model.count, 2, "the stale row is gone")
        compare(model.sessionKey, "s-1")
        compare(model.epoch, "e-7f3a")
        compare(model.watermark, 42)
        compare(model.rowAt(0).callId, "call-a")
        compare(model.rowAt(1).callId, "call-b")

        // Switching sessions goes through the same door: the old rows cannot
        // survive, which is what keeps two sessions from ever mixing (plan §P6).
        model.applySnapshot({
            "sessionKey": "s-2", "epoch": "e-0001", "seq": 1, "truncated": false,
            "rows": [makeRow({ "callId": "call-z", "state": "running" })]
        })
        compare(model.count, 1)
        compare(model.sessionKey, "s-2")
        compare(model.epoch, "e-0001")
        compare(model.rowAt(0).callId, "call-z")
        compare(model.indexOfCall("call-a"), -1)
    }

    function test_rowLookup() {
        model.applyRow(makeRow({ "callId": "call-a" }))
        model.applyRow(makeRow({ "callId": "call-b", "state": "ok" }))

        compare(model.indexOfCall("call-b"), 1)
        compare(model.indexOfCall("nope"), -1)
        compare(model.rowFor("call-b").state, "ok")
        compare(model.rowFor("nope"), null)
        compare(model.rowAt(99), null)
        compare(model.applyRow(null), -1)
        compare(model.applyRow({ "name": "no id" }), -1, "a row without a call id is unusable")
    }

    // ---- ToolCallRow ------------------------------------------------------

    function test_rowHeaderShowsTitleSummaryAndState() {
        rowView.row = makeRow({ "state": "running" })
        const title = findChild(rowView, "toolRowTitle")
        const state = findChild(rowView, "toolRowStateText")
        verify(title !== null)
        verify(state !== null)
        compare(title.text, "Read · src/a.ts")
        compare(state.text, "Running")
        compare(findChild(rowView, "toolRowStateDot").color, rowView.theme.accent)

        rowView.row = makeRow({ "state": "ok" })
        compare(findChild(rowView, "toolRowStateText").text, "Done")
        compare(findChild(rowView, "toolRowStateDot").color, rowView.theme.success)

        rowView.row = errorRow()
        compare(findChild(rowView, "toolRowStateText").text, "Failed")
        compare(findChild(rowView, "toolRowStateDot").color, rowView.theme.danger)

        rowView.row = makeRow({ "state": "stopped" })
        compare(findChild(rowView, "toolRowStateText").text, "Stopped")
        compare(findChild(rowView, "toolRowStateDot").color, rowView.theme.warning)
    }

    function test_rowUnknownToolFallsBackToRawName() {
        rowView.row = makeRow({ "name": "some_new_tool", "titleKey": "tool.title.unknown", "summary": "" })
        compare(findChild(rowView, "toolRowTitle").text, "some_new_tool")

        rowView.row = makeRow({ "name": "", "titleKey": "", "summary": "" })
        compare(findChild(rowView, "toolRowTitle").text, "Tool call")
    }

    function test_preparingRowShowsByteCount() {
        rowView.row = makeRow({ "state": "preparing", "summary": "", "argsBytes": 2048 })
        compare(findChild(rowView, "toolRowTitle").text, "Read · 2.0 KB")
    }

    function test_collapsedRowShowsPreviewOnly() {
        rowView.row = makeRow({ "state": "ok" })
        rowView.expanded = false
        const preview = findChild(rowView, "toolRowPreview")
        compare(preview.visible, true)
        compare(preview.text, "line one\nline two")
        compare(preview.maximumLineCount, 3)
        compare(findChild(rowView, "toolRowResultSection").visible, false)
        compare(findChild(rowView, "toolRowArgsSection").visible, false)
    }

    function test_expandedRowShowsArgsResultAndStreamingNotice() {
        rowView.row = makeRow({ "state": "running", "argsComplete": false })
        rowView.expanded = true

        compare(findChild(rowView, "toolRowPreview").visible, false)
        compare(findChild(rowView, "toolRowArgsSection").visible, true)
        compare(findChild(rowView, "toolRowArgsBody").text, "{\"path\":\"src/a.ts\"}")
        compare(findChild(rowView, "toolRowArgsStreaming").visible, true)
        compare(findChild(rowView, "toolRowResultSection").visible, true)
        compare(findChild(rowView, "toolRowResultBody").text, "line one\nline two")

        rowView.row = makeRow({ "state": "ok", "argsComplete": true })
        compare(findChild(rowView, "toolRowArgsStreaming").visible, false)
    }

    function test_errorAndEmptyOutputAreStated() {
        rowView.expanded = true
        rowView.row = errorRow()
        compare(findChild(rowView, "toolRowError").text, "ToolError (EACCES): permission denied")
        compare(findChild(rowView, "toolRowEmptyNotice").visible, false)

        rowView.row = makeRow({ "state": "ok", "resultText": "", "resultPreview": "" })
        compare(findChild(rowView, "toolRowError").visible, false)
        compare(findChild(rowView, "toolRowEmptyNotice").visible, true, "no output is stated, not hidden")
    }

    function test_truncatedResultIsAnnounced() {
        rowView.expanded = true
        rowView.row = makeRow({ "state": "ok", "resultTruncated": true, "resultLines": 2000 })
        const notice = findChild(rowView, "toolRowTruncationNotice")
        compare(notice.visible, true)
        verify(notice.text.indexOf("2000") >= 0)
    }

    function test_copyEmitsPayload() {
        rowView.row = makeRow({ "state": "ok" })
        copySpy.clear()
        mouseClick(findChild(rowView, "toolRowCopyButton"))
        compare(copySpy.count, 1)
        compare(copySpy.signalArguments[0][0], "line one\nline two")
        compare(copySpy.signalArguments[0][1], "Tool output")

        rowView.row = makeRow({ "state": "preparing", "resultText": "", "resultPreview": "" })
        copySpy.clear()
        mouseClick(findChild(rowView, "toolRowCopyButton"))
        compare(copySpy.count, 1)
        compare(copySpy.signalArguments[0][0], "{\"path\":\"src/a.ts\"}", "no output yet: copy the arguments")
        compare(copySpy.signalArguments[0][1], "Tool arguments")
    }

    function test_expandToggleEmitsAndFlips() {
        rowView.row = makeRow({ "state": "ok" })
        expandSpy.clear()
        compare(findChild(rowView, "toolRowToggleButton").text, "Expand")

        mouseClick(findChild(rowView, "toolRowToggleButton"))
        compare(rowView.expanded, true)
        compare(expandSpy.count, 1)
        compare(expandSpy.signalArguments[0][0], "call-1")
        compare(expandSpy.signalArguments[0][1], true)
        compare(findChild(rowView, "toolRowToggleButton").text, "Collapse")
    }

    function test_chartRendersOnlyFromExplicitPayload() {
        rowView.expanded = true
        rowView.row = chartRow()
        const chart = findChild(rowView, "toolRowChart")
        compare(findChild(rowView, "toolRowChartSection").visible, true)
        compare(chart.visible, true)
        compare(chart.chartType, "bar")
        compare(chart.pointCount, 2)
        compare(chart.valid, true)
        compare(findChild(rowView, "toolRowChartNotice").visible, false)
    }

    function test_rejectedChartDegradesToNotice() {
        rowView.expanded = true
        rowView.row = rejectedChartRow()
        compare(findChild(rowView, "toolRowChartSection").visible, true)
        compare(findChild(rowView, "toolRowChart").visible, false, "no chart for a refused payload")
        const notice = findChild(rowView, "toolRowChartNotice")
        compare(notice.visible, true)
        verify(notice.text.indexOf("non-numeric") >= 0)
    }

    function test_jsonResultIsNeverGuessedIntoAChart() {
        // A result that merely *contains* chart-looking JSON must stay text.
        rowView.expanded = true
        rowView.row = makeRow({
            "state": "ok",
            "resultText": "{\"chart\":{\"type\":\"bar\",\"series\":[]}}",
            "resultPreview": "{\"chart\":{\"type\":\"bar\",\"series\":[]}}"
        })
        compare(findChild(rowView, "toolRowChartSection").visible, false)
        compare(findChild(rowView, "toolRowResultBody").text,
                "{\"chart\":{\"type\":\"bar\",\"series\":[]}}")
    }

    function test_tableRendersThroughMarkdownTable() {
        rowView.expanded = true
        rowView.row = tableRow()
        const table = findChild(rowView, "toolRowTable")
        compare(findChild(rowView, "toolRowTableSection").visible, true)
        compare(table.node.header.length, 2)
        compare(table.node.rows.length, 2)
        compare(table.node.header[0][0].text, "file")
    }

    function test_nullRowRendersEmptyShell() {
        rowView.row = null
        verify(rowView.implicitHeight > 0, "the card still exists")
        compare(findChild(rowView, "toolRowStateText").text, "")
        compare(findChild(rowView, "toolRowCopyButton").text, "Copy")
    }

    // ---- ToolChart --------------------------------------------------------

    function test_chartBoundsAndColors() {
        chartView.chart = {
            "type": "line",
            "series": [
                { "name": "a", "points": [{ "x": 0, "y": -2 }, { "x": 10, "y": 8 }] },
                { "name": "b", "points": [{ "x": 2, "y": 1 }] }
            ]
        }
        compare(chartView.chartType, "line")
        compare(chartView.series.length, 2)
        compare(chartView.pointCount, 3)
        compare(chartView.minX, 0)
        compare(chartView.maxX, 10)
        compare(chartView.minY, -2)
        compare(chartView.maxY, 8)
        compare(chartView.valid, true)
        verify(chartView.seriesColor(0) !== chartView.seriesColor(1), "series get distinct colors")
    }

    function test_chartOverBudgetIsInvalid() {
        const points = []
        for (let i = 0; i <= chartView.maxPoints; ++i)
            points.push({ "x": i, "y": i })
        chartView.chart = { "type": "bar", "series": [{ "name": "big", "points": points }] }
        compare(chartView.pointCount, chartView.maxPoints + 1)
        compare(chartView.overBudget, true)
        compare(chartView.valid, false, "over the point budget: degrade, do not paint")
    }

    function test_chartWithoutSeriesIsInvalid() {
        chartView.chart = { "type": "bar", "series": [] }
        compare(chartView.pointCount, 0)
        compare(chartView.valid, false)

        chartView.chart = null
        compare(chartView.chartType, "")
        compare(chartView.valid, false)
    }
}
