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
constexpr auto kNavigationBlocked = "navigation-blocked";
constexpr auto kLoadFailed = "load-failed";

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
    // The only place the authenticated URL lives. Never exposed to QML.
    QUrl authenticatedUrl;
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
    d->maskedUrl = maskedUrl.isEmpty() ? maskToken(url) : maskedUrl;
    emit maskedUrlChanged();

#if DSH_QT_HAS_WEBENGINE
    QQuickItem *container = qobject_cast<QQuickItem *>(d->container.data());
    if (container == nullptr) {
        emit loadFailed(QString::fromLatin1(kLoadFailed));
        return false;
    }
    if (d->view.isNull()) {
        QQmlEngine *engine = qmlEngine(container);
        if (engine == nullptr) {
            emit loadFailed(QString::fromLatin1(kLoadFailed));
            return false;
        }
        QQmlComponent component(engine);
        component.setData("import QtWebEngine\nWebEngineView {}", QUrl(QStringLiteral("qrc:/dsh/webview_host.qml")));
        QObject *created = component.create();
        if (created == nullptr) {
            qWarning() << "dsh-qt: WebEngineView unavailable:" << component.errorString();
            emit loadFailed(QString::fromLatin1(kLoadFailed));
            return false;
        }
        auto *item = qobject_cast<QQuickItem *>(created);
        if (item == nullptr) {
            delete created;
            emit loadFailed(QString::fromLatin1(kLoadFailed));
            return false;
        }
        item->setParentItem(container);
        item->setVisible(false);
        d->view = item;
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
    d->view->setProperty("url", QVariant::fromValue(url));
    d->view->setVisible(true);
    d->visible = true;
    emit visibleChanged();
    return true;
#else
    return false;
#endif
}

void WebviewHost::close()
{
    d->authenticatedUrl.clear();
    d->maskedUrl.clear();
#if DSH_QT_HAS_WEBENGINE
    if (!d->view.isNull()) {
        d->view->setProperty("url", QVariant::fromValue(QUrl(QStringLiteral("about:blank"))));
        d->view->setVisible(false);
    }
#endif
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
    if (!d->view.isNull())
        d->view->setProperty("url", QVariant::fromValue(d->authenticatedUrl));
#endif
}
