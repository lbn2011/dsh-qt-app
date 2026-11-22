// main.qml — the DSH native shell window.
//
// Phase 1c wires the QML skeleton: a session sidebar, the chat flow and the
// composer. There is no Node side attached yet, so `sendMessage()` echoes the
// turn into the model locally; Phase 2 replaces that body with a call into
// `ctx.qtRenderer` over the 10 ms event-loop bridge (src/event-loop/timer.ts).
import QtQuick
import QtQuick.Controls
import "components"
import "models"
import "views"

ApplicationWindow {
    id: window

    objectName: "appWindow"

    width: 1280
    height: 800
    minimumWidth: 960
    minimumHeight: 640
    visible: true
    title: Qt.application.name.length > 0 ? Qt.application.name : qsTr("DSH")
    color: theme.background

    // ---- Shared state -----------------------------------------------------
    Theme { id: theme }
    MessageModel { id: chatModel }
    SessionModel { id: session }
    ListModel { id: sessionIndexModel }

    /**
     * Append a user turn locally.
     *
     * Phase 1c only echoes; the streaming reply, status transitions and Markdown
     * rendering arrive with the N-API bridge in Phase 2.
     */
    function sendMessage(text) {
        const body = String(text).trim()
        if (body === "")
            return
        chatModel.appendUserMessage(body)
        session.messageCount = chatModel.count
        if (!session.hasSession) {
            session.title = body.length > 40 ? body.slice(0, 40) + "…" : body
            sessionIndexModel.append({ "title": session.title })
        }
    }

    /** Start over: drop the conversation and reset the session metadata. */
    function newSession() {
        chatModel.clearMessages()
        session.reset()
    }

    // ---- Layout -----------------------------------------------------------
    SessionSidebar {
        id: sidebar
        objectName: "sessionSidebar"
        theme: theme
        sessionList: sessionIndexModel
        currentIndex: session.hasSession ? sessionIndexModel.count - 1 : -1
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        onNewSessionRequested: window.newSession()
        onSessionSelected: function (index) {
            window.newSession()
            session.title = sessionIndexModel.get(index).title
        }
    }

    ChatView {
        id: chatView
        objectName: "chatView"
        theme: theme
        messageModel: chatModel
        title: session.title
        status: session.status
        modelName: session.model
        anchors.left: sidebar.right
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.bottom: messageInput.top
        onNewSessionRequested: window.newSession()
    }

    MessageInput {
        id: messageInput
        objectName: "messageInputBar"
        theme: theme
        busy: session.busy
        anchors.left: sidebar.right
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        onSend: function (text) {
            window.sendMessage(text)
        }
    }
}
