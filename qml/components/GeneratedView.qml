// GeneratedView.qml — renders a `ConversionResult` from the Phase 3 converter.
//
//   { status: "native", tree }   → GeneratedNode draws the tree
//   { status: "text",  reason, text }  → one notice line (unsupported/failed)
//   { status: "web",   reason }  → the slot has a declared web entry; the panel
//                                  offers the WebUI fallback instead of guessing
//
// The view is a pure consumer: it never calls the converter and never opens
// anything by itself. `action` bubbles a user gesture up to the owner, which is
// responsible for sending `ui.action` and feeding the new result back in.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "."

Item {
    id: root

    /** The `ConversionResult` to draw, or null while nothing has arrived. */
    property var result: null

    /** Token source; a parent injects its own Theme instance. */
    property var theme: null

    /** False for read-only previews: controls render but cannot act. */
    property bool interactive: true

    /** Slot-level payload source, handed to every generated action. */
    property var slotContext: ({})

    /** Emitted with the converter's action: event is click/change/submit. */
    signal action(string event, var payload)

    readonly property string status: (root.result !== null && root.result !== undefined
        && typeof root.result === "object" && root.result.status !== undefined)
        ? String(root.result.status)
        : "empty"

    readonly property var tree: (root.status === "native" && root.result.tree !== undefined
        && root.result.tree !== null) ? root.result.tree : null

    readonly property string notice: (root.result !== null && root.result !== undefined
        && root.result.text !== undefined && root.result.text !== null)
        ? String(root.result.text)
        : ""

    readonly property string reason: (root.result !== null && root.result !== undefined
        && root.result.reason !== undefined && root.result.reason !== null)
        ? String(root.result.reason.detail !== undefined ? root.result.reason.detail : root.result.reason)
        : ""

    /** Status helpers; the panel and the tests assert these, not effective visibility. */
    readonly property bool showsNative: root.status === "native" && root.tree !== null
    readonly property bool showsNotice: root.status === "text"
    readonly property bool showsWeb: root.status === "web"
    readonly property bool showsEmpty: root.status === "empty"

    readonly property color textColor: root.theme !== null ? root.theme.text : "#e6e6e6"
    readonly property color mutedColor: root.theme !== null ? root.theme.textMuted : "#9a9a9a"
    readonly property color warningColor: root.theme !== null ? root.theme.warning : "#e0a030"
    readonly property int fontSmall: root.theme !== null ? root.theme.fontSmall : 11
    readonly property int fontNormal: root.theme !== null ? root.theme.fontNormal : 13

    objectName: "generatedView"
    implicitWidth: 320
    implicitHeight: body.implicitHeight

    ColumnLayout {
        id: body

        width: root.width
        spacing: root.theme !== null ? root.theme.spacing : 6

        Loader {
            id: treeLoader

            objectName: "generatedTreeLoader"
            Layout.fillWidth: true
            Layout.preferredHeight: item !== null ? item.implicitHeight : 0
            visible: root.showsNative
            source: root.showsNative ? "GeneratedNode.qml" : ""
            // The action signal is wired once per loaded item. The Loader destroys
            // its item whenever the source empties (text/web results), so track the
            // item reference instead of a boolean: a reloaded item gets rewired.

            onLoaded: treeLoader.applyTree()
            onItemChanged: treeLoader.applyTree()

            property var wiredItem: null

            function applyTree() {
                if (treeLoader.item === null || treeLoader.item === undefined)
                    return
                if (wiredItem !== treeLoader.item) {
                    wiredItem = treeLoader.item
                    treeLoader.item.action.connect(function (event, payload) {
                        root.action(event, payload)
                    })
                }
                treeLoader.item.node = root.tree
                treeLoader.item.theme = root.theme
                treeLoader.item.interactive = root.interactive
                treeLoader.item.slotContext = root.slotContext
            }

            Connections {
                target: root

                function onTreeChanged() {
                    treeLoader.applyTree()
                }

                function onSlotContextChanged() {
                    treeLoader.applyTree()
                }
            }
        }

        Label {
            objectName: "generatedNotice"
            visible: root.showsNotice
            Layout.fillWidth: true
            text: root.notice.length > 0 ? root.notice : qsTr("This slot cannot be drawn natively.")
            color: root.warningColor
            font.pixelSize: root.fontSmall
            wrapMode: Text.Wrap
        }

        Label {
            objectName: "generatedNoticeReason"
            visible: root.showsNotice && root.reason.length > 0
            Layout.fillWidth: true
            text: root.reason
            color: root.mutedColor
            font.pixelSize: root.fontSmall - 1
            wrapMode: Text.Wrap
        }

        Label {
            objectName: "generatedWebNotice"
            visible: root.showsWeb
            Layout.fillWidth: true
            text: qsTr("This slot has a Web UI; open it for the full view.")
            color: root.warningColor
            font.pixelSize: root.fontSmall
            wrapMode: Text.Wrap
        }

        Label {
            objectName: "generatedEmpty"
            visible: root.showsEmpty
            Layout.fillWidth: true
            text: qsTr("Waiting for this slot to render…")
            color: root.mutedColor
            font.pixelSize: root.fontSmall
            wrapMode: Text.Wrap
        }
    }
}