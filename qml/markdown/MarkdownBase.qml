// MarkdownBase.qml — the shared contract and markup engine for the markdown tree.
//
// Every component in qml/markdown/ either extends this type (the inline ones:
// Emphasis, Strong, Link) or holds an instance of it (the visual ones), so the
// AST contract and the inline-markup rules exist in exactly one place.
//
// WHY A NON-VISUAL BASE
// Inline formatting is rendered as ONE `Text` with `textFormat: Text.StyledText`,
// not as nested Text items: nested items cannot flow and wrap as a single
// paragraph, so `<b>`/`<i>`/`<code>`/`<a>` are produced as markup here and the
// paragraph/heading/list-item components hand the result to a single Text.
// Block-level structure (paragraph, heading, list, blockquote, code block, table)
// is rendered with real visual items — see Markdown.qml for the dispatch.
//
// The markup engine is deliberately total: unknown token types degrade to their
// escaped content, raw HTML tokens are escaped rather than passed through, and
// link targets are filtered (see sanitizeHref) so a `javascript:` href can never
// reach Qt's rich-text engine.
//
// THEME
// `theme` is typed `var` on purpose. qml/markdown/ must not import
// qml/components/ — qml/components/MessageDelegate.qml imports qml/markdown/, and
// a directory import in both directions is a cycle. Instead the caller passes any
// object exposing the token names (the real `Theme` instance, or a plain JS
// object), and `fallbackTokens` below keeps every component usable on its own —
// under qmltestrunner, qmllint, or a bare `qml` run with no host attached.
import QtQuick

QtObject {
    id: root

    // ---- MarkdownNode role properties --------------------------------------
    // These four mirror the AST node the component is rendering. They are
    // ordinary properties (not readonly) so a test can drive a component without
    // constructing a whole document, while the defaults still derive from `node`
    // when one is supplied.

    /** The AST node, in the shape documented in docs/PHASE-2-PLAN.md §3.1. */
    property var node: null

    /** Token type: document | paragraph | heading | text | strong | ... */
    property string type: root.node !== null && root.node !== undefined && root.node.type !== undefined
                         ? String(root.node.type)
                         : "unknown"

    /** Coarse classification used by styling decisions: block | inline | value. */
    property string role: "block"

    /** Value of a leaf token (text / code / html); empty for containers. */
    property string content: root.node !== null && root.node !== undefined && root.node.value !== undefined
                             ? String(root.node.value)
                             : ""

    /** Child nodes of a container token; empty for leaves. */
    property var children: root.node !== null && root.node !== undefined
                           && root.node.children !== undefined && root.node.children !== null
                           ? root.node.children
                           : []

    /** Inline children to render; defaults to `children` (see MarkdownInline). */
    property var nodes: root.children

    /** Plain text to render when there is no AST (the delegate's fallback path). */
    property string plainText: ""

    /** Theme source: a Theme instance, a plain token object, or null. */
    property var theme: null

    /** Resolved tokens — the theme when present, the bundled fallback otherwise. */
    readonly property var tokens: root.theme !== null && root.theme !== undefined ? root.theme : root.fallbackTokens

    /**
     * Dark-palette fallback.
     *
     * Mirrors the colour/metric subset of src/theme/themes/dark.json that the
     * markdown tree actually reads. tests/qml/tst_markdown.qml asserts these stay
     * equal to the live dark palette, so the two cannot drift silently.
     */
    readonly property var fallbackTokens: ({
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

    // ---- Inline markup engine ----------------------------------------------

    /**
     * StyledText markup for this node.
     *
     * Containers concatenate their children; leaf tokens render their content.
     * Subclasses override this to wrap (Emphasis adds <i>, Strong adds <b>, ...).
     */
    property string markup: {
        if (root.nodes !== null && root.nodes !== undefined && root.nodes.length > 0)
            return root.inlineMarkupFor(root.nodes)
        if (root.plainText.length > 0)
            return root.escapeText(root.plainText)
        return root.inlineMarkupFor(root.children)
    }

    /** Concatenated markup for a list of inline nodes. */
    function inlineMarkupFor(nodes) {
        if (nodes === null || nodes === undefined || nodes.length === undefined)
            return ""
        let out = ""
        for (let i = 0; i < nodes.length; ++i)
            out += root.markupForNode(nodes[i])
        return out
    }

    /** Markup for a single inline node; total, never throws. */
    function markupForNode(node) {
        if (node === null || node === undefined)
            return ""

        const kind = node.type !== undefined ? String(node.type) : ""
        const value = node.value !== undefined && node.value !== null ? String(node.value) : ""
        const kids = node.children !== undefined && node.children !== null ? node.children : []

        switch (kind) {
        case "text":
            return root.escapeText(value)
        case "strong":
            return "<b>" + root.inlineMarkupFor(kids) + "</b>"
        case "emphasis":
            return "<i>" + root.inlineMarkupFor(kids) + "</i>"
        case "strikethrough":
            return "<s>" + root.inlineMarkupFor(kids) + "</s>"
        case "code":
            // Inline code is a leaf in the AST; block code never reaches here
            // (CodeBlock.qml renders it as an item).
            return "<code>" + root.escapeText(value) + "</code>"
        case "link": {
            const href = root.sanitizeHref(node.href !== undefined && node.href !== null ? String(node.href) : "")
            const inner = root.inlineMarkupFor(kids)
            // The title is metadata for tooltips; it is attribute-escaped like href
            // so a quote inside it cannot break out of the tag.
            const title = node.title !== undefined && node.title !== null ? String(node.title) : ""
            const titleAttribute = title.length === 0
                ? ""
                : " title=\"" + root.escapeAttribute(title) + "\""
            return href.length === 0
                ? inner
                : "<a href=\"" + root.escapeAttribute(href) + "\"" + titleAttribute + ">" + inner + "</a>"
        }
        case "image": {
            // No image pipeline yet; the alt text is the honest rendering.
            const alt = root.inlineMarkupFor(kids)
            return alt.length > 0 ? "[" + alt + "]" : ""
        }
        case "html":
            // Raw HTML is never passed to the rich-text engine.
            return root.escapeText(value)
        case "paragraph":
        case "heading":
        case "listItem":
        case "blockquote":
        case "document":
            return root.inlineMarkupFor(kids)
        default:
            // Unknown token: render its content (or its children) rather than
            // dropping it, so a newer parser cannot make text disappear.
            return kids.length > 0 ? root.inlineMarkupFor(kids) : root.escapeText(value)
        }
    }

    /** Escape text for StyledText: the three characters Qt treats as markup. */
    function escapeText(value) {
        const text = value === null || value === undefined ? "" : String(value)
        let out = ""
        for (let i = 0; i < text.length; ++i) {
            const ch = text.charAt(i)
            if (ch === "&")
                out += "&amp;"
            else if (ch === "<")
                out += "&lt;"
            else if (ch === ">")
                out += "&gt;"
            else
                out += ch
        }
        return out
    }

    /** Escape a value placed inside a double-quoted attribute. */
    function escapeAttribute(value) {
        return root.escapeText(value).replace(/"/g, "&quot;")
    }

    /**
     * Filter a link target.
     *
     * Allows http, https, mailto, fragments and relative paths; everything else
     * (javascript:, data:, vbscript:, file:, and unknown schemes) becomes an
     * empty string, which makes the caller render plain text instead of a link.
     */
    function sanitizeHref(href) {
        const trimmed = href === null || href === undefined ? "" : String(href).trim()
        if (trimmed.length === 0)
            return ""

        const lower = trimmed.toLowerCase()
        const blocked = ["javascript:", "data:", "vbscript:", "file:", "about:"]
        for (let i = 0; i < blocked.length; ++i) {
            if (lower.indexOf(blocked[i]) === 0)
                return ""
        }

        // A scheme is only a scheme when the colon precedes the first slash.
        const colon = lower.indexOf(":")
        const slash = lower.indexOf("/")
        if (colon > 0 && (slash < 0 || colon < slash)) {
            const scheme = lower.substring(0, colon)
            if (scheme !== "http" && scheme !== "https" && scheme !== "mailto")
                return ""
        }
        return trimmed
    }
}
