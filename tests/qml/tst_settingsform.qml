// tst_settingsform.qml — the generator.
//
// Three claims are checked here:
//
//   1. **Rendering.** One control per descriptor, of the right kind, in the
//      order the descriptors arrive.
//   2. **Binding.** A control follows `value` — including after an edit that
//      came from somewhere else (a store refresh, another view). This is the
//      direction that silently rots when a control binds its widget
//      declaratively and the binding dies on first user interaction.
//   3. **Propagation.** An edit is reported once, by name, and a bridge verdict
//      is reported separately so the panel can surface a refusal.
import QtQuick
import QtTest
import "../../qml/components"
import "../../qml/views/settings"

TestCase {
    id: testCase

    name: "SettingsForm"
    when: windowShown

    /** Descriptor shaped exactly like src/settings/forms.ts output. */
    function descriptor(name, uiType, value, extra) {
        var base = {
            "name": name,
            "label": name,
            "description": "",
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
        id: formComponent
        SettingsForm {}
    }

    /** A form holding one control of each kind, in a fixed order. */
    function makeMixedForm(parent) {
        return formComponent.createObject(parent, {
            "width": 360,
            "height": 600,
            "fields": [
                descriptor("hideSystemMessages", "toggle", false, { "valueType": "boolean" }),
                descriptor("theme", "select", "auto", {
                    "valueType": "string",
                    "options": [
                        { "value": "auto", "label": "Auto", "description": "" },
                        { "value": "dark", "label": "Dark", "description": "" }
                    ]
                }),
                descriptor("fontSize", "slider", 1, {
                    "valueType": "number",
                    "minimum": 0.8,
                    "maximum": 1.5,
                    "step": 0.05
                }),
                descriptor("maxHighlightChars", "number", 20000, {
                    "valueType": "number",
                    "minimum": 0,
                    "maximum": 1000000,
                    "step": 1000
                }),
                descriptor("codeFontFamily", "text", "monospace", { "valueType": "string" }),
                descriptor("accentColour", "color", "#4c8dff", { "valueType": "string" })
            ]
        })
    }

    function test_rendersOneControlPerDescriptor() {
        var form = makeMixedForm(testCase)
        verify(form !== null)

        compare(form.fieldCount, 6)
        for (var index = 0; index < 6; ++index) {
            var loader = findChild(form, "settingsFormControl" + index)
            verify(loader !== null, "missing control " + index)
            // A Loader with a sourceComponent always materialises synchronously.
            verify(loader.item !== null, "control " + index + " did not instantiate")
            compare(loader.item.field.name, form.resolvedFields[index].name)
        }

        form.destroy()
    }

    function test_dispatchesOnUiType() {
        var form = makeMixedForm(testCase)

        var expected = [
            "formControlCheckBox",
            "formControlSelect",
            "formControlSlider",
            "formControlNumber",
            "formControlTextInput",
            "formControlColorPicker"
        ]

        for (var index = 0; index < expected.length; ++index) {
            var loader = findChild(form, "settingsFormControl" + index)
            compare(loader.item.objectName, expected[index],
                    "descriptor " + index + " got the wrong control")
        }

        form.destroy()
    }

    function test_unknownUiTypeFallsBackToText() {
        var form = formComponent.createObject(testCase, {
            "width": 360,
            "height": 200,
            "fields": [descriptor("mystery", "no-such-widget", "value")]
        })

        compare(form.fieldCount, 1)
        var loader = findChild(form, "settingsFormControl0")
        compare(loader.item.objectName, "formControlTextInput")

        form.destroy()
    }

    function test_emptyFormSaysSoInsteadOfRenderingNothing() {
        var form = formComponent.createObject(testCase, { "width": 360, "height": 200 })

        compare(form.fieldCount, 0)
        var empty = findChild(form, "settingsFormEmpty")
        verify(empty !== null)
        compare(empty.visible, true)
        compare(empty.text.length > 0, true)

        form.destroy()
    }

    function test_controlFollowsValueWhenItChangesElsewhere() {
        var form = formComponent.createObject(testCase, {
            "width": 360,
            "height": 200,
            "fields": [descriptor("fontSize", "slider", 1, {
                "valueType": "number",
                "minimum": 0.8,
                "maximum": 1.5,
                "step": 0.05
            })]
        })

        var loader = findChild(form, "settingsFormControl0")
        var control = loader.item
        var slider = findChild(control, "formSlider")

        compare(slider.value, 1)
        control.value = 1.25
        compare(slider.value, 1.25)
        compare(findChild(control, "formSliderValue").text, "1.25")

        form.destroy()
    }

    function test_editIsReportedOnceWithTheSettingName() {
        var form = formComponent.createObject(testCase, {
            "width": 360,
            "height": 200,
            "fields": [descriptor("hideSystemMessages", "toggle", false, { "valueType": "boolean" })]
        })

        var spy = Qt.createQmlObject(
            'import QtTest; SignalSpy {}', testCase, "editSpy")
        spy.target = form
        spy.signalName = "valueEdited"

        var control = findChild(form, "settingsFormControl0").item
        control.valueEdited(true)

        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], "hideSystemMessages")
        compare(spy.signalArguments[0][1], true)
        // The form keeps the edit locally so the control shows it.
        compare(form.localValues["hideSystemMessages"], true)

        form.destroy()
    }

    function test_aBridgeVerdictIsReportedSeparatelyFromTheEdit() {
        var form = formComponent.createObject(testCase, {
            "width": 360,
            "height": 200,
            "fields": [descriptor("fontSize", "number", 1, {
                "valueType": "number",
                "minimum": 0.8,
                "maximum": 1.5,
                "step": 0.05
            })],
            "settings": {
                "set": function (name, value) {
                    return false
                }
            }
        })

        var spy = Qt.createQmlObject(
            'import QtTest; SignalSpy {}', testCase, "appliedSpy")
        spy.target = form
        spy.signalName = "applied"

        form.applyValue("fontSize", 1.2)

        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], "fontSize")
        compare(spy.signalArguments[0][2], false)
        // A refusal must not throw or discard the user's input.
        compare(form.localValues["fontSize"], 1.2)

        form.destroy()
    }

    function test_sectionFilterDropsOtherSections() {
        var appearance = descriptor("theme", "select", "dark", { "section": "appearance" })
        var messages = descriptor("showTimestamps", "toggle", false, {
            "section": "messages",
            "valueType": "boolean"
        })

        var form = formComponent.createObject(testCase, {
            "width": 360,
            "height": 200,
            "fields": [appearance, messages],
            "section": "messages"
        })

        compare(form.fieldCount, 1)
        compare(form.resolvedFields[0].name, "showTimestamps")

        form.destroy()
    }

    function test_rawSchemaEntriesAreDescribedOnTheFly() {
        var form = formComponent.createObject(testCase, {
            "width": 360,
            "height": 200,
            "schema": [
                {
                    "name": "hideSystemMessages",
                    "type": "boolean",
                    "default": false,
                    "section": "messages",
                    "description": "Keep notices out.",
                    "ui": { "type": "toggle" }
                }
            ]
        })

        compare(form.fieldCount, 1)
        var field = form.resolvedFields[0]
        compare(field.name, "hideSystemMessages")
        compare(field.label, "Hide system messages")
        compare(field.uiType, "toggle")
        compare(field.description, "Keep notices out.")

        form.destroy()
    }

    function test_descriptorsTakePriorityOverSchema() {
        var form = formComponent.createObject(testCase, {
            "width": 360,
            "height": 200,
            "fields": [descriptor("fromFields", "text", "a")],
            "schema": [
                {
                    "name": "fromSchema",
                    "type": "string",
                    "default": "b",
                    "section": "editor",
                    "description": "",
                    "ui": { "type": "text" }
                }
            ]
        })

        compare(form.fieldCount, 1)
        compare(form.resolvedFields[0].name, "fromFields")

        form.destroy()
    }
}
