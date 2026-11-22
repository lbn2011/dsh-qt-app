// MessagesForm.qml — the built-in conversation-display form.
//
// Two toggles: `hideSystemMessages` and `showTimestamps`. The acceptance text
// names `HideSystemMessages`; it is one row here rather than a form of its own
// because a one-row form is a worse UI than a two-row one, and the generated
// control is identical either way.
import QtQuick
import QtQuick.Layouts
import "../../components"

SettingsForm {
    id: root

    objectName: "messagesForm"

    /** Settings bridge (`fields`/`get`/`set`), or null. */
    property var settingsBridge: null

    /** Section this form draws. */
    readonly property string formSection: "messages"

    /** Descriptors used when no bridge is available. */
    property var fallbackFields: [
        {
            "name": "hideSystemMessages",
            "label": "Hide system messages",
            "description": "Keep notices about reconnects and model switches out of the transcript.",
            "section": "messages",
            "valueType": "boolean",
            "uiType": "toggle",
            "value": false,
            "defaultValue": false,
            "options": [],
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
            "name": "showTimestamps",
            "label": "Show timestamps",
            "description": "Print the time beside each message.",
            "section": "messages",
            "valueType": "boolean",
            "uiType": "toggle",
            "value": false,
            "defaultValue": false,
            "options": [],
            "placeholder": "",
            "unit": "",
            "minimum": null,
            "maximum": null,
            "step": null,
            "minLength": null,
            "maxLength": null,
            "requiresRestart": false,
            "transient": false,
            "order": 10
        }
    ]

    theme: parent !== null ? parent.theme : null
    settings: root.settingsBridge
    fields: (root.settingsBridge !== null && root.settingsBridge !== undefined
        && typeof root.settingsBridge.fields === "function")
        ? root.settingsBridge.fields(root.formSection)
        : root.fallbackFields
}
