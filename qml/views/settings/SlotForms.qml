pragma ComponentBehavior: Bound

// SlotForms.qml — renders the `conversation.settings.form` contributions that
// belong to one settings tab.
//
// A "form" is the narrow case of a slot: the plugin contributes a small block of
// controls that belongs *inside* an existing tab rather than being a tab of its
// own (that is `conversation.settings.section`). The panel decides where each
// form goes by reading its `section` field; this component only draws what it is
// given, in `order`, and stays out of the way when the list is empty.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../../components"

ColumnLayout {
    id: root

    objectName: "settingsSlotForms"

    /** Token source; a parent injects its own Theme instance. */
    property Theme theme: null

    /** Contributions to render, already filtered for one tab. */
    property var forms: []

    /** Values handed to every form, in addition to `theme`. */
    property var slotContext: ({})

    spacing: root.theme !== null ? root.theme.spacingLarge : 8

    /**
     * Sort by `order`, keeping declaration order for equal or missing values.
     *
     * Array.prototype.sort is not stable across engines in older Qt builds, so
     * the index is used as an explicit tie-breaker.
     */
    readonly property var orderedForms: {
        var input = root.forms
        if (input === null || input === undefined || input.length === undefined)
            return []
        var decorated = []
        for (var index = 0; index < input.length; ++index) {
            var entry = input[index]
            if (entry === null || entry === undefined)
                continue
            var order = (entry.order === undefined || entry.order === null) ? 0 : Number(entry.order)
            if (isNaN(order))
                order = 0
            decorated.push({ "entry": entry, "order": order, "index": index })
        }
        decorated.sort(function (left, right) {
            if (left.order !== right.order)
                return left.order - right.order
            return left.index - right.index
        })
        var result = []
        for (var position = 0; position < decorated.length; ++position)
            result.push(decorated[position].entry)
        return result
    }

    Repeater {
        model: root.orderedForms
        delegate: SlotHost {
            id: formHost

            // Required, not context properties: qmllint flags an unqualified
            // `index`/`modelData` as an error in Qt 6.7, and CI treats warnings
            // as failures.
            required property var modelData
            required property int index

            objectName: "settingsSlotForm" + formHost.index
            Layout.fillWidth: true
            Binding {
                target: formHost
                property: "theme"
                value: root.theme
                when: root.theme !== null
            }
            contribution: formHost.modelData
            slotContext: root.slotContext
        }
    }
}
