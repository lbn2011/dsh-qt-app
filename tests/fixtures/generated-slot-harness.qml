// QML harness for tests/generated-slot-live.e2e.ts.
//
// Loads the shipped GeneratedView against a live Node PluginService, renders a
// fixture slot, performs a real button gesture and reports the re-rendered
// label on stderr. It never fakes a ConversionResult: every tree comes from
// `ui.render` over the v1 bridge.
import QtQuick
import QtQuick.Controls
import "../../qml/components"

ApplicationWindow {
    id: harness
    objectName: "generatedSlotHarness"
    width: 480
    height: 320
    visible: true
    title: "generated slot harness"

    property var result: null
    property int phase: 0

    GeneratedView {
        id: view
        objectName: "generatedSlotHarnessView"
        anchors.fill: parent
        anchors.margins: 12
        theme: Theme {}
        result: harness.result
        slotContext: ({ "slotId": "fixture.slot" })
        onAction: function (event, payload) {
            dshQt.request("ui.action", ({
                "slotId": "fixture.slot",
                "event": event,
                "payload": payload === undefined ? ({}) : payload
            }))
        }
    }

    function findNamed(parent, name) {
        if (parent === null || parent === undefined)
            return null
        if (parent.objectName === name)
            return parent
        var kids = parent.children !== undefined && parent.children !== null ? parent.children : []
        for (var index = 0; index < kids.length; ++index) {
            var hit = findNamed(kids[index], name)
            if (hit !== null)
                return hit
        }
        if (parent.item !== undefined && parent.item !== null)
            return findNamed(parent.item, name)
        return null
    }

    function report(ok, detail) {
        console.log("[harness] " + detail)
        harness.phase = ok ? harness.phase : -1
    }

    Connections {
        target: dshQt

        function onRequestReplied(id, method, ok, result, error) {
            if (method === "ui.render") {
                if (!ok) {
                    console.log("[harness] render-error " + error)
                    Qt.exit(2)
                    return
                }
                harness.result = result
                console.log("[harness] render status=" + result.status)
                clickTimer.start()
            } else if (method === "ui.action") {
                if (!ok) {
                    console.log("[harness] action-error " + error)
                    Qt.exit(3)
                    return
                }
                harness.result = result
                var button = harness.findNamed(view, "generatedButton")
                console.log("[harness] rerender status=" + result.status
                            + " label=" + (button === null ? "<missing>" : button.text))
                Qt.exit(button !== null && button.text === "Count 1" ? 0 : 4)
            }
        }
    }

    Timer {
        id: clickTimer
        interval: 200
        repeat: false
        onTriggered: {
            var button = harness.findNamed(view, "generatedButton")
            if (button === null) {
                console.log("[harness] button-missing")
                Qt.exit(5)
                return
            }
            console.log("[harness] clicking label=" + button.text)
            button.clicked()
        }
    }

    Component.onCompleted: dshQt.request("ui.render", ({ "slotId": "fixture.slot", "props": ({}) }))
}
