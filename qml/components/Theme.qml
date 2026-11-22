// Theme.qml — design tokens for the native Qt profile.
//
// Phase 1c keeps the palette deliberately small: one dark scheme that matches
// the DSH WebUI, expressed as a plain QML component so every consumer can hold a
// typed `property Theme theme: Theme {}`. Phase 2 (settings panel) turns these
// tokens into user-selectable light/dark schemes; keeping them in one file means
// that switch never has to touch a view.
//
// Colours are chosen for WCAG AA contrast against `background` / `surface`.
import QtQuick

QtObject {
    // ---- Surfaces ---------------------------------------------------------
    /** Window background. */
    readonly property color background: "#1b1c1f"
    /** Raised panels: composer, sidebar, cards. */
    readonly property color surface: "#24262b"
    /** Assistant / tool message bubbles. */
    readonly property color surfaceAlt: "#26272b"
    /** User message bubbles. */
    readonly property color surfaceAccent: "#2b3b57"
    /** Hairline separators. */
    readonly property color border: "#33363d"

    // ---- Text -------------------------------------------------------------
    readonly property color text: "#e6e6e6"
    readonly property color textMuted: "#8a8f98"
    readonly property color textInverse: "#12141a"

    // ---- Accents ----------------------------------------------------------
    readonly property color accent: "#4c8dff"
    readonly property color accentHover: "#6ba1ff"
    readonly property color danger: "#e5534b"
    readonly property color warning: "#d29922"
    readonly property color success: "#3fb950"

    // ---- Typography -------------------------------------------------------
    readonly property int fontSmall: 11
    readonly property int fontNormal: 13
    readonly property int fontLarge: 16
    readonly property int fontTitle: 20
    /** Preferred UI font family; falls back to the platform default. */
    readonly property string fontFamily: "Inter"

    // ---- Metrics ----------------------------------------------------------
    readonly property int spacing: 8
    readonly property int spacingLarge: 12
    readonly property int radius: 8
    readonly property int radiusLarge: 12
    readonly property int controlHeight: 32
    readonly property int composerHeight: 96
    readonly property int sidebarWidth: 240
    readonly property int headerHeight: 48

    // ---- Behaviour --------------------------------------------------------
    readonly property int animationDuration: 120
}
