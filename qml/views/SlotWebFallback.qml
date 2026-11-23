// SlotWebFallback.qml — what a slot shows when it cannot be drawn natively.
//
// The converter (src/ui/converter.ts) answers one of three things for a slot:
//
//   { status: "native", tree }            → SlotForms/controls draw it
//   { status: "web",    reason }          → this component: offer the WebUI
//   { status: "text",   reason, text }    → this component: show the text
//
// Three rules, all of them about not lying to the user:
//
//   1. **Never blank.** A slot that could not be converted still shows something:
//      either the readable text the converter salvaged, or an explicit notice.
//      An empty panel reads as "this plugin does nothing", which is false.
//   2. **Name the reason.** The F-code is shown in muted text so a bug report can
//      quote it; the friendly sentence above it is what the user reads.
//   3. **The fallback is offered, not assumed.** `status: "text"` does not mean a
//      web entry exists — only `status: "web"` carries a URL. The button appears
//      only when there is somewhere to go.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

Item {
    id: root

    objectName: "slotWebFallback"

    // qmllint disable unqualified
    readonly property QtObject themeBridge: (typeof ctx !== "undefined" && ctx.theme) ? ctx.theme : null
    // qmllint enable unqualified

    /** Token source; a parent may inject its own instance. */
    property Theme theme: Theme { bridge: root.themeBridge }

    /** The conversion result to explain. Null means "nothing arrived yet". */
    property var conversion: null

    /** Shown above the notice so the user knows which plugin this is. */
    property string slotTitle: ""

    /** The slot this belongs to; echoed back on `openRequested`. */
    property string slotId: ""

    /**
     * The host's full WebUI root URL, when one is available.
     *
     * P3: a slot-level entry is preferred; when a plugin has no web entry of its
     * own the honest fallback is the *whole* WebUI — not a dead end. The caller
     * supplies this URL (it knows whether a web host is running), and this
     * component says plainly that the slot will not be located there.
     */
    property string fullWebuiUrl: ""

    /** Emitted when the user asks for the WebUI; the host decides how to open it. */
    signal openRequested(string slotId, string url)

    readonly property bool hasConversion: root.conversion !== null
        && typeof root.conversion === "object"

    readonly property string status: root.hasConversion ? String(root.conversion.status ?? "") : ""

    /** Only a `web` result carries a URL; a `text` result does not. */
    readonly property string webUrl: {
        if (!root.hasConversion)
            return ""
        const entry = root.conversion.webEntry
        if (entry !== undefined && entry !== null && String(entry.kind) === "declared")
            return String(entry.url ?? "")
        return ""
    }

    /** A slot-level entry exists: open exactly this slot. */
    readonly property bool canOpenSlot: root.webUrl !== ""

    /** No slot-level entry, but the host has a WebUI: open it at the root. */
    readonly property bool canOpenPanel: !root.canOpenSlot && root.fullWebuiUrl !== ""

    readonly property string reasonCode: root.hasConversion
        && root.conversion.reason !== undefined && root.conversion.reason !== null
        ? String(root.conversion.reason.code ?? "") : ""

    readonly property string reasonName: root.hasConversion
        && root.conversion.reason !== undefined && root.conversion.reason !== null
        ? String(root.conversion.reason.name ?? "") : ""

    readonly property string reasonDetail: root.hasConversion
        && root.conversion.reason !== undefined && root.conversion.reason !== null
        ? String(root.conversion.reason.detail ?? "") : ""

    readonly property string fallbackText: root.hasConversion
        ? String(root.conversion.text ?? "") : ""

    readonly property string headline: {
        if (root.status === "web")
            return qsTr("This part of the plugin needs the WebUI.")
        if (root.status === "text")
            return qsTr("This part of the plugin cannot be shown in the Qt interface.")
        return qsTr("Nothing to show yet.")
    }

    implicitHeight: layout.implicitHeight

    ColumnLayout {
        id: layout

        anchors.fill: parent
        anchors.margins: root.theme.spacingLarge
        spacing: root.theme.spacing

        Text {
            objectName: "slotFallbackTitle"

            visible: root.slotTitle !== ""
            text: root.slotTitle
            color: root.theme.text
            font.pixelSize: root.theme.fontLarge
            font.bold: true
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }

        Text {
            objectName: "slotFallbackHeadline"

            text: root.headline
            color: root.theme.text
            font.pixelSize: root.theme.fontNormal
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }

        // The salvaged text: what the plugin wanted to say, minus the structure
        // that could not be converted.
        Text {
            objectName: "slotFallbackText"

            visible: root.status === "text" && root.fallbackText !== ""
            text: root.fallbackText
            color: root.theme.textMuted
            font.pixelSize: root.theme.fontNormal
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }

        // The machine-readable reason, muted: for bug reports, not for reading.
        Text {
            objectName: "slotFallbackReason"

            visible: root.reasonCode !== ""
            text: root.reasonCode + (root.reasonName === "" ? "" : " " + root.reasonName)
                + (root.reasonDetail === "" ? "" : " — " + root.reasonDetail)
            color: root.theme.textMuted
            font.pixelSize: root.theme.fontSmall
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }

        // Slot-level entry: the preferred path (P3 first half).
        Button {
            objectName: "slotFallbackOpenButton"

            visible: root.canOpenSlot
            text: qsTr("Open this plugin in the WebUI")
            onClicked: root.openRequested(root.slotId, root.webUrl)
        }

        // Panel-level fallback: the WebUI exists but cannot be pointed at this
        // slot, so say that before opening it (P3 second half).
        Text {
            objectName: "slotFallbackPanelNotice"

            visible: root.canOpenPanel
            text: qsTr("This slot cannot be opened directly, so the WebUI will open at its home screen instead.")
            color: root.theme.textMuted
            font.pixelSize: root.theme.fontSmall
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }

        Button {
            objectName: "slotFallbackOpenPanelButton"

            visible: root.canOpenPanel
            text: qsTr("Open the full WebUI")
            onClicked: root.openRequested(root.slotId, root.fullWebuiUrl)
        }

        // Nothing to open at all: say so plainly instead of offering a button
        // that would do nothing.
        Text {
            objectName: "slotFallbackNoWebEntry"

            visible: root.hasConversion && !root.canOpenSlot && !root.canOpenPanel
            text: qsTr("This plugin does not ship a web version and no WebUI is available, so there is nowhere to open it.")
            color: root.theme.textMuted
            font.pixelSize: root.theme.fontSmall
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }

        Item { Layout.fillHeight: true }
    }
}
