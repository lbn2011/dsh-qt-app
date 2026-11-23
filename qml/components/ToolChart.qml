// ToolChart.qml — a deliberately small bar / line chart.
//
// Scope (plan §3.7): the ONLY data this component draws is an explicitly
// declared payload of the shape
//
//   { type: "bar" | "line", title?: string, series: [{ name?: string,
//                                                     points: [{ x: number, y: number }] }] }
//
// Anything else is refused upstream by ToolProjection and shown as text, so this
// file never inspects free-form JSON, never fetches anything, and renders no
// SVG/HTML. That is what keeps "we draw charts" from turning into "we guess what
// the model meant".
//
// Drawn with the Qt Quick Canvas: no third-party charting dependency, no
// QML-internal C++ requirement, and it repaints on resize without relayouting
// the chat flow.
import QtQuick

Item {
    id: chartRoot

    /** The validated chart payload from the projection; null means "draw nothing". */
    property var chart: null
    /** Theme object (qml/components/Theme.qml); null falls back to neutral colors. */
    property var theme: null

    /** Hard point budget; mirrors TOOL_CHART_MAX_POINTS in src/tools/dto.ts. */
    readonly property int maxPoints: 1000
    /** Chart height in device-independent pixels. */
    readonly property int chartHeight: 160

    readonly property var series: {
        if (chartRoot.chart === null || chartRoot.chart === undefined)
            return []
        const value = chartRoot.chart.series
        return value === undefined || value === null ? [] : value
    }

    readonly property string chartType: {
        if (chartRoot.chart === null || chartRoot.chart === undefined)
            return ""
        const value = chartRoot.chart.type
        return value === "bar" || value === "line" ? value : ""
    }

    readonly property string title: {
        if (chartRoot.chart === null || chartRoot.chart === undefined)
            return ""
        const value = chartRoot.chart.title
        return value === undefined || value === null ? "" : String(value)
    }

    readonly property int pointCount: {
        let total = 0
        for (let s = 0; s < chartRoot.series.length; ++s) {
            const points = chartRoot.series[s].points
            if (points !== undefined && points !== null)
                total += points.length
        }
        return total
    }

    /** True when the payload is cheap enough to draw. */
    readonly property bool overBudget: chartRoot.pointCount > chartRoot.maxPoints

    /** True only for a declared, in-budget, non-empty bar/line payload. */
    readonly property bool valid: chartRoot.chartType !== "" && chartRoot.pointCount > 0 && !chartRoot.overBudget

    readonly property real minX: chartRoot.bound("x", true)
    readonly property real maxX: chartRoot.bound("x", false)
    readonly property real minY: chartRoot.bound("y", true)
    readonly property real maxY: chartRoot.bound("y", false)

    implicitWidth: 240
    implicitHeight: chartRoot.valid ? chartRoot.chartHeight : 0

    readonly property color axisColor: chartRoot.colorOr("border", "#3a3a3a")
    readonly property color labelColor: chartRoot.colorOr("textMuted", "#8b8b8b")

    onChartChanged: canvas.requestPaint()
    onWidthChanged: canvas.requestPaint()
    onHeightChanged: canvas.requestPaint()
    onThemeChanged: canvas.requestPaint()

    Canvas {
        id: canvas
        objectName: "toolChartCanvas"
        anchors.fill: parent
        visible: chartRoot.valid
        onPaint: chartRoot.paint(canvas.getContext("2d"))
    }

    /** Read one numeric field from the theme, or fall back. */
    function colorOr(name, fallback) {
        if (chartRoot.theme === null || chartRoot.theme === undefined)
            return fallback
        const value = chartRoot.theme[name]
        return value === undefined || value === null ? fallback : value
    }

    /** Color for series `index`; a fixed palette so two series never merge. */
    function seriesColor(index) {
        // The palette is theme-tinted at both ends but stays distinguishable in
        // every scheme, because a chart legend is read, not just looked at.
        const palette = [
            chartRoot.colorOr("accent", "#4c8dff"),
            chartRoot.colorOr("warning", "#e0a03c"),
            chartRoot.colorOr("success", "#4caf7d"),
            chartRoot.colorOr("danger", "#e05c5c"),
            chartRoot.colorOr("textMuted", "#8b8b8b")
        ]
        return palette[index % palette.length]
    }

    /** Extremum of one axis across every series. */
    function bound(axis, wantMin) {
        let best = NaN
        for (let s = 0; s < chartRoot.series.length; ++s) {
            const points = chartRoot.series[s].points
            if (points === undefined || points === null)
                continue
            for (let p = 0; p < points.length; ++p) {
                const value = points[p][axis]
                if (typeof value !== "number" || !isFinite(value))
                    continue
                if (isNaN(best) || (wantMin ? value < best : value > best))
                    best = value
            }
        }
        return isNaN(best) ? 0 : best
    }

    /** Draw the chart. Called from the Canvas `onPaint` handler. */
    function paint(ctx) {
        const w = chartRoot.width
        const h = chartRoot.height
        ctx.clearRect(0, 0, w, h)
        if (!chartRoot.valid || w <= 0 || h <= 0)
            return

        const padLeft = 12
        const padRight = 12
        const padTop = chartRoot.title === "" ? 8 : 26
        const padBottom = 10
        const plotW = Math.max(1, w - padLeft - padRight)
        const plotH = Math.max(1, h - padTop - padBottom)

        const spanY = chartRoot.maxY - chartRoot.minY === 0 ? 1 : chartRoot.maxY - chartRoot.minY
        const spanX = chartRoot.maxX - chartRoot.minX === 0 ? 1 : chartRoot.maxX - chartRoot.minX
        const yOf = function (value) {
            return padTop + plotH - ((value - chartRoot.minY) / spanY) * plotH
        }
        const xOf = function (value) {
            return padLeft + ((value - chartRoot.minX) / spanX) * plotW
        }

        // Baseline + quarter lines: enough to read a magnitude, cheap to draw.
        ctx.strokeStyle = chartRoot.axisColor
        ctx.lineWidth = 1
        for (let line = 0; line <= 2; ++line) {
            const y = padTop + (plotH * line) / 2
            ctx.beginPath()
            ctx.moveTo(padLeft, y)
            ctx.lineTo(padLeft + plotW, y)
            ctx.stroke()
        }

        if (chartRoot.title !== "") {
            ctx.fillStyle = chartRoot.labelColor
            ctx.font = "11px sans-serif"
            ctx.fillText(chartRoot.title, padLeft, 14)
        }

        for (let s = 0; s < chartRoot.series.length; ++s) {
            const seriesValue = chartRoot.series[s]
            const points = seriesValue.points
            if (points === undefined || points === null || points.length === 0)
                continue
            const color = chartRoot.seriesColor(s)
            const seriesName = seriesValue.name === undefined || seriesValue.name === null
                               ? "" : String(seriesValue.name)
            if (seriesName !== "") {
                ctx.fillStyle = color
                ctx.font = "10px sans-serif"
                ctx.fillText(seriesName, padLeft + (s * plotW) / Math.max(1, chartRoot.series.length), 10)
            }

            if (chartRoot.chartType === "bar") {
                const slot = plotW / Math.max(1, points.length)
                const barWidth = Math.max(2, slot / (chartRoot.series.length + 1))
                ctx.fillStyle = color
                for (let p = 0; p < points.length; ++p) {
                    const centre = padLeft + slot * p + slot / 2
                                  + (s - (chartRoot.series.length - 1) / 2) * barWidth
                    const top = yOf(points[p].y)
                    ctx.fillRect(centre - barWidth / 2, top, barWidth, padTop + plotH - top)
                }
            } else {
                ctx.strokeStyle = color
                ctx.lineWidth = 2
                ctx.beginPath()
                for (let p = 0; p < points.length; ++p) {
                    const x = xOf(points[p].x)
                    const y = yOf(points[p].y)
                    if (p === 0)
                        ctx.moveTo(x, y)
                    else
                        ctx.lineTo(x, y)
                }
                ctx.stroke()
            }
        }
    }
}
