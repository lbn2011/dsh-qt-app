// tst_settingsbridge.qml — runs the settings bridge against a fake native host.
//
// This is the QML half of I3's verification: it proves that the component the
// forms actually use correlates `request`/`requestReplied`, drops replies nobody
// waits for, cancels what is in flight, and degrades when no host is attached.
// It never needs a real Node process.
pragma ComponentBehavior: Bound

import QtQuick
import QtTest
import "../../qml/views/settings"

TestCase {
    id: testCase

    name: "SettingsBridge"
    width: 480
    height: 320
    when: windowShown

    /** Records what the bridge asked for and lets the test answer it. */
    QtObject {
        id: fakeHost

        property int sequence: 0
        property string lastMethod: ""
        property var lastParams: ({})
        property var cancelled: []

        signal requestReplied(string id, string method, bool ok, var result, string error)

        function request(method, params) {
            sequence += 1
            lastMethod = String(method)
            lastParams = params === undefined ? ({}) : params
            return "req-" + sequence
        }

        function cancelRequest(id) {
            cancelled.push(String(id))
            return true
        }

        function reset() {
            sequence = 0
            lastMethod = ""
            lastParams = ({})
            cancelled = []
        }
    }

    SettingsBridge {
        id: bridge

        host: fakeHost
    }

    function init() {
        fakeHost.reset()
        // Drop anything a previous test left in flight, so `busy` starts clean.
        bridge._pending = ({})
        bridge._pendingCount = 0
        bridge.host = fakeHost
        bridge.descriptors = []
        bridge.revision = -1
        bridge.providers = []
        bridge.defaultSelection = ({})
        bridge.lastError = ""
    }

    function test_describeCorrelatesTheReply() {
        var outcome = { called: 0, ok: false, result: null }

        var id = bridge.describe("core", function (ok, result) {
            outcome.called += 1
            outcome.ok = ok
            outcome.result = result
        })

        verify(id !== "", "describe must return the host request id")
        compare(fakeHost.lastMethod, "settings.describe")
        compare(fakeHost.lastParams.ns, "core")
        compare(bridge.busy, true)

        fakeHost.requestReplied(id, "settings.describe", true,
                                { "revision": 7, "namespaces": [{ "ns": "core" }] }, "")

        compare(outcome.called, 1)
        compare(outcome.ok, true)
        compare(bridge.revision, 7)
        compare(bridge.descriptors.length, 1)
        compare(bridge.busy, false)
        compare(bridge.lastError, "")
    }

    function test_aLateReplyNobodyWaitsForIsIgnored() {
        // A reply for a request the bridge never issued (or already cancelled)
        // must not throw and must not resurrect `busy`.
        fakeHost.requestReplied("req-unknown", "settings.describe", true, ({}), "")
        compare(bridge.busy, false)
    }

    function test_cancelForgetsTheCallbackAndAsksTheHost() {
        var called = 0
        var id = bridge.describe("", function () { called += 1 })

        compare(bridge.cancel(id), true)
        compare(fakeHost.cancelled.length, 1)
        compare(fakeHost.cancelled[0], id)
        compare(bridge.busy, false)

        // The reply that may still arrive later finds no callback.
        fakeHost.requestReplied(id, "settings.describe", true, { "revision": 1 }, "")
        compare(called, 0)
        compare(bridge.revision, -1)
    }

    function test_discoverPassesTheOneShotKeyThrough() {
        bridge.discover({ "settingsNs": "llm", "provider": "deepseek",
                          "apiKey": "sk-live-QML-ONLY-1", "operationId": "op-1" }, function () {})

        compare(fakeHost.lastMethod, "llm.models.discover")
        compare(fakeHost.lastParams.settingsNs, "llm")
        compare(fakeHost.lastParams.apiKey, "sk-live-QML-ONLY-1")
        compare(fakeHost.lastParams.operationId, "op-1")

        // The bridge keeps no copy of its own: nothing in its public state
        // carries the key after the request has been handed to the host.
        verify(JSON.stringify(bridge.providers).indexOf("sk-live-QML-ONLY-1") === -1)
        verify(bridge.lastError.indexOf("sk-live-QML-ONLY-1") === -1)
    }

    function test_credentialWritesUseTheOfficialMethodNames() {
        bridge.describeCredential("DEEPSEEK_API_KEY", function () {})
        compare(fakeHost.lastMethod, "cred.describe")
        compare(fakeHost.lastParams.ref, "DEEPSEEK_API_KEY")

        bridge.setCredential("DEEPSEEK_API_KEY", "sk-live-DRAFT-2", function () {})
        compare(fakeHost.lastMethod, "cred.set")
        compare(fakeHost.lastParams.value, "sk-live-DRAFT-2")

        bridge.unsetCredential("DEEPSEEK_API_KEY", function () {})
        compare(fakeHost.lastMethod, "cred.unset")
        compare(fakeHost.lastParams.ref, "DEEPSEEK_API_KEY")
    }

    function test_mutateForwardsOpsAndRevision() {
        var ops = [{ "op": "set", "path": ["theme", "mode"], "value": "dark" }]
        bridge.mutate("ui", ops, 4, function () {})

        compare(fakeHost.lastMethod, "settings.mutate")
        compare(fakeHost.lastParams.ns, "ui")
        compare(fakeHost.lastParams.ops.length, 1)
        compare(fakeHost.lastParams.expectedRevision, 4)
    }

    function test_noHostDegradesToUnavailable() {
        bridge.host = null

        var outcome = { ok: null, error: "" }
        var id = bridge.describe("", function (ok, result, error) {
            outcome.ok = ok
            outcome.error = String(error)
        })

        compare(id, "")
        compare(outcome.ok, false)
        verify(outcome.error.indexOf("not attached") !== -1)
        compare(bridge.busy, false)
    }
}