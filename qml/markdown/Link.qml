// Link.qml — <a href="…">.
//
// Markup producer like Emphasis/Strong, with one addition that matters for
// safety: the target is filtered through MarkdownBase.sanitizeHref() before it is
// put in the markup. A blocked scheme (javascript:, data:, vbscript:, file:)
// degrades to plain text instead of a clickable link, so a hostile message cannot
// hand a `javascript:` URL to Qt's rich-text engine.
import QtQuick

MarkdownBase {
    id: root

    type: "link"
    role: "inline"

    /** Raw target as it appeared in the AST. */
    property string href: root.node !== null && root.node !== undefined && root.node.href !== undefined
                          ? String(root.node.href)
                          : ""

    /** Optional tooltip text from `[label](href "title")`. */
    property string title: root.node !== null && root.node !== undefined && root.node.title !== undefined
                           ? String(root.node.title)
                           : ""

    /** The filtered target; empty means "render as plain text". */
    readonly property string safeHref: root.sanitizeHref(root.href)

    markup: root.safeHref.length === 0
            ? root.inlineMarkupFor(root.children)
            : "<a href=\"" + root.escapeAttribute(root.safeHref) + "\""
              + (root.title.length > 0 ? " title=\"" + root.escapeAttribute(root.title) + "\"" : "")
              + ">" + root.inlineMarkupFor(root.children) + "</a>"
}
