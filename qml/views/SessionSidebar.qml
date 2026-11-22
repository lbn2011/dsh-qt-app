// SessionSidebar.qml — the session list on the left.
//
// Phase 1c renders the list of known sessions and the "New session" action. The
// model is a plain ListModel with a single `title` role; Phase 2 binds it to the
// Cordis session registry through the event-loop bridge.
import QtQuick
import QtQuick.Controls
import "../components"

Rectangle {
    id: sidebar

    property Theme theme: Theme {}
    /** Sessions to show; expected roles: title. */
    property ListModel sessionList: null
    /** Index of the active session, -1 when none is selected. */
    property int currentIndex: -1

    signal newSessionRequested()
    signal sessionSelected(int index)

    implicitWidth: theme.sidebarWidth
    color: theme.surface

    Rectangle {
        id: divider
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        width: 1
        color: sidebar.theme.border
    }

    Column {
        anchors.fill: parent
        anchors.margins: sidebar.theme.spacingLarge
        spacing: sidebar.theme.spacing

        Label {
            text: qsTr("Sessions")
            color: sidebar.theme.textMuted
            font.pixelSize: sidebar.theme.fontSmall
            font.bold: true
        }

        Button {
            objectName: "sidebarNewSessionButton"
            text: qsTr("New session")
            width: parent.width
            implicitHeight: sidebar.theme.controlHeight
            onClicked: sidebar.newSessionRequested()
        }

        ListView {
            id: sessionListView
            objectName: "sessionList"
            width: parent.width
            height: parent.height - y
            clip: true
            spacing: 2
            model: sidebar.sessionList
            currentIndex: sidebar.currentIndex
            boundsBehavior: Flickable.StopAtBounds

            delegate: Item {
                id: sessionRow
                required property int index
                required property string title

                width: sessionListView.width
                height: Math.round(sidebar.theme.controlHeight * 1.25)

                Rectangle {
                    anchors.fill: parent
                    radius: sidebar.theme.radius
                    color: sessionRow.index === sidebar.currentIndex
                        ? sidebar.theme.surfaceAccent
                        : "transparent"
                }

                Label {
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: sidebar.theme.spacing
                    anchors.rightMargin: sidebar.theme.spacing
                    text: sessionRow.title
                    color: sidebar.theme.text
                    font.pixelSize: sidebar.theme.fontNormal
                    elide: Text.ElideRight
                }

                MouseArea {
                    anchors.fill: parent
                    onClicked: sidebar.sessionSelected(sessionRow.index)
                }
            }
        }
    }
}
