// CodeBlock.qml — fenced/indented code blocks and inline code spans.
//
// One component covers both roles because the AST uses a single `code` token with
// an `inline` flag:
//
//   role "block"   → a bordered, horizontally scrollable monospace panel
//   role "inline"  → no visual body at all; `markup` yields <code>…</code> for the
//                    surrounding paragraph's StyledText run
//
// SYNTAX HIGHLIGHTING (Phase 2d). The colouring itself lives in TypeScript
// (src/highlight/), behind `ctx.qtRenderer.highlightCode()`, per decision D1:
// Shiki when the host has it, the built-in tokenizer otherwise, and anything over
// `maxHighlightChars` comes back uncoloured instead of being tokenized. This file
// only asks for the markup and paints it.
//
// Two details matter for correctness:
//   * the request is asynchronous, so a late answer for a *previous* node must not
//     overwrite the current one — `highlightGeneration` guards that;
//   * when no renderer is available (qmltestrunner, or a host without the service)
//     the block stays plain text rather than empty.
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

    // ---- highlighting ------------------------------------------------------

    /** Test/host seam: a stand-in for ctx.qtRenderer. */
    property var rendererOverride: null

    /** The Cordis renderer service, when the host published one. */
    readonly property var renderer: root.rendererOverride !== null && root.rendererOverride !== undefined
                                    ? root.rendererOverride
                                    : ((typeof ctx !== "undefined" && ctx.qtRenderer) ? ctx.qtRenderer : null)

    /** Colour scheme to ask for; follows the active theme. */
    readonly property string scheme: {
        if (root.theme !== null && root.theme !== undefined && root.theme.appearance !== undefined)
            return String(root.theme.appearance) === "light" ? "light" : "dark"
        if (root.theme !== null && root.theme !== undefined && root.theme.themeId !== undefined)
            return String(root.theme.themeId) === "light" ? "light" : "dark"
        return "dark"
    }

    /** Highlighted rich text, or "" while there is nothing to paint. */
    property string highlightedMarkup: ""

    /** Guards against a stale asynchronous answer overwriting a newer node. */
    property int highlightGeneration: 0

    /** True when the panel is showing coloured markup rather than plain text. */
    readonly property bool isHighlighted: root.highlightedMarkup !== ""

    function requestHighlight() {
        root.highlightGeneration += 1
        const generation = root.highlightGeneration
        root.highlightedMarkup = ""

        if (root.inlineCode || root.renderer === null || root.content.length === 0)
            return

        let answer = null
        try {
            answer = root.renderer.highlightCode(root.content, root.language, { "theme": root.scheme })
        } catch (error) {
            // A renderer that throws simply leaves the block plain.
            return
        }

        const apply = function (markup) {
            if (generation !== root.highlightGeneration)
                return
            root.highlightedMarkup = (markup === null || markup === undefined) ? "" : String(markup)
        }

        // The service returns a Promise; a synchronous stand-in returns a string.
        if (answer !== null && answer !== undefined && typeof answer.then === "function")
            answer.then(apply).catch(function () { apply("") })
        else
            apply(answer)
    }

    onContentChanged: root.requestHighlight()
    onLanguageChanged: root.requestHighlight()
    onRendererChanged: root.requestHighlight()
    onSchemeChanged: root.requestHighlight()
    Component.onCompleted: root.requestHighlight()

    // ---- chrome ------------------------------------------------------------

    visible: !root.inlineCode
    implicitWidth: root.inlineCode ? 0 : panel.implicitWidth
    implicitHeight: root.inlineCode ? 0 : panel.implicitHeight

    Rectangle {
        id: panel
        objectName: "markdownCodePanel"
        visible: !root.inlineCode
        width: parent.width
        height: codeText.contentHeight + 2 * root.base.tokens.spacing
        color: root.base.tokens.codeBackground !== undefined ? root.base.tokens.codeBackground : root.base.tokens.surfaceAlt
        radius: root.base.tokens.radius
        border.width: 1
        border.color: root.base.tokens.codeBorder !== undefined ? root.base.tokens.codeBorder : root.base.tokens.border

        Flickable {
            id: scroller
            objectName: "markdownCodeScroller"
            anchors.fill: parent
            anchors.margins: root.base.tokens.spacing
            contentWidth: codeText.contentWidth
            contentHeight: codeText.contentHeight
            clip: true
            flickableDirection: Flickable.HorizontalFlick
            boundsBehavior: Flickable.StopAtBounds

            // A read-only TextEdit rather than a Text: it renders the same rich text
            // and additionally lets the user select and copy the snippet, which is
            // what people actually do with a code block in a chat transcript.
            TextEdit {
                id: codeText
                objectName: "markdownCodeText"
                // Coloured markup when the highlighter answered, the source verbatim
                // otherwise. `plainText` keeps the raw source available to callers.
                text: root.isHighlighted ? root.highlightedMarkup : root.content
                textFormat: root.isHighlighted ? TextEdit.RichText : TextEdit.PlainText
                readOnly: true
                selectByMouse: true
                // Monospace, no wrapping: code keeps its own line structure and the
                // panel scrolls sideways instead of re-flowing it.
                font.family: "monospace"
                font.pixelSize: root.base.tokens.fontNormal
                color: root.base.tokens.text
                wrapMode: TextEdit.NoWrap
                width: Math.max(scroller.width, contentWidth)
                height: contentHeight
                // TextEdit paints its own background only when asked to; the panel
                // already draws the chrome.
                selectByKeyboard: true

                /** The unhighlighted source, for tests and copy-to-clipboard. */
                readonly property string plainText: root.content
            }
        }
    }

    /** Language badge text ("ts"), or "" when the fence had no info string. */
    readonly property string languageLabel: root.language.length > 0 ? root.language : ""
}
