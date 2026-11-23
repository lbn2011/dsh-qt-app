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
// Streaming:
//     The block list lives in a ListModel rather than a plain array so a reply that
//     arrives in pieces can update *one* row in place. Re-assigning a JS array
//     would rebuild every delegate (and lose scroll position, selection and any
//     hover state) on every chunk. Hosts feed updates through `applySnapshot()`,
//     or call `updateNode()` / `appendNode()` / `removeNode()` directly.
//     MessageModel.appendChunk() is the producer: it hands each delta to the
//     TypeScript DeltaMarkdownParser, whose snapshot (append/replace/remove) is
//     then mirrored onto the model row by row.
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
    // NOTE: deliberately *not* named `children`. Item.children is the list of
    // visual children, and Qt Quick Test's findChild() walks exactly that list —
    // shadowing it with an AST role property made every findChild() call on a
    // Markdown root return null (the AST array has no objectName). The role
    // property keeps its meaning under `nodes`, matching MarkdownBase.
    property var nodes: root.blocks

    /** The document to render (alias of `node` that reads better at call sites). */
    property var document: root.node

    /** Plain-text fallback, rendered as one paragraph when no AST is supplied. */
    property string text: ""

    /** A Theme instance, a plain token object, or null for the bundled palette. */
    property var theme: null

    /** Emitted when the host should follow a link; this file never navigates. */
    signal linkActivated(string href)

    /** Emitted after any in-place change, with the id that changed ("" for a reset). */
    signal nodeUpdated(string nodeId)

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
    readonly property int blockCount: streamModel.count

    /** Ids of the current blocks, in order. */
    readonly property var blockIds: {
        const ids = []
        for (let index = 0; index < streamModel.count; ++index)
            ids.push(streamModel.get(index).nodeId)
        return ids
    }

    /**
     * True once the host has applied a streaming snapshot.
     *
     * While streaming, the model is authoritative and the `document` binding is
     * ignored: re-deriving the block list from a stale document would undo the
     * incremental updates.
     */
    property bool streaming: false

    implicitWidth: column.implicitWidth
    implicitHeight: column.implicitHeight

    /** Rows: one per top-level block. `node` is the AST node for that row. */
    ListModel { id: streamModel }

    // A new document (or fallback text) replaces the whole list.
    onBlocksChanged: root.rebuild()
    Component.onCompleted: root.rebuild()

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
            model: streamModel

            delegate: Loader {
                id: blockLoader
                required property string nodeId
                required property string nodeType
                required property var node
                required property int index

                objectName: "markdownBlock" + index
                width: column.width > 0 ? column.width : implicitWidth
                sourceComponent: root.componentFor(node)

                onLoaded: {
                    if (blockLoader.item !== null) {
                        blockLoader.item.node = blockLoader.node
                        blockLoader.item.theme = root.theme
                    }
                }

                // A row whose node changed keeps its Loader (same block type) and
                // only hands the new node over, which is the whole point of the
                // ListModel: no delegate is destroyed and recreated.
                onNodeChanged: {
                    if (blockLoader.item !== null) {
                        blockLoader.item.node = blockLoader.node
                        blockLoader.item.theme = root.theme
                    }
                }

                onNodeTypeChanged: {
                    if (blockLoader.item !== null && blockLoader.node !== null
                            && blockLoader.node !== undefined)
                        blockLoader.item.node = blockLoader.node
                }
            }
        }
    }

    // ---- block list maintenance -------------------------------------------

    /** Rebuild the whole list from `blocks` (static documents, theme reloads). */
    function rebuild() {
        const list = root.blocks
        streamModel.clear()
        for (let index = 0; index < list.length; ++index) {
            const item = list[index]
            streamModel.append({
                "nodeId": root.defaultIdFor(index),
                "nodeType": String(item.type === undefined || item.type === null ? "" : item.type),
                "node": item,
            })
        }
    }

    /** Deterministic id for the block at `index` of a freshly loaded document. */
    function defaultIdFor(index) {
        return "blk-" + index
    }

    /** Row index of `nodeId`, or -1. */
    function indexOfNode(nodeId) {
        for (let index = 0; index < streamModel.count; ++index) {
            if (streamModel.get(index).nodeId === nodeId)
                return index
        }
        return -1
    }

    /** Id of the block at `index`, or "" when out of range. */
    function nodeIdAt(index) {
        if (index < 0 || index >= streamModel.count)
            return ""
        return streamModel.get(index).nodeId
    }

    /** The node at `index`, or null. */
    function nodeAt(index) {
        if (index < 0 || index >= streamModel.count)
            return null
        return streamModel.get(index).node
    }

    /**
     * Coerce `value` into a node.
     *
     * A string is accepted because a host often has plain text where it would
     * rather hand over a node; wrapping it keeps the update path uniform.
     */
    function normaliseNode(value) {
        if (value === null || value === undefined)
            return null
        if (typeof value === "string")
            return { "type": "paragraph", "children": [{ "type": "text", "value": value }] }
        return value
    }

    /**
     * Replace the content of an existing block in place.
     *
     * Returns true when the id was found. The Loader for that row is kept alive, so
     * only the affected block re-renders.
     */
    function updateNode(nodeId, newContent) {
        const index = root.indexOfNode(nodeId)
        const node = root.normaliseNode(newContent)
        if (index < 0 || node === null)
            return false
        const nextType = String(node.type === undefined || node.type === null ? "" : node.type)
        // Replace the whole row rather than re-assigning roles one by one: a role's
        // type is fixed when the row is created, so setProperty(index, "node", …)
        // fails with "Can't assign to existing role of different type" whenever the
        // new node has a different shape (e.g. a list instead of a map).
        streamModel.set(index, {
            "nodeId": streamModel.get(index).nodeId,
            "nodeType": nextType,
            "node": node,
        })
        root.streaming = true
        root.nodeUpdated(nodeId)
        return true
    }

    /** Append a block; `nodeId` is generated when omitted. */
    function appendNode(node, nodeId) {
        const value = root.normaliseNode(node)
        if (value === null)
            return ""
        const id = (nodeId === undefined || nodeId === null || nodeId === "")
                     ? "blk-" + streamModel.count + "-" + root.generatedIdSuffix()
                     : String(nodeId)
        streamModel.append({
            "nodeId": id,
            "nodeType": String(value.type === undefined || value.type === null ? "" : value.type),
            "node": value,
        })
        root.streaming = true
        root.nodeUpdated(id)
        return id
    }

    /** Insert a block at `index` (clamped); returns the id used. */
    function insertNode(index, node, nodeId) {
        const value = root.normaliseNode(node)
        if (value === null)
            return ""
        const at = Math.max(0, Math.min(index, streamModel.count))
        const id = (nodeId === undefined || nodeId === null || nodeId === "")
                     ? "blk-" + at + "-" + root.generatedIdSuffix()
                     : String(nodeId)
        streamModel.insert(at, {
            "nodeId": id,
            "nodeType": String(value.type === undefined || value.type === null ? "" : value.type),
            "node": value,
        })
        root.streaming = true
        root.nodeUpdated(id)
        return id
    }

    /** Remove a block by id; returns true when it existed. */
    function removeNode(nodeId) {
        const index = root.indexOfNode(nodeId)
        if (index < 0)
            return false
        streamModel.remove(index)
        root.streaming = true
        root.nodeUpdated(nodeId)
        return true
    }

    /** Monotonic counter so generated ids never collide. */
    property int generatedIds: 0
    function generatedIdSuffix() {
        root.generatedIds += 1
        return String(root.generatedIds)
    }

    /**
     * Apply one streaming snapshot from `DeltaMarkdownParser`.
     *
     * `snapshot.updates` is the ordered list of append/replace/remove operations the
     * TypeScript parser computed; this function only mirrors them onto the model.
     * When the parser reports a full re-parse (or the block count shrinks beyond
     * what the updates describe) the list is rebuilt from `snapshot.document`.
     */
    function applySnapshot(snapshot) {
        if (snapshot === null || snapshot === undefined)
            return 0
        const updates = snapshot.updates !== undefined && snapshot.updates !== null
                        ? snapshot.updates : []
        let applied = 0
        for (let index = 0; index < updates.length; ++index) {
            const update = updates[index]
            const id = String(update.nodeId)
            if (update.type === "remove") {
                if (root.removeNode(id))
                    applied += 1
            } else if (update.type === "append") {
                // Appends arrive in document order; insertNode keeps that order even
                // when an earlier block was replaced in the same snapshot.
                if (root.indexOfNode(id) >= 0)
                    root.updateNode(id, update.node)
                else
                    root.insertNode(update.index, update.node, id)
                applied += 1
            } else if (update.type === "replace") {
                if (root.updateNode(id, update.node))
                    applied += 1
                else
                    root.insertNode(update.index, update.node, id)
                applied += 1
            }
        }
        // The parser can decide the whole document at once (integrity fallback);
        // mirror that so the model can never drift away from the AST.
        if (updates.length === 0 && snapshot.document !== undefined && snapshot.document !== null) {
            const children = snapshot.document.children !== undefined && snapshot.document.children !== null
                             ? snapshot.document.children : []
            if (children.length !== streamModel.count) {
                root.replaceDocument(snapshot.document)
                applied = children.length
            }
        }
        root.streaming = true
        return applied
    }

    /** Replace every block from a document node (used on reset or after a repair). */
    function replaceDocument(documentNode) {
        root.streaming = true
        const previous = root.document
        root.document = documentNode
        // Assigning the same document does not re-run onBlocksChanged.
        if (previous === documentNode || root.blocks.length !== streamModel.count)
            root.rebuild()
    }

    /** Drop every block (a cleared reply). */
    function clear() {
        streamModel.clear()
        root.streaming = true
        root.nodeUpdated("")
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
