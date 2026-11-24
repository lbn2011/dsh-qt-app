// GeneratedNode.qml — draws one converted `NativeNode` from the Phase 3
// converter (`src/ui/converter.ts`).
//
// The converter turns a plugin's limited React render function into a small,
// closed set of native nodes; this file is the QML half of that contract. Every
// branch is deliberately dumb: a node carries text, a checked value or an
// action, never code. A node kind this file has no control for is drawn as the
// "unsupported control" notice instead of an empty gap, so a future converter
// addition degrades visibly rather than silently.
//
// Nested containers recurse through a Loader pointing back at this file. The
// recursion is bounded by the converter (MAX_DEPTH = 32, MAX_NODES = 5000), so a
// malformed tree cannot build an unbounded QML object tree.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "."

// Nested Repeater/RadioButton delegates reference this component's `root` id;
// `ComponentBehavior: Bound` keeps those ids resolvable for qmllint and at runtime.
pragma ComponentBehavior: Bound

Item {
    id: root

    /** One converted node: `{ kind, ... }`. */
    property var node: ({})

    /** Token source; a parent injects its own Theme instance. */
    property var theme: null

    /** False for read-only previews: controls render but cannot act. */
    property bool interactive: true

    /** Slot-level payload source, handed to every action unchanged. */
    property var slotContext: ({})

    /** Emitted for every user action: click, change or submit. */
    signal action(string event, var payload)

    readonly property string kind: (root.node !== null && root.node !== undefined
        && typeof root.node === "object" && root.node.kind !== undefined)
        ? String(root.node.kind)
        : ""

    readonly property color textColor: root.theme !== null ? root.theme.text : "#e6e6e6"
    readonly property color mutedColor: root.theme !== null ? root.theme.textMuted : "#9a9a9a"
    readonly property color accentColor: root.theme !== null ? root.theme.accent : "#4c8dff"
    readonly property color borderColor: root.theme !== null ? root.theme.border : "#3a3a3a"
    readonly property int fontSmall: root.theme !== null ? root.theme.fontSmall : 11
    readonly property int fontNormal: root.theme !== null ? root.theme.fontNormal : 13
    readonly property int fontLarge: root.theme !== null ? root.theme.fontLarge : 16
    readonly property int gap: root.theme !== null ? root.theme.spacing : 6
    readonly property int pad: root.theme !== null ? root.theme.spacingLarge : 10

    objectName: "generatedNode" + root.kind

    implicitWidth: 320
    implicitHeight: body.implicitHeight

    /** Render inline runs (`text`/`strong`/`emphasis`/`code`/`link`) as HTML. */
    function inlineHtml(inlines) {
        if (inlines === null || inlines === undefined || inlines.length === undefined)
            return ""
        var out = ""
        for (var index = 0; index < inlines.length; ++index) {
            var run = inlines[index]
            if (run === null || typeof run !== "object")
                continue
            var inner = root.inlineHtml(run.children)
            if (inner.length === 0 && run.text !== undefined && run.text !== null)
                inner = root.escapeHtml(String(run.text))
            switch (String(run.kind)) {
            case "strong":
                out += "<b>" + inner + "</b>"
                break
            case "emphasis":
                out += "<i>" + inner + "</i>"
                break
            case "code":
                out += "<code>" + inner + "</code>"
                break
            case "link":
                out += "<a href=\"" + root.escapeHtml(String(run.href)) + "\">" + inner + "</a>"
                break
            default:
                out += root.escapeHtml(String(run.text !== undefined ? run.text : ""))
                break
            }
        }
        return out
    }

    function escapeHtml(text) {
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
    }

    /** Payload sent with an action: the slot context keys the plugin supplied. */
    function actionPayload() {
        if (root.slotContext === null || typeof root.slotContext !== "object")
            return ({})
        var payload = {}
        for (var key in root.slotContext) {
            if (key === "theme" || key === "settings" || key === "pluginsBridge")
                continue
            payload[key] = root.slotContext[key]
        }
        return payload
    }

    function fire() {
        var declared = (root.node !== null && root.node !== undefined && root.node.action !== undefined
            && root.node.action !== null) ? root.node.action : null
        if (!root.interactive || root.node.disabled === true || declared === null)
            return
        root.action(String(declared.event), root.actionPayload())
    }

    // Change-style gestures are ignored for read-only previews and disabled
    // controls, exactly like clicks.
    function act(event, payload) {
        if (!root.interactive || root.node.disabled === true)
            return
        root.action(String(event), payload)
    }

    ColumnLayout {
        id: body

        width: root.width
        spacing: root.gap

        // ---- Text-ish nodes -------------------------------------------------
        Label {
            objectName: "generatedParagraph"
            visible: root.kind === "paragraph"
            Layout.fillWidth: true
            text: root.kind === "paragraph" ? root.inlineHtml(root.node.children) : ""
            textFormat: Text.RichText
            color: root.textColor
            font.pixelSize: root.fontNormal
            wrapMode: Text.Wrap
        }

        Label {
            objectName: "generatedHeading"
            visible: root.kind === "heading"
            Layout.fillWidth: true
            property int level: (root.kind === "heading" && root.node.level !== undefined)
                ? Number(root.node.level) : 2
            text: root.kind === "heading" ? root.inlineHtml(root.node.children) : ""
            textFormat: Text.RichText
            color: root.textColor
            font.pixelSize: level === 1 ? root.fontLarge + 4 : level === 2 ? root.fontLarge : root.fontNormal + 1
            font.bold: true
            wrapMode: Text.Wrap
        }

        Label {
            objectName: "generatedPre"
            visible: root.kind === "pre"
            Layout.fillWidth: true
            text: root.kind === "pre" ? String(root.node.text !== undefined ? root.node.text : "") : ""
            color: root.textColor
            font.family: (root.theme !== null && root.theme.fontFamily) ? root.theme.fontFamily : "monospace"
            font.pixelSize: root.fontSmall
            wrapMode: Text.Wrap
            padding: root.pad
            background: Rectangle {
                color: "transparent"
                border.color: root.borderColor
                radius: 4
            }
        }

        ColumnLayout {
            objectName: "generatedList"
            visible: root.kind === "list"
            Layout.fillWidth: true
            spacing: 2

            Repeater {
                model: (root.kind === "list" && root.node.items !== undefined) ? root.node.items : []

                Label {
                    required property var modelData
                    required property int index

                    objectName: "generatedListItem" + index
                    Layout.fillWidth: true
                    text: ((root.kind === "list" && root.node.ordered) ? (index + 1) + ". " : "• ")
                        + root.inlineHtml(modelData)
                    textFormat: Text.RichText
                    color: root.textColor
                    font.pixelSize: root.fontNormal
                    wrapMode: Text.Wrap
                }
            }
        }

        Rectangle {
            objectName: "generatedSeparator"
            visible: root.kind === "separator"
            Layout.fillWidth: true
            implicitHeight: 1
            color: root.borderColor
        }

        // ---- Layout container: recurse -------------------------------------
        ColumnLayout {
            objectName: "generatedContainer"
            visible: root.kind === "container"
            Layout.fillWidth: true
            spacing: root.kind === "container" && root.node.gap !== undefined ? Number(root.node.gap) : root.gap

            Repeater {
                model: (root.kind === "container" && root.node.children !== undefined) ? root.node.children : []

                Loader {
                    id: childLoader

                    required property var modelData
                    required property int index

                    objectName: "generatedChild" + index
                    Layout.fillWidth: true
                    Layout.preferredHeight: childLoader.implicitHeight
                    source: (root.kind === "container" && root.node.direction === "row")
                        ? "" : "GeneratedNode.qml"

                    onLoaded: childLoader.applyModel()
                    onModelDataChanged: childLoader.applyModel()

                    function applyModel() {
                        if (childLoader.item === null || childLoader.item === undefined)
                            return
                        childLoader.item.node = childLoader.modelData
                        childLoader.item.theme = root.theme
                        childLoader.item.interactive = root.interactive
                        childLoader.item.slotContext = root.slotContext
                        childLoader.item.action.connect(function (event, payload) {
                            root.action(event, payload)
                        })
                    }
                }
            }
        }

        // Row layouts take the same children into a horizontal arrangement.
        RowLayout {
            objectName: "generatedContainerRow"
            visible: root.kind === "container" && root.node.direction === "row"
            Layout.fillWidth: true
            spacing: root.gap

            Repeater {
                model: (root.kind === "container" && root.node.direction === "row"
                    && root.node.children !== undefined) ? root.node.children : []

                Loader {
                    id: rowChild

                    required property var modelData
                    required property int index

                    objectName: "generatedRowChild" + index
                    Layout.fillWidth: true
                    Layout.preferredHeight: rowChild.implicitHeight
                    source: "GeneratedNode.qml"

                    onLoaded: rowChild.applyModel()
                    onModelDataChanged: rowChild.applyModel()

                    function applyModel() {
                        if (rowChild.item === null || rowChild.item === undefined)
                            return
                        rowChild.item.node = rowChild.modelData
                        rowChild.item.theme = root.theme
                        rowChild.item.interactive = root.interactive
                        rowChild.item.slotContext = root.slotContext
                        rowChild.item.action.connect(function (event, payload) {
                            root.action(event, payload)
                        })
                    }
                }
            }
        }

        // ---- Leaf containers ------------------------------------------------
        Label {
            objectName: "generatedContainerLabel"
            visible: root.kind === "container" && root.node.children === undefined
            Layout.fillWidth: true
            text: qsTr("This slot has nothing to show yet.")
            color: root.mutedColor
            font.pixelSize: root.fontSmall
            wrapMode: Text.Wrap
        }

        // ---- Controls -------------------------------------------------------
        Button {
            objectName: "generatedButton"
            visible: root.kind === "button"
            Layout.fillWidth: true
            text: root.kind === "button" ? String(root.node.label !== undefined ? root.node.label : "") : ""
            enabled: root.interactive && !(root.kind === "button" && root.node.disabled === true)
            highlighted: root.kind === "button" && root.node.tone === "danger"
            onClicked: root.fire()
        }

        TextField {
            objectName: "generatedField"
            visible: root.kind === "field"
            Layout.fillWidth: true
            readonly property string control: (root.kind === "field" && root.node.control !== undefined)
                ? String(root.node.control) : "text"
            text: (root.kind === "field" && root.node.value !== undefined && root.node.value !== null)
                ? String(root.node.value) : ""
            placeholderText: (root.kind === "field" && root.node.placeholder !== undefined)
                ? String(root.node.placeholder) : ""
            enabled: root.interactive
                && !(root.kind === "field" && root.node.disabled === true)
            readOnly: root.kind !== "field" || root.node.readOnly === true
            echoMode: control === "password" ? TextInput.Password : TextInput.Normal
            maximumLength: (root.kind === "field" && root.node.maxLength !== undefined)
                ? Number(root.node.maxLength) : 32767
            onEditingFinished: {
                if (root.kind === "field")
                    root.act("change", { "value": text })
            }
        }

        ComboBox {
            objectName: "generatedSelect"
            visible: root.kind === "select"
            Layout.fillWidth: true
            readonly property var options: (root.kind === "select" && root.node.options !== undefined)
                ? root.node.options : []
            model: {
                var labels = []
                for (var index = 0; index < options.length; ++index)
                    labels.push(String(options[index].label))
                return labels
            }
            enabled: root.interactive
                && !(root.kind === "select" && root.node.disabled === true)
            currentIndex: {
                if (root.kind !== "select" || root.node.value === undefined)
                    return -1
                for (var index = 0; index < options.length; ++index) {
                    if (String(options[index].value) === String(root.node.value))
                        return index
                }
                return -1
            }
            onActivated: function (index) {
                if (root.kind !== "select" || index < 0 || index >= options.length)
                    return
                root.act("change", { "value": String(options[index].value) })
            }
        }

        CheckBox {
            objectName: "generatedCheckbox"
            visible: root.kind === "checkbox"
            Layout.fillWidth: true
            text: (root.kind === "checkbox" && root.node.label !== undefined)
                ? String(root.node.label) : ""
            checked: root.kind === "checkbox" && root.node.checked === true
            enabled: root.interactive
                && !(root.kind === "checkbox" && root.node.disabled === true)
            onToggled: {
                if (root.kind === "checkbox")
                    root.act("change", { "value": checked })
            }
        }

        ColumnLayout {
            objectName: "generatedRadiogroup"
            visible: root.kind === "radiogroup"
            Layout.fillWidth: true

            Repeater {
                model: (root.kind === "radiogroup" && root.node.options !== undefined)
                    ? root.node.options : []

                RadioButton {
                    required property var modelData
                    required property int index

                    objectName: "generatedRadio" + index
                    Layout.fillWidth: true
                    text: String(modelData.label)
                    checked: root.kind === "radiogroup" && root.node.value !== undefined
                        && String(root.node.value) === String(modelData.value)
                    enabled: root.interactive
                        && !(root.kind === "radiogroup" && root.node.disabled === true)
                    onClicked: {
                        if (root.kind === "radiogroup")
                            root.act("change", { "value": String(modelData.value) })
                    }
                }
            }
        }

        Slider {
            objectName: "generatedSlider"
            visible: root.kind === "slider"
            Layout.fillWidth: true
            from: (root.kind === "slider" && root.node.min !== undefined) ? Number(root.node.min) : 0
            to: (root.kind === "slider" && root.node.max !== undefined) ? Number(root.node.max) : 100
            stepSize: (root.kind === "slider" && root.node.step !== undefined) ? Number(root.node.step) : 1
            value: (root.kind === "slider" && root.node.value !== undefined) ? Number(root.node.value) : from
            enabled: root.interactive
                && !(root.kind === "slider" && root.node.disabled === true)
            onMoved: {
                if (root.kind === "slider")
                    root.act("change", { "value": value })
            }
        }

        // ---- Unknown / unsupported -----------------------------------------
        Label {
            objectName: "generatedUnsupported"
            visible: root.kind !== "" && !["paragraph", "heading", "pre", "list",
                "separator", "container", "button", "field", "select", "checkbox",
                "radiogroup", "slider"].includes(root.kind)
            Layout.fillWidth: true
            text: qsTr("This control (“%1”) has no Qt equivalent yet.").arg(root.kind)
            color: root.theme !== null ? root.theme.warning : "#e0a030"
            font.pixelSize: root.fontSmall
            wrapMode: Text.Wrap
        }
    }
}