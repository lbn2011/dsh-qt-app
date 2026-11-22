// Blockquote.qml — a quoted block.
//
// A left rule plus the quoted content, which is itself a Markdown document: a
// blockquote may hold paragraphs, lists and nested quotes, so it delegates back to
// Markdown.qml rather than assuming a single paragraph.
import QtQuick

Item {
    id: root

    // ---- MarkdownNode role properties --------------------------------------
    property var node: null
    property string type: "blockquote"
    property string role: "block"
    property string content: ""
    property var children: root.node !== null && root.node !== undefined
                           && root.node.children !== undefined && root.node.children !== null
                           ? root.node.children
                           : []

    property var theme: null

    readonly property MarkdownBase base: MarkdownBase {
        node: root.node
        theme: root.theme
    }

    implicitWidth: content.implicitWidth + rule.width + root.base.tokens.spacing
    implicitHeight: content.implicitHeight + 2 * Math.round(root.base.tokens.spacing / 2)

    Rectangle {
        id: rule
        objectName: "markdownBlockquoteRule"
        width: 3
        height: parent.height
        radius: 1.5
        color: root.base.tokens.border
    }

    Markdown {
        id: content
        objectName: "markdownBlockquoteBody"
        anchors.left: rule.right
        anchors.leftMargin: root.base.tokens.spacing
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.topMargin: Math.round(root.base.tokens.spacing / 2)
        document: root.children
        theme: root.theme
    }
}
