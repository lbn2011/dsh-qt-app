// SlotHost.qml — renders one plugin slot contribution.
//
// The settings panel does not know what a plugin's settings UI looks like; it
// only knows that a contribution arrived for a surface and that it wants to be
// shown. This component is the whole of that contract:
//
//   contribution.surface      "conversation.settings.section" | "conversation.settings.form"
//   contribution.id           stable id, unique within the surface
//   contribution.title        tab label (sections) or form heading (forms)
//   contribution.component    a Component to instantiate, OR
//   contribution.url          a URL to load
//   contribution.order        optional sort key
//   contribution.properties   optional map assigned onto the loaded item
//
// Two rules worth stating, because both are easy to get wrong:
//
//   1. **A broken slot must not take the panel down.** Loader failures are
//      reported on `failed()` and replaced with an inline message, so a plugin
//      that throws on load costs one tab, not the settings UI.
//   2. **Never assume the slot declares properties.** `theme` and anything from
//      `contribution.properties` are assigned defensively: a QML item does not
//      have to accept `theme`, and assigning an undeclared property throws.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../../components"

Item {
    id: root

    objectName: "settingsSlotHost"

    // ---- Theme source ------------------------------------------------------
    // qmllint disable unqualified
    readonly property QtObject themeBridge: (typeof ctx !== "undefined" && ctx.theme) ? ctx.theme : null
    // qmllint enable unqualified

    /** Token source; a parent may inject its own instance. */
    property Theme theme: Theme { bridge: root.themeBridge }

    /** The contribution to render. Null means "nothing to show". */
    property var contribution: null

    /** Extra values handed to the loaded item, in addition to `theme`. */
    property var slotContext: ({})

    /** True when the contribution carries something loadable. */
    readonly property bool hasComponent: root.contribution !== null
        && typeof root.contribution === "object"
        && root.contribution.component !== undefined
        && root.contribution.component !== null

    /** True when the contribution asks for a URL instead of a Component. */
    readonly property bool hasUrl: !root.hasComponent
        && root.contribution !== null
        && typeof root.contribution === "object"
        && typeof root.contribution.url === "string"
        && root.contribution.url.length > 0

    /** Heading for the contribution, or an empty string. */
    readonly property string heading: (root.contribution !== null
        && typeof root.contribution === "object"
        && root.contribution.title !== undefined)
        ? String(root.contribution.title)
        : ""

    /** True while a URL-backed slot is still loading. */
    readonly property bool loading: loader.status === Loader.Loading

    /** True when the slot could not be shown. */
    readonly property bool failedToLoad: loader.status === Loader.Error

    /** The instantiated slot item, or null while loading / on failure. */
    readonly property var loadedItem: loader.item

    /** Emitted when a slot fails to load; the panel logs it. */
    signal failed(string id, string reason)

    implicitWidth: 320
    implicitHeight: column.implicitHeight

    /** Assign a property only when the target accepts it. */
    function assignIfPresent(target, name, value) {
        if (target === null || target === undefined)
            return
        try {
            target[name] = value
        } catch (error) {
            // The slot simply does not declare that property; not an error.
        }
    }

    /** Hand the theme and the caller's context to the loaded item. */
    function prepareItem(item) {
        if (item === null || item === undefined)
            return
        root.assignIfPresent(item, "theme", root.theme)
        var extra = root.slotContext
        if (extra === null || typeof extra !== "object")
            return
        for (var key in extra) {
            if (key === "theme")
                continue
            root.assignIfPresent(item, key, extra[key])
        }
    }

    ColumnLayout {
        id: column

        width: root.width
        spacing: root.theme.spacing

        Label {
            objectName: "settingsSlotHeading"
            visible: root.heading.length > 0
            text: root.heading
            color: root.theme.text
            font.pixelSize: root.theme.fontLarge
            font.bold: true
            wrapMode: Text.Wrap
            Layout.fillWidth: true
        }

        Loader {
            id: loader

            objectName: "settingsSlotLoader"
            Layout.fillWidth: true
            visible: status !== Loader.Null && status !== Loader.Error
            sourceComponent: root.hasComponent ? root.contribution.component : null
            source: root.hasUrl ? root.contribution.url : ""

            onStatusChanged: {
                if (loader.status === Loader.Ready)
                    root.prepareItem(loader.item)
                else if (loader.status === Loader.Error)
                    root.failed(root.contribution !== null ? String(root.contribution.id) : "", "load error")
            }
        }

        Label {
            objectName: "settingsSlotEmpty"
            visible: !root.hasComponent && !root.hasUrl && !root.failedToLoad
            text: qsTr("This plugin has not provided a settings view yet.")
            color: root.theme.textMuted
            font.pixelSize: root.theme.fontSmall
            wrapMode: Text.Wrap
            Layout.fillWidth: true
        }

        Label {
            objectName: "settingsSlotError"
            visible: root.failedToLoad
            text: qsTr("This plugin's settings failed to load.")
            color: root.theme.danger
            font.pixelSize: root.theme.fontSmall
            wrapMode: Text.Wrap
            Layout.fillWidth: true
        }
    }
}
