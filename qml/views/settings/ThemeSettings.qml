// ThemeSettings.qml — scheme and font-scale controls for the settings pane.
//
// Phase 2h. The live switching machinery already exists: native/main.cpp owns a
// `ThemeBridge` published as `ctx.theme`, and components/Theme.qml turns its
// `themeId` / `fontScale` into token bindings, so *writing* one of those two
// properties repaints the whole window in place. This file is therefore only a
// control surface plus one piece of policy:
//
//   * three modes — Auto / Dark / Light. Auto resolves the platform colour
//     scheme through `Qt.styleHints.colorScheme` (Qt 6.5+) and falls back to the
//     dark palette on runtimes or platforms that do not report one.
//   * the font scale slider, clamped to the bridge's own 0.8 … 1.5 window so the
//     UI can never ask for a value the host would silently rewrite.
//
// Two details worth knowing before editing:
//
//   * There is no `ctx.theme.applyTheme()` on the C++ side — the bridge exposes
//     `themeId` (writable), `fontScale` (writable), `toggle()` and `reload()`.
//     `applyTheme()` below is the QML-side entry point the task asks for; it
//     writes the bridge property, which is what actually persists the choice
//     (the bridge saves theme.json on every change).
//   * Under qmltestrunner / qmllint / a bare `qml` run there is no host, so
//     `bridge` is null. In that case the same functions write the fallback
//     properties on the `Theme` instance instead, which keeps the panel
//     testable *and* still exercises the real repaint path, because Theme.qml
//     reads those fallbacks when no bridge is attached.
pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../../components"

Item {
    id: root

    objectName: "themeSettings"

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

    /**
     * Test/preview seam: use this object instead of `ctx.theme`.
     *
     * Lets a QML test hand in a stub exposing `themeId` / `fontScale` and assert
     * that the controls write to the host rather than to the local fallbacks.
     */
    property QtObject bridgeOverride: null

    /** The bridge actually in use, or null when running without a host. */
    readonly property var bridge: root.bridgeOverride !== null ? root.bridgeOverride : root.themeBridge

    /** Token source. Follows the live palette through the bridge. */
    property Theme theme: Theme { bridge: root.bridge }

    // ---- Selection state ---------------------------------------------------
    /** Modes offered by the segmented control, in display order. */
    readonly property var modes: ["auto", "dark", "light"]

    /**
     * User-visible mode: "auto", "dark" or "light".
     *
     * Kept separate from `effectiveScheme` because "auto" is a policy, not a
     * palette: the bridge only ever stores a concrete "dark" / "light" id.
     */
    property string mode: "auto"

    /** Concrete scheme the UI is currently painted with. */
    readonly property string effectiveScheme: root.resolveScheme(root.mode)

    /** True while the mode defers to the platform. */
    readonly property bool followingSystem: root.mode === "auto"

    // ---- Font scale --------------------------------------------------------
    /** Lower bound, mirroring kMinFontScale in native/main.cpp. */
    readonly property real minimumFontScale: 0.8
    /** Upper bound, mirroring kMaxFontScale in native/main.cpp. */
    readonly property real maximumFontScale: 1.5
    /** Slider granularity — 5 % steps are distinguishable by eye. */
    readonly property real fontScaleStep: 0.05

    /**
     * Active font scale.
     *
     * Reads the bridge when one exists, otherwise the Theme fallback, so the
     * slider shows the truth in both the hosted and the host-less case.
     */
    property real fontScale: root.bridge !== null
                              ? Number(root.bridge.fontScale)
                              : Number(root.theme.fallbackFontScale)

    /** Percentage for the value read-out, e.g. "125 %". */
    readonly property string fontScaleLabel: Math.round(root.fontScale * 100) + " %"

    // ---- Signals -----------------------------------------------------------
    /** Emitted after a mode was applied; carries the concrete scheme id. */
    signal schemeApplied(string scheme)
    /** Emitted after the font scale was applied; carries the clamped value. */
    signal fontScaleApplied(real scale)
    /** Emitted once per user interaction that changed anything. */
    signal settingsChanged(string scheme, real scale)

    // ---- Scheme policy -----------------------------------------------------
    /**
     * Platform colour scheme, or "dark" when the runtime cannot tell.
     *
     * `Qt.styleHints.colorScheme` exists since Qt 6.5 and returns a
     * `Qt.ColorScheme` value (Light = 1, Dark = 2, Unknown = 0). Everything is
     * guarded because the offscreen test platform and older runtimes report
     * Unknown, and a bare `qml` invocation may not have the singleton at all.
     */
    function systemScheme() {
        // Qt exposes styleHints as QObject in its tooling metadata; the
        // runtime colorScheme property is guarded below (available since 6.5).
        // qmllint disable unqualified missing-property
        const hints = Qt.styleHints
        if (hints !== undefined && hints.colorScheme !== undefined) {
            const reported = hints.colorScheme
            if (reported === 1) // Qt.ColorScheme.Light
                return "light"
            if (reported === 2) // Qt.ColorScheme.Dark
                return "dark"
        }
        // qmllint enable unqualified missing-property
        return "dark"
    }

    /** Map a mode onto the concrete scheme id to paint with. */
    function resolveScheme(value) {
        const name = String(value === undefined || value === null ? "" : value).toLowerCase()
        if (name === "light" || name === "dark")
            return name
        return root.systemScheme()
    }

    /** True when `value` is one of the three modes this panel offers. */
    function isMode(value) {
        const name = String(value === undefined || value === null ? "" : value).toLowerCase()
        return root.modes.indexOf(name) !== -1
    }

    // ---- Mutators ----------------------------------------------------------
    /**
     * Select a mode and paint with it.
     *
     * Accepts the three modes *and* the two concrete ids, so a caller holding
     * only "light" (the persisted value) can drive this control directly.
     * Returns the concrete scheme that was applied.
     */
    function applyTheme(value) {
        const requested = String(value === undefined || value === null ? "" : value).toLowerCase()
        const mode = root.isMode(requested) ? requested : root.resolveScheme(requested)
        const scheme = root.resolveScheme(mode)

        root.mode = mode
        if (root.bridge !== null) {
            // The bridge persists this to theme.json and emits themeChanged.
            root.bridge.themeId = scheme
        } else {
            // No host: drive the Theme fallback so the tree repaints anyway.
            root.theme.fallbackThemeId = scheme
        }

        root.schemeApplied(scheme)
        root.settingsChanged(root.mode, root.fontScale)
        return scheme
    }

    /** Clamp a font scale into the bridge's window, snapping to the step. */
    function clampFontScale(value) {
        const numeric = Number(value)
        if (!isFinite(numeric))
            return 1.0
        const stepped = Math.round(numeric / root.fontScaleStep) * root.fontScaleStep
        const clamped = Math.min(root.maximumFontScale, Math.max(root.minimumFontScale, stepped))
        // Kill binary float dust so 1.05 stays 1.05 and not 1.0499999999999998.
        return Math.round(clamped * 100) / 100
    }

    /**
     * Apply a font scale.
     *
     * Returns the value actually in force after clamping, so a caller (or a
     * slider) can snap its own handle to the truth.
     */
    function setFontScale(value) {
        const scale = root.clampFontScale(value)
        if (root.bridge !== null) {
            root.bridge.fontScale = scale
        } else {
            root.theme.fallbackFontScale = scale
        }
        root.fontScaleApplied(scale)
        root.settingsChanged(root.mode, scale)
        return scale
    }

    /** Apply both at once — used when the panel is opened from a saved state. */
    function applySettings(modeValue, scaleValue) {
        const scheme = root.applyTheme(modeValue)
        const scale = root.setFontScale(scaleValue)
        return { "scheme": scheme, "fontScale": scale }
    }

    /** Re-read the host state (e.g. after an external `reload()`). */
    function refresh() {
        if (root.bridge !== null) {
            root.fontScale = Number(root.bridge.fontScale)
            const current = String(root.bridge.themeId).toLowerCase()
            root.mode = root.mode === "auto" ? "auto" : root.resolveScheme(current)
        } else {
            root.fontScale = Number(root.theme.fallbackFontScale)
        }
        return root.effectiveScheme
    }

    // ---- Layout ------------------------------------------------------------
    implicitWidth: 320
    implicitHeight: layout.implicitHeight

    ColumnLayout {
        id: layout
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: root.theme.spacing

        // -- Scheme ----------------------------------------------------------
        Label {
            objectName: "themeModeLabel"
            text: qsTr("Appearance")
            color: root.theme.text
            font.pixelSize: root.theme.fontNormal
            font.bold: true
            Layout.fillWidth: true
        }

        Label {
            objectName: "themeModeHint"
            text: root.followingSystem
                  ? qsTr("Following the system colour scheme (%1).").arg(root.effectiveScheme)
                  : qsTr("Always %1.").arg(root.effectiveScheme)
            color: root.theme.textMuted
            font.pixelSize: root.theme.fontSmall
            wrapMode: Text.Wrap
            Layout.fillWidth: true
        }

        RowLayout {
            id: modeRow

            objectName: "themeModeRow"
            spacing: root.theme.spacing / 2
            Layout.fillWidth: true

            ButtonGroup {
                id: modeGroup
                exclusive: true
            }

            Repeater {
                model: root.modes

                delegate: Button {
                    id: modeButton

                    required property string modelData

                    objectName: "themeMode" + modelData.charAt(0).toUpperCase() + modelData.slice(1)
                    text: modeButton.modelData.charAt(0).toUpperCase() + modeButton.modelData.slice(1)
                    checkable: true
                    checked: root.mode === modeButton.modelData
                    ButtonGroup.group: modeGroup
                    Layout.fillWidth: true
                    implicitHeight: root.theme.controlHeight

                    palette.button: checked ? root.theme.accent : root.theme.surfaceAlt
                    palette.buttonText: checked ? root.theme.textInverse : root.theme.text
                    palette.highlight: root.theme.accent
                    palette.highlightedText: root.theme.textInverse

                    onClicked: root.applyTheme(modeButton.modelData)
                }
            }
        }

        // -- Font scale ------------------------------------------------------
        Item { Layout.preferredHeight: root.theme.spacing / 2 }

        RowLayout {
            Layout.fillWidth: true
            spacing: root.theme.spacing

            Label {
                objectName: "fontScaleLabel"
                text: qsTr("Font scale")
                color: root.theme.text
                font.pixelSize: root.theme.fontNormal
                font.bold: true
                Layout.fillWidth: true
            }

            Label {
                objectName: "fontScaleValue"
                text: root.fontScaleLabel
                color: root.theme.textMuted
                font.pixelSize: root.theme.fontSmall
                horizontalAlignment: Text.AlignRight
            }
        }

        Slider {
            id: fontScaleSlider

            objectName: "fontScaleSlider"
            from: root.minimumFontScale
            to: root.maximumFontScale
            stepSize: root.fontScaleStep
            Layout.fillWidth: true

            /**
             * Re-sync the handle with the outside world.
             *
             * A plain `value: root.fontScale` binding dies the first time the
             * user drags (the drag assigns the property imperatively), so an
             * external change — the Ctrl+Shift+T shortcut, `reload()` picking up
             * an edited theme.json, a system palette switch under Auto — would
             * silently leave the handle behind. A Binding with restoreMode
             * re-establishes itself after each drag and is suspended *while* the
             * user is dragging so the two never fight.
             */
            Binding {
                target: fontScaleSlider
                property: "value"
                value: root.fontScale
                when: !fontScaleSlider.pressed
                restoreMode: Binding.RestoreBindingOrValue
            }

            onMoved: root.setFontScale(value)
        }

        Label {
            objectName: "fontScaleRangeLabel"
            text: qsTr("Smaller") + " · " + root.minimumFontScale.toFixed(2)
                  + " – " + root.maximumFontScale.toFixed(2) + " · " + qsTr("Larger")
            color: root.theme.textMuted
            font.pixelSize: root.theme.fontSmall
            Layout.fillWidth: true
        }

        // -- Live preview ----------------------------------------------------
        Item { Layout.preferredHeight: root.theme.spacing / 2 }

        Rectangle {
            objectName: "themePreview"

            Layout.fillWidth: true
            implicitHeight: previewColumn.implicitHeight + root.theme.spacing * 2
            color: root.theme.surface
            border.width: 1
            border.color: root.theme.border
            radius: root.theme.radius

            ColumnLayout {
                id: previewColumn
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.margins: root.theme.spacing
                spacing: root.theme.spacing / 2

                Label {
                    objectName: "themePreviewText"
                    text: qsTr("The quick brown fox")
                    color: root.theme.text
                    font.family: root.theme.fontFamily
                    font.pixelSize: root.theme.fontNormal
                    Layout.fillWidth: true
                }

                Label {
                    objectName: "themePreviewMuted"
                    text: qsTr("Muted text at %1").arg(root.effectiveScheme)
                    color: root.theme.textMuted
                    font.pixelSize: root.theme.fontSmall
                    Layout.fillWidth: true
                }
            }
        }
    }
}
