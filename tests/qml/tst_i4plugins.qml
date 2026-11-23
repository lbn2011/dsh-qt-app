import QtQuick
import QtTest
import "../../qml/views" as Views
import "../../qml/views/settings" as SettingsViews

TestCase {
    id: testCase
    name: "I4Plugins"
    when: windowShown
    visible: true
    width: 600
    height: 600

    property var theBridge: null

    Component {
        id: fakeBridgeComponent
        QtObject {
            id: fake
            property var calls: []
            signal requestReplied(string id, string method, bool ok, var result, string error)
            signal eventReceived(string name, var payload)
            function request(method, params) {
                fake.calls = fake.calls.concat([{ "method": method, "params": params }])
                return "req-" + fake.calls.length
            }
        }
    }

    Component {
        id: fallbackComponent
        Views.SlotWebFallback {}
    }

    Component {
        id: bridgeComponent
        SettingsViews.PluginsBridge { qtBridge: testCase.theBridge }
    }

    function test_textFallbackShowsSalvagedTextAndNoButton() {
        const item = createTemporaryObject(fallbackComponent, testCase, {
            "conversion": {
                "status": "text",
                "reason": { "code": "F4", "name": "third-party-component", "detail": "<Chart>" },
                "text": "two bundles active"
            },
            "slotTitle": "Acme",
            "slotId": "acme.panel"
        })
        verify(item !== null)
        compare(item.status, "text")
        compare(item.fallbackText, "two bundles active")
        compare(item.webUrl, "")
        const button = findChild(item, "slotFallbackOpenButton")
        verify(button !== null)
        compare(button.visible, false)
        const notice = findChild(item, "slotFallbackNoWebEntry")
        compare(notice.visible, true)
        const reason = findChild(item, "slotFallbackReason")
        compare(reason.visible, true)
        verify(String(reason.text).indexOf("F4") === 0)
    }

    function test_webFallbackOffersTheUrlItWasGiven() {
        const item = createTemporaryObject(fallbackComponent, testCase, {
            "conversion": {
                "status": "web",
                "reason": { "code": "F5", "name": "complex-dom", "detail": "<div onClick>" },
                "webEntry": { "kind": "declared", "url": "https://127.0.0.1:3080/" }
            },
            "slotTitle": "Acme",
            "slotId": "acme.panel"
        })
        verify(item !== null)
        compare(item.status, "web")
        compare(item.webUrl, "https://127.0.0.1:3080/")
        const button = findChild(item, "slotFallbackOpenButton")
        compare(button.visible, true)

        let opened = null
        item.openRequested.connect(function (slotId, url) { opened = { "slotId": slotId, "url": url } })
        button.clicked()
        verify(opened !== null)
        compare(opened.slotId, "acme.panel")
        compare(opened.url, "https://127.0.0.1:3080/")
    }

    function test_bridgeSendsRequestsAndRoutesTheListReply() {
        const fake = createTemporaryObject(fakeBridgeComponent, testCase)
        testCase.theBridge = fake
        const bridge = createTemporaryObject(bridgeComponent, testCase)
        verify(bridge !== null)

        bridge.refresh()
        compare(fake.calls.length, 2)
        compare(fake.calls[0].method, "plugin.list")
        compare(fake.calls[1].method, "plugin.bundles")
        compare(bridge.loading, true)

        let changed = 0
        bridge.changed.connect(function () { changed += 1 })

        fake.requestReplied("req-1", "plugin.list", true, [{ "id": "acme", "enabled": true }], "")
        compare(bridge.rows.length, 1)
        compare(bridge.rows[0].id, "acme")
        compare(bridge.loading, false)
        compare(changed, 1)

        fake.requestReplied("req-2", "plugin.bundles", true, [{ "name": "acme" }], "")
        compare(bridge.bundles.length, 1)
        compare(changed, 2)
    }

    function test_bridgeTurnsAFailedChangeIntoAValue() {
        const fake = createTemporaryObject(fakeBridgeComponent, testCase)
        testCase.theBridge = fake
        const bridge = createTemporaryObject(bridgeComponent, testCase)

        let failure = ""
        bridge.failed.connect(function (message) { failure = message })

        bridge.setEnabled("acme", false)
        compare(fake.calls[0].method, "plugin.setEnabled")
        compare(fake.calls[0].params.id, "acme")
        compare(fake.calls[0].params.enabled, false)

        fake.requestReplied("req-1", "plugin.setEnabled", true, {
            "changed": false,
            "application": "failed",
            "stage": "enable",
            "target": "acme",
            "error": { "code": "incompatible-version", "diagnostic": "needs dsh >= 0.3" }
        }, "")

        verify(failure.indexOf("incompatible-version") === 0)
        compare(bridge.lastError, "incompatible-version: needs dsh >= 0.3")
        compare(bridge.busy, false)
    }

    function test_bridgeTracksTheOperationPhase() {
        const fake = createTemporaryObject(fakeBridgeComponent, testCase)
        testCase.theBridge = fake
        const bridge = createTemporaryObject(bridgeComponent, testCase)

        bridge.install("acme@1.2.3")
        compare(fake.calls[0].method, "plugin.install")
        compare(fake.calls[0].params.spec, "acme@1.2.3")
        fake.requestReplied("req-1", "plugin.install", true, { "opId": "op-1" }, "")
        compare(bridge.operation.opId, "op-1")
        compare(bridge.busy, true)

        // A transport failure must not leave the panel stuck in "busy".
        bridge.cancel()
        compare(fake.calls[1].method, "plugin.op.cancel")
        compare(fake.calls[1].params.opId, "op-1")
    }

    function test_unsupportedControlIsForwarded() {
        const fake = createTemporaryObject(fakeBridgeComponent, testCase)
        testCase.theBridge = fake
        const bridge = createTemporaryObject(bridgeComponent, testCase)

        let seen = null
        bridge.unsupportedControl.connect(function (slotId, type) {
            seen = { "slotId": slotId, "type": type }
        })
        fake.eventReceived("ui.unsupported", { "slotId": "acme.chart", "type": "chart" })
        verify(seen !== null)
        compare(seen.slotId, "acme.chart")
        compare(seen.type, "chart")
    }

    function test_progressEventRefetchesTheList() {
        const fake = createTemporaryObject(fakeBridgeComponent, testCase)
        testCase.theBridge = fake
        const bridge = createTemporaryObject(bridgeComponent, testCase)

        let phases = []
        bridge.operationPhaseChanged.connect(function (opId, phase) { phases.push(phase) })
        fake.eventReceived("plugin.op.progress", { "opId": "op-1", "phase": "installing" })
        compare(bridge.busy, true)
        fake.eventReceived("plugin.op.progress", { "opId": "op-1", "phase": "settled" })
        compare(bridge.busy, false)
        compare(phases.length, 2)
        compare(phases[1], "settled")
        // settling re-lists instead of trusting a push
        compare(fake.calls[0].method, "plugin.list")
    }

    function test_panelFallbackOffersTheFullWebuiAndSaysSo() {
        const item = createTemporaryObject(fallbackComponent, testCase, {
            "conversion": {
                "status": "text",
                "reason": { "code": "F5", "name": "complex-dom", "detail": "<div onClick>" },
                "text": "Status"
            },
            "slotTitle": "Acme",
            "slotId": "acme.panel",
            "fullWebuiUrl": "https://127.0.0.1:3080/"
        })
        verify(item !== null)
        compare(item.canOpenSlot, false)
        compare(item.canOpenPanel, true)
        compare(findChild(item, "slotFallbackOpenButton").visible, false)
        compare(findChild(item, "slotFallbackPanelNotice").visible, true)
        const panelButton = findChild(item, "slotFallbackOpenPanelButton")
        compare(panelButton.visible, true)
        // A panel fallback must not pretend it can locate the slot.
        compare(findChild(item, "slotFallbackNoWebEntry").visible, false)

        let opened = null
        item.openRequested.connect(function (slotId, url) { opened = { "slotId": slotId, "url": url } })
        panelButton.clicked()
        verify(opened !== null)
        compare(opened.url, "https://127.0.0.1:3080/")
        compare(opened.slotId, "acme.panel")
    }

    function test_slotEntryWinsOverThePanelFallback() {
        const item = createTemporaryObject(fallbackComponent, testCase, {
            "conversion": {
                "status": "web",
                "reason": { "code": "F4", "name": "third-party-component", "detail": "<Chart>" },
                "webEntry": { "kind": "declared", "url": "https://plugin.example/slot" }
            },
            "slotId": "acme.panel",
            "fullWebuiUrl": "https://127.0.0.1:3080/"
        })
        compare(item.canOpenSlot, true)
        compare(item.canOpenPanel, false)
        compare(findChild(item, "slotFallbackOpenButton").visible, true)
        compare(findChild(item, "slotFallbackOpenPanelButton").visible, false)
        compare(findChild(item, "slotFallbackPanelNotice").visible, false)
    }
}
