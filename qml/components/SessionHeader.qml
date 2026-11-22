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

    property Theme theme: Theme {}
    property string title: qsTr("New session")
    property string status: "idle"
    property string model: ""

    signal newSessionRequested()

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
            objectName: "newSessionButton"
            text: qsTr("New session")
            onClicked: header.newSessionRequested()
        }
    }
}
