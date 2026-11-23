// tst_markdown.qml — Qt Quick Test suite for the markdown component tree.
//
// Verifies that Markdown.qml dispatches each block node type to the right
// component, that role properties match the MarkdownNode contract, that the
// plain-text fallback works without an AST, and that an unrecognised node
// degrades to escaped text instead of an empty gap.
import QtQuick
import QtTest
import "../../qml/markdown"

TestCase {
    id: testCase

    name: "Markdown"
    when: windowShown

    // A dark palette stand-in: the components must work with a plain token
    // object, not only with a live Theme.
    readonly property var tokens: ({
        "background": "#1b1c1f",
        "surface": "#24262b",
        "surfaceAlt": "#26272b",
        "surfaceAccent": "#2b3b57",
        "border": "#33363d",
        "text": "#e6e6e6",
        "textMuted": "#8a8f98",
        "accent": "#4c8dff",
        "codeBackground": "#15161a",
        "codeBorder": "#2c2f36",
        "fontFamily": "Inter",
        "fontSmall": 11,
        "fontNormal": 13,
        "fontLarge": 16,
        "fontTitle": 20,
        "spacing": 8,
        "spacingLarge": 12,
        "radius": 8,
        "radiusLarge": 12
    })

    Component {
        id: markdownComponent
        Markdown {
            width: 400
            theme: testCase.tokens
        }
    }

    function documentWith() {
        return { "type": "document", "children": Array.prototype.slice.call(arguments) }
    }

    function paragraph(text) {
        return { "type": "paragraph", "children": [{ "type": "text", "value": text }] }
    }

    function createMarkdown(doc) {
        const item = createTemporaryObject(markdownComponent, testCase)
        verify(item !== null, "Markdown must instantiate")
        item.document = doc
        return item
    }

    function test_rendersParagraph() {
        const view = createMarkdown(documentWith(paragraph("hello world")))
        tryCompare(view, "blockCount", 1)

        const text = findChild(view, "markdownParagraphText")
        verify(text !== null, "paragraph must expose its inline text item")
        compare(text.text, "hello world")
    }

    function test_rendersEveryBlockType() {
        const view = createMarkdown(documentWith(
            { "type": "heading", "level": 2, "children": [{ "type": "text", "value": "Title" }] },
            paragraph("body"),
            { "type": "code", "value": "const x = 1", "language": "js" },
            { "type": "thematicBreak" }
        ))
        tryCompare(view, "blockCount", 4)

        verify(findChild(view, "markdownHeadingText") !== null, "heading component rendered")
        verify(findChild(view, "markdownParagraphText") !== null, "paragraph component rendered")
        verify(findChild(view, "markdownCodeText") !== null, "code component rendered")
        verify(findChild(view, "markdownThematicBreak") !== null, "thematic break rendered")
    }

    function test_rolePropertiesMatchTheContract() {
        const view = createMarkdown(documentWith(
            { "type": "code", "value": "x", "language": "python" }
        ))
        tryCompare(view, "blockCount", 1)

        const block = findChild(view, "markdownBlock0").item
        verify(block !== null && block !== undefined, "block item must exist")
        compare(block.type, "code", "type mirrors the AST node type")
        compare(block.role, "block", "a fenced code block is a block-level node")
        compare(block.content, "x", "content mirrors the node literal")
        compare(block.language, "python", "language mirrors the fence info string")
    }

    function test_plainTextFallbackWithoutAst() {
        const view = createMarkdown(null)
        view.text = "**not** parsed"
        tryCompare(view, "blockCount", 1)

        const text = findChild(view, "markdownParagraphText")
        verify(text !== null, "fallback must synthesise a paragraph")
        compare(text.text, "**not** parsed", "fallback text is shown verbatim, not parsed")
    }

    function test_emptyDocumentRendersNothing() {
        const view = createMarkdown(documentWith())
        compare(view.blockCount, 0, "an empty document has no blocks")
        compare(findChild(view, "markdownParagraphText"), null)
    }

    function test_unknownNodeTypeDegradesToEscapedText() {
        const view = createMarkdown(documentWith(
            { "type": "definitionList", "value": "<b>raw</b>" }
        ))
        tryCompare(view, "blockCount", 1)

        const text = findChild(view, "markdownParagraphText")
        verify(text !== null, "unknown nodes must still render something")
        compare(text.text, "&lt;b&gt;raw&lt;/b&gt;", "raw markup is escaped, never interpreted")
    }

    function test_bareBlockNodeIsAccepted() {
        // A single block node (not wrapped in a document) renders as one block.
        const view = createMarkdown({ "type": "paragraph", "children": [{ "type": "text", "value": "solo" }] })
        tryCompare(view, "blockCount", 1)
        compare(findChild(view, "markdownParagraphText").text, "solo")
    }

    function test_blockSpacingComesFromTheTheme() {
        const view = createMarkdown(documentWith(paragraph("a"), paragraph("b")))
        tryCompare(view, "blockCount", 2)

        const column = findChild(view, "markdownColumn")
        verify(column !== null, "root column must be exposed")
        compare(column.spacing, testCase.tokens.spacing, "vertical rhythm follows the theme")
    }
}
