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

    /** Re-emitted from the header so a host can open its settings surface. */
    signal settingsRequested()

    /**
     * Re-emitted from the model for every streamed delta.
     *
     * @param index row being updated
     * @param delta the characters that just arrived
     * @param text the accumulated body so far
     */
    signal chunk(int index, string delta, string text)

    /**
     * Stable block ids per row, captured from the last parser snapshot.
     *
     * The delegate needs the ids (not just the document) to update a single block
     * in place: `streamBlockIds[index]` is the id array reported by
     * `DeltaMarkdownParser.blockIds`. Kept here rather than in the model because
     * it is view state — the model only carries the document.
     */
    property var streamBlockIds: ({})

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

    /** Block ids recorded for `index`, or an empty array. */
    function blockIdsFor(index) {
        const ids = chatView.streamBlockIds[index]
        return ids === undefined || ids === null ? [] : ids
    }

    /**
     * Append one streamed delta to row `index`.
     *
     * Forwards to the model when it exposes `appendChunk()` (the QML MessageModel
     * and the planned C++ model both do) and re-emits `chunk`. The parser snapshot
     * is stored per row so the delegate can address individual blocks by id.
     *
     * @returns the snapshot, or null when the model has no parser
     */
    function appendChunk(index, delta) {
        if (chatView.messageModel === null || chatView.messageModel === undefined)
            return null
        if (typeof chatView.messageModel.appendChunk !== "function")
            return null
        const snapshot = chatView.messageModel.appendChunk(index, delta)
        chatView.recordSnapshot(index, snapshot)
        return snapshot
    }

    /** Start a streamed assistant message; returns its row index. */
    function beginStream(role) {
        if (chatView.messageModel === null || chatView.messageModel === undefined)
            return -1
        if (typeof chatView.messageModel.beginStream !== "function")
            return -1
        const index = chatView.messageModel.beginStream(role)
        chatView.streamBlockIds[index] = []
        return index
    }

    /** Finish a streamed message (clears `pending`, flushes a held surrogate). */
    function endStream(index) {
        if (chatView.messageModel === null || chatView.messageModel === undefined)
            return null
        if (typeof chatView.messageModel.endStream !== "function")
            return null
        const snapshot = chatView.messageModel.endStream(index)
        chatView.recordSnapshot(index, snapshot)
        return snapshot
    }

    /** Remember the block ids a snapshot reported for one row. */
    function recordSnapshot(index, snapshot) {
        if (snapshot === null || snapshot === undefined || snapshot.blockIds === undefined)
            return
        const ids = snapshot.blockIds
        const copy = []
        for (let position = 0; position < ids.length; ++position)
            copy.push(ids[position])
        chatView.streamBlockIds[index] = copy
    }

    color: theme.background

    SessionHeader {
        id: sessionHeader
        theme: chatView.theme
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        onNewSessionRequested: chatView.newSessionRequested()
        onSettingsRequested: chatView.settingsRequested()
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

    // Re-emit the model's streaming signals so a host can listen on the view.
    Connections {
        target: chatView.messageModel
        ignoreUnknownSignals: true
        function onChunk(index, delta, text) { chatView.chunk(index, delta, text) }
        function onPartialMarkdown(index, snapshot) { chatView.recordSnapshot(index, snapshot) }
    }

    EmptyState {
        objectName: "emptyState"
        theme: chatView.theme
        anchors.fill: messageList
        visible: chatView.showEmptyState
    }
}
