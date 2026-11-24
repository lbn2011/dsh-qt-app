#pragma once

// Embedded WebUI host for the on-demand fallback (I5).
//
// The class is deliberately dependency-light: it is compiled whether or not
// QtWebEngine is available. When it is not, `available()` is false and the QML
// panel shows the browser hand-off instead (`openExternal`), which is why the
// rest of the shell never has to `#ifdef` on WebEngine.
//
// Security contract (see docs/PHASE-3-WEB-FALLBACK.md §7):
//
//   * the authenticated URL — the one carrying `?token=` — enters through
//     `loadAuthenticated()` and stays in this object's private storage. It is
//     never a Q_PROPERTY, never a signal argument and never logged;
//   * only `maskedUrl()` (token replaced by `***`) is QML-readable, for display;
//   * navigation is pinned to the origin of the loaded page, so the token cannot
//     be carried to a third-party host by a redirect or a link click;
//   * `close()` drops the page and wipes the stored URL, so a later `open()`
//     needs a fresh `webui.token` (the Node side hands the token out once).

#include <QObject>
#include <QString>
#include <QUrl>
#include <QVariantMap>

class QQuickItem;

class WebviewHost : public QObject
{
    Q_OBJECT
    // False when QtWebEngine was not found at configure time; the panel then
    // offers the browser fallback only.
    Q_PROPERTY(bool available READ available CONSTANT)
    // Machine-readable reason when `available` is false (`webengine-unavailable`).
    Q_PROPERTY(QString unavailableReason READ unavailableReason CONSTANT)
    Q_PROPERTY(bool visible READ visible NOTIFY visibleChanged)
    // Safe to display: `http://127.0.0.1:PORT/?token=***`.
    Q_PROPERTY(QString maskedUrl READ maskedUrl NOTIFY maskedUrlChanged)
    // Last load outcome reported by the embedded engine. One of `idle`,
    // `loading`, `loaded`, `failed`, `closed`. Added for the WebEngine
    // acceptance test (T28-2): the headless self-test waits for `loaded`
    // before asserting the page title and then closing the page.
    Q_PROPERTY(QString loadState READ loadState NOTIFY loadStateChanged)
    // Title reported by the engine for the last committed page. Never a token.
    Q_PROPERTY(QString pageTitle READ pageTitle NOTIFY loadStateChanged)

public:
    explicit WebviewHost(QObject *parent = nullptr);
    ~WebviewHost() override;

    WebviewHost(const WebviewHost &) = delete;
    WebviewHost &operator=(const WebviewHost &) = delete;

    bool available() const;
    QString unavailableReason() const;
    bool visible() const;
    QString maskedUrl() const;
    // `idle`, `loading`, `loaded`, `failed` or `closed`.
    QString loadState() const;
    QString pageTitle() const;

    // The URL the embedded page is actually showing, token-masked. This exists
    // for the acceptance test to assert that `close()` reached `about:blank`;
    // like `maskedUrl` it never carries the authenticated token.
    Q_INVOKABLE QString currentUrlMasked() const;

    // The QML Item that owns the embedded page (WebFallbackPanel.qml's
    // `embedSlot`). The QML side injects it once, right after the host is
    // assigned; without a container the WebEngineView has no scene to live in,
    // so `loadAuthenticated` refuses instead of creating an orphan view.
    Q_INVOKABLE void setContainer(QQuickItem *item);

    // Mirror of the Node-side `webui.state` event. Only `Ready` shows the view;
    // `Failed`, `Stopping` and `Idle` hide it so a stale page can never be shown
    // as if it were live.
    Q_INVOKABLE void applyStatus(const QVariantMap &status);

    // Hand the one-shot authenticated URL to the engine. Returns false when the
    // WebEngine is unavailable or the URL is unusable (a `loadFailed` signal
    // explains why). `maskedUrl` is what the UI may keep.
    Q_INVOKABLE bool loadAuthenticated(const QString &authenticatedUrl, const QString &maskedUrl);

    // Tear the page down and forget the URL; the caller is expected to have
    // asked the Node side to `webui.close` as well.
    Q_INVOKABLE void close();

    // Reload the current page. Only allowed while an authenticated URL is held,
    // because a reload after `close()` must not resurrect the token.
    Q_INVOKABLE void reload();

signals:
    void visibleChanged();
    void maskedUrlChanged();
    // Emitted for every load-state transition (loading → loaded/failed →
    // closed). Carries no data; read the properties for the safe summary.
    void loadStateChanged();
    // `webengine-unavailable`, `invalid-url`, `load-failed`.
    void loadFailed(const QString &reason);

private:
    class Private;
    Private *d = nullptr;

private Q_SLOTS:
    // Receives the QML wrapper's `loadFinished` (old-style connect: the
    // WebEngineView is created from a QML string, so there is no C++ signal to
    // take a pointer to). Kept as a slot rather than a lambda for that reason.
    void handleViewLoadFinished(bool ok, const QString &title, const QString &loadedUrl);
};
