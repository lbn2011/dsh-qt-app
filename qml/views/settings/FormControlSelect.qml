// FormControlSelect.qml — enumerated choice.
//
// Used for `ui.type: "select"`. `valueRole` carries the *stored* value, so the
// control reports the schema's own value ("auto") rather than the display label
// ("Auto"); a form never has to map labels back to values.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FormControl {
    id: root

    objectName: "formControlSelect"

    /** Options as a plain list, safe with a null field. */
    function optionList() {
        if (root.field === null || root.field === undefined)
            return []
        var source = root.field.options
        if (source === null || source === undefined || source.length === undefined)
            return []
        return source
    }

    /** Index of the current value, or -1 when it is not offered. */
    function selectedIndex() {
        var options = root.optionList()
        for (var index = 0; index < options.length; ++index) {
            if (options[index].value === root.value)
                return index
        }
        return -1
    }

    ComboBox {
        id: combo

        objectName: "formSelect"
        Layout.fillWidth: true
        enabled: root.interactive
        model: root.optionList()
        textRole: "label"
        valueRole: "value"
        palette.text: root.theme !== null ? root.theme.text : "#e6e6e6"
        palette.button: root.theme !== null ? root.theme.surfaceAlt : "#26272b"
        palette.buttonText: root.theme !== null ? root.theme.text : "#e6e6e6"
        palette.highlight: root.theme !== null ? root.theme.accent : "#4c8dff"
        palette.highlightedText: root.theme !== null ? root.theme.textInverse : "#12141a"

        Binding {
            target: combo
            property: "currentIndex"
            value: root.selectedIndex()
            when: !combo.popup.visible
            restoreMode: Binding.RestoreBindingOrValue
        }

        onActivated: function (index) {
            root.valueEdited(combo.valueAt(index))
        }
    }
}
