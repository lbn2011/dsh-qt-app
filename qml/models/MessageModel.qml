// MessageModel.qml — the message list model the Qt views bind to.
//
// This file is the QML stand-in for the C++ model. The native side ships
// `MessageListModel : QAbstractListModel` (in dsh-qt-napi / native/) exposing
// exactly these roles:
//
//   role       string  "user" | "assistant" | "system" | "tool"
//   text       string  plain text or pre-rendered HTML fragment
//   timestamp  string  ISO-8601 wall-clock time for the message
//   pending    bool    true while the assistant reply is still streaming
//   markdown   object  MarkdownNode document for the body, or null/undefined
//
// `markdown` is the optional structured form of `text`: when the parser (N-API
// cmark-gfm or the pure-TS fallback) has produced an AST, MessageDelegate renders
// it through qml/markdown/Markdown.qml; when it is null the delegate falls back to
// the plain `text` role, so a model filled by hand still renders.
//
// Swapping in the C++ model is a one-line change in main.qml (`model:` binding),
// because every view only relies on those roles — nothing else.
//
// Keeping a QML implementation first lets Phase 1c run the whole UI skeleton
// before the N-API bridge exists.
import QtQuick

ListModel {
    id: model

    /** Role values understood by MessageDelegate. */
    readonly property string roleUser: "user"
    readonly property string roleAssistant: "assistant"
    readonly property string roleSystem: "system"
    readonly property string roleTool: "tool"

    /**
     * Emitted for every streamed delta.
     *
     * @param index row being updated
     * @param delta the characters that just arrived
     * @param text the accumulated body so far
     */
    signal chunk(int index, string delta, string text)

    /**
     * Emitted once the parser has turned the accumulated text into a document.
     *
     * @param index row being updated
     * @param snapshot the `StreamSnapshot` (updates + document + blockIds)
     */
    signal partialMarkdown(int index, var snapshot)

    /**
     * Optional incremental parser (`DeltaMarkdownParser` from src/markdown).
     *
     * The parser lives in TypeScript, so the host injects it: native/main.cpp can
     * expose the Node parser over the bridge, and a test can inject a stub. When it
     * is null `appendChunk()` still accumulates text and emits `chunk`, which keeps
     * the model usable without a parser attached.
     */
    property var parser: null

    /** Most recent snapshot, or null. */
    readonly property var lastSnapshot: model.internalSnapshot

    property var internalSnapshot: null

    /**
     * Append one message.
     *
     * @param role one of roleUser / roleAssistant / roleSystem / roleTool
     * @param text message body (plain text)
     * @param timestamp ISO-8601 string; defaults to "now"
     * @param pending true while the reply is still streaming
     * @param markdown optional MarkdownNode document for the body
     * @returns the index of the appended message
     */
    function appendMessage(role, text, timestamp, pending, markdown) {
        const stamp = timestamp !== undefined && timestamp !== null && timestamp !== ""
            ? String(timestamp)
            : new Date().toISOString()
        model.append({
            "role": role === undefined || role === null ? model.roleAssistant : String(role),
            "text": text === undefined || text === null ? "" : String(text),
            "timestamp": stamp,
            "pending": pending === true,
            "markdown": markdown === undefined ? null : markdown
        })
        return model.count - 1
    }

    /** Convenience wrapper for a user turn. */
    function appendUserMessage(text) {
        return model.appendMessage(model.roleUser, text)
    }

    /** Convenience wrapper for an assistant turn. */
    function appendAssistantMessage(text, pending, markdown) {
        return model.appendMessage(model.roleAssistant, text, undefined, pending === true, markdown)
    }

    /** Convenience wrapper for a system notice. */
    function appendSystemMessage(text) {
        return model.appendMessage(model.roleSystem, text)
    }

    /**
     * Attach (or replace) the markdown document of one message.
     *
     * Used when the parser finishes after the text has already been appended, so
     * the reply shows plain text first and upgrades to rendered markdown in place.
     *
     * @returns true when the index existed
     */
    function setMessageMarkdown(index, markdown) {
        if (index < 0 || index >= model.count)
            return false
        model.setProperty(index, "markdown", markdown === undefined ? null : markdown)
        return true
    }

    /**
     * Replace the body of one message (used when a streamed reply completes).
     *
     * @returns true when the index existed
     */
    function updateMessage(index, text, pending) {
        if (index < 0 || index >= model.count)
            return false
        model.setProperty(index, "text", text === undefined || text === null ? "" : String(text))
        if (pending !== undefined)
            model.setProperty(index, "pending", pending === true)
        return true
    }

    /** Read one message back as a plain object; null when the index is invalid. */
    function messageAt(index) {
        if (index < 0 || index >= model.count)
            return null
        const item = model.get(index)
        return {
            "role": item.role,
            "text": item.text,
            "timestamp": item.timestamp,
            "pending": item.pending,
            "markdown": item.markdown === undefined ? null : item.markdown
        }
    }

    /** Drop every message (new session). */
    function clearMessages() {
        model.clear()
    }

    // ---- streaming ---------------------------------------------------------

    /**
     * Append one streamed delta to a message.
     *
     * The text role is updated immediately so a plain-text fallback stays current,
     * then the delta is handed to `parser` (when present) and the resulting
     * snapshot is emitted. Nothing here re-parses Markdown in QML: the AST always
     * comes from TypeScript, so there is exactly one parser in the system.
     *
     * @returns the snapshot, or null when no parser is attached
     */
    function appendChunk(index, delta) {
        const text = typeof delta === "string" ? delta : String(delta)
        if (index < 0 || index >= model.count)
            return null
        const row = model.get(index)
        const accumulated = (row.text === undefined || row.text === null ? "" : row.text) + text
        model.setProperty(index, "text", accumulated)

        model.chunk(index, text, accumulated)

        if (model.parser === null || model.parser === undefined) {
            model.internalSnapshot = null
            return null
        }

        const snapshot = model.parser.onChunk(text)
        model.internalSnapshot = snapshot
        if (snapshot !== null && snapshot !== undefined && snapshot.document !== undefined)
            model.setProperty(index, "markdown", snapshot.document)
        model.partialMarkdown(index, snapshot)
        return snapshot
    }

    /** Start a fresh streamed message and return its row index. */
    function beginStream(role) {
        const rowRole = (role === undefined || role === null || role === "")
                        ? model.roleAssistant : String(role)
        const index = model.appendMessage(rowRole, "", new Date().toISOString(), true, null)
        if (model.parser !== null && model.parser !== undefined && typeof model.parser.reset === "function")
            model.parser.reset()
        model.internalSnapshot = null
        return index
    }

    /** Finish a streamed message: clear `pending` and flush a held surrogate. */
    function endStream(index) {
        if (index < 0 || index >= model.count)
            return null
        if (model.parser !== null && model.parser !== undefined && typeof model.parser.flush === "function") {
            const snapshot = model.parser.flush()
            model.internalSnapshot = snapshot
            if (snapshot !== null && snapshot !== undefined && snapshot.document !== undefined)
                model.setProperty(index, "markdown", snapshot.document)
            model.partialMarkdown(index, snapshot)
        }
        model.setProperty(index, "pending", false)
        return model.internalSnapshot
    }
}
