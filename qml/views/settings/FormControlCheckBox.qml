// FormControlCheckBox.qml — boolean switch.
//
// Used for `ui.type: "toggle"`. The `Binding` is guarded by `pressed` because
// the user's click writes `checked` directly; without the guard the declarative
// binding dies on first use and the box stops reflecting `value`.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FormControl {
    id: root

    objectName: "formControlCheckBox"

    CheckBox {
        id: box

        objectName: "formCheckBox"
        Layout.fillWidth: true
        enabled: root.interactive
        text: qsTr("Enabled")
        palette.text: root.theme !== null ? root.theme.text : "#e6e6e6"
        palette.windowText: root.theme !== null ? root.theme.text : "#e6e6e6"

        Binding {
            target: box
            property: "checked"
            value: root.value === true
            when: !box.pressed
            restoreMode: Binding.RestoreBindingOrValue
        }

        onToggled: root.valueEdited(box.checked)
    }
}
