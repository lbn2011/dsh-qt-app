// main.qml — the DSH native shell window.
//
// Phase 1c wires the QML skeleton: a session sidebar, the chat flow and the
// composer. There is no Node side attached yet, so `sendMessage()` echoes the
// turn into the model locally; Phase 2 replaces that body with a call into
// `ctx.qtRenderer` over the 10 ms event-loop bridge (src/event-loop/timer.ts).
//
// Phase 2g adds live theming. The C++ host (native/main.cpp) publishes
// `ctx.theme` — a ThemeBridge owning the scheme id and the font scale — and
// `Theme.qml` turns it into bindings, so switching scheme or scale repaints the
// window in place. This file owns the one place that cannot be a binding: the
// window-level `themeChanged` broadcast that the settings UI (t17) and any
// imperative code can hook into.
//
// Phase 2h mounts the settings pane in a right-hand Drawer (SettingsPanel.qml):
// the sidebar's footer button, the session header's gear and `Ctrl+,` all open
// it, and the theme controls
// inside write straight to `ctx.theme`, so a scheme or font-scale change is
// visible in the chat behind the drawer while it is still open.
import QtQuick
import QtQuick.Controls
import "components"
import "models"
import "views"
import "views/settings"

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
    // `Theme` picks up `ctx.theme` on its own (see components/Theme.qml), so the
    // whole tree below follows the live palette without further wiring.
    Theme { id: theme }
    MessageModel { id: chatModel }
    SessionModel { id: session }
    ListModel { id: sessionIndexModel }

    /** Active scheme id, mirrored for bindings that only need the name. */
    readonly property string themeId: theme.themeId

    /**
     * Broadcast after the palette has been swapped.
     *
     * Everything that is a pure binding has already repainted by the time this
     * fires; the signal exists for the parts that cannot be (a settings pane
     * re-reading the list of schemes, the Markdown renderer re-highlighting with
     * the new code colours).
     */
    signal themeChanged(string themeId)

    /**
     * Cycle dark → light → dark.
     *
     * The real switch lives in the bridge so the choice is persisted to
     * theme.json and picked up by the next start; this is the manual hook the
     * settings UI and `Ctrl+Shift+T` both use.
     */
    function toggleTheme() {
        if (theme.bridge !== null)
            theme.bridge.toggle()
    }

    // The bridge is null outside the native host (qmltestrunner, qmllint).
    Connections {
        target: theme.bridge
        ignoreUnknownSignals: true

        function onThemeChanged() {
            window.themeChanged(theme.themeId)
        }
    }

    Shortcut {
        sequences: ["Ctrl+Shift+T", "Meta+Shift+T"]
        context: Qt.ApplicationShortcut
        onActivated: window.toggleTheme()
    }

    /** Ctrl+, / Cmd+, opens the settings pane — the platform convention. */
    Shortcut {
        sequences: ["Ctrl+,", "Meta+,"]
        context: Qt.ApplicationShortcut
        onActivated: settingsDrawer.open()
    }

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
        onSettingsRequested: settingsDrawer.open()
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
        onSettingsRequested: settingsDrawer.open()
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

    /**
     * Settings pane.
     *
     * A Drawer rather than a page because settings are a detour, not a
     * destination: the chat stays visible (and, with modal: true, dimmed but
     * still repainting) while the theme is being changed, which is the whole
     * point of live switching.
     */
    Drawer {
        id: settingsDrawer

        objectName: "settingsDrawer"
        edge: Qt.RightEdge
        width: Math.min(420, Math.round(window.width * 0.4))
        height: window.height
        modal: true
        interactive: true
        padding: 0

        SettingsPanel {
            id: settingsPanel

            objectName: "settingsPanelMount"
            anchors.fill: parent
            theme: theme
            onCloseRequested: settingsDrawer.close()
        }
    }
}
