// tst_codeelement.qml — CodeBlock.qml behaviour.
//
// t12 renders code blocks as plain monospace text; syntax highlighting is t13's
// job. These tests therefore pin the *absence* of highlighting (the text is the
// source verbatim), the panel chrome, the language label and the dual block /
// inline role.
import QtQuick
import QtTest
import "../../qml/markdown"

TestCase {
    id: testCase

    name: "CodeBlock"
    when: windowShown

    readonly property var tokens: ({
        "surface": "#24262b",
        "surfaceAlt": "#26272b",
        "border": "#33363d",
        "text": "#e6e6e6",
        "codeBackground": "#15161a",
        "codeBorder": "#2c2f36",
        "fontFamily": "Inter",
        "fontNormal": 13,
        "spacing": 8,
        "radius": 8
    })

    readonly property string source: "function add(a, b) {\n    return a + b;\n}"

    Component {
        id: codeComponent
        CodeBlock {
            width: 400
            theme: testCase.tokens
        }
    }

    function createCode(props) {
        const item = createTemporaryObject(codeComponent, testCase)
        verify(item !== null, "CodeBlock must instantiate")
        item.node = {
            "type": "code",
            "value": testCase.source,
            "language": "js"
        }
        if (props !== undefined) {
            for (const key in props)
                item[key] = props[key]
        }
        return item
    }

    function test_rendersPanelAndText() {
        const block = createCode()
        const panel = findChild(block, "markdownCodePanel")
        const text = findChild(block, "markdownCodeText")

        verify(panel !== null, "code block must expose its panel")
        verify(text !== null, "code block must expose its text item")
        compare(text.text, testCase.source, "source is rendered verbatim")
    }

    function test_noHighlightingInPhase2c() {
        const block = createCode()
        const text = findChild(block, "markdownCodeText")

        // t13 will replace this with a highlighted RichText fragment. Until then
        // the text must stay plain so the absence of highlighting is explicit.
        compare(text.textFormat, Text.PlainText, "phase 2c renders code as plain text")
        compare(text.text.indexOf("<span"), -1, "no markup is injected")
    }

    function test_monospaceFont() {
        const block = createCode()
        const text = findChild(block, "markdownCodeText")
        verify(text.font.family !== "", "code uses a monospace family")
    }

    function test_languageIsExposed() {
        const block = createCode()
        compare(block.language, "js")
        compare(block.languageLabel, "js", "the fence info string is shown as a label")
    }

    function test_unknownLanguageStillRenders() {
        const block = createCode()
        block.node = { "type": "code", "value": "plain", "language": "" }
        compare(block.language, "", "no fence info string means no language")
        compare(findChild(block, "markdownCodeText").text, "plain")
    }

    function test_inlineRoleProducesInlineMarkup() {
        const block = createCode()
        block.role = "inline"
        compare(block.inlineCode, true, "role=inline marks the node as inline code")
        compare(block.markup, "<code>" + testCase.source.replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</code>")
    }

    function test_panelColoursFollowTheTheme() {
        const block = createCode()
        const panel = findChild(block, "markdownCodePanel")
        compare(String(panel.color).toLowerCase(), testCase.tokens.codeBackground.toLowerCase(),
                "panel background comes from the theme")
        compare(String(panel.border.color).toLowerCase(), testCase.tokens.codeBorder.toLowerCase(),
                "panel border comes from the theme")
    }

    function test_wideLineScrollsInsteadOfClipping() {
        const block = createCode()
        block.node = { "type": "code", "value": "x".repeat(400), "language": "" }

        const scroller = findChild(block, "markdownCodeScroller")
        verify(scroller !== null, "code block must be horizontally scrollable")
        verify(scroller.contentWidth >= 400, "content keeps its natural width")
        compare(scroller.flickableDirection, Flickable.HorizontalFlick)
    }
}
