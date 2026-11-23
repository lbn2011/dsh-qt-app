// tst_themesettings.qml — the settings pane's controls and live switching.
//
// These tests run *without* a native host: `ctx` does not exist under
// qmltestrunner, so ThemeSettings.qml sees `bridge === null` and drives
// `Theme.fallbackThemeId` / `Theme.fallbackFontScale` instead. That is the path a
// bare `qml` invocation takes, and it still exercises the real repaint path —
// Theme.qml reads those fallbacks when no bridge is attached, so every token
// below genuinely changes as a result of the control being operated.
//
// What is covered:
//   * the three modes exist (Auto / Dark / Light) and are mutually exclusive
//   * picking a mode repaints the palette, and the choice is reported back
//   * Auto resolves to a concrete scheme and never throws on a runtime that
//     cannot report one (the offscreen platform reports Unknown → dark)
//   * the slider drives the font scale, which moves text metrics and leaves the
//     layout rhythm alone
//   * out-of-range and non-numeric scales are clamped, not propagated
//   * the panel exposes the Theme / Language / Plugins / About tabs
//   * a stub bridge receives the writes instead of the local fallbacks
import QtQuick
import QtTest
import "../../qml/components" as Components
import "../../qml/views/settings"

TestCase {
    id: testCase
    name: "ThemeSettings"
    when: windowShown

    /** Font scale must move these. */
    readonly property var scaledTokens: ["fontSmall", "fontNormal", "fontLarge", "fontTitle", "controlHeight"]

    /** …and must not move these. */
    readonly property var fixedTokens: ["spacing", "spacingLarge", "radius", "radiusLarge", "sidebarWidth", "animationDuration"]

    // Declared rather than built with Qt.createQmlObject(): relative imports
    // inside a QML string resolve against the calling file, which is easy to get
    // wrong, whereas this Component shares the file's imports.
    Component {
        id: themeSettingsComponent

        ThemeSettings {}
    }

    Component {
        id: settingsPanelComponent

        SettingsPanel {}
    }

    /** A stand-in for ctx.theme that records what the controls wrote. */
    Component {
        id: stubBridgeComponent

        QtObject {
            property string themeId: "dark"
            property real fontScale: 1.0
            property int themeWrites: 0
            property int scaleWrites: 0

            signal themeChanged()

            onThemeIdChanged: themeWrites += 1
            onFontScaleChanged: scaleWrites += 1
        }
    }

    /**
     * Perceived luminance of a #rrggbb colour, 0 … 1.
     *
     * Used instead of comparing hex strings, which happens to work for these two
     * palettes but breaks the moment either one changes tone.
     */
    function luminance(colour) {
        const hex = String(colour).replace("#", "")
        if (hex.length < 6)
            return 0
        const r = parseInt(hex.substring(0, 2), 16) / 255
        const g = parseInt(hex.substring(2, 4), 16) / 255
        const b = parseInt(hex.substring(4, 6), 16) / 255
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    function makeSettings(props) {
        const item = themeSettingsComponent.createObject(testCase, props || {})
        verify(item !== null, "ThemeSettings could not be created")
        return item
    }

    // ---- Modes ------------------------------------------------------------
    function test_modesAreAutoDarkLight() {
        const settings = makeSettings({})

        compare(settings.modes.length, 3, "three modes are offered")
        compare(settings.modes[0], "auto")
        compare(settings.modes[1], "dark")
        compare(settings.modes[2], "light")
        compare(settings.mode, "auto", "the panel defaults to following the system")

        settings.destroy()
    }

    function test_autoResolvesToAConcreteScheme() {
        const settings = makeSettings({})

        // The offscreen platform does not report a colour scheme, so this must
        // fall back rather than return "auto" or throw.
        const resolved = settings.effectiveScheme
        verify(resolved === "dark" || resolved === "light", "auto resolves to a real scheme, got " + resolved)
        verify(settings.followingSystem, "mode 'auto' is flagged as following the system")

        settings.destroy()
    }

    function test_selectingLightRepaintsThePalette() {
        const settings = makeSettings({})
        const theme = settings.theme

        const before = String(theme.background)
        const beforeLuminance = testCase.luminance(before)
        settings.applyTheme("light")

        compare(settings.mode, "light")
        compare(settings.effectiveScheme, "light")
        compare(theme.themeId, "light", "the Theme follows the selection")
        verify(String(theme.background) !== before, "background repainted")
        // A light scheme is genuinely lighter than the dark one, by number
        // rather than by an opaque string comparison.
        verify(testCase.luminance(theme.background) > beforeLuminance + 0.5,
               "light background is measurably lighter: " + theme.background)

        settings.destroy()
    }

    function test_selectingDarkReturnsToTheDefaultPalette() {
        const settings = makeSettings({})
        const theme = settings.theme

        settings.applyTheme("light")
        const lightSurface = String(theme.surface)

        settings.applyTheme("dark")

        compare(settings.effectiveScheme, "dark")
        compare(theme.themeId, "dark")
        verify(String(theme.surface) !== lightSurface, "surface repainted back to dark")

        settings.destroy()
    }

    function test_concreteIdsAreAcceptedAsWellAsModes() {
        const settings = makeSettings({})

        // The persisted value is "light"/"dark", never "auto", so a caller
        // holding only that must be able to drive the control.
        const applied = settings.applyTheme("LIGHT")

        compare(applied, "light")
        compare(settings.mode, "light")
        compare(settings.isMode("light"), true)
        compare(settings.isMode("auto"), true)
        compare(settings.isMode("solarized"), false)

        settings.destroy()
    }

    function test_unknownModeFallsBackInsteadOfBreaking() {
        const settings = makeSettings({})

        const applied = settings.applyTheme("banana")

        verify(applied === "dark" || applied === "light", "unknown input resolves to a real scheme, got " + applied)
        compare(settings.theme.themeId, applied, "the palette still matches what was reported")

        settings.destroy()
    }

    // ---- Font scale -------------------------------------------------------
    function test_fontScaleSliderBounds() {
        const settings = makeSettings({})

        compare(settings.minimumFontScale, 0.8)
        compare(settings.maximumFontScale, 1.5)
        compare(settings.fontScaleStep, 0.05)

        settings.destroy()
    }

    function test_setFontScaleRescalesTextAndControls() {
        const settings = makeSettings({})
        const theme = settings.theme

        const baseNormal = theme.fontNormal
        const baseControlHeight = theme.controlHeight

        const applied = settings.setFontScale(1.5)

        compare(applied, 1.5)
        compare(settings.fontScale, 1.5)
        compare(theme.fontScale, 1.5, "the Theme reports the new scale")
        compare(theme.fontNormal, Math.round(baseNormal / 1.0 * 1.5), "body text grew")
        compare(theme.controlHeight, Math.round(baseControlHeight * 1.5), "controls grew with the text")
        verify(theme.fontNormal > baseNormal, "sanity: text really got larger")

        settings.destroy()
    }

    function test_fontScaleLeavesLayoutRhythmAlone() {
        const settings = makeSettings({})
        const theme = settings.theme

        // Capture the unscaled values first.
        settings.setFontScale(1.0)
        const reference = ({})
        for (let i = 0; i < testCase.fixedTokens.length; i += 1)
            reference[testCase.fixedTokens[i]] = theme[testCase.fixedTokens[i]]

        settings.setFontScale(1.5)

        for (let i = 0; i < testCase.fixedTokens.length; i += 1) {
            const name = testCase.fixedTokens[i]
            compare(theme[name], reference[name], name + " must not scale")
        }

        settings.destroy()
    }

    function test_fontScaleIsClampedAndStepped() {
        const settings = makeSettings({})
        const theme = settings.theme

        compare(settings.setFontScale(9.0), 1.5, "above the ceiling clamps")
        compare(settings.setFontScale(0.1), 0.8, "below the floor clamps")
        compare(settings.setFontScale("1.22"), 1.2, "snaps to the nearest step")
        compare(settings.setFontScale("nonsense"), 1.0, "non-numeric falls back to 1.0")
        compare(settings.fontScale, 1.0)
        compare(theme.fontScale, 1.0, "the Theme ends up at the clamped value")

        settings.destroy()
    }

    // ---- Signals ----------------------------------------------------------
    function test_signalsFireOncePerChange() {
        const settings = makeSettings({})

        schemeSpy.target = settings
        schemeSpy.clear()
        scaleSpy.target = settings
        scaleSpy.clear()

        settings.applyTheme("light")
        compare(schemeSpy.count, 1, "schemeApplied fired once")
        compare(schemeSpy.signalArguments[0][0], "light", "…and carried the concrete scheme")

        settings.setFontScale(1.25)
        compare(scaleSpy.count, 1, "fontScaleApplied fired once")
        compare(scaleSpy.signalArguments[0][0], 1.25, "…and carried the clamped value")

        settings.destroy()
    }

    // ---- Hosted path ------------------------------------------------------
    function test_stubBridgeReceivesTheWrites() {
        const settings = makeSettings({})
        const stub = stubBridgeComponent.createObject(testCase, {})

        settings.bridgeOverride = stub
        compare(settings.bridge, stub, "the override is used as the bridge")

        settings.applyTheme("light")
        compare(stub.themeId, "light", "the scheme was written to the host")
        verify(stub.themeWrites >= 1, "the host observed a themeId write")

        settings.setFontScale(1.35)
        compare(stub.fontScale, 1.35, "the scale was written to the host")
        verify(stub.scaleWrites >= 1, "the host observed a fontScale write")

        // With a host attached the local fallbacks must stay untouched: the
        // bridge is the single source of truth for persisted state.
        compare(settings.theme.fallbackFontScale, 1.0, "fallback untouched while hosted")

        settings.bridgeOverride = null
        stub.destroy()
        settings.destroy()
    }

    // ---- Panel shell ------------------------------------------------------
    function test_panelExposesTheBuiltinTabs() {
        const panel = settingsPanelComponent.createObject(testCase, {})
        verify(panel !== null, "SettingsPanel could not be created")

        // Phase 2j turned the stacked sections into tabs; Phase 3 added Models.
        compare(panel.sections.length, 5)
        compare(panel.sections[0], "theme")
        compare(panel.sections[1], "language")
        compare(panel.sections[2], "models")
        compare(panel.sections[3], "plugins")
        compare(panel.sections[4], "about")

        verify(findChild(panel, "settingsSectionTheme") !== null, "Theme section is present")
        verify(findChild(panel, "settingsSectionLanguage") !== null, "Language section is present")
        verify(findChild(panel, "settingsSectionPlugins") !== null, "Plugins section is present")
        verify(findChild(panel, "settingsSectionAbout") !== null, "About section is present")
        verify(findChild(panel, "settingsTitle") !== null, "the panel has a title")

        panel.destroy()
    }

    function test_panelThemeSectionDrivesThePalette() {
        const panel = settingsPanelComponent.createObject(testCase, {})
        const controls = panel.themeSettings

        verify(controls !== null, "the panel exposes its ThemeSettings instance")

        controls.applyTheme("light")
        compare(panel.theme.themeId, "light", "the panel's own theme repainted")

        controls.setFontScale(1.4)
        compare(panel.theme.fontScale, 1.4)

        panel.destroy()
    }

    function test_panelCloseRequestedIsForwarded() {
        const panel = settingsPanelComponent.createObject(testCase, {})

        closeSpy.target = panel
        closeSpy.clear()

        const closeButton = findChild(panel, "settingsCloseButton")
        verify(closeButton !== null, "the panel has a close button")
        closeButton.clicked()

        compare(closeSpy.count, 1, "closeRequested fired")

        panel.destroy()
    }

    // ---- Spies ------------------------------------------------------------
    // Declared as real SignalSpy items and pointed at each subject at test time:
    // building one through Component.createObject() is needlessly fragile, and
    // assigning `target` later is the supported way to spy on a dynamic object.
    SignalSpy {
        id: schemeSpy

        signalName: "schemeApplied"
    }

    SignalSpy {
        id: scaleSpy

        signalName: "fontScaleApplied"
    }

    SignalSpy {
        id: closeSpy

        signalName: "closeRequested"
    }
}
