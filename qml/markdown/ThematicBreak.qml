// ThematicBreak.qml — <hr> / "---".
//
// A one-pixel rule with vertical breathing room; it carries no content, so it is
// the smallest component in the tree.
import QtQuick

Item {
    id: root

    // ---- MarkdownNode role properties --------------------------------------
    property var node: null
    property string type: "thematicBreak"
    property string role: "block"
    property string content: ""
    property var children: []

    property var theme: null

    readonly property MarkdownBase base: MarkdownBase {
        node: root.node
        theme: root.theme
    }

    implicitWidth: 0
    implicitHeight: root.base.tokens.spacing + 1

    Rectangle {
        objectName: "markdownThematicBreak"
        anchors.verticalCenter: parent.verticalCenter
        width: parent.width
        height: 1
        color: root.base.tokens.border
    }
}
