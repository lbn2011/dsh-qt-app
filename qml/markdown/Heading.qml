// Heading.qml — an ATX/setext heading (levels 1–6).
//
// Size comes from the theme's type scale: h1/h2 use the title and large sizes,
// h3 and below fall back to the body size. All levels are bold, which matches how
// Qt renders <h1>–<h6> in rich text and keeps the visual hierarchy readable
// without six extra font sizes in the theme schema.
import QtQuick

Item {
    id: root

    // ---- MarkdownNode role properties --------------------------------------
    property var node: null
    property string type: "heading"
    property string role: "block"
    property string content: ""
    property var children: root.node !== null && root.node !== undefined
                           && root.node.children !== undefined && root.node.children !== null
                           ? root.node.children
                           : []

    /** 1 … 6; anything else is treated as 3. */
    property int level: root.node !== null && root.node !== undefined && root.node.level !== undefined
                        ? Number(root.node.level)
                        : 1

    property var theme: null

    readonly property MarkdownBase base: MarkdownBase {
        node: root.node
        theme: root.theme
    }

    readonly property int resolvedLevel: (root.level >= 1 && root.level <= 6) ? root.level : 3

    readonly property int pixelSize: {
        const tokens = root.base.tokens
        if (root.resolvedLevel <= 1)
            return tokens.fontTitle
        if (root.resolvedLevel === 2)
            return tokens.fontLarge
        if (root.resolvedLevel === 3)
            return tokens.fontNormal
        return tokens.fontSmall
    }

    implicitWidth: body.implicitWidth
    implicitHeight: body.implicitHeight

    MarkdownInline {
        id: body
        objectName: "markdownHeadingText"
        width: root.width > 0 ? root.width : implicitWidth
        nodes: root.children
        plainText: root.content
        theme: root.theme
        pixelSize: root.pixelSize
        bold: true
    }
}
