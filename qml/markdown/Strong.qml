// Strong.qml — <strong> / <b>.
//
// Markup producer, same rationale as Emphasis.qml: inline formatting ends up in a
// single Text, and MarkdownBase.markupForNode() applies the identical rule (a
// test keeps the two in sync).
import QtQuick

MarkdownBase {
    id: root

    type: "strong"
    role: "inline"
    markup: "<b>" + root.inlineMarkupFor(root.children) + "</b>"
}
