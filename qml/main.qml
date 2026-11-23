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
// Phase 2l connects the window to the Node host. `dshQt` is now a QObject
// (DshQtBridge in native/main.cpp), so the window can *ask* for things instead
// of only reading constants: composing a turn, parsing Markdown into the AST the
// message delegate renders, and persisting settings all travel through it and
// come back as signals. Nothing in this file waits for a reply — the composer
// appends optimistically and corrects itself on `deliveryReported`.
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
     * The Node bridge (`dshQt`), or null outside the native host.
     *
     * qmltestrunner and qmllint have no `dshQt` context property, so every use
     * is guarded: the window must stay fully usable without Node, just with local
     * echo instead of a real reply.
     */
    // qmllint disable unqualified
    readonly property var qtBridge: (typeof dshQt !== "undefined" && dshQt !== null
                                          && typeof dshQt.request === "function") ? dshQt : null
    // qmllint enable unqualified

    /** True when the host is listening for requests on its stdio transport. */
    readonly property bool nodeConnected: window.qtBridge !== null
                                          && window.qtBridge.transportState === "connected"

    /** Delivery request id → model row, so a late verdict finds its message. */
    property var pendingSends: ({})

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
        const index = chatModel.appendUserMessage(body)
        // The composer already handed the turn to Node; remember which row its
        // verdict belongs to. `lastRequestId` is set before `send` is emitted.
        const requestId = String(messageInput.lastRequestId)
        if (requestId !== "") {
            chatModel.updateMessage(index, body, window.nodeConnected)
            window.pendingSends[requestId] = index
        }
        session.messageCount = chatModel.count
        if (!session.hasSession) {
            session.title = body.length > 40 ? body.slice(0, 40) + "…" : body
            sessionIndexModel.append({ "title": session.title })
        }
    }

    /**
     * Settle an optimistic send.
     *
     * The row was appended immediately; here it either loses its pending flag or
     * gains a system note saying delivery failed. Silently dropping the failure
     * would leave a message that looks sent but never was.
     */
    function finishSend(id, text, accepted, error) {
        const row = window.pendingSends[id]
        if (row === undefined)
            return
        delete window.pendingSends[id]
        if (accepted) {
            chatModel.updateMessage(row, String(text), false)
            return
        }
        chatModel.updateMessage(row, String(text), false)
        chatModel.appendSystemMessage(qsTr("Delivery failed: ") + (error !== "" ? error : qsTr("no reply")))
        session.messageCount = chatModel.count
    }

    /**
     * Apply a scheme mode through the bridge.
     *
     * The settings pane already wrote to `ctx.theme` for the instant repaint;
     * this call additionally announces the change to Node (so plugins and the
     * persisted file agree) and resolves "auto" against the platform scheme.
     */
    function applyThemeMode(mode) {
        if (window.qtBridge !== null) {
            window.qtBridge.applyTheme(String(mode))
            return
        }
        if (theme.bridge !== null && String(mode) !== "auto")
            theme.bridge.themeId = String(mode)
    }

    /** Apply a font scale through the bridge; the host clamps to 0.8 … 1.5. */
    function applyFontScale(scale) {
        if (window.qtBridge !== null) {
            window.qtBridge.setFontScale(Number(scale))
            return
        }
        if (theme.bridge !== null)
            theme.bridge.fontScale = Number(scale)
    }

    /**
     * Settings catalogue for the forms in the pane.
     *
     * Left null on purpose: a QML-side descriptor object would have to be pushed
     * from Node, and until that exists the forms use the fallback descriptors they
     * ship with (`ThemeForm.fallbackFields`, …). Edits still reach the store
     * through `saveSetting()`, so this is a display-only gap, not a write-path one.
     */
    readonly property var settingsBridge: null

    /** Persist one setting; the schema is validated on the Node side. */
    function saveSetting(name, value) {
        if (window.qtBridge !== null)
            window.qtBridge.saveSetting(String(name), value)
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
        qtBridge: window.qtBridge
        title: session.title
        status: session.status
        modelName: session.model
        anchors.left: sidebar.right
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.bottom: messageInput.top
        onNewSessionRequested: window.newSession()
        onSettingsRequested: settingsDrawer.open()
        onMarkdownParsed: function (index, document, error) {
            if (error !== "" && error !== undefined)
                console.warn("markdown parse failed for row", index, ":", error)
        }
        Component.onCompleted: window.requestRenderedBody()
    }

    /**
     * Parse the turns that have no Markdown yet.
     *
     * Deliberately not called for every keystroke: `sendMessage()` appends the
     * row and the delegate already shows its plain text, so parsing can happen
     * whenever it is cheapest. Rows that already carry a document are skipped.
     */
    function requestRenderedBody() {
        if (chatView === null || !window.nodeConnected)
            return
        chatView.requestMarkdownForAll()
    }

    /**
     * Mirror the settings pane's own edits into the bridge.
     *
     * The pane writes `ctx.theme` first for an instant repaint; these handlers
     * additionally announce the change through `dshQt` so Node persists the same
     * value and "auto" resolves against the platform scheme.
     */
    Connections {
        target: settingsPanel.themeSettings
        ignoreUnknownSignals: true

        function onSchemeApplied(mode) {
            window.applyThemeMode(mode)
        }

        function onFontScaleApplied(scale) {
            window.applyFontScale(scale)
        }
    }

    MessageInput {
        id: messageInput
        objectName: "messageInputBar"
        theme: theme
        busy: session.busy
        anchors.left: sidebar.right
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        qtBridge: window.qtBridge
        onSend: function (text) {
            window.sendMessage(text)
        }
        onDeliveryReported: function (id, text, accepted, error) {
            window.finishSend(id, text, accepted, error)
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
            settingsBridge: window.settingsBridge
            onSettingEdited: function (name, value) {
                window.saveSetting(name, value)
            }
            onCloseRequested: settingsDrawer.close()
        }
    }
}
