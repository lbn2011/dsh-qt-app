// CodeBlock.qml — fenced/indented code blocks and inline code spans.
//
// One component covers both roles because the AST uses a single `code` token with
// an `inline` flag:
//
//   role "block"   → a bordered, horizontally scrollable monospace panel
//   role "inline"  → no visual body at all; `markup` yields <code>…</code> for the
//                    surrounding paragraph's StyledText run
//
// NO SYNTAX HIGHLIGHTING HERE. That is t13 (Phase 2d): this file only has to keep
// the structure, the language label and the plain-text fallback correct, and
// t13 will replace the body of the Text with highlighted spans.
import QtQuick

Item {
    id: root

    // ---- MarkdownNode role properties --------------------------------------
    property var node: null
    property string type: "code"
    property string role: "block"
    property string content: root.node !== null && root.node !== undefined && root.node.value !== undefined
                             ? String(root.node.value)
                             : ""
    property var children: []

    /** Info string of the fence ("ts", "qml", …); empty for indented blocks. */
    property string language: root.node !== null && root.node !== undefined && root.node.language !== undefined
                              ? String(root.node.language)
                              : ""

    property var theme: null

    readonly property MarkdownBase base: MarkdownBase {
        node: root.node
        content: root.content
        theme: root.theme
    }

    /** True when this instance represents an inline span rather than a panel. */
    readonly property bool inlineCode: root.role === "inline"
                                       || (root.node !== null && root.node !== undefined && root.node.inline === true)

    /** StyledText markup for the inline role. */
    readonly property string markup: "<code>" + root.base.escapeText(root.content) + "</code>"

    // An inline span has no box of its own; the paragraph's Text renders it.
    visible: !root.inlineCode
    implicitWidth: root.inlineCode ? 0 : panel.implicitWidth
    implicitHeight: root.inlineCode ? 0 : panel.implicitHeight

    Rectangle {
        id: panel
        objectName: "markdownCodePanel"
        visible: !root.inlineCode
        width: parent.width
        height: codeText.implicitHeight + 2 * root.base.tokens.spacing
        color: root.base.tokens.codeBackground !== undefined ? root.base.tokens.codeBackground : root.base.tokens.surfaceAlt
        radius: root.base.tokens.radius
        border.width: 1
        border.color: root.base.tokens.codeBorder !== undefined ? root.base.tokens.codeBorder : root.base.tokens.border

        Flickable {
            id: scroller
            objectName: "markdownCodeScroller"
            anchors.fill: parent
            anchors.margins: root.base.tokens.spacing
            contentWidth: codeText.implicitWidth
            contentHeight: codeText.implicitHeight
            clip: true
            flickableDirection: Flickable.HorizontalFlick
            boundsBehavior: Flickable.StopAtBounds

            Text {
                id: codeText
                objectName: "markdownCodeText"
                text: root.content
                // Monospace, no wrapping: code keeps its own line structure and the
                // panel scrolls sideways instead of re-flowing it.
                font.family: "monospace"
                font.pixelSize: root.base.tokens.fontNormal
                color: root.base.tokens.text
                textFormat: Text.PlainText
                wrapMode: Text.NoWrap
            }
        }
    }

    /** Language badge text ("ts"), or "" when the fence had no info string. */
    readonly property string languageLabel: root.language.length > 0 ? root.language : ""
}
