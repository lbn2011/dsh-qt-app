// ApiKeyField.qml — one write-only credential row.
//
// The rules this component exists to enforce:
//
//   * a stored key is never read back: the Host has no API that returns it, and
//     this field only ever receives `configured`/`source`/`writable` facts;
//   * the text the user types is a *draft*: it lives in `draft`, is sent once by
//     `cred.set`, and is cleared as soon as the write succeeds;
//   * nothing here logs, and the draft is not bound into any persistent model.
//
// The field is deliberately not tied to a provider: the caller supplies the
// credential ref (the environment-style name the Host publishes, e.g.
// `DEEPSEEK_API_KEY`). Empty or blank drafts never leave the component.
pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: root

    objectName: "apiKeyField"

    /** SettingsBridge instance; a stub with the same methods is accepted. */
    property var settingsBridge: null

    /** Credential ref this row edits, e.g. "DEEPSEEK_API_KEY". */
    property string credentialRef: ""

    /** Row caption. */
    property string label: qsTr("API key")

    /** One-line help text shown under the caption. */
    property string description: ""

    /** Facts from `cred.describe`. */
    property bool configured: false
    property bool writable: false
    property string credentialSource: ""

    /** The uncommitted key. Never populated from a stored value. */
    property string draft: ""

    /** Short status line ("Stored", "Not stored", a failure …). */
    property string status: ""

    /** True while a describe/set/unset is in flight for this row. */
    property bool busy: false

    /**
     * Emitted after a successful write. The draft has already been cleared; the
     * argument is the ref, not the value.
     */
    signal committed(string ref)

    spacing: 6

    function bridgeAvailable() {
        return root.settingsBridge !== null && root.settingsBridge !== undefined
    }

    /** Re-read the configured/writable facts; safe to call at any time. */
    function refresh() {
        if (!bridgeAvailable() || root.credentialRef === "")
            return
        root.busy = true
        root.settingsBridge.describeCredential(root.credentialRef, function (ok, result) {
            root.busy = false
            if (!ok) {
                root.status = qsTr("Could not read this credential")
                return
            }
            root.configured = result && result.configured === true
            root.writable = result && result.writable === true
            root.credentialSource = result && result.source ? String(result.source) : ""
            root.status = root.configured
                ? (root.credentialSource !== "" ? qsTr("Stored (%1)").arg(root.credentialSource) : qsTr("Stored"))
                : qsTr("Not stored")
        })
    }

    /** Validate, submit the draft once, then forget it. */
    function save() {
        if (!bridgeAvailable() || root.credentialRef === "")
            return
        var value = String(root.draft)
        if (value.trim() === "") {
            root.status = qsTr("Enter a key first")
            return
        }
        root.busy = true
        root.settingsBridge.setCredential(root.credentialRef, value, function (ok, result) {
            root.busy = false
            // Drop the draft whatever happened: it is not kept for a retry, and a
            // failed write must not leave the key sitting in a text field.
            root.draft = ""
            input.text = ""
            if (!ok) {
                root.status = qsTr("Could not store the key")
                return
            }
            root.configured = true
            root.writable = result && result.writable === true
            root.status = qsTr("Stored")
            root.committed(root.credentialRef)
            root.refresh()
        })
    }

    /** Remove the stored credential (never reads it first). */
    function remove() {
        if (!bridgeAvailable() || root.credentialRef === "" || !root.configured)
            return
        root.busy = true
        root.settingsBridge.unsetCredential(root.credentialRef, function (ok) {
            root.busy = false
            if (!ok) {
                root.status = qsTr("Could not remove the key")
                return
            }
            root.configured = false
            root.credentialSource = ""
            root.status = qsTr("Not stored")
            root.committed(root.credentialRef)
        })
    }

    Component.onCompleted: root.refresh()

    onCredentialRefChanged: root.refresh()

    Label {
        Layout.fillWidth: true
        text: root.label
        font.bold: true
        color: "#e6e6e6"
    }

    Label {
        Layout.fillWidth: true
        visible: root.description !== ""
        text: root.description
        wrapMode: Text.Wrap
        color: "#8a8f98"
        font.pixelSize: 12
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 8

        TextField {
            id: input

            Layout.fillWidth: true
            objectName: "apiKeyDraft"
            enabled: !root.busy && root.writable
            placeholderText: root.configured ? qsTr("Enter a replacement key") : qsTr("Enter a key")
            echoMode: TextInput.Password
            selectByMouse: true
            onTextEdited: root.draft = input.text
        }

        Button {
            objectName: "apiKeySave"
            text: qsTr("Save")
            enabled: !root.busy && root.writable && root.draft.trim() !== ""
            onClicked: root.save()
        }

        Button {
            objectName: "apiKeyRemove"
            text: qsTr("Remove")
            enabled: !root.busy && root.writable && root.configured
            onClicked: root.remove()
        }
    }

    Label {
        Layout.fillWidth: true
        objectName: "apiKeyStatus"
        text: root.status
        wrapMode: Text.Wrap
        color: root.configured ? "#8fd18f" : "#8a8f98"
        font.pixelSize: 12
    }
}