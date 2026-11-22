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
//
// Swapping in the C++ model is a one-line change in main.qml (`model:` binding),
// because every view only relies on those four roles — nothing else.
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
     * Append one message.
     *
     * @param role one of roleUser / roleAssistant / roleSystem / roleTool
     * @param text message body (plain text for now)
     * @param timestamp ISO-8601 string; defaults to "now"
     * @param pending true while the reply is still streaming
     * @returns the index of the appended message
     */
    function appendMessage(role, text, timestamp, pending) {
        const stamp = timestamp !== undefined && timestamp !== null && timestamp !== ""
            ? String(timestamp)
            : new Date().toISOString()
        model.append({
            "role": role === undefined || role === null ? model.roleAssistant : String(role),
            "text": text === undefined || text === null ? "" : String(text),
            "timestamp": stamp,
            "pending": pending === true
        })
        return model.count - 1
    }

    /** Convenience wrapper for a user turn. */
    function appendUserMessage(text) {
        return model.appendMessage(model.roleUser, text)
    }

    /** Convenience wrapper for an assistant turn. */
    function appendAssistantMessage(text, pending) {
        return model.appendMessage(model.roleAssistant, text, undefined, pending === true)
    }

    /** Convenience wrapper for a system notice. */
    function appendSystemMessage(text) {
        return model.appendMessage(model.roleSystem, text)
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
            "pending": item.pending
        }
    }

    /** Drop every message (new session). */
    function clearMessages() {
        model.clear()
    }
}
