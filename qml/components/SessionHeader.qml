// SessionHeader.qml — the bar above the chat flow.
//
// Shows the session title, a status pill (idle / streaming / error) and the
// "New session" action. It is deliberately independent of the Cordis side: it
// takes plain properties, so ChatView and main.qml can both host it and the
// tests can drive it directly.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: header

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
    property Theme theme: Theme { bridge: header.themeBridge }
    property string title: qsTr("New session")
    property string status: "idle"
    property string model: ""

    signal newSessionRequested()

    /**
     * Emitted when the settings button is activated.
     *
     * The header does not own the settings panel: it only announces intent, and
     * whichever host owns the panel (main.qml today) decides how to show it.
     * Same shape as SessionSidebar.settingsRequested(), so both entry points can
     * be wired to one action.
     */
    signal settingsRequested()

    implicitHeight: theme.headerHeight
    color: theme.surface

    readonly property string statusLabel: {
        if (header.status === "streaming")
            return qsTr("Streaming")
        if (header.status === "error")
            return qsTr("Error")
        return qsTr("Idle")
    }

    readonly property color statusColor: {
        if (header.status === "streaming")
            return header.theme.accent
        if (header.status === "error")
            return header.theme.danger
        return header.theme.success
    }

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: header.theme.spacingLarge
        anchors.rightMargin: header.theme.spacingLarge
        spacing: header.theme.spacing

        Label {
            objectName: "sessionTitle"
            text: header.title
            color: header.theme.text
            font.pixelSize: header.theme.fontLarge
            font.bold: true
            elide: Text.ElideRight
            Layout.fillWidth: true
        }

        Label {
            objectName: "sessionModel"
            visible: header.model !== ""
            text: header.model
            color: header.theme.textMuted
            font.pixelSize: header.theme.fontSmall
        }

        Rectangle {
            objectName: "sessionStatus"
            implicitWidth: statusRow.implicitWidth + 2 * header.theme.spacing
            implicitHeight: Math.round(header.theme.controlHeight * 0.72)
            radius: implicitHeight / 2
            color: Qt.rgba(header.statusColor.r, header.statusColor.g, header.statusColor.b, 0.16)
            border.width: 1
            border.color: header.statusColor

            Row {
                id: statusRow
                anchors.centerIn: parent
                spacing: 6

                Rectangle {
                    width: 6
                    height: 6
                    radius: 3
                    color: header.statusColor
                    anchors.verticalCenter: parent.verticalCenter
                }

                Label {
                    text: header.statusLabel
                    color: header.statusColor
                    font.pixelSize: header.theme.fontSmall
                    anchors.verticalCenter: parent.verticalCenter
                }
            }
        }

        Button {
            objectName: "sessionSettingsButton"
            text: "\u2699" // gear, so no icon asset is needed
            flat: true
            implicitWidth: Math.round(header.theme.controlHeight * 1.15)
            implicitHeight: Math.round(header.theme.controlHeight * 0.85)
            palette.buttonText: header.theme.textMuted
            palette.highlight: header.theme.accent
            palette.highlightedText: header.theme.textInverse
            ToolTip.visible: hovered
            ToolTip.text: qsTr("Settings (Ctrl+,)")
            ToolTip.delay: 400
            onClicked: header.settingsRequested()
        }

        Button {
            objectName: "newSessionButton"
            text: qsTr("New session")
            // The Basic style paints buttons from the palette; without these the
            // light scheme would keep dark-on-dark button text.
            palette.button: header.theme.surfaceAlt
            palette.buttonText: header.theme.text
            palette.highlight: header.theme.accent
            palette.highlightedText: header.theme.textInverse
            onClicked: header.newSessionRequested()
        }
    }
}
