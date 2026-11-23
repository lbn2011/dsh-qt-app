// LanguageForm.qml — the built-in interface-language form.
//
// Language is a real setting (`language`, one option today) with
// `requiresRestart: true`, so this form is also the one place the restart hint
// is exercised: the generated control shows "Takes effect after restart" from
// the descriptor, not from anything declared here.
import QtQuick
import QtQuick.Layouts
import "../../components"

SettingsForm {
    id: root

    objectName: "languageForm"

    /** Settings bridge (`fields`/`get`/`set`), or null. */
    property var settingsBridge: null

    /** Section this form draws. */
    readonly property string formSection: "editor"

    /** Descriptors used when no bridge is available. */
    property var fallbackFields: [
        {
            "name": "language",
            "label": "Interface language",
            "description": "More translations arrive once the message catalogue is extracted.",
            "section": "editor",
            "valueType": "string",
            "uiType": "select",
            "value": "en",
            "defaultValue": "en",
            "options": [
                { "value": "en", "label": "English", "description": "" }
            ],
            "placeholder": "",
            "unit": "",
            "minimum": null,
            "maximum": null,
            "step": null,
            "minLength": null,
            "maxLength": null,
            "requiresRestart": true,
            "transient": false,
            "order": 0
        }
    ]

    // The owner injects theme explicitly; SettingsForm supports a null theme.
    settings: root.settingsBridge
    fields: (root.settingsBridge !== null && root.settingsBridge !== undefined
        && typeof root.settingsBridge.fields === "function")
        ? root.settingsBridge.fields(root.formSection)
        : root.fallbackFields
}
