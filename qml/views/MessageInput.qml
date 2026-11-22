// MessageInput.qml — the composer.
//
// Emits `send(text)` when the user submits; it deliberately does not touch the
// model itself, so the same component works in main.qml (wired to the session)
// and in the Qt Quick Test suite (wired to a SignalSpy).
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

Rectangle {
    id: messageInput

    property Theme theme: Theme {}
    /** Two-way access to the editor contents (handy for tests and shortcuts). */
    property alias text: editor.text
    /** While busy the send action is disabled but typing stays possible. */
    property bool busy: false
    /** Hard cap so a paste cannot blow up the native bridge queue. */
    property int maxLength: 8000
    /** Placeholder text of the editor. */
    property string placeholder: qsTr("Send a message…")

    /** Emitted with the trimmed message body. */
    signal send(string text)

    readonly property bool canSend: !messageInput.busy && messageInput.text.trim() !== ""

    implicitHeight: theme.composerHeight
    color: theme.surface

    /** Emit send(text) for the current contents and clear the editor. */
    function submit() {
        const body = messageInput.text.trim()
        if (messageInput.busy || body === "")
            return
        messageInput.text = ""
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
            onClicked: messageInput.submit()
        }
    }
}
