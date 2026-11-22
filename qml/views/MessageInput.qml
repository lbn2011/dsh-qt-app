// MessageInput.qml — the composer.
//
// Emits `send(text)` when the user submits; it deliberately does not touch the
// model itself, so the same component works in main.qml (wired to the session)
// and in the Qt Quick Test suite (wired to a SignalSpy).
//
// Phase 2l hands the composed turn to the Node host: `submit()` asks `dshQt`
// (the DshQtBridge QObject published by native/main.cpp) to deliver the message
// and remembers the request id, then emits `send` so the window can append the
// turn locally at once. The delivery verdict arrives asynchronously on
// `deliveryReported`; sending stays optimistic because the user must see their
// own text immediately, and a failure corrects the record afterwards instead of
// freezing the composer on a round trip.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

Rectangle {
    id: messageInput

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
    /** Two-way access to the editor contents (handy for tests and shortcuts). */
    property alias text: editor.text
    /** While busy the send action is disabled but typing stays possible. */
    property bool busy: false
    /** Hard cap so a paste cannot blow up the native bridge queue. */
    property int maxLength: 8000
    /** Placeholder text of the editor. */
    property string placeholder: qsTr("Send a message…")

    /**
     * The Node bridge, or null when no host is attached.
     *
     * Injected by main.qml; it stays null under qmltestrunner, which is exactly
     * why `submit()` still works without it.
     */
    property QtObject qtBridge: null

    /** Id of the most recent delivery request, or "". */
    readonly property string lastRequestId: internal.lastRequestId

    /** Asynchronous verdict for the turn submitted most recently. */
    signal deliveryReported(string id, string text, bool accepted, string error)

    /** Emitted with the trimmed message body. */
    signal send(string text)

    readonly property bool canSend: !messageInput.busy && messageInput.text.trim() !== ""

    QtObject {
        id: internal

        property string lastRequestId: ""
    }

    Connections {
        target: messageInput.qtBridge
        ignoreUnknownSignals: true

        function onMessageSent(id, text, accepted, error) {
            messageInput.deliveryReported(id, text, accepted, error)
        }
    }

    implicitHeight: theme.composerHeight
    color: theme.surface

    /** Emit send(text) for the current contents and clear the editor. */
    function submit() {
        const body = messageInput.text.trim()
        if (messageInput.busy || body === "")
            return
        messageInput.text = ""
        // Id first, then the signal: the window maps the request id to the model
        // row inside its `onSend` handler, so the id must be readable by then.
        internal.lastRequestId = messageInput.qtBridge !== null
                ? String(messageInput.qtBridge.sendMessage(body))
                : ""
        messageInput.send(body)
    }

    /** Clear the editor without sending. */
    function clear() {
        messageInput.text = ""
    }

    Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        height: 1
        color: messageInput.theme.border
    }

    RowLayout {
        anchors.fill: parent
        anchors.margins: messageInput.theme.spacingLarge
        spacing: messageInput.theme.spacing

        TextField {
            id: editor
            objectName: "messageInput"
            Layout.fillWidth: true
            Layout.fillHeight: true
            placeholderText: messageInput.placeholder
            color: messageInput.theme.text
            placeholderTextColor: messageInput.theme.textMuted
            font.pixelSize: messageInput.theme.fontNormal
            // Cursor, selection and platform text colour follow the scheme too;
            // `color` above only covers the glyphs themselves.
            palette.text: messageInput.theme.text
            palette.base: messageInput.theme.background
            palette.highlight: messageInput.theme.accent
            palette.highlightedText: messageInput.theme.textInverse
            selectByMouse: true
            wrapMode: Text.WordWrap
            maximumLength: messageInput.maxLength
            background: Rectangle {
                color: messageInput.theme.background
                radius: messageInput.theme.radius
                border.width: 1
                border.color: editor.activeFocus ? messageInput.theme.accent : messageInput.theme.border
            }
            onAccepted: messageInput.submit()
        }

        Button {
            objectName: "sendButton"
            text: qsTr("Send")
            enabled: messageInput.canSend
            implicitHeight: messageInput.theme.controlHeight
            palette.button: messageInput.theme.accent
            palette.buttonText: messageInput.theme.textInverse
            palette.highlight: messageInput.theme.accentHover
            palette.highlightedText: messageInput.theme.textInverse
            onClicked: messageInput.submit()
        }
    }
}
