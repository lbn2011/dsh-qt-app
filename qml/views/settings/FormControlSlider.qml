// FormControlSlider.qml — bounded numeric value with a track.
//
// Used for `ui.type: "slider"`. Bounds and step come from the schema, so the
// slider can never produce a value the store would refuse; the current value is
// echoed next to the track because a thumb position alone does not tell you
// whether the font scale is 1.05 or 1.15.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FormControl {
    id: root

    objectName: "formControlSlider"

    readonly property real minimum: root.fieldNumber("minimum", 0)
    readonly property real maximum: root.fieldNumber("maximum", 1)
    readonly property real stepSize: root.fieldNumber("step", 0)
    readonly property string unit: root.fieldText("unit", "")

    /** Value rendered for the readout, e.g. `1.05` or `20%`. */
    readonly property string readout: {
        var shown = root.valueNumber(root.minimum)
        var text = root.stepSize >= 1 ? String(Math.round(shown)) : String(Math.round(shown * 100) / 100)
        return root.unit.length > 0 ? text + root.unit : text
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: root.rowSpacing

        Slider {
            id: slider

            objectName: "formSlider"
            Layout.fillWidth: true
            enabled: root.interactive
            from: root.minimum
            to: root.maximum
            stepSize: root.stepSize
            snapMode: root.stepSize > 0 ? Slider.SnapAlways : Slider.NoSnap

            Binding {
                target: slider
                property: "value"
                value: root.valueNumber(root.minimum)
                when: !slider.pressed
                restoreMode: Binding.RestoreBindingOrValue
            }

            onMoved: root.valueEdited(slider.value)
        }

        Label {
            objectName: "formSliderValue"
            text: root.readout
            color: root.theme !== null ? root.theme.text : "#e6e6e6"
            font.pixelSize: root.theme !== null ? root.theme.fontNormal : 13
            horizontalAlignment: Text.AlignRight
            Layout.minimumWidth: 56
        }
    }
}
