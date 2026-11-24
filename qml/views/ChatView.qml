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
    property Theme theme: Theme { bridge: chatView.themeBridge }
    /** Message model to render; null renders the empty state only. */
    /**
     * The Node bridge (`dshQt`), or null when no host is attached.
     *
     * ChatView parses Markdown through it: the AST the message delegate renders
     * cannot be produced in QML, so the text is sent to Node and the reply is
     * attached to the model row. Null is a supported state — the delegate falls
     * back to the plain-text body.
     */
    property QtObject qtBridge: null

    /** In-flight parse requests, `request id → model row`. */
    readonly property var pendingParses: internal.pendingParses

    property ListModel messageModel: null

    /**
     * Tool-call rows for this conversation (I2).
     *
     * `null` is a supported state: a QML preview or qmltestrunner has no host,
     * so the section stays hidden rather than showing an empty frame.
     */
    property var toolModel: null

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

    /** Emitted once a Node-side parse produced a renderable document. */
    signal markdownParsed(int index, var document, string error)

    /** Emitted once Node rendered a message to HTML (used for export/copy). */
    signal markdownRendered(string id, string html, string error)

    /** Emitted once Node highlighted a code block. */
    signal codeHighlighted(string id, string markup, string error)

    QtObject {
        id: internal

        property var pendingParses: ({})
        property var pendingRenders: ({})
        property var pendingHighlights: ({})
    }

    Connections {
        target: chatView.qtBridge
        ignoreUnknownSignals: true

        /**
         * One funnel for every reply: the bridge reports `requestReplied` for all
         * methods, so the view keeps its own id → row bookkeeping rather than
         * depending on a reply signal per method.
         */
        function onRequestReplied(id, method, ok, result, error) {
            if (method === "markdown.parse") {
                const index = internal.pendingParses[id]
                if (index === undefined)
                    return
                delete internal.pendingParses[id]
                const document = ok && result ? result.document : null
                chatView.markdownParsed(index, document, error)
                if (ok && document && chatView.messageModel !== null
                        && typeof chatView.messageModel.setMessageMarkdown === "function")
                    chatView.messageModel.setMessageMarkdown(index, document)
            } else if (method === "markdown.render") {
                if (internal.pendingRenders[id] === undefined)
                    return
                delete internal.pendingRenders[id]
                chatView.markdownRendered(id, ok && result ? String(result.html) : "", error)
            } else if (method === "code.highlight") {
                if (internal.pendingHighlights[id] === undefined)
                    return
                delete internal.pendingHighlights[id]
                chatView.codeHighlighted(id, ok && result ? String(result.markup) : "", error)
            }
        }
    }

    /**
     * Ask Node to parse `text` and attach the AST to row `index`.
     *
     * Returns the request id, or "" when no bridge is attached — callers treat
     * both the same way, because the delegate already renders plain text.
     */
    function requestMarkdown(index, text) {
        if (chatView.qtBridge === null || text === undefined || String(text) === "")
            return ""
        const id = String(chatView.qtBridge.request("markdown.parse", { "text": String(text) }))
        internal.pendingParses[id] = index
        return id
    }

    /** Ask Node to render `text` to HTML; the reply arrives on `markdownRendered`. */
    function renderMarkdown(text) {
        if (chatView.qtBridge === null)
            return ""
        const id = String(chatView.qtBridge.renderMarkdown(String(text)))
        internal.pendingRenders[id] = true
        return id
    }

    /** Ask Node to highlight `code`; the reply arrives on `codeHighlighted`. */
    function highlightCode(code, language) {
        if (chatView.qtBridge === null)
            return ""
        const id = String(chatView.qtBridge.highlightCode(String(code), String(language)))
        internal.pendingHighlights[id] = true
        return id
    }

    /** Parse every non-empty row that has no Markdown yet (session restore). */
    function requestMarkdownForAll() {
        if (chatView.messageModel === null)
            return 0
        let queued = 0
        for (let index = 0; index < chatView.messageModel.count; ++index) {
            const row = chatView.messageModel.get(index)
            if (row === undefined || row === null)
                continue
            if (row.markdown !== undefined && row.markdown !== null && row.markdown !== "")
                continue
            if (chatView.requestMarkdown(index, row.text) !== "")
                ++queued
        }
        return queued
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
        anchors.bottom: toolSection.top
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

    /**
     * Tool activity, above the composer.
     *
     * Height follows the row count up to a cap so a long tool stream cannot
     * push the conversation off screen; once capped the list scrolls.
     */
    Item {
        id: toolSection

        objectName: "toolCallSection"
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.margins: chatView.theme.spacingLarge
        height: (chatView.toolModel !== null && chatView.toolModel.count > 0)
                ? Math.min(220, chatView.toolModel.count * (chatView.theme.controlHeight + 8)) : 0
        visible: height > 0

        ListView {
            id: toolList

            objectName: "toolCallList"
            anchors.fill: parent
            clip: true
            spacing: chatView.theme.spacing
            boundsBehavior: Flickable.StopAtBounds
            model: chatView.toolModel
            ScrollBar.vertical: ScrollBar {
                palette.mid: chatView.theme.border
                palette.dark: chatView.theme.textMuted
            }

            delegate: ToolCallRow {
                // ListView injects `index` as a required property; declaring it here
                // is the documented form and lets qmllint resolve the access.
                required property int index

                width: toolList.width
                rowModel: chatView.toolModel
                rowIndex: index
                revision: chatView.toolModel.watermark
            }
        }
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
