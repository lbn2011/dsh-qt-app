// ChatView.qml — the message flow.
//
// Hosts the session header and the ListView that renders the message model.
// `messageModel` is typed as ListModel so this file needs no import of the
// models/ directory: any ListModel-compatible model works, including the QML
// MessageModel used in Phase 1c and the C++ `MessageListModel` planned for the
// N-API phase.
pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import "../components"

Rectangle {
    id: chatView

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
    /** Message model to render; null renders the empty state only. */
    property ListModel messageModel: null

    // Re-exported header state so main.qml wires a single source of truth.
    property alias title: sessionHeader.title
    property alias status: sessionHeader.status
    property alias modelName: sessionHeader.model

    signal newSessionRequested()

    /**
     * Rows currently held by the model.
     *
     * Deliberately derived from the *model*, not from ListView.count: the view's
     * count is refreshed internally and was observed to go stale across a
     * model reset, which left the empty state hidden on an empty model.
     */
    readonly property int messageCount: chatView.messageModel ? chatView.messageModel.count : 0

    /**
     * True while there is nothing to render.
     *
     * Exposed separately from EmptyState.visible because Item.visible propagates
     * from the parent: in a hidden window every descendant reports visible=false,
     * which makes the raw property useless as an assertion target (qmltestrunner
     * keeps its window hidden, so tests must assert this intent instead).
     */
    readonly property bool showEmptyState: chatView.messageCount === 0

    color: theme.background

    SessionHeader {
        id: sessionHeader
        theme: chatView.theme
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        onNewSessionRequested: chatView.newSessionRequested()
    }

    ListView {
        id: messageList
        objectName: "messageList"
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: sessionHeader.bottom
        anchors.bottom: parent.bottom
        anchors.margins: chatView.theme.spacingLarge
        clip: true
        spacing: chatView.theme.spacingLarge
        boundsBehavior: Flickable.StopAtBounds
        model: chatView.messageModel
        ScrollBar.vertical: ScrollBar {
            palette.mid: chatView.theme.border
            palette.dark: chatView.theme.textMuted
        }

        delegate: MessageDelegate {
            theme: chatView.theme
        }

        // Keep the newest message in view, including while a reply streams in.
        onCountChanged: messageList.positionViewAtEnd()
    }

    EmptyState {
        objectName: "emptyState"
        theme: chatView.theme
        anchors.fill: messageList
        visible: chatView.showEmptyState
    }
}
