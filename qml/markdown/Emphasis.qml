// Emphasis.qml — <em> / <i>.
//
// A markup producer rather than a visual item: inline formatting is rendered by a
// single Text (see MarkdownBase.qml for why), so this type's job is to say what
// the wrapped content looks like. Markdown.qml never instantiates it for
// rendering; MarkdownBase.markupForNode() applies the same rule, and
// tests/qml/tst_markdowninline.qml asserts the two agree so they cannot drift.
import QtQuick

MarkdownBase {
    id: root

    type: "emphasis"
    role: "inline"
    markup: "<i>" + root.inlineMarkupFor(root.children) + "</i>"
}
