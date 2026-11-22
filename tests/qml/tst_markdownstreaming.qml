// tst_markdownstreaming.qml — Qt Quick Test suite for incremental markdown updates.
//
// A streaming reply must update one block in place: appending a delta to a
// paragraph must not destroy and recreate the other delegates, and a block that
// disappears must be removed from the list. This suite drives the API that
// MessageDelegate / ChatView / MessageModel use, with hand-written snapshots that
// mirror what DeltaMarkdownParser emits from TypeScript (src/markdown/streaming.ts).
import QtQuick
import QtTest
import "../../qml/markdown"

TestCase {
    id: testCase

    name: "MarkdownStreaming"
    when: windowShown

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

    function heading(text, level) {
        return {
            "type": "heading",
            "level": level === undefined ? 1 : level,
            "children": [{ "type": "text", "value": text }]
        }
    }

    function code(value, language) {
        return {
            "type": "code",
            "value": value,
            "inline": false,
            "language": language === undefined ? "text" : language
        }
    }

    function createMarkdown(doc) {
        const item = createTemporaryObject(markdownComponent, testCase)
        verify(item !== null, "Markdown must instantiate")
        item.document = doc
        return item
    }

    function findBlock(item, index) {
        return findChild(item, "markdownBlock" + index)
    }

    function textOf(item) {
        // The paragraph text lives in the inline renderer of the first block.
        const block = findBlock(item, 0)
        if (block === null || block.item === null || block.item === undefined)
            return ""
        const text = findChild(block.item, "markdownParagraphText")
        return text === null ? "" : text.text
    }

    // ---- the model is the source of truth ---------------------------------

    function test_aDocumentFillsTheBlockList() {
        const item = createMarkdown(documentWith(paragraph("one"), paragraph("two"), heading("three")))
        compare(item.blockCount, 3)
        compare(item.blockIds.length, 3)
        compare(item.nodeIdAt(0), "blk-0")
        compare(item.nodeIdAt(1), "blk-1")
        compare(item.nodeIdAt(2), "blk-2")
        compare(item.nodeAt(1).type, "paragraph")
        compare(item.nodeIdAt(9), "")
        compare(item.nodeAt(9), null)
    }

    function test_anEmptyDocumentHasNoBlocks() {
        const item = createMarkdown(documentWith())
        compare(item.blockCount, 0)
        compare(item.blockIds.length, 0)
    }

    function test_plainTextFallbackBecomesOneParagraph() {
        const item = createTemporaryObject(markdownComponent, testCase)
        item.text = "just text"
        compare(item.blockCount, 1)
        compare(item.nodeAt(0).type, "paragraph")
        compare(textOf(item), "just text")
    }

    // ---- in-place updates --------------------------------------------------

    function test_updateNodeReplacesContentWithoutTouchingTheList() {
        const item = createMarkdown(documentWith(paragraph("first"), paragraph("second")))
        const before = item.blockIds
        const applied = item.updateNode(before[0], paragraph("first, extended"))
        verify(applied, "updateNode must report success")
        compare(item.blockCount, 2, "the block count is unchanged")
        compare(item.blockIds[0], before[0], "the id is preserved")
        compare(item.blockIds[1], before[1], "the other block kept its id")
        compare(textOf(item), "first, extended")
    }

    function test_updateNodeAcceptsPlainText() {
        const item = createMarkdown(documentWith(paragraph("old")))
        verify(item.updateNode(item.nodeIdAt(0), "new text"))
        compare(item.blockCount, 1)
        compare(item.nodeAt(0).type, "paragraph")
        compare(textOf(item), "new text")
    }

    function test_updateNodeWithAnUnknownIdIsANoOp() {
        const item = createMarkdown(documentWith(paragraph("only")))
        verify(!item.updateNode("does-not-exist", paragraph("ignored")))
        compare(item.blockCount, 1)
        compare(textOf(item), "only")
    }

    function test_appendNodeGrowsTheList() {
        const item = createMarkdown(documentWith(paragraph("first")))
        const id = item.appendNode(paragraph("second"))
        compare(item.blockCount, 2)
        verify(id !== "")
        compare(item.nodeIdAt(1), id)
        compare(item.nodeAt(1).type, "paragraph")
    }

    function test_appendNodeUsesTheGivenId() {
        const item = createMarkdown(documentWith())
        const id = item.appendNode(code("let x = 1"), "md-42")
        compare(id, "md-42")
        compare(item.nodeIdAt(0), "md-42")
        compare(item.nodeAt(0).type, "code")
    }

    function test_insertNodeKeepsDocumentOrder() {
        const item = createMarkdown(documentWith(paragraph("first"), paragraph("third")))
        item.insertNode(1, paragraph("second"), "md-mid")
        compare(item.blockCount, 3)
        compare(item.nodeIdAt(1), "md-mid")
        compare(item.nodeAt(1).type, "paragraph")
        compare(item.blockIds.length, 3)
    }

    function test_removeNodeShrinksTheList() {
        const item = createMarkdown(documentWith(paragraph("first"), paragraph("second")))
        const id = item.nodeIdAt(0)
        verify(item.removeNode(id))
        compare(item.blockCount, 1)
        compare(item.blockIds.indexOf(id), -1)
        verify(!item.removeNode(id), "removing twice must report failure")
    }

    function test_clearEmptiesTheList() {
        const item = createMarkdown(documentWith(paragraph("one"), paragraph("two")))
        item.clear()
        compare(item.blockCount, 0)
        compare(item.blockIds.length, 0)
    }

    // ---- snapshots ---------------------------------------------------------

    function test_applySnapshotAppendsThenReplaces() {
        const item = createMarkdown(documentWith())
        // First chunk: one paragraph appears.
        item.applySnapshot({
            "text": "hello",
            "updates": [{ "type": "append", "nodeId": "md-1", "index": 0, "node": paragraph("hello") }],
            "blockIds": ["md-1"],
            "blockCount": 1,
            "document": documentWith(paragraph("hello"))
        })
        compare(item.blockCount, 1)
        compare(item.nodeIdAt(0), "md-1")

        // Second chunk: the same paragraph grew.
        item.applySnapshot({
            "text": "hello world",
            "updates": [{ "type": "replace", "nodeId": "md-1", "index": 0, "node": paragraph("hello world") }],
            "blockIds": ["md-1"],
            "blockCount": 1,
            "document": documentWith(paragraph("hello world"))
        })
        compare(item.blockCount, 1)
        compare(item.nodeIdAt(0), "md-1")
        compare(textOf(item), "hello world")
    }

    function test_applySnapshotAddsASecondBlock() {
        const item = createMarkdown(documentWith(paragraph("hello")))
        item.applySnapshot({
            "text": "hello\n\n```js\nx\n```",
            "updates": [{
                "type": "append",
                "nodeId": "md-2",
                "index": 1,
                "node": code("x", "js")
            }],
            "blockIds": ["blk-0", "md-2"],
            "blockCount": 2,
            "document": documentWith(paragraph("hello"), code("x", "js"))
        })
        compare(item.blockCount, 2)
        compare(item.nodeIdAt(1), "md-2")
        compare(item.nodeAt(1).type, "code")
        compare(item.nodeAt(1).language, "js")
    }

    function test_applySnapshotRemovesABlock() {
        const item = createMarkdown(documentWith(paragraph("one"), paragraph("two")))
        item.applySnapshot({
            "text": "one",
            "updates": [{ "type": "remove", "nodeId": "blk-1", "index": 1 }],
            "blockIds": ["blk-0"],
            "blockCount": 1,
            "document": documentWith(paragraph("one"))
        })
        compare(item.blockCount, 1)
        compare(item.blockIds.indexOf("blk-1"), -1)
    }

    function test_applySnapshotWithNoUpdatesAdoptsTheDocument() {
        const item = createMarkdown(documentWith())
        item.applySnapshot({
            "text": "# t\n\nbody",
            "updates": [],
            "blockIds": ["a", "b"],
            "blockCount": 2,
            "document": documentWith(heading("t"), paragraph("body"))
        })
        compare(item.blockCount, 2)
        compare(item.nodeAt(0).type, "heading")
        compare(item.nodeAt(1).type, "paragraph")
    }

    function test_applySnapshotToleratesNull() {
        const item = createMarkdown(documentWith(paragraph("one")))
        compare(item.applySnapshot(null), 0)
        compare(item.blockCount, 1)
    }

    // ---- view integration --------------------------------------------------

    function test_theDelegateRendersTheUpdatedText() {
        const item = createMarkdown(documentWith(paragraph("alpha")))
        wait(0)
        compare(textOf(item), "alpha")
        item.updateNode(item.nodeIdAt(0), paragraph("alpha beta"))
        wait(0)
        compare(textOf(item), "alpha beta")
    }

    function test_streamingFlagFlipsOnFirstUpdate() {
        const item = createMarkdown(documentWith(paragraph("one")))
        verify(!item.streaming, "a static document is not streaming")
        item.updateNode(item.nodeIdAt(0), paragraph("two"))
        verify(item.streaming, "an in-place update marks the view as streaming")
    }
}
