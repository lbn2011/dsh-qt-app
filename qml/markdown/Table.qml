// Table.qml — a GFM pipe table.
//
// The AST stores a table as `header: cell[][]`, `rows: cell[][][]` and an optional
// `align: ("left"|"center"|"right"|null)[]`, where a cell is a list of inline
// nodes. Layout uses QtQuick's Grid, which sizes every column to its widest cell
// automatically — no manual text measurement, and no ragged columns.
//
// Wide tables scroll horizontally rather than squeezing the chat bubble: the
// Flickable only takes the width it is given and lets the Grid overflow.
pragma ComponentBehavior: Bound

import QtQuick

Item {
    id: root

    // ---- MarkdownNode role properties --------------------------------------
    property var node: null
    property string type: "table"
    property string role: "block"
    property string content: ""
    property var children: []

    property var theme: null

    readonly property MarkdownBase base: MarkdownBase {
        node: root.node
        theme: root.theme
    }

    readonly property var header: root.node !== null && root.node !== undefined
                                  && root.node.header !== undefined && root.node.header !== null
                                  ? root.node.header
                                  : []

    readonly property var rows: root.node !== null && root.node !== undefined
                                && root.node.rows !== undefined && root.node.rows !== null
                                ? root.node.rows
                                : []

    readonly property var align: root.node !== null && root.node !== undefined
                                 && root.node.align !== undefined && root.node.align !== null
                                 ? root.node.align
                                 : []

    readonly property int columnCount: root.header.length > 0
                                       ? root.header.length
                                       : (root.rows.length > 0 ? root.rows[0].length : 0)

    /** Flattened cell list: header cells first, then every body row. */
    readonly property var cells: {
        const out = []
        for (let c = 0; c < root.header.length; ++c)
            out.push({ "nodes": root.header[c], "isHeader": true, "column": c })
        for (let r = 0; r < root.rows.length; ++r) {
            const row = root.rows[r]
            for (let c = 0; c < row.length; ++c)
                out.push({ "nodes": row[c], "isHeader": false, "column": c })
        }
        return out
    }

    implicitWidth: 0
    implicitHeight: scroller.height

    Flickable {
        id: scroller
        objectName: "markdownTableScroller"
        width: root.width > 0 ? root.width : grid.implicitWidth
        height: grid.implicitHeight
        contentWidth: grid.implicitWidth
        contentHeight: grid.implicitHeight
        clip: true
        flickableDirection: Flickable.HorizontalFlick
        boundsBehavior: Flickable.StopAtBounds

        Grid {
            id: grid
            objectName: "markdownTableGrid"
            columns: Math.max(1, root.columnCount)
            spacing: 0

            Repeater {
                model: root.cells

                delegate: Rectangle {
                    required property var modelData

                    readonly property bool headerCell: modelData.isHeader === true

                    objectName: "markdownTableCell"
                    width: cellText.implicitWidth + 2 * root.base.tokens.spacing
                    height: cellText.implicitHeight + root.base.tokens.spacing
                    color: "transparent"
                    border.width: headerCell ? 0 : 1
                    border.color: root.base.tokens.border

                    Rectangle {
                        // Header underline: a full border on every body cell plus a
                        // rule under the header row reads as a table without needing
                        // row spans (Grid cannot span columns).
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.bottom: parent.bottom
                        height: parent.headerCell ? 1 : 0
                        color: root.base.tokens.border
                    }

                    MarkdownInline {
                        id: cellText
                        anchors.centerIn: parent
                        nodes: modelData.nodes
                        theme: root.theme
                        bold: parent.headerCell
                        horizontalAlignment: root.alignmentFor(modelData.column)
                    }
                }
            }
        }
    }

    /** Qt text alignment for a column, from the table's `align` array. */
    function alignmentFor(column) {
        if (column < 0 || column >= root.align.length)
            return Text.AlignLeft
        const value = root.align[column]
        if (value === "center")
            return Text.AlignHCenter
        if (value === "right")
            return Text.AlignRight
        return Text.AlignLeft
    }
}
