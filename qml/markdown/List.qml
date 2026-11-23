// List.qml — <ul> / <ol>, including GFM task lists.
//
// The AST stores a list as `items: MarkdownNode[][]` — one array of block nodes per
// item — so this component only owns the markers and the vertical rhythm; each
// item's content is rendered by ListItem.qml, which delegates back to Markdown.qml.
// That mutual reference (Markdown → List → ListItem → Markdown) is how a nested
// list or a multi-paragraph item works without any special-casing here.
pragma ComponentBehavior: Bound

import QtQuick

Item {
    id: root

    // ---- MarkdownNode role properties --------------------------------------
    property var node: null
    property string type: "list"
    property string role: "block"
    property string content: ""
    property var nodes: root.items

    property var theme: null

    readonly property MarkdownBase base: MarkdownBase {
        node: root.node
        theme: root.theme
    }

    readonly property bool ordered: root.node !== null && root.node !== undefined && root.node.ordered === true

    /** First ordinal of an ordered list; the AST only emits it when it is not 1. */
    readonly property int start: root.node !== null && root.node !== undefined
                                 && root.node.start !== undefined && root.node.start !== null
                                 ? Number(root.node.start)
                                 : 1

    /** One entry per item, each an array of block nodes. */
    readonly property var items: root.node !== null && root.node !== undefined
                                 && root.node.items !== undefined && root.node.items !== null
                                 ? root.node.items
                                 : []

    /** Present only for task lists: true/false per item. */
    readonly property var taskChecked: root.node !== null && root.node !== undefined
                                       && root.node.taskChecked !== undefined && root.node.taskChecked !== null
                                       ? root.node.taskChecked
                                       : []

    implicitWidth: column.implicitWidth
    implicitHeight: column.implicitHeight

    /** Number of items; exposed so a test need not wait for delegate creation. */
    readonly property int count: root.items.length

    /**
     * The rendered ListItem at `index`, or null.
     *
     * Repeater inserts its delegates as children of the column, so this is a plain
     * lookup — useful for tests and for scrolling an item into view later.
     */
    function itemAt(index) {
        if (index < 0 || index >= column.children.length)
            return null
        return column.children[index]
    }

    Column {
        id: column
        width: root.width
        spacing: Math.round(root.base.tokens.spacing / 2)

        Repeater {
            model: root.items

            delegate: ListItem {
                required property var modelData
                required property int index

                width: column.width > 0 ? column.width : implicitWidth
                blocks: modelData
                marker: root.markerFor(index)
                checked: index < root.taskChecked.length ? root.taskChecked[index] : null
                theme: root.theme
            }
        }
    }

    /**
     * Marker text for one item.
     *
     * Ordered lists count from `start`; task lists use a box; everything else uses
     * a bullet. Exposed so a test can assert the numbering without scraping the
     * rendered Text.
     */
    function markerFor(index) {
        if (root.ordered)
            return String(root.start + index) + "."
        if (index < root.taskChecked.length)
            return root.taskChecked[index] === true ? "☑" : "☐"
        return "•"
    }
}
