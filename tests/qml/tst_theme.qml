// tst_theme.qml — theme switching and font scaling at the QML boundary.
//
// These tests deliberately run *without* a native host: `ctx` does not exist
// under qmltestrunner, so components/Theme.qml falls back to its bundled
// palettes. That is exactly the path a bare `qml` invocation and the qmllint job
// take, and it is the only way to test the token maths on CI without spinning up
// ThemeBridge.
//
// What is covered:
//   * the dark palette is the default and matches Phase 1 token for token
//   * flipping the scheme repaints every colour token (light is not a no-op)
//   * the font scale multiplies text and control metrics, and leaves the layout
//     rhythm (spacing, radii, sidebar width) alone — the same rule
//     scaleTheme() applies on the TypeScript side
//   * token kinds stay stable across schemes, so bindings cannot silently
//     degrade to undefined
import QtQuick
import QtTest
import "../../qml/components" as Components

TestCase {
    id: testCase
    name: "Theme"
    when: windowShown

    // Colour tokens: these must differ between dark and light.
    readonly property var colourTokens: [
        "background", "surface", "surfaceAlt", "surfaceAccent", "border",
        "text", "textMuted", "textInverse", "accent", "accentHover",
        "danger", "warning", "success"
    ]

    // Metrics that must NOT move with the font scale.
    readonly property var fixedMetrics: ["spacing", "spacingLarge", "radius", "radiusLarge", "sidebarWidth", "animationDuration"]

    // Declared rather than built with Qt.createQmlObject(): relative imports
    // inside a QML string are resolved against the calling file, which is easy
    // to get wrong, whereas this Component uses the same import as the file.
    Component {
        id: themeComponent
        Components.Theme {}
    }

    function makeTheme(props) {
        const theme = themeComponent.createObject(testCase)
        verify(theme !== null, "Theme component failed to instantiate")
        for (const key in props)
            theme[key] = props[key]
        return theme
    }

    function destroyTheme(theme) {
        if (theme)
            theme.destroy()
    }

    function test_darkIsTheDefault() {
        const theme = makeTheme({})
        compare(theme.themeId, "dark")
        compare(theme.fontScale, 1.0)
        compare(theme.appearance, "dark")
        compare(theme.background.toString(), "#1b1c1f")
        compare(theme.surface.toString(), "#24262b")
        compare(theme.surfaceAccent.toString(), "#2b3b57")
        compare(theme.text.toString(), "#e6e6e6")
        compare(theme.textMuted.toString(), "#8a8f98")
        compare(theme.accent.toString(), "#4c8dff")
        compare(theme.danger.toString(), "#e5534b")
        compare(theme.success.toString(), "#3fb950")
        compare(theme.spacing, 8)
        compare(theme.radius, 8)
        compare(theme.controlHeight, 32)
        compare(theme.sidebarWidth, 240)
        compare(theme.fontFamily, "Inter")
        destroyTheme(theme)
    }

    // The whole point of the refactor: one property change repaints the UI.
    function test_switchingToLightRepaintsColours() {
        const theme = makeTheme({})
        const darkBackground = theme.background.toString()

        theme.fallbackThemeId = "light"

        compare(theme.themeId, "light")
        compare(theme.appearance, "light")
        compare(theme.background.toString(), "#f7f8fa")
        compare(theme.surface.toString(), "#ffffff")
        compare(theme.text.toString(), "#1b1c1f")
        compare(theme.textInverse.toString(), "#ffffff")
        compare(theme.accent.toString(), "#2f6fd0")
        verify(theme.background.toString() !== darkBackground, "background must change with the scheme")
        destroyTheme(theme)
    }

    // A token that forgot its binding would keep the dark value and read as a
    // black-on-black surface in light mode; this catches that.
    function test_everyColourTokenChangesBetweenSchemes() {
        const theme = makeTheme({})
        const dark = {}
        for (let i = 0; i < colourTokens.length; i++)
            dark[colourTokens[i]] = theme[colourTokens[i]].toString()

        theme.fallbackThemeId = "light"

        for (let i = 0; i < colourTokens.length; i++) {
            const name = colourTokens[i]
            const light = theme[name].toString()
            verify(light !== dark[name],
                   "colour token " + name + " did not change between dark (" + dark[name] + ") and light (" + light + ")")
        }
        destroyTheme(theme)
    }

    function test_fontScaleGrowsTextAndControls() {
        const theme = makeTheme({})
        theme.fallbackFontScale = 1.5

        compare(theme.fontScale, 1.5)
        // 13 * 1.5 = 19.5 -> 20, 16 * 1.5 = 24, 20 * 1.5 = 30, 11 * 1.5 = 16.5 -> 17
        compare(theme.fontNormal, 20)
        compare(theme.fontLarge, 24)
        compare(theme.fontTitle, 30)
        compare(theme.fontSmall, 17)
        // Controls grow with their text so nothing clips.
        compare(theme.controlHeight, 48)
        compare(theme.composerHeight, 144)
        compare(theme.headerHeight, 72)
        destroyTheme(theme)
    }

    function test_fontScaleShrinksTextAtTheLowerBound() {
        const theme = makeTheme({})
        theme.fallbackFontScale = 0.8

        compare(theme.fontScale, 0.8)
        compare(theme.fontNormal, 10)   // 10.4
        compare(theme.fontSmall, 9)     // 8.8
        compare(theme.fontLarge, 13)    // 12.8
        compare(theme.fontTitle, 16)    // 16.0
        compare(theme.controlHeight, 26) // 25.6
        destroyTheme(theme)
    }

    // Layout rhythm is scale-invariant on purpose (see scaleTheme() in
    // src/theme/manager.ts): scaling the 8 px baseline drifts the whole grid.
    function test_layoutRhythmIsNotScaled() {
        const theme = makeTheme({})
        const before = {}
        for (let i = 0; i < fixedMetrics.length; i++)
            before[fixedMetrics[i]] = theme[fixedMetrics[i]]

        theme.fallbackFontScale = 1.5

        for (let i = 0; i < fixedMetrics.length; i++) {
            const name = fixedMetrics[i]
            compare(theme[name], before[name], name + " must not follow the font scale")
        }
        destroyTheme(theme)
    }

    // Guards against a token silently becoming undefined (a typo in `tokens`
    // would surface as an invisible control rather than a test failure).
    function test_tokenKindsAreStableAcrossSchemes() {
        const theme = makeTheme({})

        for (const scheme of ["dark", "light"]) {
            theme.fallbackThemeId = scheme
            for (let i = 0; i < colourTokens.length; i++) {
                const value = theme[colourTokens[i]]
                verify(value !== undefined && value !== null,
                       colourTokens[i] + " is undefined in " + scheme)
                compare(typeof value.toString(), "string")
                verify(/^#[0-9a-fA-F]{6,8}$/.test(value.toString()),
                       colourTokens[i] + " in " + scheme + " is not a hex colour: " + value)
            }
            verify(theme.fontNormal > 0, "fontNormal must be positive in " + scheme)
            verify(theme.sidebarWidth > 0, "sidebarWidth must be positive in " + scheme)
        }
        destroyTheme(theme)
    }

    // Returning to the original scheme must restore the original colours exactly
    // (no accumulated state from the intermediate scale/theme changes).
    function test_roundTripRestoresTheOriginalPalette() {
        const theme = makeTheme({})
        const darkBackground = theme.background.toString()
        const darkFont = theme.fontNormal

        theme.fallbackThemeId = "light"
        theme.fallbackFontScale = 1.3
        theme.fallbackThemeId = "dark"
        theme.fallbackFontScale = 1.0

        compare(theme.background.toString(), darkBackground)
        compare(theme.fontNormal, darkFont)
        destroyTheme(theme)
    }
}
