// EmptyState.qml — shown in place of the message list before the first turn.
//
// Kept as its own component so the tests can assert it is visible on a fresh
// model and hidden once a message exists, without reaching into ChatView
// internals.
import QtQuick
import QtQuick.Controls

Item {
    id: emptyState

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
