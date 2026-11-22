// FormControlNumber.qml — bounded numeric value with steppers.
//
// Used for `ui.type: "number"`. Kept separate from the slider because a value
// like `maxHighlightChars` (0…1,000,000, step 1000) is unusable as a thumb: you
// cannot land on 20,000 by dragging, but you can type it.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FormControl {
    id: root

    objectName: "formControlNumber"

    readonly property real minimum: root.fieldNumber("minimum", 0)
    readonly property real maximum: root.fieldNumber("maximum", Math.max(root.minimum + 1, 1))
    readonly property real stepSize: {
        var step = root.fieldNumber("step", 1)
        return step > 0 ? step : 1
    }

    SpinBox {
        id: spin

        objectName: "formNumber"
        Layout.fillWidth: true
        enabled: root.interactive
        editable: true
        from: Math.round(root.minimum)
        to: Math.round(root.maximum)
        stepSize: Math.max(1, Math.round(root.stepSize))
        palette.text: root.theme !== null ? root.theme.text : "#e6e6e6"
        palette.base: root.theme !== null ? root.theme.surfaceAlt : "#26272b"
        palette.button: root.theme !== null ? root.theme.surfaceAlt : "#26272b"
        palette.buttonText: root.theme !== null ? root.theme.text : "#e6e6e6"

        Binding {
            target: spin
            property: "value"
            value: Math.round(root.valueNumber(root.minimum))
            when: !spin.contentItem.activeFocus && !spin.up.pressed && !spin.down.pressed
            restoreMode: Binding.RestoreBindingOrValue
        }

        onValueModified: root.valueEdited(spin.value)
    }
}
