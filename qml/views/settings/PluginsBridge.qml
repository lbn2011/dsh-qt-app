// PluginsBridge.qml — the settings panel's view of the plugin manager (I4).
//
// This object owns no UI. It turns the panel's intent ("disable acme", "install
// acme@1.2.3") into `plugin.*` bridge calls and keeps the rows Qt draws in sync
// with what the host answered. Keeping it separate from the panel is what lets
// the panel stay a pure layout: it binds to `rows` and calls a function.
//
// Four rules that the code below is built around:
//
//   1. **The host is the only source of truth.** `ChangeResult` is displayed as
//      it arrived; this file never recomputes `application` or `restartReason`.
//      A second opinion here would disagree with the manager.
//   2. **Long operations are not awaited.** `plugin.install/update/remove`
//      answer with an `opId` immediately; `busy` stays true until the operation
//      settles. The panel must not offer a second install while one runs.
//   3. **Events are an optimisation, not a requirement.** The native shell
//      forwards host events only once `main.cpp` re-emits `evt` frames; until
//      then this object re-fetches after every settled operation, so the list is
//      correct either way. `ignoreUnknownSignals` is what makes that safe.
//   4. **A failure is a value, not an exception.** `lastError` and `failed()`
//      carry the message; the panel shows it inline and keeps working.
import QtQuick

QtObject {
    id: root

    objectName: "pluginsBridge"

    /** The Qt bridge (DshQtBridge). Null means the host is not attached yet. */
    property var qtBridge: null

    /** Rows from `plugin.list`, exactly as the official manager produced them. */
    property var rows: []

    /** Bundle rows from `plugin.bundles`; empty when the host has no such method. */
    property var bundles: []

    /** False once the host answered that it has no `listBundles()`. */
    property bool bundlesAvailable: true

    /** Slot contributions from `slot.list`. */
    property var slots: []

    /** True while a read is in flight. */
    property bool loading: false

    /** The current long operation: `{ opId, phase }`; empty when idle. */
    property var operation: ({})

    /** Last human-readable failure; empty when the last call succeeded. */
    property string lastError: ""

    /** True while an install/update/remove is running; the panel disables actions. */
    readonly property bool busy: {
        const phase = root.operation ? String(root.operation.phase ?? "") : ""
        return phase === "installing" || phase === "cancelling"
    }

    /** Emitted whenever `rows` or `bundles` were refreshed. */
    signal changed()

    /** Emitted when a slot list arrived. */
    signal slotListChanged()

    /** Emitted when a call failed; `message` is shown to the user. */
    signal failed(string message)

    /** Emitted when an operation changed phase. */
    signal operationPhaseChanged(string opId, string phase)

    /** Emitted with a conversion result from `ui.render` / `ui.action`. */
    signal rendered(string slotId, var result)

    /** Emitted when the host reported a control it cannot draw (P1). */
    signal unsupportedControl(string slotId, string type)

    // A QtObject root has no default property, so the private state lives on an
    // explicit property rather than as an anonymous child object.
    property QtObject internals: QtObject {
        id: internal

        // request id → { kind, slotId } so one reply funnel can route by method.
        property var pending: ({})
        property int nextToken: 0
    }

    // Same reason as `internals`: no default property on a QtObject root.
    property Connections bridgeConnections: Connections {
        target: root.qtBridge
        // The shell may not forward events yet; missing signals are not an error.
        ignoreUnknownSignals: true

        function onRequestReplied(id, method, ok, result, error) {
            const entry = internal.pending[String(id)]
            if (entry === undefined)
                return
            delete internal.pending[String(id)]

            if (!ok) {
                root.lastError = error === undefined || error === null || String(error) === ""
                    ? qsTr("The plugin manager did not answer.") : String(error)
                root.loading = false
                if (entry.kind === "render" || entry.kind === "action")
                    root.rendered(entry.slotId, null)
                root.failed(root.lastError)
                return
            }

            if (method === "plugin.list") {
                root.rows = result !== null && result !== undefined && Array.isArray(result) ? result : []
                root.loading = false
                root.lastError = ""
                root.changed()
            } else if (method === "plugin.bundles") {
                root.bundles = result !== null && result !== undefined && Array.isArray(result) ? result : []
                root.bundlesAvailable = true
                root.changed()
            } else if (method === "plugin.setEnabled" || method === "plugin.bundle.setEnabled") {
                root.noteChangeResult(result)
            } else if (method === "plugin.install" || method === "plugin.update"
                       || method === "plugin.remove") {
                const opId = result !== null && result !== undefined ? String(result.opId ?? "") : ""
                root.operation = ({ "opId": opId, "phase": "installing" })
                root.operationPhaseChanged(opId, "installing")
            } else if (method === "plugin.op.cancel") {
                const cancelling = result !== null && result !== undefined && result.cancelling === true
                if (cancelling && root.operation) {
                    root.operation = ({ "opId": String(root.operation.opId ?? ""), "phase": "cancelling" })
                    root.operationPhaseChanged(String(root.operation.opId ?? ""), "cancelling")
                }
            } else if (method === "slot.list") {
                root.slots = result !== null && result !== undefined && Array.isArray(result.contributions)
                    ? result.contributions : []
                root.slotListChanged()
            } else if (method === "ui.render" || method === "ui.action") {
                root.rendered(entry.slotId, result)
            }
        }

        // Host → Qt events. Only arrives once the shell re-emits `evt` frames.
        function onEventReceived(name, payload) {
            const event = String(name)
            if (event === "plugin.changed") {
                root.refresh()
            } else if (event === "plugin.op.progress") {
                const phase = payload !== null && payload !== undefined ? String(payload.phase ?? "") : ""
                const opId = payload !== null && payload !== undefined ? String(payload.opId ?? "") : ""
                root.operation = ({ "opId": opId, "phase": phase })
                root.operationPhaseChanged(opId, phase)
                if (phase === "settled") {
                    root.operation = ({})
                    // Re-fetch rather than trusting a push: the list is the truth.
                    root.refresh()
                }
            } else if (event === "slot.changed") {
                root.refreshSlots("")
            } else if (event === "ui.unsupported") {
                if (payload !== null && payload !== undefined)
                    root.unsupportedControl(String(payload.slotId ?? ""), String(payload.type ?? ""))
            }
        }
    }

    /** Show the official `ChangeResult` without reinterpreting it. */
    function noteChangeResult(result) {
        const failedResult = result !== null && result !== undefined
            && String(result.application ?? "") === "failed"
        if (failedResult) {
            const code = result.error !== null && result.error !== undefined
                ? String(result.error.code ?? "") : ""
            const detail = result.error !== null && result.error !== undefined
                ? String(result.error.diagnostic ?? "") : ""
            root.lastError = code === "" ? qsTr("The change failed.") : code + (detail === "" ? "" : ": " + detail)
            root.failed(root.lastError)
            return
        }
        root.lastError = ""
        // `changed: false` means nothing on disk moved; re-listing is still cheap
        // and keeps the panel honest about the enabled state.
        root.refresh()
    }

    function send(method, params, entry) {
        if (root.qtBridge === null || root.qtBridge === undefined) {
            root.lastError = qsTr("The Qt host is not attached.")
            root.failed(root.lastError)
            return ""
        }
        internal.nextToken += 1
        const id = String(root.qtBridge.request(method, params === undefined ? ({}) : params))
        internal.pending[id] = entry === undefined ? ({ "kind": method }) : entry
        return id
    }

    function refresh() {
        root.loading = true
        root.send("plugin.list", ({}), ({ "kind": "list" }))
        if (root.bundlesAvailable)
            root.send("plugin.bundles", ({}), ({ "kind": "bundles" }))
    }

    function refreshSlots(surface) {
        root.send("slot.list", ({ "surface": String(surface ?? "") }), ({ "kind": "slots" }))
    }

    function setEnabled(id, enabled) {
        root.send("plugin.setEnabled", ({ "id": String(id), "enabled": enabled === true }),
                  ({ "kind": "toggle" }))
    }

    function setBundleEnabled(name, enabled) {
        root.send("plugin.bundle.setEnabled", ({ "name": String(name), "enabled": enabled === true }),
                  ({ "kind": "toggle" }))
    }

    function install(spec) {
        root.send("plugin.install", ({ "spec": String(spec) }), ({ "kind": "operation" }))
    }

    function update(name, version) {
        root.send("plugin.update", ({ "name": String(name), "version": String(version) }),
                  ({ "kind": "operation" }))
    }

    function remove(name) {
        root.send("plugin.remove", ({ "name": String(name) }), ({ "kind": "operation" }))
    }

    function cancel() {
        const opId = root.operation ? String(root.operation.opId ?? "") : ""
        if (opId === "")
            return
        root.send("plugin.op.cancel", ({ "opId": opId }), ({ "kind": "cancel" }))
    }

    function renderSlot(slotId, props) {
        root.send("ui.render", ({ "slotId": String(slotId), "props": props === undefined ? ({}) : props }),
                  ({ "kind": "render", "slotId": String(slotId) }))
    }

    function act(slotId, event, payload) {
        root.send("ui.action", ({
            "slotId": String(slotId),
            "event": String(event),
            "payload": payload === undefined ? ({}) : payload
        }), ({ "kind": "action", "slotId": String(slotId) }))
    }
}
