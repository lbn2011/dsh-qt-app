// tst_codeelement.qml — CodeBlock.qml behaviour.
//
// Phase 2d: the block asks ctx.qtRenderer.highlightCode() for Qt rich text. In the
// test runner there is no Cordis context, so the block must fall back to plain
// text; a stand-in renderer injected through `rendererOverride` exercises the
// highlighted path deterministically (synchronously — no Promise needed here).
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

    /** Records what the last highlight request carried (set by the stand-ins). */
    property var lastHighlightRequest: null

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

    function test_withoutARendererTheBlockStaysPlainText() {
        // qmltestrunner publishes no `ctx`, so this is the no-service path: the
        // block must still show the source verbatim rather than nothing.
        const block = createCode()
        const text = findChild(block, "markdownCodeText")

        compare(block.renderer, null, "no renderer without a host")
        compare(block.isHighlighted, false, "nothing is highlighted")
        compare(text.textFormat, TextEdit.PlainText, "plain text is the fallback format")
        compare(text.text, testCase.source, "the source is shown verbatim")
    }

    function test_rendererMarkupIsPaintedAsRichText() {
        const block = createCode()
        block.rendererOverride = {
            "highlightCode": function (code, language, options) {
                testCase.lastHighlightRequest = { "code": code, "language": language, "options": options }
                return "<font color=\"#6ba1ff\">const</font> x = 1"
            }
        }

        const text = findChild(block, "markdownCodeText")
        compare(block.isHighlighted, true, "markup from the renderer is used")
        compare(text.textFormat, TextEdit.RichText, "highlighted code is rich text")
        compare(text.getText(0, text.length), "const x = 1")
        verify(text.text.indexOf("#6ba1ff") >= 0, "highlight colour survives rich-text normalization")
        compare(text.plainText, testCase.source, "the raw source stays available")

        // the request carried the code, the fence language and the scheme
        compare(testCase.lastHighlightRequest.code, testCase.source)
        compare(testCase.lastHighlightRequest.language, "js")
        compare(testCase.lastHighlightRequest.options.theme, "dark")
    }

    function test_aThrowingRendererLeavesTheBlockPlain() {
        const block = createCode()
        block.rendererOverride = {
            "highlightCode": function () { throw new Error("boom") }
        }

        compare(block.isHighlighted, false, "a failing renderer must not break the block")
        compare(findChild(block, "markdownCodeText").text, testCase.source)
    }

    function test_aNullAnswerLeavesTheBlockPlain() {
        const block = createCode()
        block.rendererOverride = { "highlightCode": function () { return null } }

        compare(block.isHighlighted, false)
        compare(findChild(block, "markdownCodeText").text, testCase.source)
    }

    function test_lightThemeAsksForTheLightScheme() {
        const block = createCode()
        block.theme = { "appearance": "light", "text": "#1b1c1f", "fontNormal": 13, "spacing": 8,
                        "radius": 8, "codeBackground": "#f3f4f7", "codeBorder": "#dde0e6",
                        "surfaceAlt": "#f1f2f5", "border": "#d8dbe2" }
        block.rendererOverride = {
            "highlightCode": function (code, language, options) {
                testCase.lastHighlightRequest = { "code": code, "language": language, "options": options }
                return "light markup"
            }
        }
        compare(testCase.lastHighlightRequest.options.theme, "light")
    }

    function test_codeIsSelectableButNotEditable() {
        // A read-only TextEdit rather than a Text: the snippet can be selected and
        // copied, and the user cannot accidentally type into the transcript.
        const block = createCode()
        const text = findChild(block, "markdownCodeText")
        compare(text.readOnly, true, "code blocks are read-only")
        compare(text.selectByMouse, true, "code can be selected with the mouse")
        compare(text.wrapMode, TextEdit.NoWrap, "code never re-wraps")
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
