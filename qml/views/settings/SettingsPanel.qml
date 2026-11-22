// SettingsPanel.qml — the settings shell.
//
// Phase 2j turns the Phase 2h stacked-sections pane into a tabbed shell:
//
//   Theme     — live scheme + font scale (ThemeSettings.qml)          built-in
//   Language  — placeholder, the renderer is English-only for now     built-in
//   Plugins   — what the panel accepts, plus plugin forms             built-in
//   About     — build facts, read from the `dshQt` context map        built-in
//
// Plugins extend it without touching this file. Two surfaces are honoured:
//
//   conversation.settings.section  → becomes an extra tab (SlotHost.qml)
//   conversation.settings.form     → rendered inside the tab named by the
//                                    contribution's `section` field, defaulting
//                                    to the Plugins tab (SlotForms.qml)
//
// Both ids come from src/constants.ts (`SETTINGS_SLOT_SURFACES`); the panel
// mirrors them in `acceptedSurfaces` and a TS test keeps the two in step.
//
// The panel is deliberately dumb about *where* it lives: main.qml mounts it in a
// right-hand Drawer, but nothing here assumes that, so the same file can become a
// full page later without a rewrite. It owns no state beyond the tab bookkeeping;
// everything durable lives in the ThemeBridge behind ThemeSettings.qml.
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

    /** Emitted when the user asks to leave the panel. */
    /**
     * Settings bridge (`get`/`set`/`fields`), or null.
     *
     * The panel does not own the store — C++ and the Node side do — so it accepts
     * whatever bridge the host injects and passes it down. With no bridge the
     * forms still render and still report edits; they simply cannot persist,
     * which is what a QML test wants.
     */
    property var settingsBridge: null

    /** Emitted when any hosted form reports a user edit. */
    signal settingEdited(string name, var value)

    signal closeRequested()

    /**
     * Lifecycle: emitted when the host shows / hides the panel.
     *
     * The panel does not own a visibility of its own — the Drawer does — so the
     * host toggles `active` and the panel turns that into the pair of signals
     * every other component already expects. A plugin that needs to start or stop
     * polling can hook these instead of guessing at the parent's type.
     */
    signal opened()
    signal closed()

    property bool active: false

    onActiveChanged: {
        if (root.active)
            root.opened()
        else
            root.closed()
    }

    // ---- Tabs --------------------------------------------------------------
    /** Tabs that ship with the shell, in display order. */
    readonly property var builtinTabs: [
        {
            "id": "theme",
            "title": qsTr("Theme"),
            "kind": "builtin"
        },
        {
            "id": "language",
            "title": qsTr("Language"),
            "kind": "builtin"
        },
        {
            "id": "plugins",
            "title": qsTr("Plugins"),
            "kind": "builtin"
        },
        {
            "id": "about",
            "title": qsTr("About"),
            "kind": "builtin"
        }
    ]

    /**
     * Plugin contributions registered for this panel.
     *
     * Shape matches `QtSlotContribution`: `surface`, `id`, `title`, `order`,
     * and either `component` or `url`. The host fills this in from
     * `ctx.qtRenderer.slotContributions("conversation.settings.*")`.
     */
    property var slotContributions: []

    /** Slot contributions that become tabs of their own. */
    readonly property var slotSectionTabs: {
        var input = root.slotContributions
        if (input === null || input === undefined || input.length === undefined)
            return []
        var tabs = []
        for (var index = 0; index < input.length; ++index) {
            var entry = input[index]
            if (entry === null || entry === undefined)
                continue
            if (entry.surface !== "conversation.settings.section")
                continue
            var tabId = (entry.section !== undefined && entry.section !== null)
                ? String(entry.section)
                : ("plugin-" + String(entry.id))
            tabs.push({
                "id": tabId,
                "title": (entry.title === undefined || entry.title === null) ? tabId : String(entry.title),
                "kind": "slot",
                "contribution": entry
            })
        }
        return tabs
    }

    /** Every tab, built-in first. */
    readonly property var tabs: root.builtinTabs.concat(root.slotSectionTabs)

    /** Ids only, in display order — handy for tests and for `selectTab`. */
    readonly property var sections: {
        var ids = []
        for (var index = 0; index < root.tabs.length; ++index)
            ids.push(root.tabs[index].id)
        return ids
    }

    /** Currently selected tab id. */
    property string currentTab: "theme"

    /** Index of `currentTab`, or 0 when it no longer exists. */
    readonly property int currentTabIndex: root.indexOfTab(root.currentTab)

    /** Surfaces this panel hosts; mirrors SETTINGS_SLOT_SURFACES in the TS side. */
    readonly property var acceptedSurfaces: [
        "conversation.settings.section",
        "conversation.settings.form"
    ]

    /** Index of a tab id, or 0 when unknown. */
    function indexOfTab(tabId) {
        var wanted = String(tabId)
        for (var index = 0; index < root.tabs.length; ++index) {
            if (root.tabs[index].id === wanted)
                return index
        }
        return 0
    }

    /** Tab record at `index`, or null. */
    function tabAt(index) {
        if (index < 0 || index >= root.tabs.length)
            return null
        return root.tabs[index]
    }

    /** Select a tab by id. Unknown ids are ignored, not coerced. */
    function selectTab(tabId) {
        var wanted = String(tabId)
        for (var index = 0; index < root.tabs.length; ++index) {
            if (root.tabs[index].id === wanted) {
                root.currentTab = wanted
                return true
            }
        }
        return false
    }

    /** Step through tabs, wrapping — what Left/Right in the tab bar do. */
    function stepTab(offset) {
        if (root.tabs.length === 0)
            return
        var count = root.tabs.length
        var next = ((root.currentTabIndex + offset) % count + count) % count
        root.currentTab = root.tabs[next].id
    }

    /**
     * Contributions belonging to one tab.
     *
     * A form with no `section` field belongs to the Plugins tab: that is where a
     * plugin's settings land when the plugin did not ask for anything more
     * specific, and it keeps old contributions working unchanged.
     */
    function contributionsFor(tabId) {
        var wanted = String(tabId)
        var input = root.slotContributions
        var result = []
        if (input === null || input === undefined || input.length === undefined)
            return result
        for (var index = 0; index < input.length; ++index) {
            var entry = input[index]
            if (entry === null || entry === undefined)
                continue
            if (entry.surface !== "conversation.settings.form")
                continue
            var owner = (entry.section === undefined || entry.section === null || String(entry.section) === "")
                ? "plugins"
                : String(entry.section)
            if (owner === wanted)
                result.push(entry)
        }
        return result
    }

    /** Number of form contributions a tab will render. */
    function formCountFor(tabId) {
        return root.contributionsFor(tabId).length
    }

    /** Extra values handed to every slot, so plugins need no globals. */
    readonly property var slotContext: ({
            "theme": root.theme,
            "bridge": root.bridge,
            "panel": root,
            "settings": root.settingsBridge,
            "closeRequested": function () {
                root.closeRequested()
            }
        })

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

        // ---- Tab bar -------------------------------------------------------
        Flickable {
            id: tabBar

            objectName: "settingsTabBar"

            Layout.fillWidth: true
            implicitHeight: root.theme.controlHeight
            contentWidth: tabRow.implicitWidth
            contentHeight: height
            clip: true
            flickableDirection: Flickable.HorizontalFlick
            boundsBehavior: Flickable.StopAtBounds

            Row {
                id: tabRow
                height: tabBar.height
                spacing: root.theme.spacing / 2

                Repeater {
                    model: root.tabs

                    delegate: Button {
                        id: tabButton

                        required property var modelData
                        required property int index

                        objectName: "settingsTab" + index

                        /** True for the active tab; purely derived, never stored. */
                        readonly property bool selected: root.currentTab === tabButton.modelData.id

                        text: tabButton.modelData.title
                        height: tabBar.height
                        // Deliberately NOT checkable. A checkable Button keeps its
                        // own `checked` state, which fights the single source of
                        // truth (`currentTab`) as soon as the user clicks: the
                        // control writes the property and the binding that was
                        // supposed to keep it in sync dies. Selection is derived
                        // instead, and the underline below draws it.
                        flat: true
                        palette.buttonText: tabButton.selected ? root.theme.text : root.theme.textMuted
                        palette.highlight: root.theme.accent
                        palette.highlightedText: root.theme.textInverse
                        onClicked: root.selectTab(tabButton.modelData.id)

                        Rectangle {
                            objectName: "settingsTabIndicator" + tabButton.index
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.bottom: parent.bottom
                            implicitHeight: 2
                            visible: tabButton.selected
                            color: root.theme.accent
                        }
                    }
                }
            }
        }

        Rectangle {
            objectName: "settingsTabRule"
            Layout.fillWidth: true
            implicitHeight: 1
            color: root.theme.border
        }

        // ---- Pages ---------------------------------------------------------
        StackLayout {
            id: pages

            objectName: "settingsPages"

            Layout.fillWidth: true
            Layout.fillHeight: true
            currentIndex: root.currentTabIndex

            // -- Theme -------------------------------------------------------
            Flickable {
                id: themePage

                objectName: "settingsPageTheme"

                contentWidth: width
                contentHeight: themeColumn.implicitHeight
                clip: true
                boundsBehavior: Flickable.StopAtBounds

                ScrollBar.vertical: ScrollBar {
                    policy: ScrollBar.AsNeeded
                    palette.mid: root.theme.textMuted
                    palette.dark: root.theme.border
                }

                ColumnLayout {
                    id: themeColumn

                    objectName: "settingsSectionTheme"
                    width: themePage.width
                    spacing: root.theme.spacing

                    ThemeSettings {
                        id: themeSection

                        objectName: "settingsThemeSettings"
                        Layout.fillWidth: true
                        theme: root.theme
                        bridgeOverride: root.bridgeOverride
                    }

                    SlotForms {
                        Layout.fillWidth: true
                        theme: root.theme
                        forms: root.contributionsFor("theme")
                        slotContext: root.slotContext
                    }
                }
            }

            // -- Language (future) -------------------------------------------
            Flickable {
                id: languagePage

                objectName: "settingsPageLanguage"

                contentWidth: width
                contentHeight: languageColumn.implicitHeight
                clip: true
                boundsBehavior: Flickable.StopAtBounds

                ScrollBar.vertical: ScrollBar {
                    policy: ScrollBar.AsNeeded
                    palette.mid: root.theme.textMuted
                    palette.dark: root.theme.border
                }

                ColumnLayout {
                    id: languageColumn

                    objectName: "settingsSectionLanguage"
                    width: languagePage.width
                    spacing: root.theme.spacing

                    Label {
                        objectName: "settingsSectionLanguageTitle"
                        text: qsTr("Language")
                        color: root.theme.text
                        font.pixelSize: root.theme.fontLarge
                        font.bold: true
                        Layout.fillWidth: true
                    }

                    // The generated form replaces t19's disabled placeholder:
                    // `language` is a real setting with `requiresRestart`, so
                    // the row is live (one option for now) and says so, instead
                    // of pretending the setting does not exist. More languages
                    // arrive with Phase 3 localisation — the option list grows,
                    // this file does not change.
                    LanguageForm {
                        objectName: "settingsLanguageForm"
                        Layout.fillWidth: true
                        theme: root.theme
                        settingsBridge: root.settingsBridge

                        onValueEdited: function (name, value) {
                            root.settingEdited(name, value)
                        }
                    }
                }
            }

            // -- Plugins -----------------------------------------------------
            Flickable {
                id: pluginsPage

                objectName: "settingsPagePlugins"

                contentWidth: width
                contentHeight: pluginsColumn.implicitHeight
                clip: true
                boundsBehavior: Flickable.StopAtBounds

                ScrollBar.vertical: ScrollBar {
                    policy: ScrollBar.AsNeeded
                    palette.mid: root.theme.textMuted
                    palette.dark: root.theme.border
                }

                ColumnLayout {
                    id: pluginsColumn

                    width: pluginsPage.width
                    spacing: root.theme.spacingLarge

                    PluginsSettings {
                        objectName: "settingsSectionPlugins"
                        Layout.fillWidth: true
                        theme: root.theme
                        contributions: root.contributionsFor("plugins")
                    }

                    SlotForms {
                        Layout.fillWidth: true
                        theme: root.theme
                        forms: root.contributionsFor("plugins")
                        slotContext: root.slotContext
                    }
                }
            }

            // -- About -------------------------------------------------------
            Flickable {
                id: aboutPage

                objectName: "settingsPageAbout"

                contentWidth: width
                contentHeight: aboutColumn.implicitHeight
                clip: true
                boundsBehavior: Flickable.StopAtBounds

                ScrollBar.vertical: ScrollBar {
                    policy: ScrollBar.AsNeeded
                    palette.mid: root.theme.textMuted
                    palette.dark: root.theme.border
                }

                ColumnLayout {
                    id: aboutColumn

                    width: aboutPage.width
                    spacing: root.theme.spacingLarge

                    AboutSettings {
                        objectName: "settingsSectionAbout"
                        Layout.fillWidth: true
                        theme: root.theme
                    }

                    SlotForms {
                        Layout.fillWidth: true
                        theme: root.theme
                        forms: root.contributionsFor("about")
                        slotContext: root.slotContext
                    }
                }
            }

            // -- Plugin tabs --------------------------------------------------
            Repeater {
                model: root.slotSectionTabs

                delegate: Flickable {
                    id: slotPage

                    required property var modelData
                    required property int index

                    objectName: "settingsPageSlot" + slotPage.index

                    contentWidth: width
                    contentHeight: slotColumn.implicitHeight
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds

                    ScrollBar.vertical: ScrollBar {
                        policy: ScrollBar.AsNeeded
                        palette.mid: root.theme.textMuted
                        palette.dark: root.theme.border
                    }

                    ColumnLayout {
                        id: slotColumn

                        width: slotPage.width
                        spacing: root.theme.spacingLarge

                        SlotHost {
                            objectName: "settingsSlotSection" + slotPage.index
                            Layout.fillWidth: true
                            theme: root.theme
                            contribution: slotPage.modelData.contribution
                            slotContext: root.slotContext
                        }

                        SlotForms {
                            Layout.fillWidth: true
                            theme: root.theme
                            forms: root.contributionsFor(slotPage.modelData.id)
                            slotContext: root.slotContext
                        }
                    }
                }
            }
        }
    }
}
