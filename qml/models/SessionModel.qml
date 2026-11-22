// SessionModel.qml — the session context shared by the chat views.
//
// Mirrors the subset of the DSH session that Phase 1c renders: identity, title,
// status and a coarse message counter. The Cordis side owns the real session
// (`ui-session`, `ui-session-status`); this model is the QML-side projection that
// the native UI updates from the event-loop bridge (`session.updated` messages).
import QtQuick

QtObject {
    id: session

    /** Stable session id used by the Node side; empty until a session is bound. */
    property string sessionId: ""
    /** Human-readable title shown in the header and the sidebar. */
    property string title: qsTr("New session")
    /** "idle" | "streaming" | "error". */
    property string status: "idle"
    /** Number of messages in the session, kept in sync by the chat view. */
    property int messageCount: 0
    /** Model identifier of the agent answering in this session. */
    property string model: ""

    readonly property bool busy: session.status === "streaming"
    readonly property bool hasSession: session.sessionId !== ""

    /** Reset to an empty session (the "New session" action). */
    function reset() {
        session.sessionId = ""
        session.title = qsTr("New session")
        session.status = "idle"
        session.messageCount = 0
        session.model = ""
    }

    /** Apply an update coming from the Node side. */
    function applyUpdate(update) {
        if (update === undefined || update === null)
            return
        if (update.sessionId !== undefined)
            session.sessionId = String(update.sessionId)
        if (update.title !== undefined)
            session.title = String(update.title)
        if (update.status !== undefined)
            session.status = String(update.status)
        if (update.messageCount !== undefined)
            session.messageCount = Number(update.messageCount)
        if (update.model !== undefined)
            session.model = String(update.model)
    }
}
