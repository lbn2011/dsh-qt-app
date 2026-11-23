// ModelsForm.qml — the Models settings page.
//
// Three jobs, all through SettingsBridge.qml (which correlates the native
// `request`/`requestReplied` pair):
//
//   1. show the provider directory (`llm.providers.list`)
//   2. run a model discovery (`llm.models.discover`) — cancellable, with the API
//      key kept as a one-shot draft that is cleared when the call settles
//   3. read and set the default selection (`llm.default.get|set`)
//
// The page never persists a key itself and never displays a stored one; when a
// caller supplies `credentialRef`, the embedded ApiKeyField is the only writer,
// and it goes through `cred.set`/`cred.unset`.
pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: root

    objectName: "modelsForm"

    /** SettingsBridge instance, or null when previewing without a host. */
    property var settingsBridge: null

    /** Optional credential ref for a provider key; empty hides the field. */
    property string credentialRef: ""

    /** Credential refs are provider-managed names, shown verbatim. */
    property string credentialLabel: qsTr("Provider API key")

    /** Model discovery state. */
    property bool discovering: false
    property string operationId: ""
    property var models: []
    property string status: ""

    /** Draft key for *discovery only*; cleared as soon as the call settles. */
    property string discoveryKey: ""

    /** A provider id to preselect, when the caller has one. */
    property string initialProvider: ""

    spacing: 10

    function bridgeAvailable() {
        return root.settingsBridge !== null && root.settingsBridge !== undefined
    }

    function providerIds() {
        var ids = []
        for (var i = 0; i < root.providers.length; i += 1)
            ids.push(String(root.providers[i].id))
        return ids
    }

    function selectedProviderId() {
        if (root.providers.length === 0)
            return ""
        var index = Math.max(0, Math.min(providerBox.currentIndex, root.providers.length - 1))
        return String(root.providers[index].id)
    }

    function settingsNamespaceFor(providerId) {
        for (var i = 0; i < root.providers.length; i += 1) {
            if (String(root.providers[i].id) === String(providerId) && root.providers[i].settingsNs)
                return String(root.providers[i].settingsNs)
        }
        return ""
    }

    function reload() {
        if (!bridgeAvailable())
            return
        root.settingsBridge.loadProviders(function (ok) {
            if (!ok) {
                root.status = qsTr("Provider list unavailable")
                return
            }
            root.applyInitialProvider()
        })
        root.settingsBridge.loadDefault()
    }

    function applyInitialProvider() {
        if (root.initialProvider === "")
            return
        var index = root.providerIds().indexOf(root.initialProvider)
        if (index >= 0)
            providerBox.currentIndex = index
    }

    function startDiscovery() {
        if (!bridgeAvailable() || root.discovering)
            return
        var providerId = root.selectedProviderId()
        var settingsNs = root.settingsNamespaceFor(providerId)
        if (settingsNs === "") {
            root.status = qsTr("This provider exposes no settings namespace")
            return
        }
        var params = { "settingsNs": settingsNs }
        if (providerId !== "")
            params["provider"] = providerId
        if (baseUrlField.text.trim() !== "")
            params["baseURL"] = baseUrlField.text.trim()
        // One-shot key: the local variable is the only reference we keep.
        var draftKey = String(root.discoveryKey)
        if (draftKey !== "")
            params["apiKey"] = draftKey
        // Name the operation ourselves so Cancel can address it before the result
        // arrives (the server would otherwise mint an id we only learn at the end).
        root._discovers = root._discovers + 1
        var operationId = "qml-discover-" + root._discovers
        params["operationId"] = operationId
        root.operationId = operationId
        root.discovering = true
        root.status = qsTr("Discovering models…")
        root.settingsBridge.discover(params, function (ok, result, error) {
            root.discovering = false
            root.operationId = ""
            // The draft is single-use whether the call worked or not.
            root.discoveryKey = ""
            discoveryKeyField.text = ""
            if (!ok) {
                root.status = String(error).indexOf("cancelled") !== -1
                    ? qsTr("Discovery cancelled")
                    : qsTr("Discovery failed")
                return
            }
            root.models = result && result.models ? result.models : []
            root.status = qsTr("%1 model(s) discovered").arg(root.models.length)
        })
    }

    function cancelDiscovery() {
        if (!root.discovering)
            return
        if (root.operationId !== "")
            root.settingsBridge.cancelDiscover(root.operationId)
        else if (root.settingsBridge)
            root.settingsBridge.cancelAll()
        root.status = qsTr("Cancelling…")
    }

    function applyDefault() {
        if (!bridgeAvailable())
            return
        var selection = { "provider": root.selectedProviderId() }
        if (defaultModelField.text.trim() === "") {
            root.status = qsTr("Choose a model id first")
            return
        }
        selection["model"] = defaultModelField.text.trim()
        root.settingsBridge.saveDefault(selection, function (ok, result, error) {
            if (ok) {
                root.status = qsTr("Default model saved")
                return
            }
            root.status = String(error).indexOf("unsupported") !== -1
                ? qsTr("This profile does not persist a default model")
                : qsTr("Could not save the default model")
        })
    }

    /**
     * Monotonic counter for discovery operation ids (see `startDiscovery`).
     */
    property int _discovers: 0

    /** Providers, mirrored from the bridge. */
    property var providers: []

    Component.onCompleted: root.reload()

    onSettingsBridgeChanged: root.reload()

    Connections {
        target: root.settingsBridge

        function onProvidersChanged() {
            root.providers = root.settingsBridge.providers
            root.applyInitialProvider()
        }

        function onDefaultChanged() {
            var selection = root.settingsBridge.defaultSelection
            if (selection && selection.model)
                defaultModelField.text = String(selection.model)
        }
    }

    Label {
        Layout.fillWidth: true
        text: qsTr("Models")
        font.pixelSize: 18
        font.bold: true
        color: "#e6e6e6"
    }

    Label {
        Layout.fillWidth: true
        text: qsTr("Discover what a provider offers, then choose the default model.")
        wrapMode: Text.Wrap
        color: "#8a8f98"
        font.pixelSize: 12
    }

    GridLayout {
        Layout.fillWidth: true
        columns: 2
        columnSpacing: 10
        rowSpacing: 8

        Label { text: qsTr("Provider"); color: "#e6e6e6" }

        ComboBox {
            id: providerBox

            objectName: "modelsProviderBox"
            Layout.fillWidth: true
            model: root.providers
            textRole: "name"
            valueRole: "id"
            enabled: !root.discovering && root.providers.length > 0
            onActivated: root.status = ""
        }

        Label { text: qsTr("Base URL"); color: "#e6e6e6" }

        TextField {
            id: baseUrlField

            objectName: "modelsBaseUrl"
            Layout.fillWidth: true
            placeholderText: qsTr("Optional override, https://…")
            enabled: !root.discovering
        }

        Label { text: qsTr("Discovery key"); color: "#e6e6e6" }

        TextField {
            id: discoveryKeyField

            objectName: "modelsDiscoveryKey"
            Layout.fillWidth: true
            placeholderText: qsTr("Optional, used once and forgotten")
            echoMode: TextInput.Password
            enabled: !root.discovering
            onTextEdited: root.discoveryKey = discoveryKeyField.text
        }
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 8

        Button {
            objectName: "modelsDiscover"
            text: qsTr("Discover")
            enabled: !root.discovering && root.providers.length > 0
            onClicked: root.startDiscovery()
        }

        Button {
            objectName: "modelsCancel"
            text: qsTr("Cancel")
            enabled: root.discovering
            onClicked: root.cancelDiscovery()
        }

        Item { Layout.fillWidth: true }

        Label {
            objectName: "modelsStatus"
            text: root.status
            color: "#8a8f98"
            font.pixelSize: 12
        }
    }

    ListView {
        id: modelList

        Layout.fillWidth: true
        Layout.preferredHeight: 150
        visible: root.models.length > 0
        clip: true
        model: root.models
        spacing: 2

        delegate: ItemDelegate {
            id: modelRow

            required property var modelData
            required property int index

            width: modelList.width
            text: String(modelRow.modelData.id)
                + (modelRow.modelData.contextWindow ? "  ·  " + modelRow.modelData.contextWindow + " ctx" : "")
            onClicked: {
                defaultModelField.text = String(modelRow.modelData.id)
                root.status = qsTr("Selected %1").arg(String(modelRow.modelData.id))
            }
        }
    }

    Label {
        Layout.fillWidth: true
        visible: root.models.length === 0
        text: qsTr("No models discovered yet.")
        color: "#8a8f98"
        font.pixelSize: 12
    }

    Rectangle {
        Layout.fillWidth: true
        Layout.preferredHeight: 1
        color: "#2f3138"
    }

    Label {
        Layout.fillWidth: true
        text: qsTr("Default model")
        font.bold: true
        color: "#e6e6e6"
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 8

        TextField {
            id: defaultModelField

            objectName: "modelsDefaultModel"
            Layout.fillWidth: true
            placeholderText: qsTr("Model id")
        }

        Button {
            objectName: "modelsApplyDefault"
            text: qsTr("Use as default")
            enabled: root.providers.length > 0
            onClicked: root.applyDefault()
        }
    }

    ApiKeyField {
        Layout.fillWidth: true
        visible: root.credentialRef !== ""
        settingsBridge: root.settingsBridge
        credentialRef: root.credentialRef
        label: root.credentialLabel
        description: qsTr("Stored through the Host credentials API; it is never read back.")
    }
}