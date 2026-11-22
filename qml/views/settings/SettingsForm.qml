// SettingsForm.qml — the generator: schema in, controls out.
//
// This is the whole point of the settings work: a plugin that declares its
// preferences as schema entries gets a working form without writing QML. Three
// input modes, in priority order:
//
//   1. `fields`  — descriptors, already flattened by src/settings/forms.ts.
//      This is what the bridge hands over, and what tests use.
//   2. `schema`  — raw `SettingsSchema` entries. Flattened here by
//      `describeEntry()`, which mirrors forms.ts closely enough to render, and
//      is only used when nothing has flattened them already.
//   3. `settings` — a bridge with `fields(section)`; the last resort, and what a
//      plugin-hosted form normally relies on.
//
// Two behaviours worth stating:
//
//   * A value edit is *reported*, never assumed. `valueEdited(name, value)` fires
//     for the form's owner; `applied(name, value, accepted)` additionally says
//     whether a settings bridge took the write. A refused write still updates
//     the form's local view, so the user sees what they typed, and the owner can
//     surface the refusal.
//   * An unknown `ui.type` renders a plain text control rather than nothing.
//     A plugin with a typo gets an editable row, not an invisible setting — the
//     same principle as an unknown markdown node degrading to a paragraph.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../../components"

ColumnLayout {
    id: root

    objectName: "settingsForm"

    /** Token source; a parent injects its own Theme instance. */
    property Theme theme: null

    /** Descriptors from src/settings/forms.ts, highest priority. */
    property var fields: []

    /** Raw schema entries; used only when `fields` is empty. */
    property var schema: []

    /** Optional settings bridge (`get`/`set`/`fields`). */
    property var settings: null

    /** Optional section filter applied to `fields` and `settings.fields()`. */
    property string section: ""

    /**
     * Values edited in this form, by setting name.
     *
     * Kept so a form without a bridge still behaves sensibly: the control shows
     * what the user chose, even though nobody has persisted it.
     */
    property var localValues: ({})

    /** Emitted for every user edit. */
    signal valueEdited(string name, var value)

    /** Emitted after `valueEdited`, with the bridge's verdict. */
    signal applied(string name, var value, bool accepted)

    spacing: root.theme !== null ? root.theme.spacingLarge : 12

    /** True when there is at least one control to draw. */
    readonly property int fieldCount: root.resolvedFields.length

    /** The descriptors this form will render, with local edits applied. */
    readonly property var resolvedFields: root.buildFields()

    /** Humanised label; keeps the QML side from duplicating forms.ts exactly. */
    function humanise(name) {
        if (typeof name !== "string" || name.length === 0)
            return ""
        var spaced = name.replace(/[._-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        if (spaced.length === 0)
            return name
        var lower = spaced.toLowerCase()
        return lower.charAt(0).toUpperCase() + lower.slice(1)
    }

    /** Turn one raw schema entry into a descriptor-shaped object. */
    function describeEntry(entry) {
        if (entry === null || entry === undefined || typeof entry !== "object")
            return null
        var ui = (entry.ui !== null && entry.ui !== undefined && typeof entry.ui === "object") ? entry.ui : {}
        var options = []
        if (entry.options !== null && entry.options !== undefined && entry.options.length !== undefined) {
            for (var index = 0; index < entry.options.length; ++index) {
                var option = entry.options[index]
                if (option === null || option === undefined)
                    continue
                options.push({
                    "value": option.value,
                    "label": option.label !== undefined ? String(option.label) : String(option.value),
                    "description": option.description !== undefined ? String(option.description) : ""
                })
            }
        }
        return {
            "name": String(entry.name),
            "label": ui.label !== undefined ? String(ui.label) : root.humanise(String(entry.name)),
            "description": entry.description !== undefined ? String(entry.description) : "",
            "section": entry.section !== undefined ? String(entry.section) : "",
            "valueType": entry.type !== undefined ? String(entry.type) : "string",
            "uiType": ui.type !== undefined ? String(ui.type) : "text",
            "value": entry.default,
            "defaultValue": entry.default,
            "options": options,
            "placeholder": ui.placeholder !== undefined ? String(ui.placeholder) : "",
            "unit": ui.unit !== undefined ? String(ui.unit) : "",
            "minimum": (typeof entry.minimum === "number") ? entry.minimum : null,
            "maximum": (typeof entry.maximum === "number") ? entry.maximum : null,
            "step": (typeof entry.step === "number") ? entry.step : null,
            "minLength": (typeof entry.minLength === "number") ? entry.minLength : null,
            "maxLength": (typeof entry.maxLength === "number") ? entry.maxLength : null,
            "requiresRestart": entry.requiresRestart === true,
            "transient": entry.transient === true,
            "order": (typeof ui.order === "number") ? ui.order : 0
        }
    }

    /** Copy a descriptor with one field replaced (descriptors are read-only in TS). */
    function withValue(field, value) {
        var copy = {}
        for (var key in field)
            copy[key] = field[key]
        copy.value = value
        return copy
    }

    /** Build the render list from the best available source. */
    function buildFields() {
        var source = []
        if (root.fields !== null && root.fields !== undefined && root.fields.length !== undefined
                && root.fields.length > 0) {
            for (var first = 0; first < root.fields.length; ++first)
                source.push(root.fields[first])
        } else if (root.schema !== null && root.schema !== undefined && root.schema.length !== undefined
                && root.schema.length > 0) {
            for (var second = 0; second < root.schema.length; ++second) {
                var described = root.describeEntry(root.schema[second])
                if (described !== null)
                    source.push(described)
            }
        } else if (root.settings !== null && root.settings !== undefined
                && typeof root.settings.fields === "function") {
            var fromBridge = root.section.length > 0
                ? root.settings.fields(root.section)
                : root.settings.fields()
            if (fromBridge !== null && fromBridge !== undefined && fromBridge.length !== undefined) {
                for (var third = 0; third < fromBridge.length; ++third)
                    source.push(fromBridge[third])
            }
        }

        var result = []
        for (var index = 0; index < source.length; ++index) {
            var field = source[index]
            if (field === null || field === undefined)
                continue
            if (root.section.length > 0 && field.section !== undefined && field.section !== null
                    && String(field.section) !== root.section)
                continue
            var edited = root.localValues[field.name]
            result.push(edited === undefined ? field : root.withValue(field, edited))
        }
        return result
    }

    /** Record a user edit, persist it when possible, and report it. */
    function applyValue(name, value) {
        var accepted = false
        var hasBridge = root.settings !== null && root.settings !== undefined
            && typeof root.settings.set === "function"
        if (hasBridge)
            accepted = root.settings.set(name, value) === true

        var next = {}
        for (var key in root.localValues)
            next[key] = root.localValues[key]
        next[name] = value
        root.localValues = next

        root.valueEdited(name, value)
        root.applied(name, value, accepted)
    }

    /** The control for one descriptor; unknown kinds fall back to text. */
    function componentFor(field) {
        if (field === null || field === undefined)
            return textControl
        var kind = String(field.uiType)
        if (kind === "toggle")
            return toggleControl
        if (kind === "select")
            return selectControl
        if (kind === "slider")
            return sliderControl
        if (kind === "number")
            return numberControl
        if (kind === "color")
            return colorControl
        return textControl
    }

    Repeater {
        model: root.resolvedFields

        delegate: Loader {
            id: controlLoader

            required property var modelData
            required property int index

            objectName: "settingsFormControl" + controlLoader.index
            Layout.fillWidth: true
            sourceComponent: root.componentFor(controlLoader.modelData)

            onLoaded: {
                controlLoader.item.field = controlLoader.modelData
                controlLoader.item.theme = root.theme
                controlLoader.item.interactive = true
            }
        }
    }

    Label {
        objectName: "settingsFormEmpty"
        visible: root.fieldCount === 0
        text: qsTr("This section has no settings yet.")
        color: root.theme !== null ? root.theme.textMuted : "#8a8f98"
        font.pixelSize: root.theme !== null ? root.theme.fontSmall : 11
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }

    Component {
        id: toggleControl
        FormControlCheckBox {
            onValueEdited: function (value) {
                root.applyValue(settingName, value)
            }
        }
    }

    Component {
        id: selectControl
        FormControlSelect {
            onValueEdited: function (value) {
                root.applyValue(settingName, value)
            }
        }
    }

    Component {
        id: sliderControl
        FormControlSlider {
            onValueEdited: function (value) {
                root.applyValue(settingName, value)
            }
        }
    }

    Component {
        id: numberControl
        FormControlNumber {
            onValueEdited: function (value) {
                root.applyValue(settingName, value)
            }
        }
    }

    Component {
        id: colorControl
        FormControlColorPicker {
            onValueEdited: function (value) {
                root.applyValue(settingName, value)
            }
        }
    }

    Component {
        id: textControl
        FormControlTextInput {
            onValueEdited: function (value) {
                root.applyValue(settingName, value)
            }
        }
    }
}
