// ThemeForm.qml — the built-in `appearance` form, generated from the catalogue.
//
// A worked example of what SettingsForm buys: this file declares no controls at
// all. It names the section and hands over the descriptors, and the generator
// draws a select for the theme and a slider for the font scale — including the
// bounds and the step, which come from src/settings/schema.ts rather than being
// restated here.
//
// `fallbackFields` exists so the form is renderable with no bridge at all (a
// QML test, a preview). It deliberately mirrors the catalogue's theme/fontSize
// entries; tests/settings-forms.test.ts checks every name here against
// BUILTIN_SETTINGS so the two cannot drift.
import QtQuick
import QtQuick.Layouts
import "../../components"

SettingsForm {
    id: root

    objectName: "themeForm"

    /** Settings bridge (`fields`/`get`/`set`), or null. */
    property var settingsBridge: null

    /** Section this form draws. */
    readonly property string formSection: "appearance"

    /** Descriptors used when no bridge is available. */
    property var fallbackFields: [
        {
            "name": "theme",
            "label": "Theme",
            "description": "Follow the system appearance, or force a scheme.",
            "section": "appearance",
            "valueType": "string",
            "uiType": "select",
            "value": "auto",
            "defaultValue": "auto",
            "options": [
                { "value": "auto", "label": "Auto", "description": "" },
                { "value": "dark", "label": "Dark", "description": "" },
                { "value": "light", "label": "Light", "description": "" }
            ],
            "placeholder": "",
            "unit": "",
            "minimum": null,
            "maximum": null,
            "step": null,
            "minLength": null,
            "maxLength": null,
            "requiresRestart": false,
            "transient": false,
            "order": 0
        },
        {
            "name": "fontSize",
            "label": "Font scale",
            "description": "Scales text and control heights across the window.",
            "section": "appearance",
            "valueType": "number",
            "uiType": "slider",
            "value": 1,
            "defaultValue": 1,
            "options": [],
            "placeholder": "",
            "unit": "",
            "minimum": 0.8,
            "maximum": 1.5,
            "step": 0.05,
            "minLength": null,
            "maxLength": null,
            "requiresRestart": false,
            "transient": false,
            "order": 10
        }
    ]

    // The owner injects theme explicitly; SettingsForm supports a null theme.
    settings: root.settingsBridge
    fields: (root.settingsBridge !== null && root.settingsBridge !== undefined
        && typeof root.settingsBridge.fields === "function")
        ? root.settingsBridge.fields(root.formSection)
        : root.fallbackFields
}
