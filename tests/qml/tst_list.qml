// tst_list.qml — List.qml / ListItem.qml behaviour.
//
// Verifies bullet, ordinal and task markers, the `start` attribute, and that an
// item's body is rendered through Markdown.qml so a list item may hold several
// blocks (or a nested list) without ListItem knowing about them.
import QtQuick
import QtTest
import "../../qml/markdown"

TestCase {
    id: testCase

    name: "List"
    when: windowShown

    readonly property var tokens: ({
        "text": "#e6e6e6",
        "textMuted": "#8a8f98",
        "accent": "#4c8dff",
        "border": "#33363d",
        "fontFamily": "Inter",
        "fontNormal": 13,
        "spacing": 8,
        "radius": 8
    })

    Component {
        id: listComponent
        List {
            width: 400
            theme: testCase.tokens
        }
    }

    function item(text) {
        return [{ "type": "paragraph", "children": [{ "type": "text", "value": text }] }]
    }

    function createList(props) {
        const view = createTemporaryObject(listComponent, testCase)
        verify(view !== null, "List must instantiate")
        if (props !== undefined) {
            for (const key in props)
                view[key] = props[key]
        }
        return view
    }

    function test_unorderedMarkers() {
        const view = createList({ "items": [item("one"), item("two"), item("three")] })
        tryCompare(view, "count", 3)
        compare(view.markerFor(0), "•")
        compare(view.markerFor(2), "•")
    }

    function test_orderedMarkersUseStart() {
        const view = createList({ "ordered": true, "start": 3, "items": [item("a"), item("b")] })
        tryCompare(view, "count", 2)
        compare(view.markerFor(0), "3.", "the first ordinal honours start")
        compare(view.markerFor(1), "4.", "subsequent ordinals increment")
    }

    function test_orderedWithoutStartBeginsAtOne() {
        const view = createList({ "ordered": true, "items": [item("a")] })
        tryCompare(view, "count", 1)
        compare(view.markerFor(0), "1.")
    }

    function test_taskListMarkers() {
        const view = createList({
            "items": [item("done"), item("todo")],
            "taskChecked": [true, false]
        })
        tryCompare(view, "count", 2)
        compare(view.markerFor(0), "☑", "checked task item")
        compare(view.markerFor(1), "☐", "unchecked task item")
    }

    function test_itemRendersItsBodyThroughMarkdown() {
        const view = createList({ "items": [item("body text")] })
        tryCompare(view, "count", 1)

        const marker = findChild(view, "markdownListItemMarker")
        verify(marker !== null, "list item must expose its marker")
        compare(marker.text, "•")

        const body = findChild(view, "markdownListItemBody")
        verify(body !== null, "list item must expose its body")
        compare(body.blockCount, 1, "the item body is a markdown document")
    }

    function test_itemWithSeveralBlocks() {
        const blocks = [
            { "type": "paragraph", "children": [{ "type": "text", "value": "first" }] },
            { "type": "paragraph", "children": [{ "type": "text", "value": "second" }] }
        ]
        const view = createList({ "items": [blocks] })
        tryCompare(view, "count", 1)

        const body = findChild(view, "markdownListItemBody")
        verify(body !== null)
        compare(body.blockCount, 2, "a loose list item keeps every block")
    }

    function test_emptyListRendersNothing() {
        const view = createList({ "items": [] })
        compare(view.count, 0)
        compare(findChild(view, "markdownListItemMarker"), null)
    }

    function test_markerColumnIsFixedWidth() {
        const view = createList({ "items": [item("a"), item("a much longer line that wraps")] })
        tryCompare(view, "count", 2)

        const first = view.itemAt(0)
        const second = view.itemAt(1)
        verify(first !== null && second !== null, "List must expose itemAt()")

        const firstMarker = findChild(first, "markdownListItemMarker")
        const secondMarker = findChild(second, "markdownListItemMarker")
        verify(firstMarker !== null && secondMarker !== null, "both items expose a marker")
        // Fixed width is what makes wrapped text line up under the content.
        compare(firstMarker.width, secondMarker.width, "the marker column width is constant")
    }
}
