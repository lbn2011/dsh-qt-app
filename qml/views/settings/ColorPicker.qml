// ColorPicker.qml — a swatch grid plus a hex field.
//
// Colour is the one setting whose raw value is unpleasant to type, so it gets a
// widget: a row of swatches for the common choices and a hex box for anything
// else. The grammar it accepts is exactly the one src/settings/schema.ts stores
// (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `transparent`) — the picker never
// invents a colour the writer would reject.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../../components"

Item {
    id: root

    objectName: "colorPicker"

    property Theme theme: null

    /** Currently selected colour, as a stored string. */
    property string color: "#4c8dff"

    /** Swatches offered before the user types a hex value. */
    property var swatches: [
        "#1b1c1f", "#24262b", "#33363d", "#e6e6e6",
        "#4c8dff", "#6ba1ff", "#3fb950", "#d29922",
        "#e5534b", "#c93c34", "#8a8f98", "transparent"
    ]

    /** Emitted when the user picks a swatch or commits a hex value. */
    signal picked(string color)

    readonly property color previewColor: root.isAcceptable(root.color) ? root.color : "transparent"

    /** True when `candidate` is a colour this picker will emit. */
    function isAcceptable(candidate) {
        if (typeof candidate !== "string")
            return false
        if (candidate === "transparent")
            return true
        return /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(candidate)
    }

    implicitWidth: 320
    implicitHeight: column.implicitHeight

    ColumnLayout {
        id: column

        width: root.width
        spacing: root.theme !== null ? root.theme.spacing : 8

        GridLayout {
            objectName: "colorSwatches"
            columns: 6
            columnSpacing: root.theme !== null ? root.theme.spacing : 8
            rowSpacing: root.theme !== null ? root.theme.spacing : 8
            Layout.fillWidth: true

            Repeater {
                model: root.swatches
                delegate: Rectangle {
                    id: swatch

                    required property string modelData
                    required property int index

                    objectName: "colorSwatch" + swatch.index
                    implicitWidth: 28
                    implicitHeight: 28
                    radius: root.theme !== null ? root.theme.radius / 2 : 4
                    color: swatch.modelData === "transparent" ? "transparent" : swatch.modelData
                    border.width: 1
                    border.color: root.theme !== null ? root.theme.border : "#33363d"

                    MouseArea {
                        anchors.fill: parent
                        onClicked: root.picked(swatch.modelData)
                    }
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: root.theme !== null ? root.theme.spacing : 8

            Rectangle {
                objectName: "colorPreview"
                implicitWidth: 28
                implicitHeight: 28
                radius: root.theme !== null ? root.theme.radius / 2 : 4
                color: root.previewColor
                border.width: 1
                border.color: root.theme !== null ? root.theme.border : "#33363d"
            }

            TextField {
                id: hexInput

                objectName: "colorHexInput"
                Layout.fillWidth: true
                text: root.color
                placeholderText: "#rrggbb"
                selectByMouse: true
                color: root.theme !== null ? root.theme.text : "#e6e6e6"
                placeholderTextColor: root.theme !== null ? root.theme.textMuted : "#8a8f98"
                palette.base: root.theme !== null ? root.theme.surfaceAlt : "#26272b"
                palette.text: root.theme !== null ? root.theme.text : "#e6e6e6"

                Binding {
                    target: hexInput
                    property: "text"
                    value: root.color
                    when: !hexInput.activeFocus
                    restoreMode: Binding.RestoreBindingOrValue
                }

                onEditingFinished: {
                    if (root.isAcceptable(hexInput.text))
                        root.picked(hexInput.text)
                    else
                        hexInput.text = root.color
                }
            }
        }
    }
}
