// tst_settings.qml — the settings shell: tabs, plugin slots, lifecycle.
//
// Phase 2j. The panel is the one place where the native UI meets plugin-authored
// content, so the interesting failures are structural rather than cosmetic:
//
//   * a tab that exists in the model but has no page (blank panel),
//   * a slot contribution that lands in the wrong tab,
//   * a slot that fails to load and takes the panel with it,
//   * a lifecycle signal that fires on the wrong transition.
//
// Everything is driven through the panel's public surface — `sections`,
// `selectTab()`, `slotContributions`, `active` — because that is what the host
// and the plugins use.
import QtQuick
import QtTest
import "../../qml/views/settings"
import "../../qml/components"

TestCase {
    id: testCase

    name: "SettingsPanel"
    when: windowShown

    width: 420
    height: 640

    // ---- Panel under test --------------------------------------------------
    Component {
        id: panelComponent

        SettingsPanel {}
    }

    // A plugin-contributed settings tab: a Rectangle that accepts the values
    // SlotHost hands out, so the test proves the hand-off rather than the
    // helpfully-failing assignment path.
    Component {
        id: pluginSectionComponent

        Rectangle {
            id: pluginSection

            property var theme: null
            property var panel: null

            objectName: "pluginSectionBody"
            implicitHeight: 80
            color: pluginSection.theme !== null ? pluginSection.theme.surfaceAlt : "#202124"
        }
    }

    // A plugin-contributed form, deliberately without a `section` field: it must
    // default to the Plugins tab.
    Component {
        id: pluginFormComponent

        Rectangle {
            id: pluginForm

            property var theme: null

            objectName: "pluginFormBody"
            implicitHeight: 60
            color: pluginForm.theme !== null ? pluginForm.theme.surfaceAlt : "#202124"
        }
    }

    SignalSpy {
        id: openedSpy
        signalName: "opened"
    }

    SignalSpy {
        id: closedSpy
        signalName: "closed"
    }

    SignalSpy {
        id: closeRequestedSpy
        signalName: "closeRequested"
    }

    property var panel: null

    function createPanel(props) {
        panel = panelComponent.createObject(testCase, props || {})
        return panel
    }

    function cleanup() {
        if (panel !== null) {
            panel.destroy()
            panel = null
        }
    }

    // ---- Tabs --------------------------------------------------------------
    function test_builtinTabsAreListedInOrder() {
        createPanel()

        compare(panel.sections.join(","), "theme,language,models,plugins,about")
        compare(panel.tabs.length, 5)
        compare(panel.tabs[0].kind, "builtin")

        // One button per tab, and the model and the bar cannot drift apart
        // because both are driven by `tabs`.
        for (var index = 0; index < 5; ++index)
            verify(findChild(panel, "settingsTab" + index) !== null, "tab button " + index + " exists")
    }

    function test_defaultTabIsTheme() {
        createPanel()

        compare(panel.currentTab, "theme")
        compare(panel.currentTabIndex, 0)

        const themePage = findChild(panel, "settingsPageTheme")
        verify(themePage !== null, "theme page exists")
        verify(findChild(panel, "settingsThemeSettings") !== null, "ThemeSettings is hosted in the theme tab")
    }

    function test_selectTabSwitchesTheVisiblePage() {
        createPanel()

        verify(panel.selectTab("about"), "about is a known tab")
        compare(panel.currentTab, "about")
        compare(panel.currentTabIndex, 4)

        verify(panel.selectTab("plugins"))
        compare(panel.currentTab, "plugins")
        compare(panel.currentTabIndex, 3)

        const pluginsPage = findChild(panel, "settingsPagePlugins")
        verify(pluginsPage !== null, "plugins page exists")
        verify(findChild(panel, "settingsSectionPlugins") !== null, "Plugins section is present")

        // Selecting an unknown tab must be a no-op, not a silent jump to zero.
        verify(!panel.selectTab("nope"))
        compare(panel.currentTab, "plugins")
    }

    function test_stepTabWrapsAround() {
        createPanel()

        compare(panel.currentTab, "theme")
        panel.stepTab(1)
        compare(panel.currentTab, "language")
        panel.stepTab(-2)
        compare(panel.currentTab, "about")
        panel.stepTab(1)
        compare(panel.currentTab, "theme")
    }

    // ---- Lifecycle ---------------------------------------------------------
    function test_lifecycleSignalsFollowActive() {
        createPanel()

        openedSpy.clear()
        closedSpy.clear()
        openedSpy.target = panel
        closedSpy.target = panel

        panel.active = true
        compare(openedSpy.count, 1)
        compare(closedSpy.count, 0)

        panel.active = false
        compare(closedSpy.count, 1)

        // Setting the same value again is not a transition.
        panel.active = false
        compare(closedSpy.count, 1)
    }

    function test_closeButtonRequestsClose() {
        createPanel()

        closeRequestedSpy.clear()
        closeRequestedSpy.target = panel

        const closeButton = findChild(panel, "settingsCloseButton")
        verify(closeButton !== null, "close button exists")
        closeButton.clicked()
        compare(closeRequestedSpy.count, 1)
    }

    // ---- Plugin slots ------------------------------------------------------
    function test_acceptedSurfacesMirrorTheTypeScriptSide() {
        createPanel()

        compare(panel.acceptedSurfaces.join(","),
                "conversation.settings.section,conversation.settings.form")
    }

    function test_sectionContributionBecomesATab() {
        createPanel({
            "slotContributions": [{
                    "surface": "conversation.settings.section",
                    "id": "acme-settings",
                    "title": "Acme",
                    "component": pluginSectionComponent
                }]
        })

        compare(panel.tabs.length, 6)
        compare(panel.sections.join(","), "theme,language,models,plugins,about,plugin-acme-settings")

        const slotTab = panel.tabs[5]
        compare(slotTab.kind, "slot")
        compare(slotTab.title, "Acme")

        // A plugin tab is reachable like any other.
        verify(panel.selectTab(slotTab.id))
        compare(panel.currentTabIndex, 5)

        // And it really rendered: SlotHost instantiated the contributed item and
        // handed it the theme from the slot context.
        const host = findChild(panel, "settingsSlotSection0")
        verify(host !== null, "slot host exists for the plugin tab")
        tryVerify(function () {
            return host.loadedItem !== null
        }, 2000)
        compare(host.loadedItem.objectName, "pluginSectionBody")
        verify(host.loadedItem.theme !== null, "the slot received the live Theme")
        // Same object, not merely an equal one: the slot context must hand the
        // real panel through rather than a copy.
        verify(host.loadedItem.panel === panel, "the slot received the panel itself")
    }

    function test_sectionContributionCanNameItsOwnTabId() {
        createPanel({
            "slotContributions": [{
                    "surface": "conversation.settings.section",
                    "id": "acme-settings",
                    "section": "acme",
                    "title": "Acme"
                }]
        })

        compare(panel.sections.join(","), "theme,language,models,plugins,about,acme")
        // No component and no url: the host must say so instead of rendering
        // nothing at all.
        panel.selectTab("acme")
        const host = findChild(panel, "settingsSlotSection0")
        verify(host !== null, "slot host exists")
        verify(!host.hasComponent && !host.hasUrl, "the contribution carries nothing to load")
        verify(findChild(host, "settingsSlotEmpty") !== null, "an empty slot explains itself")
    }

    function test_formContributionDefaultsToThePluginsTab() {
        createPanel({
            "slotContributions": [{
                    "surface": "conversation.settings.form",
                    "id": "acme-form",
                    "title": "Acme options",
                    "component": pluginFormComponent
                }]
        })

        // Forms never create tabs of their own.
        compare(panel.tabs.length, 5)
        compare(panel.formCountFor("plugins"), 1)
        compare(panel.formCountFor("theme"), 0)

        const form = findChild(panel, "settingsSlotForm0")
        verify(form !== null, "the form is rendered in the plugins tab")
        tryVerify(function () {
            return form.loadedItem !== null
        }, 2000)
        compare(form.loadedItem.objectName, "pluginFormBody")
    }

    function test_formContributionHonoursItsSectionField() {
        createPanel({
            "slotContributions": [{
                    "surface": "conversation.settings.form",
                    "id": "acme-form",
                    "section": "about",
                    "component": pluginFormComponent
                }]
        })

        compare(panel.formCountFor("about"), 1)
        compare(panel.formCountFor("plugins"), 0)

        // Rendering happens on page creation, so the about page must actually
        // host it without the user having to switch tabs first.
        const aboutForm = findChild(panel, "settingsSlotForm0")
        verify(aboutForm !== null, "the form is rendered in the about tab")
    }

    function test_brokenSlotDoesNotTakeThePanelDown() {
        createPanel({
            "slotContributions": [{
                    "surface": "conversation.settings.section",
                    "id": "broken",
                    "title": "Broken",
                    "url": "file:///nonexistent/plugin/settings.qml"
                }]
        })

        panel.selectTab("plugin-broken")
        const host = findChild(panel, "settingsSlotSection0")
        verify(host !== null, "slot host still exists")
        tryVerify(function () {
            return host.failedToLoad
        }, 2000)
        verify(findChild(host, "settingsSlotError") !== null, "the failure is reported inline")

        // The rest of the panel is unaffected.
        verify(panel.selectTab("theme"))
        compare(panel.currentTab, "theme")
        verify(findChild(panel, "settingsThemeSettings") !== null, "theme tab still works")
    }
}
