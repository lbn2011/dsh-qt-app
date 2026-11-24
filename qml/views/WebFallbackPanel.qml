// WebFallbackPanel.qml — the on-demand WebUI fallback surface (I5).
//
// This panel is the *only* place the shell shows a DOM-based plugin surface. It
// is deliberately inert: mounting it starts nothing. The Node-side
// `WebuiService` (src/webui/service.ts) owns the lifecycle and this panel only
// renders its state and forwards user intent.
//
// Security contract — read before editing:
//
//   * `maskedUrl` (`http://127.0.0.1:PORT/?token=***`) is the only URL that may
//     appear here. The authenticated URL never enters QML: the shell consumes
//     `webui.token` natively and either loads it into `WebviewHost` or hands it
//     to `QDesktopServices::openUrl`, which is why the two fallbacks below are
//     *signals* (`embedRequested`, `externalOpenRequested`) and not QML code.
//   * The panel must never log or `console.log` its state; a stray token would
//     then reach the Qt logs. `maskedUrl` makes that mistake harmless.
//
// State model (mirrors `WebuiState` in src/webui/types.ts):
//
//   Idle → Resolving → Spawning → WaitingReady → Ready
//                                    ↘ Failed{reason} → (retry) → Spawning …
//   any → Stopping → Idle
//
// Without a native host (qmllint, qmltestrunner, a design preview) the panel
// stays in `Idle` and `hostAvailable` is false, so the buttons are disabled
// instead of failing at click time.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

Item {
    id: root

    objectName: "webFallbackPanel"

    // qmllint disable unqualified
    readonly property QtObject themeBridge: (typeof ctx !== "undefined" && ctx.theme) ? ctx.theme : null
    // qmllint enable unqualified

    /** Token source; a parent injects its own Theme instance. */
    property Theme theme: Theme { bridge: root.themeBridge }

    /** True when native/main.cpp published the `dshQt` bridge. */
    // qmllint disable unqualified
    readonly property bool hostAvailable: typeof dshQt !== "undefined" && dshQt !== null
    // qmllint enable unqualified

    /**
     * `native/webview_host.h` instance, injected by the shell.
     *
     * Null (or `available === false`) means this build has no QtWebEngine: the
     * panel then offers the browser hand-off only, which is a supported
     * configuration, not an error.
     */
    property var webviewHost: null
    readonly property bool canEmbed: root.webviewHost !== null && root.webviewHost.available === true

    // Hand the stable slot to the native host. WebviewHost owns the
    // WebEngineView and needs a QQuickItem to parent it to; without this the
    // embed step can only fail. A host injected later is handled by the change
    // handler, a host present at completion by the slot's own handler.
    function syncEmbedContainer() {
        if (root.webviewHost !== null && root.webviewHost.available === true)
            root.webviewHost.setContainer(embedSlot)
    }
    onWebviewHostChanged: root.syncEmbedContainer()

    /** Mirrors the Node-side `webui.state` event payload. */
    property string state: "Idle"
    property string mode: ""
    property string maskedUrl: ""
    property string reason: ""
    property string notice: ""
    property bool sharedSession: false
    property int attempts: 0

    readonly property bool busy: root.state === "Resolving" || root.state === "Spawning"
                                 || root.state === "WaitingReady" || root.state === "Stopping"
    readonly property bool ready: root.state === "Ready"
    readonly property bool failed: root.state === "Failed"
    readonly property bool idle: root.state === "Idle"

    signal openRequested()
    signal closeRequested()
    signal retryRequested()
    // The shell resolves these two natively, because both need the raw URL.
    signal embedRequested()
    signal externalOpenRequested()

    /**
     * Apply a `webui.state` payload (or the `webui.open` reply, which carries the
     * same fields). Unknown states fall back to `Failed` rather than pretending
     * the surface is live.
     */
    function applyStatus(payload) {
        if (payload === undefined || payload === null)
            return
        var next = String(payload.state === undefined ? "" : payload.state)
        if (["Idle", "Resolving", "Spawning", "WaitingReady", "Ready", "Stopping"].indexOf(next) < 0)
            next = next === "Failed" ? "Failed" : "Failed"
        root.state = next
        root.mode = payload.mode === undefined || payload.mode === null ? "" : String(payload.mode)
        root.maskedUrl = payload.maskedUrl === undefined || payload.maskedUrl === null ? "" : String(payload.maskedUrl)
        root.reason = payload.reason === undefined || payload.reason === null ? "" : String(payload.reason)
        root.notice = payload.notice === undefined || payload.notice === null ? "" : String(payload.notice)
        root.sharedSession = payload.sharedSession === true
        root.attempts = payload.attempts === undefined ? 0 : Number(payload.attempts)
        if (root.state === "Ready" && root.canEmbed)
            root.embedRequested()
        if (root.state === "Idle" || root.state === "Failed")
            root.externalUrlShown = false
    }

    /** True once the user asked for the browser fallback (hides the hint). */
    property bool externalUrlShown: false

    function requestOpen() {
        if (!root.hostAvailable)
            return
        root.state = "Resolving"
        root.reason = ""
        root.attempts = 0
        root.openRequested()
    }

    function requestClose() {
        if (!root.hostAvailable || root.idle)
            return
        root.state = "Stopping"
        root.closeRequested()
    }

    function requestRetry() {
        if (!root.hostAvailable || root.busy)
            return
        root.state = "Resolving"
        root.reason = ""
        root.retryRequested()
    }

    /** Human-readable status line. Kept in one place so the tests can assert it. */
    readonly property string statusText: {
        switch (root.state) {
        case "Idle":
            return qsTr("WebUI 回退未启动")
        case "Resolving":
            return qsTr("正在解析宿主…")
        case "Spawning":
            return qsTr("正在启动…")
        case "WaitingReady":
            return qsTr("正在等待 WebUI 就绪…")
        case "Ready":
            return root.mode === "child" ? qsTr("已在独立进程中就绪") : qsTr("已在当前进程内就绪")
        case "Stopping":
            return qsTr("正在关闭…")
        case "Failed":
            return root.reason.length > 0 ? qsTr("回退失败：%1").arg(root.reason) : qsTr("回退失败")
        default:
            return qsTr("未知状态：%1").arg(root.state)
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: root.theme.spacingLarge
        spacing: root.theme.spacing

        RowLayout {
            Layout.fillWidth: true
            spacing: (root.theme.spacing / 2)

            Label {
                objectName: "webFallbackTitle"
                text: qsTr("WebUI 回退")
                font.pixelSize: root.theme.fontLarge
                color: root.theme.text
                Layout.fillWidth: true
            }

            Label {
                objectName: "webFallbackStatus"
                text: root.statusText
                color: root.failed ? root.theme.danger : root.theme.textMuted
                font.pixelSize: root.theme.fontSmall
            }
        }

        // The embedded surface. `WebviewHost` reparents its WebEngineView here, so
        // this Item must keep a stable identity and be visible before loading.
        Item {
            id: embedSlot
            objectName: "webFallbackEmbedSlot"
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: root.ready && root.canEmbed
            Component.onCompleted: root.syncEmbedContainer()
        }

        // Browser fallback: the token-carrying URL is handed over natively.
        Rectangle {
            objectName: "webFallbackExternal"
            Layout.fillWidth: true
            visible: root.ready && !root.canEmbed
            implicitHeight: externalColumn.implicitHeight + root.theme.spacing * 2
            color: root.theme.surface
            radius: root.theme.radius

            ColumnLayout {
                id: externalColumn
                anchors.fill: parent
                anchors.margins: root.theme.spacing
                spacing: (root.theme.spacing / 2)

                Label {
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    text: qsTr("此构建未包含 QtWebEngine，回退内容将在系统浏览器中打开。")
                    color: root.theme.text
                    font.pixelSize: root.theme.fontSmall
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: (root.theme.spacing / 2)

                    Label {
                        objectName: "webFallbackMaskedUrl"
                        Layout.fillWidth: true
                        text: root.maskedUrl
                        elide: Text.ElideMiddle
                        color: root.theme.textMuted
                        font.family: root.theme.fontFamily
                        font.pixelSize: root.theme.fontSmall
                    }

                    Button {
                        objectName: "webFallbackOpenBrowser"
                        text: qsTr("在浏览器中打开")
                        enabled: root.ready && root.maskedUrl.length > 0
                        onClicked: {
                            root.externalUrlShown = true
                            root.externalOpenRequested()
                        }
                    }
                }
            }
        }

        // Session-sharing notice: mandatory whenever the fallback is a second
        // process, because that session tree is *not* the one in this window.
        Rectangle {
            objectName: "webFallbackNotice"
            Layout.fillWidth: true
            visible: root.notice.length > 0
            implicitHeight: noticeLabel.implicitHeight + root.theme.spacing * 2
            color: root.theme.surfaceAlt
            radius: root.theme.radius

            Label {
                id: noticeLabel
                anchors.fill: parent
                anchors.margins: root.theme.spacing
                wrapMode: Text.WordWrap
                text: root.notice
                color: root.theme.warning
                font.pixelSize: root.theme.fontSmall
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: (root.theme.spacing / 2)

            Button {
                objectName: "webFallbackOpen"
                text: root.failed ? qsTr("重试") : qsTr("打开 WebUI 回退")
                enabled: root.hostAvailable && (root.idle || root.failed)
                onClicked: root.failed ? root.requestRetry() : root.requestOpen()
            }

            Button {
                objectName: "webFallbackClose"
                text: qsTr("关闭")
                enabled: root.hostAvailable && !root.idle && !root.busy
                onClicked: root.requestClose()
            }

            Label {
                objectName: "webFallbackAttempts"
                visible: root.attempts > 1
                text: qsTr("已尝试 %1 次").arg(root.attempts)
                color: root.theme.textMuted
                font.pixelSize: root.theme.fontSmall
                Layout.fillWidth: true
            }
        }
    }
}
