// Markdown.qml — the document root of the markdown component tree.
//
// Block nodes become real visual items, dispatched through a Loader so that each
// block type stays in its own file. Inline formatting inside a block is collapsed
// into a single StyledText run (see MarkdownInline.qml) because nested Text items
// cannot flow and wrap as one paragraph.
//
// Usage:
//     Markdown { document: messageNode; theme: theme }
//     Markdown { text: "**plain** fallback" }        // no AST available
//
// The component tree never imports qml/components/ on purpose: MessageDelegate
// (in components/) imports this directory, and a two-way directory import would be
// a cycle. Instead the host passes its Theme in through `theme`, and every
// component falls back to a bundled dark palette when that is null.
pragma ComponentBehavior: Bound

import QtQuick

Item {
    id: root

    // ---- MarkdownNode role properties --------------------------------------
    /** The AST node to render; a `document` node, or any block node. */
    property var node: null
    property string type: "document"
    property string role: "block"
    property string content: ""
    property var children: root.blocks

    /** The document to render (alias of `node` that reads better at call sites). */
    property var document: root.node

    /** Plain-text fallback, rendered as one paragraph when no AST is supplied. */
    property string text: ""

    /** A Theme instance, a plain token object, or null for the bundled palette. */
    property var theme: null

    /** Emitted when the host should follow a link; this file never navigates. */
    signal linkActivated(string href)

    readonly property MarkdownBase base: MarkdownBase {
        node: root.node
        theme: root.theme
    }

    readonly property var tokens: root.base.tokens

    /** Block nodes to render, derived from the AST or synthesised from `text`. */
    readonly property var blocks: {
        const source = root.document !== null && root.document !== undefined
                       ? root.document
                       : root.node
        if (source !== null && source !== undefined) {
            if (source.type === "document")
                return source.children !== undefined && source.children !== null
                       ? source.children : []
            // A bare block node is accepted too: wrap it so one code path renders.
            return [source]
        }
        if (root.text !== "" && root.text !== undefined && root.text !== null)
            return [{ "type": "paragraph", "children": [{ "type": "text", "value": root.text }] }]
        return []
    }

    /** Number of top-level blocks; handy for tests and diagnostics. */
    readonly property int blockCount: root.blocks.length

    implicitWidth: column.implicitWidth
    implicitHeight: column.implicitHeight

    Column {
        id: column
        objectName: "markdownColumn"
        // Width comes from the host only. Deriving it from column.implicitWidth
        // while the children derive theirs from column.width is a binding loop, so
        // an unsized Markdown leaves the column at 0 and lets each block fall back
        // to its own implicit width.
        width: root.width
        spacing: root.tokens.spacing

        Repeater {
            model: root.blocks

            delegate: Loader {
                id: blockLoader
                required property var modelData
                required property int index

                objectName: "markdownBlock" + index
                width: column.width > 0 ? column.width : implicitWidth
                sourceComponent: root.componentFor(blockLoader.modelData)

                onLoaded: {
                    blockLoader.item.node = blockLoader.modelData
                    blockLoader.item.theme = root.theme
                }
            }
        }
    }

    // ---- dispatch ----------------------------------------------------------
    Component { id: paragraphComponent; Paragraph {} }
    Component { id: headingComponent; Heading {} }
    Component { id: codeComponent; CodeBlock {} }
    Component { id: listComponent; List {} }
    Component { id: blockquoteComponent; Blockquote {} }
    Component { id: thematicBreakComponent; ThematicBreak {} }
    Component { id: tableComponent; Table {} }

    /**
     * Component for one block node.
     *
     * Unknown node types fall through to Paragraph, whose inline renderer escapes
     * whatever value the node carries — an unrecognised node degrades to visible
     * text instead of an empty gap or a binding error.
     */
    function componentFor(node) {
        if (node === null || node === undefined)
            return paragraphComponent
        switch (node.type) {
        case "paragraph":
        case "text":
        case "html":
            return paragraphComponent
        case "heading":
            return headingComponent
        case "code":
            // A standalone `code` node is a fenced block; inline code only ever
            // appears inside a paragraph's children.
            return node.inline === true ? paragraphComponent : codeComponent
        case "list":
            return listComponent
        case "blockquote":
            return blockquoteComponent
        case "thematicBreak":
            return thematicBreakComponent
        case "table":
            return tableComponent
        default:
            return paragraphComponent
        }
    }
}
