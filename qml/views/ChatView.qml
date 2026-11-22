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

    property Theme theme: Theme {}
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
        ScrollBar.vertical: ScrollBar {}

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
        visible: chatView.messageCount === 0
    }
}
