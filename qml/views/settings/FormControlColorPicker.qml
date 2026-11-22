// FormControlColorPicker.qml — a labelled colour setting.
//
// Used for `ui.type: "color"`: FormControl draws the label and description, and
// ColorPicker does the picking.
import QtQuick

FormControl {
    id: root

    objectName: "formControlColorPicker"

    ColorPicker {
        objectName: "formColorPicker"
        theme: root.theme
        color: root.valueText().length > 0 ? root.valueText() : "#4c8dff"
        Layout.fillWidth: true

        onPicked: function (color) {
            root.valueEdited(color)
        }
    }
}
