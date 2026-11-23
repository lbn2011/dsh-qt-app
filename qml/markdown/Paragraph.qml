// Paragraph.qml — a block-level paragraph.
//
// One paragraph is one Text (via MarkdownInline), so the whole sentence flows and
// wraps as a unit while its inline formatting comes from the markup engine.
import QtQuick

Item {
    id: root

    // ---- MarkdownNode role properties --------------------------------------
    property var node: null
    property string type: "paragraph"
    property string role: "block"
    property string content: root.node !== null && root.node !== undefined && root.node.value !== undefined
                             ? String(root.node.value)
                             : ""
    property var nodes: root.node !== null && root.node !== undefined
                           && root.node.children !== undefined && root.node.children !== null
                           ? root.node.children
                           : []

    property var theme: null

    implicitWidth: body.implicitWidth
    implicitHeight: body.implicitHeight

    MarkdownInline {
        id: body
        objectName: "markdownParagraphText"
        width: root.width > 0 ? root.width : implicitWidth
        nodes: root.nodes
        plainText: root.content
        theme: root.theme
    }
}
