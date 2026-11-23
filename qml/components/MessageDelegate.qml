// MessageDelegate.qml — one row of the chat flow.
//
// Phase 1c rendered plain text in a role-dependent bubble. Phase 2 renders the
// body through qml/markdown/Markdown.qml when the model carries a parsed
// MarkdownNode document (`markdown` role) and keeps the plain-text Label as the
// fallback, so a model filled by hand — or a reply whose parse has not finished —
// still renders.
//
// The import is one-way on purpose: this file imports qml/markdown/, and no file
// under qml/markdown/ imports qml/components/, which would be a cycle.
import QtQuick
import QtQuick.Controls
import "../markdown"

Item {
    id: delegate

    // ---- Model roles (auto-populated by the ListView) ----------------------
    required property string role
    required property string text
    required property string timestamp
    required property bool pending
    /** Optional MarkdownNode document for the body; null/undefined = plain text. */
    required property var markdown

    /** Emitted when the user activates a link inside the body. */
    signal linkActivated(string href)

    /**
     * In-place document override for a streaming reply.
     *
     * While an assistant reply streams in, the body is updated through
     * `replace()` / `applyStreamSnapshot()` instead of round-tripping through the
     * model: a model write re-evaluates the role and the whole delegate, which is
     * exactly what streaming must avoid. Null means "use the `markdown` role".
     */
    property var streamDocument: null

    // ---- Styling ----------------------------------------------------------
    /**
     * Live theme source published by native/main.cpp as `ctx.theme`.
     *
     * Declared per component (not only in Theme.qml) because a component may be
     * instantiated on its own — a QML test, a settings preview — and it must
     * still follow the live palette. When a parent injects its own `theme`, that
     * instance already carries the bridge and this one is simply unused.
     */
    // qmllint disable unqualified
    readonly property QtObject themeBridge: (typeof ctx !== "undefined" && ctx.theme) ? ctx.theme : null
    // qmllint enable unqualified
    property Theme theme: Theme { bridge: delegate.themeBridge }

    readonly property bool fromUser: delegate.role === "user"
    readonly property bool fromSystem: delegate.role === "system"
    readonly property bool fromTool: delegate.role === "tool"

    readonly property color bubbleColor: {
        if (delegate.fromUser)
            return delegate.theme.surfaceAccent
        if (delegate.fromSystem)
            return delegate.theme.surface
        return delegate.theme.surfaceAlt
    }

    readonly property string roleLabel: {
        if (delegate.fromUser)
            return qsTr("You")
        if (delegate.fromSystem)
            return qsTr("System")
        if (delegate.fromTool)
            return qsTr("Tool")
        return qsTr("Assistant")
    }

    /**
     * True when the model supplied a parsed document worth rendering.
     *
     * An empty document is treated as "no markdown" so a reply whose parse
     * produced nothing still shows its plain text instead of a blank bubble.
     */
    readonly property var bodyDocument: delegate.streamDocument !== null
                                       ? delegate.streamDocument
                                       : delegate.markdown

    readonly property bool hasMarkdown: {
        const node = delegate.bodyDocument
        if (node === null || node === undefined)
            return false
        if (typeof node !== "object")
            return false
        if (node.type === "document")
            return node.children !== undefined && node.children !== null
                   && node.children.length > 0
        return true
    }

    // The bubble never fills the full row: chat bubbles read better at ~86% and
    // the width is a pure function of the delegate width, so no binding loop.
    implicitHeight: bubble.implicitHeight
    implicitWidth: delegate.width

    Rectangle {
        id: bubble
        width: Math.round(delegate.width * 0.86)
        // User turns hug the right edge, everything else the left edge.
        anchors.left: delegate.fromUser ? undefined : delegate.left
        anchors.right: delegate.fromUser ? delegate.right : undefined
        implicitHeight: content.implicitHeight + 2 * delegate.theme.spacing
        radius: delegate.theme.radiusLarge
        color: delegate.bubbleColor
        border.width: delegate.fromTool ? 1 : 0
        border.color: delegate.theme.border

        Column {
            id: content
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.margins: delegate.theme.spacingLarge
            spacing: 4

            Row {
                spacing: delegate.theme.spacing

                Label {
                    text: delegate.roleLabel
                    color: delegate.theme.textMuted
                    font.pixelSize: delegate.theme.fontSmall
                    font.bold: true
                }

                Label {
                    text: delegate.pending ? qsTr("streaming…") : delegate.timestamp
                    color: delegate.theme.textMuted
                    font.pixelSize: delegate.theme.fontSmall
                }
            }

            // Structured body. Column/Row skip invisible children, so exactly one
            // of the two body items contributes to the layout.
            Markdown {
                id: markdownBody
                objectName: "messageMarkdownBody"
                width: content.width
                visible: delegate.hasMarkdown
                document: delegate.bodyDocument
                theme: delegate.theme
                onLinkActivated: function(href) { delegate.linkActivated(href) }
            }

            Label {
                id: plainBody
                objectName: "messagePlainBody"
                width: content.width
                visible: !delegate.hasMarkdown
                text: delegate.text
                color: delegate.theme.text
                font.pixelSize: delegate.theme.fontNormal
                wrapMode: Text.Wrap
                textFormat: Text.PlainText
            }
        }
    }

    // ---- streaming API -----------------------------------------------------

    /**
     * Replace the rendered body in place.
     *
     * Accepts either a full document node (a reset or a correction) or a
     * `StreamSnapshot` from `DeltaMarkdownParser`, whose `updates` are mirrored
     * onto the existing blocks so only the changed row re-renders.
     *
     * @returns true when something was applied
     */
    function replace(markdown) {
        if (markdown === null || markdown === undefined) {
            delegate.streamDocument = null
            return false
        }
        if (markdown.updates !== undefined && markdown.updates !== null)
            return delegate.applyStreamSnapshot(markdown) >= 0
        if (markdown.type === "document") {
            delegate.streamDocument = markdown
            markdownBody.replaceDocument(markdown)
            return true
        }
        return false
    }

    /** Apply one streaming snapshot to the body. Returns the number of updates. */
    function applyStreamSnapshot(snapshot) {
        if (snapshot === null || snapshot === undefined)
            return 0
        if (snapshot.document !== undefined && snapshot.document !== null) {
            // Keep the fallback flag in sync: an empty document means plain text.
            delegate.streamDocument = snapshot.document
        }
        return markdownBody.applySnapshot(snapshot)
    }

    /** Update a single block by id; true when the id existed. */
    function replaceNode(nodeId, node) {
        return markdownBody.updateNode(nodeId, node)
    }

    /** Append one block; returns the id used. */
    function appendNode(node, nodeId) {
        return markdownBody.appendNode(node, nodeId)
    }

    /** Remove one block by id. */
    function removeNode(nodeId) {
        return markdownBody.removeNode(nodeId)
    }

    /** Drop the streaming override and go back to the `markdown` role. */
    function clearStream() {
        delegate.streamDocument = null
        markdownBody.streaming = false
    }
}
