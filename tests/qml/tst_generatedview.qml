// tst_generatedview.qml — the QML half of the Phase 3 conversion contract.
//
// `src/ui/converter.ts` turns a plugin's limited React render function into a
// closed set of native nodes. These tests drive the consumer that makes those
// nodes visible: text, layout recursion, every control the converter can emit,
// the action payloads a user gesture produces, read-only mode, and the notices
// for unsupported controls and web-only slots.
pragma ComponentBehavior: Bound

import QtQuick
import QtTest
import QtQuick.Controls
import "../../qml/components"

TestCase {
    id: testCase

    name: "GeneratedView"
    width: 480
    height: 640
    when: windowShown

    /** Records every action the view bubbles up. */
    QtObject {
        id: recorder

        property var actions: []
        property string lastEvent: ""
        property var lastPayload: ({})

        function reset() {
            actions = []
            lastEvent = ""
            lastPayload = ({})
        }

        function record(event, payload) {
            lastEvent = String(event)
            lastPayload = payload
            actions = actions.concat([{ "event": String(event), "payload": payload }])
        }
    }

    GeneratedView {
        id: view

        width: 420
        interactive: true
        slotContext: ({ "slotName": "demo" })
        onAction: function (event, payload) {
            recorder.record(event, payload)
        }
    }

    function inline(kind, text) {
        return ({ "kind": kind, "text": text })
    }

    function textNode(text) {
        return ({ "kind": "paragraph", "children": [inline("text", text)] })
    }

    function makeNative(tree) {
        return { "status": "native", "tree": tree }
    }

    /**
     * Search a generated tree by object name.
     *
     * `findChild` only walks QObject children that were created by the caller;
     * nodes loaded from `GeneratedNode.qml` keep the Loader as their visual
     * parent but the window as their QObject parent, so the walk below follows
     * Loader items explicitly.
     */
    function deepFind(parent, name) {
        if (parent === null || parent === undefined)
            return null
        // Every GeneratedNode carries the same set of labels, so prefer the
        // deepest match: the outer container's hidden heading would otherwise
        // win over the real nested heading.
        var found = parent.objectName === name ? parent : null
        var kids = parent.children !== undefined && parent.children !== null ? parent.children : []
        for (var index = 0; index < kids.length; ++index) {
            var hit = deepFind(kids[index], name)
            if (hit !== null)
                found = hit
        }
        if (parent.item !== undefined && parent.item !== null) {
            var nested = deepFind(parent.item, name)
            if (nested !== null)
                found = nested
        }
        return found
    }

    function collectNodes(parent, out) {
        if (parent === null || parent === undefined)
            return
        if (typeof parent.objectName === "string" && parent.objectName.indexOf("generatedNode") === 0)
            out.push(parent)
        var kids = parent.children !== undefined && parent.children !== null ? parent.children : []
        for (var index = 0; index < kids.length; ++index)
            collectNodes(kids[index], out)
        if (parent.item !== undefined && parent.item !== null)
            collectNodes(parent.item, out)
    }

    /**
     * Find a generated label/control by object name.
     *
     * Every GeneratedNode instance declares the same label set, so a plain
     * recursive walk returns the outer node's hidden twin. Nodes are the
     * owners of these names: walking node instances in order and keeping the
     * last hit returns the deepest (real) node.
     */
    function plainFind(parent, name) {
        if (parent === null || parent === undefined)
            return null
        if (parent.objectName === name)
            return parent
        var kids = parent.children !== undefined && parent.children !== null ? parent.children : []
        for (var index = 0; index < kids.length; ++index) {
            var hit = plainFind(kids[index], name)
            if (hit !== null)
                return hit
        }
        if (parent.item !== undefined && parent.item !== null)
            return plainFind(parent.item, name)
        return null
    }

    function childNamed(name) {
        var nodes = []
        collectNodes(view, nodes)
        var expectedKind = name.replace(/^generated/, "").toLowerCase()
        var found = null
        for (var index = 0; index < nodes.length; ++index) {
            // Only a node of the same kind can own this label; otherwise the
            // blank twin declared by a sibling node would match first.
            if (expectedKind !== "unsupported" && String(nodes[index].kind) !== expectedKind)
                continue
            var hit = findChild(nodes[index], name)
            if (hit !== null && hit !== undefined)
                found = hit
        }
        if (found !== null)
            return found
        // View-level notices (unsupported/web/empty) live outside the node tree.
        return plainFind(view, name)
    }

    function test_paragraph_and_heading_render_inline_runs() {
        recorder.reset()
        view.result = makeNative({
            "kind": "container",
            "direction": "column",
            "children": [
                {
                    "kind": "heading",
                    "level": 1,
                    "children": [inline("text", "Settings"), inline("code", " v2")]
                },
                { "kind": "paragraph", "children": [inline("strong", "bold"), inline("text", " tail")] }
            ]
        })

        // The container instantiates child Loaders asynchronously; wait for the
        // real nested nodes instead of racing the component creation.
        tryVerify(function () {
            var heading = childNamed("generatedHeading")
            return heading !== null && heading.text.indexOf("Settings") >= 0
        }, 2000)
        var heading = childNamed("generatedHeading")
        compare(heading.text.indexOf("<code>") >= 0, true)

        tryVerify(function () {
            var paragraph = childNamed("generatedParagraph")
            return paragraph !== null && paragraph.text.indexOf("<b>bold</b>") >= 0
        }, 2000)
    }

    function test_container_children_are_rendered_recursively() {
        view.result = makeNative({
            "kind": "container",
            "direction": "column",
            "children": [
                textNode("first"),
                textNode("second")
            ]
        })

        var first
        var second
        tryCompare(view, "tree", view.tree)
        wait(50)
        first = findChild(view, "generatedChild0")
        second = findChild(view, "generatedChild1")
        compare(first !== null, true)
        compare(second !== null, true)
        compare(first.item === null, false)
        compare(first.item.kind, "paragraph")
        compare(second.item.kind, "paragraph")
    }

    function test_button_emits_click_action() {
        recorder.reset()
        view.result = makeNative({
            "kind": "button",
            "label": "Apply",
            "action": { "slotId": "demo.slot", "event": "click" }
        })

        var button = childNamed("generatedButton")
        compare(button !== null, true)
        compare(button.text, "Apply")

        button.clicked()
        compare(recorder.lastEvent, "click")
        compare(recorder.lastPayload.slotName, "demo")
        compare(recorder.actions.length, 1)
    }

    function test_disabled_button_never_acts() {
        recorder.reset()
        view.result = makeNative({
            "kind": "button",
            "label": "Apply",
            "disabled": true,
            "action": { "slotId": "demo.slot", "event": "click" }
        })

        var button = childNamed("generatedButton")
        compare(button.enabled, false)

        button.clicked()
        compare(recorder.actions.length, 0)
    }

    function test_field_edit_emits_change_with_value() {
        recorder.reset()
        view.result = makeNative({
            "kind": "field",
            "control": "text",
            "value": "before",
            "action": { "slotId": "demo.slot", "event": "change" }
        })

        var field = childNamed("generatedField")
        compare(field !== null, true)
        compare(field.text, "before")

        field.text = "after"
        field.editingFinished()
        compare(recorder.lastEvent, "change")
        compare(recorder.lastPayload.value, "after")
    }

    function test_select_change_reports_option_value() {
        recorder.reset()
        view.result = makeNative({
            "kind": "select",
            "value": "a",
            "options": [
                { "value": "a", "label": "Alpha" },
                { "value": "b", "label": "Beta" }
            ],
            "action": { "slotId": "demo.slot", "event": "change" }
        })

        var select = childNamed("generatedSelect")
        compare(select !== null, true)
        compare(select.currentIndex, 0)

        select.activated(1)
        compare(recorder.lastEvent, "change")
        compare(recorder.lastPayload.value, "b")
    }

    function test_checkbox_and_radiogroup_report_controlled_values() {
        recorder.reset()
        view.result = makeNative({
            "kind": "checkbox",
            "label": "Enable",
            "checked": true,
            "action": { "slotId": "demo.slot", "event": "change" }
        })

        var box = childNamed("generatedCheckbox")
        compare(box.checked, true)
        box.toggled()
        compare(recorder.lastPayload.value, true)

        recorder.reset()
        view.result = makeNative({
            "kind": "radiogroup",
            "value": "one",
            "options": [
                { "value": "one", "label": "One" },
                { "value": "two", "label": "Two" }
            ],
            "action": { "slotId": "demo.slot", "event": "change" }
        })

        var second = childNamed("generatedRadio1")
        compare(second !== null, true)
        second.clicked()
        compare(recorder.lastPayload.value, "two")
    }

    function test_text_result_shows_notice_and_reason() {
        view.result = {
            "status": "text",
            "reason": { "detail": "the slot renderer threw: boom" },
            "text": "This control is not supported."
        }

        compare(view.showsNotice, true)
        compare(view.showsNative, false)
        var notice = childNamed("generatedNotice")
        compare(notice.text, "This control is not supported.")
        compare(childNamed("generatedNoticeReason").text.indexOf("boom") >= 0, true)
    }

    function test_web_result_offers_fallback_notice() {
        view.result = { "status": "web", "reason": { "detail": "needs a browser" } }

        compare(view.showsWeb, true)
        compare(view.showsNotice, false)
    }

    function test_unknown_node_kind_is_visible_not_blank() {
        view.result = makeNative({ "kind": "codemirror", "value": "" })

        var unsupported = childNamed("generatedUnsupported")
        compare(unsupported !== null, true)
        compare(unsupported.text.indexOf("codemirror") >= 0, true)
    }

    function test_read_only_view_never_acts() {
        recorder.reset()
        view.interactive = false
        view.result = makeNative({
            "kind": "button",
            "label": "Apply",
            "action": { "slotId": "demo.slot", "event": "click" }
        })

        var button = childNamed("generatedButton")
        compare(button.enabled, false)
        button.clicked()
        compare(recorder.actions.length, 0)
        view.interactive = true
    }

    function test_empty_result_waits_instead_of_blank() {
        view.result = null

        compare(view.showsEmpty, true)
        compare(view.status, "empty")
    }
}