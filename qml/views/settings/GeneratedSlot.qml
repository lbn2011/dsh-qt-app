// GeneratedSlot.qml — hosts one renderable plugin slot in native QML.
//
// Flow: `ui.render` → ConversionResult → GeneratedView → user gesture →
// `ui.action` → Node updates the slot props and re-renders → the reply updates
// the view in place. A slot without a render function never reaches this
// component: PluginsSettings keeps the component/url path for those.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../../components"

ColumnLayout {
    id: root

    objectName: "generatedSlot"

    /** PluginsBridge instance; null while the host is not attached. */
    property var pluginsBridge: null

    /** Slot id on the Node side (`surface:id` is unique there). */
    property string slotId: ""

    /** Human title for the header line. */
    property string slotTitle: ""

    /** Slot surface, shown in diagnostics. */
    property string surface: ""

    property Theme theme: Theme {}

    readonly property string header: root.slotTitle.length > 0 ? root.slotTitle : root.slotId

    readonly property var result: root.lastResult
    property var lastResult: null
    property string lastError: ""

    spacing: root.theme.spacing

    function requestRender() {
        if (root.pluginsBridge === null || root.slotId.length === 0)
            return
        root.lastError = ""
        root.pluginsBridge.renderSlot(root.slotId, ({}))
    }

    Component.onCompleted: root.requestRender()

    Connections {
        target: root.pluginsBridge === null ? null : root.pluginsBridge

        function onRendered(slotId, result) {
            if (String(slotId) === root.slotId)
                root.lastResult = result
        }

        function onFailed(message) {
            root.lastError = String(message)
        }

        function onChanged() {
            // A `slot.changed` push means the plugin replaced its contribution.
            if (root.pluginsBridge !== null && root.pluginsBridge.slots !== null)
                root.requestRender()
        }
    }

    Label {
        objectName: "generatedSlotHeader"
        text: root.header
        color: root.theme.text
        font.pixelSize: root.theme.fontNormal
        font.bold: true
        Layout.fillWidth: true
        wrapMode: Text.Wrap
    }

    Label {
        objectName: "generatedSlotSurface"
        visible: root.surface.length > 0
        text: root.surface
        color: root.theme.textMuted
        font.pixelSize: root.theme.fontSmall
        Layout.fillWidth: true
    }

    GeneratedView {
        objectName: "generatedSlotView"
        Layout.fillWidth: true
        theme: root.theme
        result: root.lastResult
        slotContext: ({ "theme": root.theme, "slotId": root.slotId })

        onAction: function (event, payload) {
            if (root.pluginsBridge === null)
                return
            root.pluginsBridge.act(root.slotId, event, payload)
        }
    }

    Label {
        objectName: "generatedSlotError"
        visible: root.lastError.length > 0
        text: root.lastError
        color: root.theme.danger
        font.pixelSize: root.theme.fontSmall
        Layout.fillWidth: true
        wrapMode: Text.Wrap
    }
}
