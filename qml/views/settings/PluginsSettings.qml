// PluginsSettings.qml — the Plugins tab landing.
//
// The native shell cannot install plugins yet (the Cordis host lands in a later
// phase), so this tab does the honest thing: it states which plugin surfaces the
// settings panel accepts, and how many contributions actually arrived. When a
// plugin does ship a settings view, that view is rendered by the panel through
// SlotHost.qml, immediately below this summary.
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

    /** Token source; a parent injects its own Theme instance. */
    property Theme theme: Theme { bridge: root.themeBridge }

    /** Contributions currently registered for this tab. */
    property var contributions: []

    /** Surfaces this panel accepts, mirroring src/constants.ts. */
    readonly property var acceptedSurfaces: [
        "conversation.settings.section",
        "conversation.settings.form"
    ]

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
        text: qsTr("Manage plugins")
        // Disabled on purpose: there is no plugin manager to open yet, and a
        // button that silently does nothing is worse than a visible "not yet".
        enabled: false
        implicitHeight: root.theme.controlHeight
        palette.button: root.theme.surfaceAlt
        palette.buttonText: root.theme.text
        Layout.fillWidth: true
    }
}
