// SettingsPanel.qml — the settings shell.
//
// Phase 2h. One panel, three sections, in the order the product wants them:
//
//   Theme     — live scheme + font scale (ThemeSettings.qml)
//   Language  — placeholder, the renderer is English-only for now
//   Plugins   — placeholder, plugin settings arrive with the Cordis host work
//
// The panel is deliberately dumb about *where* it lives: main.qml mounts it in a
// right-hand Drawer, but nothing here assumes that, so the same file can become a
// full page later without a rewrite. It owns no state of its own beyond the
// section bookkeeping; everything durable lives in the ThemeBridge behind
// ThemeSettings.qml.
pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../../components"

Rectangle {
    id: root

    objectName: "settingsPanel"

    // ---- Live theme source -------------------------------------------------
    /**
     * Live theme source published by native/main.cpp as `ctx.theme`.
     *
     * Declared per component (not only in Theme.qml) because this panel may be
     * instantiated on its own — a QML test, a preview — and it must still follow
     * the live palette. When a parent injects its own `theme`, that instance
     * already carries the bridge and this one is simply unused.
     */
    // qmllint disable unqualified
    readonly property QtObject themeBridge: (typeof ctx !== "undefined" && ctx.theme) ? ctx.theme : null
    // qmllint enable unqualified

    /** Test/preview seam: forwarded to ThemeSettings.qml. */
    property QtObject bridgeOverride: null

    /** The bridge actually in use, or null when running without a host. */
    readonly property QtObject bridge: root.bridgeOverride !== null ? root.bridgeOverride : root.themeBridge

    /** Token source. Follows the live palette through the bridge. */
    property Theme theme: Theme { bridge: root.bridge }

    /** Title shown in the panel header. */
    property string title: qsTr("Settings")

    /** Sections the panel offers, in display order. */
    readonly property var sections: ["theme", "language", "plugins"]

    /** Emitted when the user asks to leave the panel. */
    signal closeRequested()

    /**
     * Theme controller instance.
     *
     * Exposed so the host (and the QML tests) can drive `applyTheme()` /
     * `setFontScale()` without reaching through the item tree.
     */
    readonly property alias themeSettings: themeSection

    implicitWidth: 360
    implicitHeight: 480
    color: root.theme.surface
    border.width: 1
    border.color: root.theme.border

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: root.theme.spacingLarge
        spacing: root.theme.spacing

        // ---- Header --------------------------------------------------------
        RowLayout {
            objectName: "settingsHeader"

            Layout.fillWidth: true
            spacing: root.theme.spacing

            Label {
                objectName: "settingsTitle"
                text: root.title
                color: root.theme.text
                font.pixelSize: root.theme.fontTitle
                font.bold: true
                Layout.fillWidth: true
            }

            Button {
                objectName: "settingsCloseButton"
                text: qsTr("Close")
                implicitHeight: root.theme.controlHeight
                palette.button: root.theme.surfaceAlt
                palette.buttonText: root.theme.text
                palette.highlight: root.theme.accent
                palette.highlightedText: root.theme.textInverse
                onClicked: root.closeRequested()
            }
        }

        Rectangle {
            objectName: "settingsHeaderRule"
            Layout.fillWidth: true
            implicitHeight: 1
            color: root.theme.border
        }

        // ---- Scrollable body -----------------------------------------------
        Flickable {
            id: bodyFlick

            objectName: "settingsBody"

            Layout.fillWidth: true
            Layout.fillHeight: true
            contentWidth: width
            contentHeight: body.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds

            ScrollBar.vertical: ScrollBar {
                policy: ScrollBar.AsNeeded
                palette.mid: root.theme.textMuted
                palette.dark: root.theme.border
            }

            ColumnLayout {
                id: body

                width: bodyFlick.width
                spacing: root.theme.spacingLarge

                // -- Theme ---------------------------------------------------
                ColumnLayout {
                    objectName: "settingsSectionTheme"
                    Layout.fillWidth: true
                    spacing: root.theme.spacing

                    Label {
                        objectName: "settingsSectionThemeTitle"
                        text: qsTr("Theme")
                        color: root.theme.text
                        font.pixelSize: root.theme.fontLarge
                        font.bold: true
                        Layout.fillWidth: true
                    }

                    ThemeSettings {
                        id: themeSection

                        objectName: "settingsThemeSettings"
                        Layout.fillWidth: true
                        theme: root.theme
                        bridgeOverride: root.bridgeOverride
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    implicitHeight: 1
                    color: root.theme.border
                }

                // -- Language (future) ---------------------------------------
                ColumnLayout {
                    objectName: "settingsSectionLanguage"
                    Layout.fillWidth: true
                    spacing: root.theme.spacing

                    Label {
                        objectName: "settingsSectionLanguageTitle"
                        text: qsTr("Language")
                        color: root.theme.text
                        font.pixelSize: root.theme.fontLarge
                        font.bold: true
                        Layout.fillWidth: true
                    }

                    // Deliberately a disabled control rather than an empty
                    // section: it documents the intent without pretending to
                    // work. The renderer is English-only until Phase 3.
                    ComboBox {
                        objectName: "settingsLanguageCombo"
                        model: [qsTr("English (default)")]
                        enabled: false
                        Layout.fillWidth: true
                        implicitHeight: root.theme.controlHeight
                    }

                    Label {
                        objectName: "settingsLanguageHint"
                        text: qsTr("Additional languages arrive with interface localisation.")
                        color: root.theme.textMuted
                        font.pixelSize: root.theme.fontSmall
                        wrapMode: Text.Wrap
                        Layout.fillWidth: true
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    implicitHeight: 1
                    color: root.theme.border
                }

                // -- Plugins (future) ----------------------------------------
                ColumnLayout {
                    objectName: "settingsSectionPlugins"
                    Layout.fillWidth: true
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
                        text: qsTr("Per-plugin settings arrive once the Cordis host is attached.")
                        color: root.theme.textMuted
                        font.pixelSize: root.theme.fontSmall
                        wrapMode: Text.Wrap
                        Layout.fillWidth: true
                    }

                    Button {
                        objectName: "settingsPluginsManageButton"
                        text: qsTr("Manage plugins")
                        enabled: false
                        implicitHeight: root.theme.controlHeight
                        palette.button: root.theme.surfaceAlt
                        palette.buttonText: root.theme.text
                        Layout.fillWidth: true
                    }
                }
            }
        }
    }
}
