// ListItem.qml — one <li>.
//
// A marker column plus the item's own block content. The content is handed back to
// Markdown.qml, so an item may contain several paragraphs, a nested list or a code
// block without this file knowing anything about them.
import QtQuick

Item {
    id: root

    // ---- MarkdownNode role properties --------------------------------------
    property var node: null
    property string type: "listItem"
    property string role: "block"
    property string content: ""
    property var children: root.blocks

    /** Block nodes of this item (the AST's list item body). */
    property var blocks: root.node !== null && root.node !== undefined
                         && root.node.children !== undefined && root.node.children !== null
                         ? root.node.children
                         : []

    /** Bullet / ordinal / task box, supplied by List.qml. */
    property string marker: "•"

    /** true/false for a task list item, null otherwise. */
    property var checked: null

    property var theme: null

    readonly property MarkdownBase base: MarkdownBase {
        node: root.node
        theme: root.theme
    }

    implicitWidth: row.implicitWidth
    implicitHeight: row.implicitHeight

    Row {
        id: row
        width: root.width > 0 ? root.width : implicitWidth
        spacing: 6

        Text {
            id: markerText
            objectName: "markdownListItemMarker"
            // Marker column is fixed so wrapped text lines up under the content.
            width: 20
            text: root.marker
            color: root.base.tokens.textMuted
            font.family: root.base.tokens.fontFamily
            font.pixelSize: root.base.tokens.fontNormal
            horizontalAlignment: Text.AlignRight
            textFormat: Text.PlainText
        }

        Markdown {
            id: body
            objectName: "markdownListItemBody"
            width: row.width - markerText.width - row.spacing
            document: root.blocks
            theme: root.theme
        }
    }
}
