// FormControl.qml — base for every generated settings control.
//
// One control draws one setting. The schema decided *what* the setting is; the
// descriptor handed over in `field` (see src/settings/forms.ts) decided how it
// looks. This base class owns the parts that are identical for all of them —
// label, description, the value/edit protocol — and leaves only the widget to
// the subclass.
//
// The protocol, stated once:
//
//   * `value` comes in from the form. A control reads it, and MUST re-read it,
//     because the same control instance is reused when the form refreshes.
//   * `valueEdited(value)` goes out when the *user* changes something. It is
//     never emitted for a programmatic `value` assignment, so a form cannot
//     mistake its own refresh for a user edit.
//
// Every subclass therefore binds its widget with a `Binding` guarded by the
// widget's own interaction state (`pressed`, `activeFocus`, `popup.visible`).
// A plain declarative binding would be destroyed the first time the user
// interacts, and the control would then silently stop following `value` — the
// exact bug class that bit the font-scale slider in t17.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../../components"

Item {
    id: root

    objectName: "formControl"

    /** Visual children of a subclass land in the control area. */
    default property alias content: controlArea.data

    /** Token source; the form injects its own instance. */
    property Theme theme: null

    /** Descriptor from src/settings/forms.ts. Never trusted blindly. */
    property var field: null

    /** Current value, as the form knows it. */
    property var value: (root.field !== null && root.field !== undefined) ? root.field.value : null

    /** False disables the widget without hiding the row. */
    property bool interactive: true

    /** Setting name; empty when `field` is absent. */
    readonly property string settingName: root.fieldText("name", "")

    /** Human label, never empty. */
    readonly property string label: root.fieldText("label", root.settingName)

    /** One-line explanation, or empty. */
    readonly property string description: root.fieldText("description", "")

    /** `ui.type` of the descriptor, or empty. */
    readonly property string uiType: root.fieldText("uiType", "")

    /** True when the setting only takes effect after a restart. */
    readonly property bool requiresRestart: root.fieldFlag("requiresRestart")

    /** Row spacing; falls back to a constant with no theme. */
    readonly property int rowSpacing: root.theme !== null ? root.theme.spacing : 8

    /** Emitted when the user changes the value. */
    signal valueEdited(var value)

    implicitWidth: 320
    implicitHeight: column.implicitHeight

    /** Read a string-ish descriptor field, with a fallback. */
    function fieldText(key, fallback) {
        if (root.field === null || root.field === undefined)
            return fallback
        var candidate = root.field[key]
        if (candidate === undefined || candidate === null)
            return fallback
        return String(candidate)
    }

    /** Read a numeric descriptor field, or `fallback` when absent/null. */
    function fieldNumber(key, fallback) {
        if (root.field === null || root.field === undefined)
            return fallback
        var candidate = root.field[key]
        if (typeof candidate !== "number" || isNaN(candidate))
            return fallback
        return candidate
    }

    /** Read a boolean descriptor field. */
    function fieldFlag(key) {
        if (root.field === null || root.field === undefined)
            return false
        return root.field[key] === true
    }

    /** `value` as display text: never "undefined". */
    function valueText() {
        if (root.value === null || root.value === undefined)
            return ""
        return String(root.value)
    }

    /** `value` as a finite number, or `fallback`. */
    function valueNumber(fallback) {
        if (typeof root.value === "number" && isFinite(root.value))
            return root.value
        var parsed = Number(root.value)
        return isFinite(parsed) ? parsed : fallback
    }

    ColumnLayout {
        id: column

        width: root.width
        spacing: root.rowSpacing

        Label {
            objectName: "formControlLabel"
            text: root.label
            visible: root.label.length > 0
            color: root.theme !== null ? root.theme.text : "#e6e6e6"
            font.pixelSize: root.theme !== null ? root.theme.fontNormal : 13
            font.bold: true
            wrapMode: Text.Wrap
            Layout.fillWidth: true
        }

        Label {
            objectName: "formControlDescription"
            text: root.description
            visible: root.description.length > 0
            color: root.theme !== null ? root.theme.textMuted : "#8a8f98"
            font.pixelSize: root.theme !== null ? root.theme.fontSmall : 11
            wrapMode: Text.Wrap
            Layout.fillWidth: true
        }

        ColumnLayout {
            id: controlArea

            objectName: "formControlArea"
            Layout.fillWidth: true
            spacing: root.rowSpacing / 2
        }

        Label {
            objectName: "formControlRestartHint"
            text: qsTr("Takes effect after restart")
            visible: root.requiresRestart
            color: root.theme !== null ? root.theme.warning : "#d29922"
            font.pixelSize: root.theme !== null ? root.theme.fontSmall : 11
            wrapMode: Text.Wrap
            Layout.fillWidth: true
        }
    }
}
