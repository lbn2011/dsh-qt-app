// MarkdownInline.qml — one text run with inline formatting.
//
// Renders a list of inline AST nodes (text, strong, emphasis, strikethrough,
// inline code, links) as a SINGLE `Text` using StyledText markup. That is the
// only way to get correct paragraph flow: nested Text items would each wrap on
// their own, so a bold word in the middle of a sentence would break the line.
//
// The markup itself comes from MarkdownBase.markupForNode() — this file is the
// visual half (colour, font, wrapping, link colour), not the formatting rules.
import QtQuick

Text {
    id: root

    // ---- MarkdownNode role properties --------------------------------------
    property var node: null
    property string type: "inline"
    property string role: "inline"
    property string content: root.plainText
    property var children: root.nodes

    /** Inline nodes to render. */
    property var nodes: root.node !== null && root.node !== undefined
                        && root.node.children !== undefined && root.node.children !== null
                        ? root.node.children
                        : []

    /** Plain text to render when no AST is available. */
    property string plainText: ""

    /** Theme source (a Theme instance, a plain token object, or null). */
    property var theme: null

    /** Font size override; 0 means "use the theme's body size". */
    property int pixelSize: 0

    /** Force bold (headings); inline <b> inside the markup still works. */
    property bool bold: false

    readonly property MarkdownBase base: MarkdownBase {
        node: root.node
        nodes: root.nodes
        plainText: root.plainText
        theme: root.theme
    }

    /** The StyledText markup actually rendered — exposed for tests. */
    readonly property string markup: root.base.markup

    text: root.markup
    textFormat: Text.StyledText
    wrapMode: Text.Wrap
    color: root.base.tokens.text
    linkColor: root.base.tokens.accent
    font.family: root.base.tokens.fontFamily
    font.pixelSize: root.pixelSize > 0 ? root.pixelSize : root.base.tokens.fontNormal
    font.bold: root.bold

    // Text already declares `linkActivated(string link)`; the host decides what a
    // click means (Markdown.qml re-emits it). Nothing is opened from here, so a
    // stray click inside a test can never launch a browser.
}
