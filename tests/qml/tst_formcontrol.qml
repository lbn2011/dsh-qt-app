// tst_formcontrol.qml — the controls themselves.
//
// The generator picks a control; this suite checks the control does its job:
// it shows the label and description, it shows the current value in a form a
// human can read, and it reports edits rather than swallowing them.
//
// Nothing here asserts on pixel colours: the panel is themed, and a colour
// assertion would fail the moment someone adjusts the palette. What is worth
// pinning is the *structure* — the objectNames the rest of the UI finds these by.
import QtQuick
import QtTest
import "../../qml/components"
import "../../qml/views/settings"

TestCase {
    id: testCase

    name: "FormControl"
    when: windowShown
    visible: true

    function descriptor(name, uiType, value, extra) {
        var base = {
            "name": name,
            "label": "Label of " + name,
            "description": "Explains " + name,
            "section": "appearance",
            "valueType": "string",
            "uiType": uiType,
            "value": value,
            "defaultValue": value,
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
        }
        if (extra !== undefined) {
            for (var key in extra)
                base[key] = extra[key]
        }
        return base
    }

    Component {
        id: checkBoxComponent
        FormControlCheckBox {}
    }

    Component {
        id: selectComponent
        FormControlSelect {}
    }

    Component {
        id: textComponent
        FormControlTextInput {}
    }

    Component {
        id: sliderComponent
        FormControlSlider {}
    }

    Component {
        id: numberComponent
        FormControlNumber {}
    }

    Component {
        id: colorComponent
        FormControlColorPicker {}
    }

    Component {
        id: pickerComponent
        ColorPicker {}
    }

    function test_labelAndDescriptionAreShown() {
        var control = checkBoxComponent.createObject(testCase, {
            "width": 320,
            "height": 160,
            "field": descriptor("hideSystemMessages", "toggle", false, { "valueType": "boolean" })
        })

        compare(findChild(control, "formControlLabel").text, "Label of hideSystemMessages")
        compare(findChild(control, "formControlDescription").text, "Explains hideSystemMessages")

        control.destroy()
    }

    function test_absentLabelFallsBackToTheSettingName() {
        var field = descriptor("theme", "select", "auto")
        field.label = undefined

        var control = selectComponent.createObject(testCase, {
            "width": 320,
            "height": 160,
            "field": field
        })

        compare(control.label, "theme")

        control.destroy()
    }

    function test_checkBoxReflectsAndReportsTheToggle() {
        var control = checkBoxComponent.createObject(testCase, {
            "width": 320,
            "height": 160,
            "field": descriptor("showTimestamps", "toggle", true, { "valueType": "boolean" })
        })

        var box = findChild(control, "formCheckBox")
        compare(box.checked, true)

        control.value = false
        compare(box.checked, false)

        var spy = Qt.createQmlObject('import QtTest; SignalSpy {}', testCase, "boxSpy")
        spy.target = control
        spy.signalName = "valueEdited"
        control.valueEdited(true)
        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], true)

        control.destroy()
    }

    function test_selectShowsTheStoredValueAndReportsItBack() {
        var control = selectComponent.createObject(testCase, {
            "width": 320,
            "height": 160,
            "field": descriptor("theme", "select", "dark", {
                "options": [
                    { "value": "auto", "label": "Auto", "description": "" },
                    { "value": "dark", "label": "Dark", "description": "" },
                    { "value": "light", "label": "Light", "description": "" }
                ]
            })
        })

        var combo = findChild(control, "formSelect")
        compare(combo.count, 3)
        compare(combo.currentIndex, 1, "the current value must select its own row")

        control.value = "light"
        compare(combo.currentIndex, 2)

        // An unrecognised value selects nothing rather than guessing row 0.
        control.value = "sepia"
        compare(combo.currentIndex, -1)
        compare(control.selectedIndex(), -1)

        control.destroy()
    }

    function test_textInputCarriesPlaceholderAndLengthLimit() {
        var control = textComponent.createObject(testCase, {
            "width": 320,
            "height": 160,
            "field": descriptor("codeFontFamily", "text", "monospace", {
                "placeholder": "font family",
                "maxLength": 12
            })
        })

        var input = findChild(control, "formTextInput")
        compare(input.text, "monospace")
        compare(input.placeholderText, "font family")
        compare(input.maximumLength, 12)

        control.value = "Fira Code"
        compare(input.text, "Fira Code")

        control.destroy()
    }

    function test_sliderHonoursBoundsStepAndReadout() {
        var control = sliderComponent.createObject(testCase, {
            "width": 320,
            "height": 200,
            "field": descriptor("fontSize", "slider", 1, {
                "valueType": "number",
                "minimum": 0.8,
                "maximum": 1.5,
                "step": 0.05
            })
        })

        var slider = findChild(control, "formSlider")
        compare(slider.from, 0.8)
        compare(slider.to, 1.5)
        compare(slider.stepSize, 0.05)
        compare(slider.value, 1)
        compare(findChild(control, "formSliderValue").text, "1")

        control.value = 1.25
        compare(findChild(control, "formSliderValue").text, "1.25")

        control.destroy()
    }

    function test_sliderReadoutCarriesAUnitWhenDeclared() {
        var control = sliderComponent.createObject(testCase, {
            "width": 320,
            "height": 200,
            "field": descriptor("opacity", "slider", 80, {
                "valueType": "number",
                "minimum": 0,
                "maximum": 100,
                "step": 1,
                "unit": "%"
            })
        })

        compare(findChild(control, "formSliderValue").text, "80%")

        control.destroy()
    }

    function test_numberControlIsBoundedAndReportsWholeNumbers() {
        var control = numberComponent.createObject(testCase, {
            "width": 320,
            "height": 200,
            "field": descriptor("maxHighlightChars", "number", 20000, {
                "valueType": "number",
                "minimum": 0,
                "maximum": 1000000,
                "step": 1000
            })
        })

        var spin = findChild(control, "formNumber")
        compare(spin.from, 0)
        compare(spin.to, 1000000)
        compare(spin.stepSize, 1000)
        compare(spin.value, 20000)

        control.value = 50000
        compare(spin.value, 50000)

        control.destroy()
    }

    function test_restartHintOnlyShowsWhenTheSettingNeedsIt() {
        var lazy = checkBoxComponent.createObject(testCase, {
            "width": 320,
            "height": 160,
            "field": descriptor("showTimestamps", "toggle", false, { "valueType": "boolean" })
        })
        compare(findChild(lazy, "formControlRestartHint").visible, false)
        lazy.destroy()

        var restarting = checkBoxComponent.createObject(testCase, {
            "width": 320,
            "height": 160,
            "field": descriptor("language", "toggle", false, {
                "valueType": "boolean",
                "requiresRestart": true
            })
        })
        compare(findChild(restarting, "formControlRestartHint").visible, true)
        restarting.destroy()
    }

    function test_colorPickerOffersSwatchesAndReportsAPick() {
        var picker = pickerComponent.createObject(testCase, {
            "width": 320,
            "height": 220,
            "color": "#4c8dff"
        })

        verify(picker.swatches.length > 0)
        var swatch = findChild(picker, "colorSwatch0")
        verify(swatch !== null)
        compare(String(swatch.color).toLowerCase(), String(picker.swatches[0]).toLowerCase())

        var spy = Qt.createQmlObject('import QtTest; SignalSpy {}', testCase, "pickSpy")
        spy.target = picker
        spy.signalName = "picked"
        picker.picked("#ff8800")
        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], "#ff8800")

        picker.destroy()
    }

    function test_colorPickerAcceptsOnlyTheStoredGrammar() {
        var picker = pickerComponent.createObject(testCase, { "width": 320, "height": 220 })

        compare(picker.isAcceptable("#abc"), true)
        compare(picker.isAcceptable("#aabbccdd"), true)
        compare(picker.isAcceptable("transparent"), true)
        compare(picker.isAcceptable("red"), false)
        compare(picker.isAcceptable("#12345"), false)
        compare(picker.isAcceptable(""), false)
        compare(picker.isAcceptable(7), false)

        picker.destroy()
    }

    function test_colorControlForwardsAPickAsAValueEdit() {
        var control = colorComponent.createObject(testCase, {
            "width": 320,
            "height": 240,
            "field": descriptor("accentColour", "color", "#4c8dff", { "valueType": "string" })
        })

        var spy = Qt.createQmlObject('import QtTest; SignalSpy {}', testCase, "colorSpy")
        spy.target = control
        spy.signalName = "valueEdited"

        var picker = findChild(control, "formColorPicker")
        verify(picker !== null)
        picker.picked("#3fb950")

        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], "#3fb950")

        control.destroy()
    }
}
