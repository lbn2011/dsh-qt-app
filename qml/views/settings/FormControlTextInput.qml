// FormControlTextInput.qml — free text.
//
// Used for `ui.type: "text"` (and for a colour's hex string, wrapped by
// FormControlColorPicker). The `Binding` is guarded by `activeFocus` so typing
// is never fought by a re-bound `text`; the edit is reported on `textEdited`
// and again on `editingFinished` so a click-away commits.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FormControl {
    id: root

    objectName: "formControlTextInput"

    /** Maximum length, or -1 for unlimited. */
    readonly property int lengthLimit: {
        var limit = root.fieldNumber("maxLength", -1)
        return limit > 0 ? Math.round(limit) : -1
    }

    TextField {
        id: input

        objectName: "formTextInput"
        Layout.fillWidth: true
        enabled: root.interactive
        placeholderText: root.fieldText("placeholder", "")
        maximumLength: root.lengthLimit
        selectByMouse: true
        color: root.theme !== null ? root.theme.text : "#e6e6e6"
        placeholderTextColor: root.theme !== null ? root.theme.textMuted : "#8a8f98"
        palette.base: root.theme !== null ? root.theme.surfaceAlt : "#26272b"
        palette.text: root.theme !== null ? root.theme.text : "#e6e6e6"
        palette.highlight: root.theme !== null ? root.theme.accent : "#4c8dff"
        palette.highlightedText: root.theme !== null ? root.theme.textInverse : "#12141a"

        Binding {
            target: input
            property: "text"
            value: root.valueText()
            when: !input.activeFocus
            restoreMode: Binding.RestoreBindingOrValue
        }

        onTextEdited: root.valueEdited(input.text)
        onEditingFinished: root.valueEdited(input.text)
    }
}
