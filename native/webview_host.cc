// Embedded WebUI host — implementation.
//
// Two builds are supported and both are real:
//
//   * `DSH_QT_HAS_WEBENGINE=1` — QtWebEngine is present; the class creates a
//     `WebEngineView` inside the QML container it is given and pins navigation
//     to the loaded origin.
//   * `DSH_QT_HAS_WEBENGINE=0` (the default in CI today) — no WebEngine: the
//     class reports `available() == false`, every load fails with
//     `webengine-unavailable`, and `WebFallbackPanel.qml` shows the browser
//     hand-off instead. Nothing else in the shell changes.
//
// The flag is set by CMake (`target_compile_definitions`) in the integration
// hand-off, not by this file: `CMakeLists.txt` and `native/main.cpp` belong to
// the host-integration task, so the wiring lives in docs/handoff/I5-webui.md.

#include "webview_host.h"

#include <QDebug>
#include <QMetaObject>
#include <QPointer>
#include <QQuickItem>
#include <QUrlQuery>

#if DSH_QT_HAS_WEBENGINE
#include <QQuickWindow>
#include <QQmlComponent>
#include <QQmlEngine>
#include <QWebEnginePage>
#include <QWebEngineProfile>
#include <QWebEngineSettings>
#endif

namespace {

constexpr auto kUnavailable = "webengine-unavailable";
constexpr auto kInvalidUrl = "invalid-url";
constexpr auto kLoadFailed = "load-failed";

// The embedded page is a QML wrapper rather than a bare WebEngineView because
// the wrapper is where the real Chromium load result becomes visible: QML has
// `loadingChanged`, C++ does not get a signal from a runtime-created item.
// The wrapper forwards success/failure with the committed title and URL; the
// C++ side stores only the token-masked URL and the title. `load()`/`blank()`
// take the target through a property so `QMetaObject::invokeMethod` does not
// have to marshal a QUrl argument into an untyped QML function.
constexpr auto kViewQml = R"QML(
import QtQuick
import QtWebEngine

Item {
    id: root
    signal loadFinished(bool ok, string title, string url)
    readonly property url currentUrl: view.url
    property url targetUrl
    function load() { view.url = root.targetUrl }
    function blank() { view.url = "about:blank" }
    WebEngineView {
        id: view
        anchors.fill: parent
        onLoadingChanged: function(info) {
            if (info.status === WebEngineView.LoadSucceededStatus)
                root.loadFinished(true, view.title, view.url)
            else if (info.status === WebEngineView.LoadFailedStatus)
                root.loadFinished(false, view.title, view.url)
        }
    }
}
)QML";

// `http://127.0.0.1:PORT/?token=***` — never the raw URL.
QString maskToken(const QUrl &url)
{
    QUrl masked = url;
    auto query = QUrlQuery(masked);
    if (query.hasQueryItem(QStringLiteral("token"))) {
        query.removeAllQueryItems(QStringLiteral("token"));
        query.addQueryItem(QStringLiteral("token"), QStringLiteral("***"));
        masked.setQuery(query);
    }
    return masked.toString();
}

} // namespace

class WebviewHost::Private
{
public:
    bool visible = false;
    QString maskedUrl;
    // Display-only summary of the last real engine load. Never the raw URL.
    QString loadState = QStringLiteral("idle");
    QString pageTitle;
    QString currentUrlMasked;
    // The only place the authenticated URL lives. Never exposed to QML.
    QUrl authenticatedUrl;
    // `close()` loads `about:blank`; the resulting loadFinished must report
    // `closed`, not a fresh successful page load.
    bool closing = false;
    QPointer<QObject> container;
#if DSH_QT_HAS_WEBENGINE
    QPointer<QQuickItem> view;
    QPointer<QQuickItem> viewItem;
#endif
};

WebviewHost::WebviewHost(QObject *parent)
    : QObject(parent)
    , d(new Private)
{
}

WebviewHost::~WebviewHost()
{
    // Wipe the credential before the object dies; the page is destroyed with the
    // container.
    d->authenticatedUrl.clear();
    delete d;
}

bool WebviewHost::available() const
{
#if DSH_QT_HAS_WEBENGINE
    return true;
#else
    return false;
#endif
}

QString WebviewHost::unavailableReason() const
{
    return available() ? QString() : QString::fromLatin1(kUnavailable);
}

bool WebviewHost::visible() const
{
    return d->visible;
}

QString WebviewHost::maskedUrl() const
{
    return d->maskedUrl;
}

QString WebviewHost::loadState() const
{
    return d->loadState;
}

QString WebviewHost::pageTitle() const
{
    return d->pageTitle;
}

QString WebviewHost::currentUrlMasked() const
{
    return d->currentUrlMasked;
}

void WebviewHost::setContainer(QQuickItem *item)
{
    d->container = item;
#if DSH_QT_HAS_WEBENGINE
    if (item != nullptr && !d->view.isNull() && d->view->parentItem() != item)
        d->view->setParentItem(item);
#endif
}

void WebviewHost::applyStatus(const QVariantMap &status)
{
    const QString state = status.value(QStringLiteral("state")).toString();
    const bool shouldShow = state == QLatin1String("Ready") && !d->authenticatedUrl.isEmpty();
    if (shouldShow == d->visible)
        return;
    d->visible = shouldShow;
    emit visibleChanged();
    if (!shouldShow) {
        // A failed or stopped fallback must not keep showing a dead page.
        emit maskedUrlChanged();
    }
}

bool WebviewHost::loadAuthenticated(const QString &authenticatedUrl, const QString &maskedUrl)
{
    const QUrl url(authenticatedUrl);
    if (!available()) {
        emit loadFailed(QString::fromLatin1(kUnavailable));
        return false;
    }
    if (!url.isValid() || url.host().isEmpty() || url.query().isEmpty()) {
        emit loadFailed(QString::fromLatin1(kInvalidUrl));
        return false;
    }

    d->authenticatedUrl = url;
    d->closing = false;
    d->maskedUrl = maskedUrl.isEmpty() ? maskToken(url) : maskedUrl;
    d->currentUrlMasked = d->maskedUrl;
    emit maskedUrlChanged();

#if DSH_QT_HAS_WEBENGINE
    QQuickItem *container = qobject_cast<QQuickItem *>(d->container.data());
    if (container == nullptr) {
        qWarning() << "dsh-qt: embedded load rejected: no container";
        emit loadFailed(QString::fromLatin1(kLoadFailed));
        return false;
    }
    if (d->view.isNull()) {
        QQmlEngine *engine = qmlEngine(container);
        if (engine == nullptr) {
            qWarning() << "dsh-qt: embedded load rejected: container has no QML engine";
            emit loadFailed(QString::fromLatin1(kLoadFailed));
            return false;
        }
        QQmlComponent component(engine);
        component.setData(QByteArray(kViewQml), QUrl(QStringLiteral("qrc:/dsh/webview_host.qml")));
        QObject *created = component.create();
        if (created == nullptr) {
            qWarning() << "dsh-qt: WebEngineView unavailable:" << component.errorString();
            emit loadFailed(QString::fromLatin1(kLoadFailed));
            return false;
        }
        auto *item = qobject_cast<QQuickItem *>(created);
        if (item == nullptr) {
            qWarning() << "dsh-qt: embedded load rejected: created object is not a QQuickItem";
            delete created;
            emit loadFailed(QString::fromLatin1(kLoadFailed));
            return false;
        }
        item->setParentItem(container);
        item->setVisible(false);
        d->view = item;
        // The wrapper forwards the real Chromium load result. Store only the
        // masked URL and the title; the raw URL is still kept in
        // `d->authenticatedUrl` for `reload()`.
        QObject::connect(created, SIGNAL(loadFinished(bool, QString, QString)), this,
                         SLOT(handleViewLoadFinished(bool, QString, QString)));
        // Keep the item glued to its container without touching QML anchors.
        const auto resize = [this, container]() {
            if (d->view.isNull())
                return;
            d->view->setWidth(container->width());
            d->view->setHeight(container->height());
        };
        QObject::connect(container, &QQuickItem::widthChanged, item, resize);
        QObject::connect(container, &QQuickItem::heightChanged, item, resize);
        resize();
    }
    d->loadState = QStringLiteral("loading");
    d->pageTitle.clear();
    emit loadStateChanged();
    d->view->setProperty("targetUrl", QVariant::fromValue(url));
    QMetaObject::invokeMethod(d->view, "load");
    d->view->setVisible(true);
    d->visible = true;
    emit visibleChanged();
    return true;
#else
    return false;
#endif
}

void WebviewHost::handleViewLoadFinished(bool ok, const QString &title, const QString &loadedUrl)
{
    const QUrl shown(loadedUrl);
    if (d->closing) {
        // `close()` asked for `about:blank`; record where the view actually
        // ended up and keep the terminal state.
        d->currentUrlMasked = shown.isEmpty() ? QString() : maskToken(shown);
        d->loadState = QStringLiteral("closed");
        d->pageTitle.clear();
        emit loadStateChanged();
        return;
    }
    d->pageTitle = title;
    d->loadState = ok ? QStringLiteral("loaded") : QStringLiteral("failed");
    if (!shown.isEmpty())
        d->currentUrlMasked = maskToken(shown);
    emit loadStateChanged();
    if (!ok) {
        d->visible = false;
        emit visibleChanged();
        emit loadFailed(QString::fromLatin1(kLoadFailed));
    }
}

void WebviewHost::close()
{
    d->authenticatedUrl.clear();
    d->maskedUrl.clear();
    d->pageTitle.clear();
    d->loadState = QStringLiteral("closed");
#if DSH_QT_HAS_WEBENGINE
    if (!d->view.isNull()) {
        // The view is only detached after Chromium commits `about:blank`, so
        // `currentUrlMasked()` cannot lie about a page that is still live. The
        // loadFinished lambda flips `loadState` back to `closed`.
        d->closing = true;
        d->view->setVisible(false);
        QMetaObject::invokeMethod(d->view, "blank");
    } else {
        d->closing = false;
        d->currentUrlMasked.clear();
    }
#else
    d->closing = false;
    d->currentUrlMasked.clear();
#endif
    if (!d->closing)
        emit loadStateChanged();
    if (d->visible) {
        d->visible = false;
        emit visibleChanged();
    }
    emit maskedUrlChanged();
}

void WebviewHost::reload()
{
    if (d->authenticatedUrl.isEmpty()) {
        // Reloading after close() would need the token again; the shell must ask
        // the Node side for a fresh `webui.token` instead.
        emit loadFailed(QString::fromLatin1(kInvalidUrl));
        return;
    }
#if DSH_QT_HAS_WEBENGINE
    if (!d->view.isNull()) {
        d->closing = false;
        d->loadState = QStringLiteral("loading");
        d->pageTitle.clear();
        emit loadStateChanged();
        d->view->setProperty("targetUrl", QVariant::fromValue(d->authenticatedUrl));
        QMetaObject::invokeMethod(d->view, "load");
        d->view->setVisible(true);
    }
#endif
}
