// Theme.qml — live design tokens for the native Qt profile.
//
// Phase 1c hardcoded a single dark palette here. Phase 2g turns the file into a
// thin, reactive façade over the C++ `ThemeBridge` (native/main.cpp), published
// to QML as `ctx.theme`:
//
//   ctx.theme.themeId    "dark" | "light"
//   ctx.theme.fontScale  0.8 … 1.5
//   ctx.theme.appearance "dark" | "light"  (derived, for styling decisions)
//
// Every token below is a *binding*, so swapping `ctx.theme.themeId` (or moving
// the font scale) repaints the whole UI in place — no restart, no re-instantiated
// views, no signal plumbing in the consumers. Components keep their
// `property Theme theme: Theme {}` contract, which is why the switch never has
// to touch a view.
//
// Two details that matter:
//   * `ctx` only exists when the native host runs (native/main.cpp installs it).
//     Under qmltestrunner, qmllint or a plain `qml` invocation the guard below
//     leaves `bridge` null and the dark palette plus scale 1.0 are used, so the
//     QML tests keep working without a host.
//   * Only the 27 tokens declared in Phase 1 stay `readonly property` — the
//     schema↔QML parity test in tests/theme.test.ts counts and kinds them. The
//     bridge/tokens plumbing therefore uses ordinary properties.
//
// Colours are chosen for WCAG AA contrast against `background` / `surface`; the
// palettes mirror src/theme/themes/{dark,light}.json one for one (that JSON is
// the canonical form the user edits, this file is what Qt can load without a
// resource-bundle change).
import QtQuick

QtObject {
    id: root

    /**
     * Live theme source, published by native/main.cpp.
     *
     * `typeof` guards an identifier that does not exist outside the native host;
     * a plain `ctx.theme` read would throw a ReferenceError there.
     */
    // qmllint cannot resolve a context property, so it flags the two reads below
    // as unqualified accesses; the `typeof` guard makes them safe by construction.
    // qmllint disable unqualified
    property QtObject bridge: (typeof ctx !== "undefined" && ctx.theme) ? ctx.theme : null
    // qmllint enable unqualified

    /** Active scheme id; falls back to the dark palette without a host. */
    property string themeId: root.bridge ? String(root.bridge.themeId) : root.fallbackThemeId

    /** Resolved scheme, "dark" | "light"; the palette actually in use. */
    readonly property string appearance: root.themeId === "light" ? "light" : "dark"

    /** User font scale, 0.8 … 1.5 (the bridge clamps; this mirrors it). */
    property real fontScale: root.bridge ? Number(root.bridge.fontScale) : root.fallbackFontScale

    /** Scheme used when no host is attached (tests, qmllint, bare `qml`). */
    property string fallbackThemeId: "dark"

    /**
     * Font scale used when no host is attached.
     *
     * Exists for the same reason as `fallbackThemeId`: a QML test has no
     * ThemeBridge, and it still has to be able to exercise scaling. When a host
     * is present this property is simply ignored.
     */
    property real fallbackFontScale: 1.0

    /** Dark palette — keep in sync with src/theme/themes/dark.json. */
    property var darkTokens: ({
        "background": "#1b1c1f",
        "surface": "#24262b",
        "surfaceAlt": "#26272b",
        "surfaceAccent": "#2b3b57",
        "border": "#33363d",
        "text": "#e6e6e6",
        "textMuted": "#8a8f98",
        "textInverse": "#12141a",
        "accent": "#4c8dff",
        "accentHover": "#6ba1ff",
        "danger": "#e5534b",
        "warning": "#d29922",
        "success": "#3fb950",
        "fontSmall": 11,
        "fontNormal": 13,
        "fontLarge": 16,
        "fontTitle": 20,
        "fontFamily": "Inter",
        "spacing": 8,
        "spacingLarge": 12,
        "radius": 8,
        "radiusLarge": 12,
        "controlHeight": 32,
        "composerHeight": 96,
        "sidebarWidth": 240,
        "headerHeight": 48,
        "animationDuration": 120
    })

    /** Light palette — keep in sync with src/theme/themes/light.json. */
    property var lightTokens: ({
        "background": "#f7f8fa",
        "surface": "#ffffff",
        "surfaceAlt": "#f1f2f5",
        "surfaceAccent": "#dbe8ff",
        "border": "#d8dbe2",
        "text": "#1b1c1f",
        "textMuted": "#5c626d",
        "textInverse": "#ffffff",
        "accent": "#2f6fd0",
        "accentHover": "#2559ad",
        "danger": "#c93c34",
        "warning": "#8a5d00",
        "success": "#1f7f36",
        "fontSmall": 11,
        "fontNormal": 13,
        "fontLarge": 16,
        "fontTitle": 20,
        "fontFamily": "Inter",
        "spacing": 8,
        "spacingLarge": 12,
        "radius": 8,
        "radiusLarge": 12,
        "controlHeight": 32,
        "composerHeight": 96,
        "sidebarWidth": 240,
        "headerHeight": 48,
        "animationDuration": 120
    })

    /**
     * Tokens for the active scheme.
     *
     * Reading `themeId` here is what makes every token below reactive: the
     * binding re-evaluates when the bridge notifies `themeChanged`.
     */
    property var tokens: root.themeId === "light" ? root.lightTokens : root.darkTokens

    // ---- Surfaces ---------------------------------------------------------
    /** Window background. */
    readonly property color background: root.tokens.background
    /** Raised panels: composer, sidebar, cards. */
    readonly property color surface: root.tokens.surface
    /** Assistant / tool message bubbles. */
    readonly property color surfaceAlt: root.tokens.surfaceAlt
    /** User message bubbles. */
    readonly property color surfaceAccent: root.tokens.surfaceAccent
    /** Hairline separators. */
    readonly property color border: root.tokens.border

    // ---- Text -------------------------------------------------------------
    readonly property color text: root.tokens.text
    readonly property color textMuted: root.tokens.textMuted
    readonly property color textInverse: root.tokens.textInverse

    // ---- Accents ----------------------------------------------------------
    readonly property color accent: root.tokens.accent
    readonly property color accentHover: root.tokens.accentHover
    readonly property color danger: root.tokens.danger
    readonly property color warning: root.tokens.warning
    readonly property color success: root.tokens.success

    // ---- Typography -------------------------------------------------------
    // Scaled by `fontScale`; rounding keeps pixel sizes integral so text stays
    // crisp and the QML↔schema parity test still sees `int` tokens.
    readonly property int fontSmall: Math.round(root.tokens.fontSmall * root.fontScale)
    readonly property int fontNormal: Math.round(root.tokens.fontNormal * root.fontScale)
    readonly property int fontLarge: Math.round(root.tokens.fontLarge * root.fontScale)
    readonly property int fontTitle: Math.round(root.tokens.fontTitle * root.fontScale)
    /** Preferred UI font family; falls back to the platform default. */
    readonly property string fontFamily: root.tokens.fontFamily

    // ---- Metrics ----------------------------------------------------------
    // Spacing and radii are deliberately *not* scaled: they are layout rhythm,
    // and scaling them makes the grid drift away from the 8 px baseline.
    readonly property int spacing: root.tokens.spacing
    readonly property int spacingLarge: root.tokens.spacingLarge
    readonly property int radius: root.tokens.radius
    readonly property int radiusLarge: root.tokens.radiusLarge
    // Controls grow with the text they contain, otherwise a 1.5 scale clips.
    readonly property int controlHeight: Math.round(root.tokens.controlHeight * root.fontScale)
    readonly property int composerHeight: Math.round(root.tokens.composerHeight * root.fontScale)
    readonly property int sidebarWidth: root.tokens.sidebarWidth
    readonly property int headerHeight: Math.round(root.tokens.headerHeight * root.fontScale)

    // ---- Behaviour --------------------------------------------------------
    readonly property int animationDuration: root.tokens.animationDuration
}
