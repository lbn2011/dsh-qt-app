// EmptyState.qml — shown in place of the message list before the first turn.
//
// Kept as its own component so the tests can assert it is visible on a fresh
// model and hidden once a message exists, without reaching into ChatView
// internals.
import QtQuick
import QtQuick.Controls

Item {
    id: emptyState

    property Theme theme: Theme {}
    property string title: qsTr("No messages yet")
    property string hint: qsTr("Type a message below to start a session.")

    Column {
        anchors.centerIn: parent
        width: Math.min(parent.width * 0.8, 420)
        spacing: emptyState.theme.spacing

        Label {
            width: parent.width
            text: emptyState.title
            color: emptyState.theme.text
            font.pixelSize: emptyState.theme.fontLarge
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
        }

        Label {
            width: parent.width
            text: emptyState.hint
            color: emptyState.theme.textMuted
            font.pixelSize: emptyState.theme.fontNormal
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
        }
    }
}
