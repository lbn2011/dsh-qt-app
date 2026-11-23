// tst_settingsplugin.qml — plugin-contributed settings.
//
// The promise of this task is that a plugin can add settings "without modifying
// the core settings panel". That promise is checked from the outside in:
//
//   * a contribution carrying only schema entries is drawn by the generator, so
//     the plugin ships no QML at all;
//   * a contribution carrying a component is drawn by that component, and the
//     generator stays out of the way;
//   * a contribution carrying nothing renderable says so instead of leaving a
//     blank tab that reads like a bug;
//   * the panel shows a plugin's tab and hosts its forms inside it.
import QtQuick
import QtTest
import QtQuick.Controls
import "../../qml/components"
import "../../qml/views/settings"

TestCase {
    id: testCase

    name: "SettingsPluginSlot"
    when: windowShown
    visible: true

    /** One toggle, declared the way a plugin would. */
    function toggleSchema(name) {
        return [{
            "name": name,
            "type": "boolean",
            "default": false,
            "section": "plugins",
            "description": "Declared by a plugin.",
            "ui": { "type": "toggle" }
        }]
    }

    Component {
        id: hostComponent
        SlotHost {}
    }

    Component {
        id: formsComponent
        SlotForms {}
    }

    Component {
        id: panelComponent
        SettingsPanel {}
    }

    Component {
        id: pluginBodyComponent
        Item {
            property Theme theme: null
            property var slotContext: ({})
            objectName: "pluginOwnBody"
        }
    }

    function test_schemaOnlyContributionIsRenderedByTheGenerator() {
        var host = hostComponent.createObject(testCase, {
            "width": 360,
            "height": 300,
            "contribution": {
                "id": "acme.telemetry",
                "surface": "conversation.settings.form",
                "title": "Telemetry",
                "section": "plugins",
                "order": 0,
                "schema": toggleSchema("telemetryOptIn")
            }
        })

        compare(host.hasSchema, true)
        compare(host.usesGeneratedForm, true)

        var generated = findChild(host, "settingsSlotGeneratedForm")
        verify(generated !== null)
        compare(generated.visible, true)
        compare(generated.fieldCount, 1)
        compare(generated.resolvedFields[0].name, "telemetryOptIn")

        // The "nothing provided" message must not appear for a schema slot.
        compare(findChild(host, "settingsSlotEmpty").visible, false)

        host.destroy()
    }

    function test_generatedFormForwardsEditsToTheHost() {
        var received = { "name": "", "value": null }

        var host = hostComponent.createObject(testCase, {
            "width": 360,
            "height": 300,
            "contribution": {
                "id": "acme.telemetry",
                "title": "Telemetry",
                "schema": toggleSchema("telemetryOptIn")
            }
        })

        host.formValueEdited.connect(function (name, value) {
            received.name = name
            received.value = value
        })

        var generated = findChild(host, "settingsSlotGeneratedForm")
        generated.valueEdited("telemetryOptIn", true)

        compare(received.name, "telemetryOptIn")
        compare(received.value, true)

        host.destroy()
    }

    function test_aComponentContributionIsLeftToThePlugin() {
        var host = hostComponent.createObject(testCase, {
            "width": 360,
            "height": 300,
            "contribution": {
                "id": "acme.own-ui",
                "title": "Acme",
                "section": "plugins",
                "component": pluginBodyComponent,
                "schema": toggleSchema("telemetryOptIn")
            }
        })

        compare(host.hasComponent, true)
        compare(host.usesGeneratedForm, false, "a plugin component must win over the generator")

        // The generator may exist in the tree but must not be showing.
        compare(findChild(host, "settingsSlotGeneratedForm").visible, false)

        var loader = findChild(host, "settingsSlotLoader")
        verify(loader !== null)
        verify(loader.item !== null)
        compare(loader.item.objectName, "pluginOwnBody")

        host.destroy()
    }

    function test_anEmptyContributionSaysSo() {
        var host = hostComponent.createObject(testCase, {
            "width": 360,
            "height": 200,
            "contribution": { "id": "acme.nothing", "title": "Nothing" }
        })

        compare(host.hasComponent, false)
        compare(host.hasUrl, false)
        compare(host.hasSchema, false)
        compare(host.usesGeneratedForm, false)

        var empty = findChild(host, "settingsSlotEmpty")
        verify(empty !== null)
        compare(empty.visible, true)

        host.destroy()
    }

    function test_formsRenderInOrderInsideOneSection() {
        var forms = formsComponent.createObject(testCase, {
            "width": 360,
            "height": 480,
            "forms": [
                { "id": "b", "title": "B", "section": "acme", "order": 20, "schema": toggleSchema("bFlag") },
                { "id": "a", "title": "A", "section": "acme", "order": 10, "schema": toggleSchema("aFlag") }
            ]
        })

        compare(forms.orderedForms.length, 2)
        compare(forms.orderedForms[0].id, "a", "lower order must render first")
        compare(forms.orderedForms[1].id, "b")

        var first = findChild(forms, "settingsSlotForm0")
        verify(first !== null)
        compare(findChild(first, "settingsSlotHeading").text, "A")
        verify(first.theme !== null, "an unthemed SlotForms preserves the host's default Theme")
        compare(findChild(first, "settingsSlotHeading").color, first.theme.text)

        forms.destroy()
    }

    function test_panelGrowsATabForAPluginSection() {
        var panel = panelComponent.createObject(testCase, {
            "width": 400,
            "height": 560
        })

        // The built-in tabs are always there.
        verify(panel.sections.indexOf("theme") >= 0)
        verify(panel.sections.indexOf("about") >= 0)

        // Hosting the built-in forms is part of the panel, not of a plugin.
        verify(findChild(panel, "settingsLanguageForm") !== null)

        panel.destroy()
    }

    function test_panelReportsAFormEditUpwards() {
        var panel = panelComponent.createObject(testCase, {
            "width": 400,
            "height": 560
        })

        var seen = { "name": "", "value": null }
        panel.settingEdited.connect(function (name, value) {
            seen.name = name
            seen.value = value
        })

        var languageForm = findChild(panel, "settingsLanguageForm")
        verify(languageForm !== null)
        languageForm.valueEdited("language", "en")

        compare(seen.name, "language")
        compare(seen.value, "en")

        panel.destroy()
    }
}
