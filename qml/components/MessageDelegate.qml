// MessageDelegate.qml — one row of the chat flow.
//
// Phase 1c renders plain text in a role-dependent bubble. Phase 2 swaps the
// Label for a Markdown-rendering item fed by `ctx.qtRenderer.renderMarkdown()`;
// the four roles below are the contract with MessageModel.qml (and, later, with
// the C++ `MessageListModel : QAbstractListModel`), so that swap stays local.
import QtQuick
import QtQuick.Controls

Item {
    id: delegate

    // ---- Model roles (auto-populated by the ListView) ----------------------
    required property string role
    required property string text
    required property string timestamp
    required property bool pending

    // ---- Styling ----------------------------------------------------------
    /**
     * Live theme source published by native/main.cpp as `ctx.theme`.
     *
     * Declared per component (not only in Theme.qml) because a component may be
     * instantiated on its own — a QML test, a settings preview — and it must
     * still follow the live palette. When a parent injects its own `theme`, that
     * instance already carries the bridge and this one is simply unused.
     */
    // qmllint disable unqualified
    readonly property QtObject themeBridge: (typeof ctx !== "undefined" && ctx.theme) ? ctx.theme : null
    // qmllint enable unqualified
    property Theme theme: Theme { bridge: themeBridge }

    readonly property bool fromUser: delegate.role === "user"
    readonly property bool fromSystem: delegate.role === "system"
    readonly property bool fromTool: delegate.role === "tool"

    readonly property color bubbleColor: {
        if (delegate.fromUser)
            return delegate.theme.surfaceAccent
        if (delegate.fromSystem)
            return delegate.theme.surface
        return delegate.theme.surfaceAlt
    }

    readonly property string roleLabel: {
        if (delegate.fromUser)
            return qsTr("You")
        if (delegate.fromSystem)
            return qsTr("System")
        if (delegate.fromTool)
            return qsTr("Tool")
        return qsTr("Assistant")
    }

    // The bubble never fills the full row: chat bubbles read better at ~86% and
    // the width is a pure function of the delegate width, so no binding loop.
    implicitHeight: bubble.implicitHeight
    implicitWidth: delegate.width

    Rectangle {
        id: bubble
        width: Math.round(delegate.width * 0.86)
        // User turns hug the right edge, everything else the left edge.
        anchors.left: delegate.fromUser ? undefined : delegate.left
        anchors.right: delegate.fromUser ? delegate.right : undefined
        implicitHeight: content.implicitHeight + 2 * delegate.theme.spacing
        radius: delegate.theme.radiusLarge
        color: delegate.bubbleColor
        border.width: delegate.fromTool ? 1 : 0
        border.color: delegate.theme.border

        Column {
            id: content
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.margins: delegate.theme.spacingLarge
            spacing: 4

            Row {
                spacing: delegate.theme.spacing

                Label {
                    text: delegate.roleLabel
                    color: delegate.theme.textMuted
                    font.pixelSize: delegate.theme.fontSmall
                    font.bold: true
                }

                Label {
                    text: delegate.pending ? qsTr("streaming…") : delegate.timestamp
                    color: delegate.theme.textMuted
                    font.pixelSize: delegate.theme.fontSmall
                }
            }

            Label {
                width: content.width
                text: delegate.text
                color: delegate.theme.text
                font.pixelSize: delegate.theme.fontNormal
                wrapMode: Text.Wrap
                textFormat: Text.PlainText
            }
        }
    }
}
