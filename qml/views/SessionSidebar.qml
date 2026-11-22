// SessionSidebar.qml — the session list on the left.
//
// Phase 1c renders the list of known sessions and the "New session" action. The
// model is a plain ListModel with a single `title` role; Phase 2 binds it to the
// Cordis session registry through the event-loop bridge.
pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import "../components"

Rectangle {
    id: sidebar

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
            palette.button: sidebar.theme.surfaceAlt
            palette.buttonText: sidebar.theme.text
            palette.highlight: sidebar.theme.accent
            palette.highlightedText: sidebar.theme.textInverse
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
