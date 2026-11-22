// AboutSettings.qml — the About tab: what this build is.
//
// Everything shown here comes from the `dshQt` context map published by
// native/main.cpp (appName, appVersion, minQtVersion, eventLoopTickMs,
// napiPackageName, napiBinaryName). Outside the native host — qmltestrunner,
// qmllint, a design preview — that map does not exist, so every value has a
// documented fallback instead of rendering "undefined".
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../../components"

ColumnLayout {
    id: root

    objectName: "settingsSectionAbout"

    // qmllint disable unqualified
    readonly property QtObject themeBridge: (typeof ctx !== "undefined" && ctx.theme) ? ctx.theme : null
    // qmllint enable unqualified

    /** Token source; a parent injects its own Theme instance. */
    property Theme theme: Theme { bridge: root.themeBridge }

    /** True when the native host published its metadata map. */
    // qmllint disable unqualified
    readonly property bool hostAvailable: typeof dshQt !== "undefined" && dshQt !== null
    // qmllint enable unqualified

    /** Read one string out of the host map, with a fallback. */
    function hostValue(key, fallbackValue) {
        // qmllint disable unqualified
        if (typeof dshQt === "undefined" || dshQt === null)
            return fallbackValue
        var value = dshQt[key]
        // qmllint enable unqualified
        if (value === undefined || value === null || String(value).length === 0)
            return fallbackValue
        return String(value)
    }

    readonly property string appName: root.hostValue("appName", qsTr("DSH"))
    readonly property string appVersion: root.hostValue("appVersion", qsTr("unknown"))
    readonly property string minimumQtVersion: root.hostValue("minQtVersion", qsTr("unknown"))
    readonly property string napiPackage: root.hostValue("napiPackageName", "dsh-qt-napi")
    readonly property string eventLoopTick: root.hostValue("eventLoopTickMs", "10")

    spacing: root.theme.spacing

    Label {
        objectName: "settingsSectionAboutTitle"
        text: qsTr("About")
        color: root.theme.text
        font.pixelSize: root.theme.fontLarge
        font.bold: true
        Layout.fillWidth: true
    }

    Label {
        objectName: "settingsAboutAppName"
        text: root.appName + " " + root.appVersion
        color: root.theme.text
        font.pixelSize: root.theme.fontNormal
        font.bold: true
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }

    Label {
        objectName: "settingsAboutDescription"
        text: qsTr("Native Qt 6 shell for DeepSeek Harness. Plugin-compatible with the Web UI: the same Cordis plugins contribute views and slot content, rendered by Qt instead of a WebView.")
        color: root.theme.textMuted
        font.pixelSize: root.theme.fontSmall
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }

    // ---- Facts -------------------------------------------------------------
    GridLayout {
        objectName: "settingsAboutFacts"

        Layout.fillWidth: true
        columns: 2
        columnSpacing: root.theme.spacingLarge
        rowSpacing: root.theme.spacing / 2

        Label {
            text: qsTr("Qt")
            color: root.theme.textMuted
            font.pixelSize: root.theme.fontSmall
        }

        Label {
            objectName: "settingsAboutQtVersion"
            text: root.minimumQtVersion
            color: root.theme.text
            font.pixelSize: root.theme.fontSmall
            Layout.fillWidth: true
        }

        Label {
            text: qsTr("Markdown addon")
            color: root.theme.textMuted
            font.pixelSize: root.theme.fontSmall
        }

        Label {
            objectName: "settingsAboutNapi"
            text: root.napiPackage
            color: root.theme.text
            font.pixelSize: root.theme.fontSmall
            Layout.fillWidth: true
        }

        Label {
            text: qsTr("Event loop")
            color: root.theme.textMuted
            font.pixelSize: root.theme.fontSmall
        }

        Label {
            objectName: "settingsAboutEventLoop"
            text: qsTr("%1 ms tick").arg(root.eventLoopTick)
            color: root.theme.text
            font.pixelSize: root.theme.fontSmall
            Layout.fillWidth: true
        }
    }

    Label {
        objectName: "settingsAboutHostHint"
        visible: !root.hostAvailable
        text: qsTr("Running outside the native host, so build details are unavailable.")
        color: root.theme.textMuted
        font.pixelSize: root.theme.fontSmall
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }
}
