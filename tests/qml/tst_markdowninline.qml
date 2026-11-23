// tst_markdowninline.qml — inline formatting inside one StyledText run.
//
// Inline nodes (text, strong, emphasis, strikethrough, code, link) do not become
// separate Text items: they compose into a single Text with textFormat
// StyledText, so a paragraph wraps as one run of text. These tests pin the
// markup composition, the escaping rules and the href sanitiser.
import QtQuick
import QtTest
import "../../qml/markdown"

TestCase {
    id: testCase

    name: "MarkdownInline"
    when: windowShown

    readonly property var tokens: ({
        "text": "#e6e6e6",
        "textMuted": "#8a8f98",
        "accent": "#4c8dff",
        "border": "#33363d",
        "fontFamily": "Inter",
        "fontNormal": 13,
        "fontSmall": 11,
        "spacing": 8
    })

    Component {
        id: inlineComponent
        MarkdownInline {
            width: 400
            theme: testCase.tokens
        }
    }

    function inline(nodes) {
        const item = createTemporaryObject(inlineComponent, testCase)
        verify(item !== null, "MarkdownInline must instantiate")
        item.nodes = nodes
        return item
    }

    function test_plainTextIsPassedThrough() {
        const run = inline([{ "type": "text", "value": "plain" }])
        tryCompare(run, "markup", "plain")
        compare(run.textFormat, Text.StyledText, "inline runs use StyledText")
    }

    function test_strongAndEmphasisCompose() {
        const run = inline([
            { "type": "text", "value": "a " },
            { "type": "strong", "children": [{ "type": "text", "value": "b" }] },
            { "type": "text", "value": " " },
            { "type": "emphasis", "children": [{ "type": "text", "value": "c" }] }
        ])
        tryCompare(run, "markup", "a <b>b</b> <i>c</i>")
    }

    function test_nestedEmphasisInsideStrong() {
        const run = inline([
            { "type": "strong", "children": [
                { "type": "text", "value": "bold " },
                { "type": "emphasis", "children": [{ "type": "text", "value": "both" }] }
            ] }
        ])
        tryCompare(run, "markup", "<b>bold <i>both</i></b>")
    }

    function test_strikethroughAndCode() {
        const run = inline([
            { "type": "strikethrough", "children": [{ "type": "text", "value": "gone" }] },
            { "type": "text", "value": " " },
            { "type": "code", "value": "x < y", "inline": true }
        ])
        tryCompare(run, "markup", "<s>gone</s> <code>x &lt; y</code>")
    }

    function test_linkKeepsHrefAndTitle() {
        const run = inline([
            { "type": "link", "href": "https://example.com", "title": "Example",
              "children": [{ "type": "text", "value": "here" }] }
        ])
        tryCompare(run, "markup", '<a href="https://example.com" title="Example">here</a>')
    }

    function test_dangerousSchemeIsDropped() {
        const run = inline([
            { "type": "link", "href": "javascript:alert(1)",
              "children": [{ "type": "text", "value": "click" }] }
        ])
        compare(run.markup, "click", "a blocked scheme keeps the text but loses the anchor")
    }

    function test_rawHtmlIsEscapedNotInterpreted() {
        const run = inline([{ "type": "html", "value": "<img src=x onerror=alert(1)>" }])
        tryCompare(run, "markup", "&lt;img src=x onerror=alert(1)&gt;")
    }

    function test_softBreaksBecomeNewlines() {
        const run = inline([{ "type": "text", "value": "line one\nline two" }])
        tryCompare(run, "markup", "line one\nline two")
    }

    function test_unknownInlineTypeFallsBackToItsText() {
        const run = inline([{ "type": "mark", "children": [{ "type": "text", "value": "hi" }] }])
        compare(run.markup, "hi", "an unknown inline node keeps its children")
    }

    function test_boldFlagAppliesToTheWholeRun() {
        const run = inline([{ "type": "text", "value": "header" }])
        run.bold = true
        compare(run.font.bold, true, "heading runs render bold")
    }
}
