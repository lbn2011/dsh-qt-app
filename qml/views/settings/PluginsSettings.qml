// PluginsSettings.qml — the Plugins tab landing.
//
// Phase 3 wires this tab to the live Cordis plugin manager (PluginsBridge.qml).
// The summary below still states which plugin surfaces the settings panel
// accepts; the catalogue and the enable switches come from the host, so the
// tab shows real data when a manager is attached and says so when it is not.
pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../../components"

ColumnLayout {
    id: root

    objectName: "settingsSectionPlugins"

    // qmllint disable unqualified
    readonly property QtObject themeBridge: (typeof ctx !== "undefined" && ctx.theme) ? ctx.theme : null
    // qmllint enable unqualified

    /** Live bridge to the Node plugin manager; injected by the settings panel. */
    property var pluginsBridge: null

    /** Token source; a parent injects its own Theme instance. */
    property Theme theme: Theme { bridge: root.themeBridge }

    /** Contributions currently registered for this tab. */
    property var contributions: []

    /** Surfaces this panel accepts, mirroring src/constants.ts. */
    readonly property var acceptedSurfaces: [
        "conversation.settings.section",
        "conversation.settings.form"
    ]

    readonly property bool bridgeBusy: root.pluginsBridge !== null && root.pluginsBridge.busy

    readonly property int contributionCount: (root.contributions === null
        || root.contributions === undefined
        || root.contributions.length === undefined) ? 0 : root.contributions.length

    spacing: root.theme.spacing

    Label {
        objectName: "settingsSectionPluginsTitle"
        text: qsTr("Plugins")
        color: root.theme.text
        font.pixelSize: root.theme.fontLarge
        font.bold: true
        Layout.fillWidth: true
    }

    Label {
        objectName: "settingsSectionPluginsHint"
        text: qsTr("Per-plugin settings arrive once the Cordis host is attached. Plugins may contribute a whole settings tab or a form inside an existing one.")
        color: root.theme.textMuted
        font.pixelSize: root.theme.fontSmall
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }

    Label {
        objectName: "settingsPluginsSurfaceList"
        text: qsTr("Accepts: %1").arg(root.acceptedSurfaces.join(", "))
        color: root.theme.textMuted
        font.pixelSize: root.theme.fontSmall
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }

    Label {
        objectName: "settingsPluginsContributionCount"
        text: root.contributionCount === 0
            ? qsTr("No plugin settings registered.")
            : qsTr("%1 plugin settings registered.").arg(root.contributionCount)
        color: root.contributionCount === 0 ? root.theme.textMuted : root.theme.text
        font.pixelSize: root.theme.fontSmall
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }

    Button {
        objectName: "settingsPluginsManageButton"
        text: root.bridgeBusy ? qsTr("Refreshing…") : qsTr("Refresh plugins")
        enabled: root.pluginsBridge !== null && !root.bridgeBusy
        implicitHeight: root.theme.controlHeight
        palette.button: root.theme.surfaceAlt
        palette.buttonText: root.theme.text
        Layout.fillWidth: true
        onClicked: root.pluginsBridge.refresh()
    }

    Label {
        objectName: "settingsPluginsStatus"
        visible: root.pluginsBridge !== null && root.pluginsBridge.lastError.length > 0
        text: root.pluginsBridge === null ? "" : root.pluginsBridge.lastError
        color: root.theme.danger
        font.pixelSize: root.theme.fontSmall
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }

    Repeater {
        objectName: "settingsPluginsRows"
        model: root.pluginsBridge === null ? [] : root.pluginsBridge.rows

        delegate: RowLayout {
            id: pluginRow

            required property var modelData
            Layout.fillWidth: true
            spacing: root.theme.spacing

            Label {
                Layout.fillWidth: true
                text: (pluginRow.modelData.name || pluginRow.modelData.id || "") + (pluginRow.modelData.version ? "  " + pluginRow.modelData.version : "")
                color: root.theme.text
                font.pixelSize: root.theme.fontSmall
                elide: Text.ElideRight
            }

            Label {
                text: pluginRow.modelData.enabled ? qsTr("enabled") : qsTr("disabled")
                color: root.theme.textMuted
                font.pixelSize: root.theme.fontSmall
            }

            Switch {
                objectName: "settingsPluginSwitch_" + (pluginRow.modelData.id || pluginRow.modelData.name || "")
                checked: !!pluginRow.modelData.enabled
                onClicked: root.pluginsBridge.setEnabled(pluginRow.modelData.id || pluginRow.modelData.name, checked)
            }
        }
    }

    Label {
        objectName: "settingsPluginsEmpty"
        visible: root.pluginsBridge !== null && root.pluginsBridge.rows.length === 0 && !root.bridgeBusy
        text: qsTr("No plugins installed in this profile.")
        color: root.theme.textMuted
        font.pixelSize: root.theme.fontSmall
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }
}
