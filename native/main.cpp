// native/main.cpp — minimal Qt host for the DSH Qt6/QML profile.
//
// Responsibilities of this host:
//   1. create the QGuiApplication (Qt Quick Controls 2 style)
//   2. publish the build-time macros from qml/config.h as the `dshQt` context
//      property so QML never hardcodes versions/paths
//   3. own the live theme state (`ThemeBridge`) and publish it as `ctx.theme`,
//      so qml/components/Theme.qml can turn it into bindings (Phase 2g)
//   4. load the embedded qrc:/qml/main.qml entry point
//
// The N-API bridge (dsh-qt-napi) and the libuv message pump are attached here
// in later phases; nothing in this file starts a second event loop.
//
// Theme state lives on the C++ side for three reasons: it must survive a QML
// reload, it is the same file the TypeScript ThemeManager writes
// (src/theme/persist.ts — `theme.json`, schemaVersion 1), and a QML-only store
// could not be watched for changes made while the app is running.
#include <QByteArray>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QFileSystemWatcher>
#include <QGuiApplication>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QJsonValue>
#include <QList>
#include <QMetaObject>
#include <QObject>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickStyle>
#include <QSaveFile>
#include <QSocketNotifier>
#include <QStandardPaths>
#include <QString>
#include <QStringList>
#include <QStyleHints>
#include <QTimer>
#include <QUrl>
#include <QVariant>
#include <QVariantMap>
#include <QtGlobal>

#if defined(Q_OS_WIN)
#include <io.h>
#else
#include <cerrno>
#include <cstring>
#include <unistd.h>
#endif

#include "config.h"

namespace {

/** Scheme ids understood by the bridge and by qml/components/Theme.qml. */
constexpr char kDarkThemeId[] = "dark";
constexpr char kLightThemeId[] = "light";

/**
 * Font scale limits.
 *
 * Mirrors the acceptance range of the theming task (0.8 … 1.5). The TypeScript
 * side allows a slightly wider 0.75 floor (src/theme/manager.ts); the host is
 * the stricter of the two on purpose, because it also drives the native metrics.
 */
constexpr double kMinFontScale = 0.8;
constexpr double kMaxFontScale = 1.5;
constexpr double kDefaultFontScale = 1.0;

/** Persisted-file contract; keep in sync with THEME_FILE_VERSION in src/theme. */
constexpr int kThemeFileVersion = 1;
constexpr char kThemeFileName[] = "theme.json";

/** Debounce for filesystem notifications (editors write in several steps). */
constexpr int kReloadDebounceMs = 50;

/**
 * Resolve the directory holding theme.json.
 *
 * Deliberately the same order as resolveConfigDir() in src/theme/persist.ts so
 * the TypeScript service and the native host read and write one file:
 * DSH_QT_CONFIG_DIR > %APPDATA%\dsh-qt > ~/Library/Application Support/dsh-qt >
 * $XDG_CONFIG_HOME/dsh-qt > the platform generic config location.
 */
QString configDirectory()
{
    const QString override = qEnvironmentVariable("DSH_QT_CONFIG_DIR");
    if (!override.isEmpty())
        return override;

#if defined(Q_OS_WIN)
    const QString appData = qEnvironmentVariable("APPDATA");
    if (!appData.isEmpty())
        return appData + QStringLiteral("/dsh-qt");
#elif defined(Q_OS_MACOS)
    return QDir::homePath() + QStringLiteral("/Library/Application Support/dsh-qt");
#else
    const QString xdg = qEnvironmentVariable("XDG_CONFIG_HOME");
    if (!xdg.isEmpty())
        return xdg + QStringLiteral("/dsh-qt");
#endif

    const QString generic = QStandardPaths::writableLocation(QStandardPaths::GenericConfigLocation);
    if (!generic.isEmpty())
        return generic + QStringLiteral("/dsh-qt");
    return QDir::homePath() + QStringLiteral("/.config/dsh-qt");
}

} // namespace

/**
 * Live theme state shared with QML as `ctx.theme`.
 *
 * QML treats it as the single source of truth: `themeId` and `fontScale` are
 * notifying properties, so qml/components/Theme.qml re-derives all 27 tokens
 * when either changes. The class never throws and never blocks the UI thread:
 * an unreadable or corrupt file degrades to the defaults and a qWarning.
 */
class ThemeBridge : public QObject
{
    Q_OBJECT
    Q_PROPERTY(QString themeId READ themeId WRITE setThemeId NOTIFY themeChanged)
    Q_PROPERTY(QString appearance READ appearance NOTIFY themeChanged)
    Q_PROPERTY(qreal fontScale READ fontScale WRITE setFontScale NOTIFY themeChanged)
    Q_PROPERTY(QStringList schemes READ schemes CONSTANT)
    Q_PROPERTY(QString configPath READ configPath CONSTANT)

public:
    explicit ThemeBridge(QObject *parent = nullptr)
        : QObject(parent)
        , configDir_(configDirectory())
        , configPath_(configDir_ + QLatin1Char('/') + QLatin1StringView(kThemeFileName))
    {
        load();
        watchConfigFile();
    }

    QString themeId() const { return themeId_; }

    void setThemeId(const QString &themeId)
    {
        const QString normalised = normaliseScheme(themeId);
        if (normalised == themeId_)
            return;
        themeId_ = normalised;
        persist();
        emit themeChanged();
    }

    /** "dark" | "light" — the derived hint QML uses for contrast decisions. */
    QString appearance() const { return themeId_ == QLatin1StringView(kLightThemeId) ? QStringLiteral("light") : QStringLiteral("dark"); }

    qreal fontScale() const { return fontScale_; }

    void setFontScale(qreal scale)
    {
        const qreal clamped = clampScale(scale);
        // Compare with a tolerance: QML round-trips qreal through doubles, and a
        // 1e-9 difference must not be treated as a user change.
        if (qAbs(clamped - fontScale_) < 1e-6)
            return;
        fontScale_ = clamped;
        persist();
        emit themeChanged();
    }

    QStringList schemes() const { return {QString::fromLatin1(kDarkThemeId), QString::fromLatin1(kLightThemeId)}; }

    QString configPath() const { return configPath_; }

    /** Flip dark <-> light; the persisted file and QML both follow. */
    Q_INVOKABLE void toggle() { setThemeId(themeId_ == QLatin1StringView(kLightThemeId) ? QString::fromLatin1(kDarkThemeId) : QString::fromLatin1(kLightThemeId)); }

    /**
     * Re-read theme.json.
     *
     * Called on filesystem notifications, so a change written by the Node side
     * (ctx.theme.setActive() in the TypeScript service) shows up live. Returns
     * true when the file was readable and the state changed.
     */
    Q_INVOKABLE bool reload()
    {
        const QString before = themeId_;
        const qreal beforeScale = fontScale_;
        load();
        const bool changed = before != themeId_ || qAbs(beforeScale - fontScale_) >= 1e-6;
        if (changed)
            emit themeChanged();
        return changed;
    }

signals:
    void themeChanged();

private:
    static QString normaliseScheme(const QString &candidate)
    {
        return candidate.compare(QLatin1StringView(kLightThemeId), Qt::CaseInsensitive) == 0 ? QString::fromLatin1(kLightThemeId)
                                                                                          : QString::fromLatin1(kDarkThemeId);
    }

    static qreal clampScale(qreal scale)
    {
        // NaN (a QML binding that resolved to undefined) falls back to 1.0.
        if (!qIsFinite(scale) || qIsNaN(scale))
            return kDefaultFontScale;
        return qBound(kMinFontScale, scale, kMaxFontScale);
    }

    void load()
    {
        QFile file(configPath_);
        if (!file.exists()) {
            // First run: defaults stand, nothing is written until the user
            // changes something (an app that never writes is easier to package).
            themeId_ = QString::fromLatin1(kDarkThemeId);
            fontScale_ = kDefaultFontScale;
            return;
        }
        if (!file.open(QIODevice::ReadOnly)) {
            qWarning("dsh-qt: cannot read %s: %s", qUtf8Printable(configPath_), qUtf8Printable(file.errorString()));
            return;
        }

        QJsonParseError error{};
        const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &error);
        if (error.error != QJsonParseError::NoError || !document.isObject()) {
            qWarning("dsh-qt: ignoring malformed %s (%s)", qUtf8Printable(configPath_), qUtf8Printable(error.errorString()));
            return;
        }

        const QJsonObject root = document.object();
        const QJsonValue version = root.value(QStringLiteral("schemaVersion"));
        if (version.isDouble() && version.toInt() > kThemeFileVersion)
            qWarning("dsh-qt: %s was written by a newer build (schemaVersion %d); reading it best-effort",
                     qUtf8Printable(configPath_), version.toInt());

        if (root.value(QStringLiteral("themeId")).isString())
            themeId_ = normaliseScheme(root.value(QStringLiteral("themeId")).toString());
        if (root.value(QStringLiteral("fontScale")).isDouble())
            fontScale_ = clampScale(root.value(QStringLiteral("fontScale")).toDouble());
    }

    /** Write the current state atomically; failures are reported, never fatal. */
    bool persist()
    {
        QDir().mkpath(configDir_);

        QJsonObject root;
        root.insert(QStringLiteral("schemaVersion"), kThemeFileVersion);
        root.insert(QStringLiteral("themeId"), themeId_);
        root.insert(QStringLiteral("fontScale"), fontScale_);

        QSaveFile file(configPath_);
        if (!file.open(QIODevice::WriteOnly | QIODevice::Text)) {
            qWarning("dsh-qt: cannot write %s: %s", qUtf8Printable(configPath_), qUtf8Printable(file.errorString()));
            return false;
        }
        file.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
        if (!file.commit()) {
            qWarning("dsh-qt: cannot commit %s: %s", qUtf8Printable(configPath_), qUtf8Printable(file.errorString()));
            return false;
        }
        return true;
    }

    void watchConfigFile()
    {
        if (QFileInfo::exists(configDir_) && !watcher_.directories().contains(configDir_))
            watcher_.addPath(configDir_);

        connect(&watcher_, &QFileSystemWatcher::directoryChanged, this, [this](const QString &) { scheduleReload(); });
        connect(&watcher_, &QFileSystemWatcher::fileChanged, this, [this](const QString &) { scheduleReload(); });
    }

    /**
     * Coalesce notifications.
     *
     * Our own QSaveFile write also fires the watcher; the single-shot delay lets
     * a burst collapse into one reload, and reload() is a no-op when the content
     * matches what is already in memory.
     */
    void scheduleReload()
    {
        if (reloadScheduled_)
            return;
        reloadScheduled_ = true;
        QTimer::singleShot(kReloadDebounceMs, this, [this]() {
            reloadScheduled_ = false;
            if (QFileInfo::exists(configDir_) && !watcher_.directories().contains(configDir_))
                watcher_.addPath(configDir_);
            reload();
        });
    }

    QString configDir_;
    QString configPath_;
    QString themeId_ = QString::fromLatin1(kDarkThemeId);
    qreal fontScale_ = kDefaultFontScale;
    QFileSystemWatcher watcher_;
    bool reloadScheduled_ = false;
};

/**
 * Non-blocking newline-delimited JSON over the host's standard streams.
 *
 * The Node side writes one JSON object per line to our stdin and reads replies
 * the same way. Three properties matter more than throughput here:
 *
 *   1. **Never block the UI thread.** Reads happen only when the descriptor is
 *      readable; writes are attempted immediately and, if the pipe is full,
 *      handed to a timer instead of spinning or waiting.
 *   2. **Never grow without bound.** A peer that stops reading must not turn
 *      into an out-of-memory crash, so both directions have hard caps and the
 *      oldest outbound frame is dropped first.
 *   3. **A broken pipe is not fatal.** The application keeps running with the
 *      QML-only behaviour it had before this phase; it simply reports the state
 *      so the UI can say "not connected to Node".
 */
class StdioTransport : public QObject
{
    Q_OBJECT

public:
    explicit StdioTransport(QObject *parent = nullptr)
        : QObject(parent)
    {
        flushTimer_ = new QTimer(this);
        flushTimer_->setSingleShot(true);
        connect(flushTimer_, &QTimer::timeout, this, &StdioTransport::flush_);
    }

    ~StdioTransport() override { stop(); }

    bool start()
    {
        if (active_)
            return true;
        active_ = true;
#ifndef Q_OS_WIN
        readNotifier_ = new QSocketNotifier(0, QSocketNotifier::Read, this);
        connect(readNotifier_, &QSocketNotifier::activated, this, [this]() { readAvailable(); });
#else
        // QSocketNotifier cannot watch a pipe on Windows, so poll instead. The
        // interval is short enough to feel instant and long enough to cost
        // nothing measurable.
        pollTimer_ = new QTimer(this);
        pollTimer_->setInterval(25);
        connect(pollTimer_, &QTimer::timeout, this, &StdioTransport::readAvailable);
        pollTimer_->start();
#endif
        emit stateChanged();
        return true;
    }

    void stop()
    {
        if (!active_ && readNotifier_ == nullptr && pollTimer_ == nullptr)
            return;
        active_ = false;
#ifndef Q_OS_WIN
        delete readNotifier_;
        readNotifier_ = nullptr;
#else
        delete pollTimer_;
        pollTimer_ = nullptr;
#endif
        emit stateChanged();
    }

    bool isActive() const { return active_; }

    QString describe() const
    {
        if (!active_)
            return QStringLiteral("disconnected");
        return QStringLiteral("connected");
    }

    qint64 bytesIn() const { return bytesIn_; }

    qint64 bytesOut() const { return bytesOut_; }

    int queuedFrames() const { return static_cast<int>(outbound_.size()); }

    int droppedFrames() const { return droppedFrames_; }

    /** Queue one message; flushes immediately when the pipe accepts it. */
    void send(const QJsonObject &message)
    {
        if (!active_)
            return;
        QByteArray line = QJsonDocument(message).toJson(QJsonDocument::Compact);
        line.append('\n');
        if (outboundBytes_ + line.size() > kMaxOutboundBytes) {
            // Drop the oldest frame: a stale reply is worth less than staying
            // alive, and the requester has already timed out on its side.
            while (!outbound_.isEmpty() && outboundBytes_ + line.size() > kMaxOutboundBytes) {
                outboundBytes_ -= outbound_.first().size();
                outbound_.removeFirst();
                ++droppedFrames_;
            }
            if (!overflowReported_) {
                overflowReported_ = true;
                emit failed(QStringLiteral("outbound queue overflow; dropping the oldest replies"));
            }
        }
        outboundBytes_ += line.size();
        outbound_.append(line);
        flush_();
    }

signals:
    void messageReceived(const QJsonObject &message);
    void failed(const QString &reason);
    void stateChanged();

private:
    static constexpr int kMaxInboundBytes = 4 * 1024 * 1024;
    static constexpr int kMaxOutboundBytes = 8 * 1024 * 1024;

    void scheduleFlush_(int delayMs = 5)
    {
        if (!flushTimer_->isActive())
            flushTimer_->start(delayMs);
    }

    void flush_()
    {
        while (!outbound_.isEmpty()) {
            QByteArray &front = outbound_.first();
            if (front.isEmpty()) {
                outbound_.removeFirst();
                continue;
            }
            qint64 written = 0;
#if defined(Q_OS_WIN)
            written = ::_write(1, front.constData(), static_cast<unsigned int>(front.size()));
            if (written < 0) {
                scheduleFlush_();
                return;
            }
#else
            written = ::write(1, front.constData(), static_cast<size_t>(front.size()));
            if (written < 0) {
                if (errno == EINTR)
                    continue;
                if (errno == EAGAIN || errno == EWOULDBLOCK) {
                    scheduleFlush_();
                    return;
                }
                emit failed(QStringLiteral("stdout write failed: ") + QString::fromLocal8Bit(std::strerror(errno)));
                stop();
                return;
            }
#endif
            bytesOut_ += written;
            outboundBytes_ -= written;
            if (written < front.size()) {
                front.remove(0, static_cast<int>(written));
                scheduleFlush_();
                return;
            }
            outbound_.removeFirst();
        }
    }

    void readAvailable()
    {
        if (!active_)
            return;
        char chunk[4096];
        qint64 got = 0;
#if defined(Q_OS_WIN)
        got = ::_read(0, chunk, static_cast<unsigned int>(sizeof(chunk)));
        if (got < 0)
            return;
#else
        // One read per readiness notification: a single ::read on a readable
        // descriptor cannot block, while a read-until-EAGAIN loop would.
        got = ::read(0, chunk, sizeof(chunk));
        if (got < 0) {
            if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)
                return;
            emit failed(QStringLiteral("stdin read failed: ") + QString::fromLocal8Bit(std::strerror(errno)));
            stop();
            return;
        }
#endif
        if (got == 0) {
            emit failed(QStringLiteral("stdin closed"));
            stop();
            return;
        }
        bytesIn_ += got;
        inbound_.append(chunk, static_cast<int>(got));
        if (inbound_.size() > kMaxInboundBytes) {
            inbound_.clear();
            emit failed(QStringLiteral("inbound buffer overflow; dropping partial message"));
            return;
        }
        int start = 0;
        for (;;) {
            const int newline = inbound_.indexOf('\n', start);
            if (newline < 0)
                break;
            const QByteArray line = inbound_.mid(start, newline - start).trimmed();
            start = newline + 1;
            if (!line.isEmpty())
                handleLine_(line);
        }
        if (start > 0)
            inbound_.remove(0, start);
    }

    void handleLine_(const QByteArray &line)
    {
        QJsonParseError error{};
        const QJsonDocument document = QJsonDocument::fromJson(line, &error);
        if (error.error != QJsonParseError::NoError || !document.isObject()) {
            emit failed(QStringLiteral("malformed frame from Node: ") + error.errorString());
            return;
        }
        emit messageReceived(document.object());
    }

    QTimer *flushTimer_ = nullptr;
#ifndef Q_OS_WIN
    QSocketNotifier *readNotifier_ = nullptr;
#else
    QTimer *pollTimer_ = nullptr;
#endif
    QByteArray inbound_;
    QList<QByteArray> outbound_;
    qint64 outboundBytes_ = 0;
    qint64 bytesIn_ = 0;
    qint64 bytesOut_ = 0;
    int droppedFrames_ = 0;
    bool overflowReported_ = false;
    bool active_ = false;
};

/**
 * The `dshQt` context property: build metadata plus the QML → Node request API.
 *
 * This used to be a plain QVariantMap of constants. A map cannot carry signals,
 * so it could never answer a QML call — the UI had no way to ask Node for a
 * rendered document. It is now a QObject that keeps **the same eight constant
 * properties** (so `dshQt.appName` and friends in AboutSettings.qml are
 * untouched) and adds a request API on top.
 *
 * Every `Q_INVOKABLE` here returns a request id **immediately** and never waits
 * for Node: QML connects to the matching signal first, then calls. That is the
 * whole point of the bridge — a Node handler may take tens of milliseconds and
 * the GUI thread must not notice.
 *
 * Theme and font scale are answered locally as well as forwarded: the host owns
 * `theme.json`, so repainting must not depend on a round trip, but the change is
 * still announced to Node so plugins observe it.
 */
class DshQtBridge : public QObject
{
    Q_OBJECT
    Q_PROPERTY(QString appName READ appName CONSTANT)
    Q_PROPERTY(QString appVersion READ appVersion CONSTANT)
    Q_PROPERTY(QString minQtVersion READ minQtVersion CONSTANT)
    Q_PROPERTY(int eventLoopTickMs READ eventLoopTickMs CONSTANT)
    Q_PROPERTY(QString napiPackageName READ napiPackageName CONSTANT)
    Q_PROPERTY(QString napiBinaryName READ napiBinaryName CONSTANT)
    Q_PROPERTY(int defaultWindowWidth READ defaultWindowWidth CONSTANT)
    Q_PROPERTY(int defaultWindowHeight READ defaultWindowHeight CONSTANT)
    Q_PROPERTY(QString transportState READ transportState NOTIFY transportStateChanged)
    Q_PROPERTY(int pendingRequests READ pendingRequests NOTIFY pendingRequestsChanged)
    Q_PROPERTY(ThemeBridge *theme READ theme CONSTANT)

public:
    explicit DshQtBridge(ThemeBridge *theme, QObject *parent = nullptr)
        : QObject(parent)
        , theme_(theme)
        , transport_(new StdioTransport(this))
    {
        connect(transport_, &StdioTransport::messageReceived, this, &DshQtBridge::handleMessage_);
        connect(transport_, &StdioTransport::failed, this, &DshQtBridge::handleTransportFailure_);
        connect(transport_, &StdioTransport::stateChanged, this, &DshQtBridge::transportStateChanged);

        elapsed_.start();

        sweepTimer_ = new QTimer(this);
        sweepTimer_->setInterval(500);
        connect(sweepTimer_, &QTimer::timeout, this, &DshQtBridge::expirePending_);
        sweepTimer_->start();
    }

    QString appName() const { return QStringLiteral(DSH_QT_APP_NAME); }
    QString appVersion() const { return QStringLiteral(DSH_QT_APP_VERSION); }
    QString minQtVersion() const { return QStringLiteral(DSH_QT_MIN_QT_VERSION); }
    int eventLoopTickMs() const { return DSH_QT_EVENT_LOOP_TICK_MS; }
    QString napiPackageName() const { return QStringLiteral(DSH_QT_NAPI_PACKAGE_NAME); }
    QString napiBinaryName() const { return QStringLiteral(DSH_QT_NAPI_BINARY_NAME); }
    int defaultWindowWidth() const { return DSH_QT_DEFAULT_WINDOW_WIDTH; }
    int defaultWindowHeight() const { return DSH_QT_DEFAULT_WINDOW_HEIGHT; }

    QString transportState() const { return transport_->describe(); }
    int pendingRequests() const { return static_cast<int>(pending_.size()); }

    ThemeBridge *theme() const { return theme_; }

    /** Start listening on stdin. Safe to call once; a no-op when already live. */
    Q_INVOKABLE bool connectToNode() { return transport_->start(); }

    Q_INVOKABLE QString renderMarkdown(const QString &text)
    {
        return submit_(QStringLiteral("markdown.render"), QJsonObject{{QStringLiteral("text"), text}});
    }

    Q_INVOKABLE QString highlightCode(const QString &code, const QString &language = QString())
    {
        QJsonObject params{{QStringLiteral("code"), code}};
        if (!language.isEmpty())
            params.insert(QStringLiteral("language"), language);
        return submit_(QStringLiteral("code.highlight"), params);
    }

    /**
     * Apply a theme mode ("auto" | "dark" | "light") without touching Node.
     *
     * "auto" is resolved here against the platform colour scheme: the persisted
     * file only ever holds a concrete scheme, so a later run does not inherit a
     * stale decision.
     */
    Q_INVOKABLE QString applyTheme(const QString &mode)
    {
        const QString id = mintId_(QStringLiteral("theme"));
        const QString requested = mode.trimmed().toLower();
        const QString resolved = (requested.isEmpty() || requested == QLatin1String("auto")) ? systemScheme_() : requested;
        theme_->setThemeId(resolved);
        const QString effective = theme_->themeId();
        notifyNode_(QStringLiteral("theme.apply"),
                    QJsonObject{{QStringLiteral("mode"), requested.isEmpty() ? QStringLiteral("auto") : requested},
                                {QStringLiteral("themeId"), effective}});

        Pending pending;
        pending.method = QStringLiteral("theme.apply");
        pending.startedMs = elapsed_.elapsed();
        pending_.insert(id, pending);
        emit pendingRequestsChanged();

        const QString announced = requested.isEmpty() ? QStringLiteral("auto") : requested;
        QMetaObject::invokeMethod(
            this,
            [this, id, announced, effective]() {
                complete_(id, true, QVariantMap{{QStringLiteral("mode"), announced},
                                                {QStringLiteral("themeId"), effective}},
                          QString(), QStringLiteral("theme.apply"));
            },
            Qt::QueuedConnection);
        return id;
    }

    Q_INVOKABLE QString setFontScale(qreal scale)
    {
        const QString id = mintId_(QStringLiteral("scale"));
        theme_->setFontScale(scale);
        const qreal effective = theme_->fontScale();
        notifyNode_(QStringLiteral("theme.scale"), QJsonObject{{QStringLiteral("scale"), effective}});

        Pending pending;
        pending.method = QStringLiteral("theme.scale");
        pending.startedMs = elapsed_.elapsed();
        pending_.insert(id, pending);
        emit pendingRequestsChanged();

        QMetaObject::invokeMethod(
            this,
            [this, id, effective]() {
                complete_(id, true, QVariantMap{{QStringLiteral("scale"), effective}},
                          QString(), QStringLiteral("theme.scale"));
            },
            Qt::QueuedConnection);
        return id;
    }

    Q_INVOKABLE QString getSetting(const QString &name)
    {
        return submit_(QStringLiteral("settings.get"), QJsonObject{{QStringLiteral("name"), name}});
    }

    Q_INVOKABLE QString saveSetting(const QString &name, const QVariant &value)
    {
        return submit_(QStringLiteral("settings.set"),
                       QJsonObject{{QStringLiteral("name"), name},
                                   {QStringLiteral("value"), QJsonValue::fromVariant(value)}});
    }

    Q_INVOKABLE QString sendMessage(const QString &text)
    {
        return submit_(QStringLiteral("composer.submit"), QJsonObject{{QStringLiteral("text"), text}});
    }

    /** Escape hatch: any method name with a raw parameter object. */
    Q_INVOKABLE QString request(const QString &method, const QVariantMap &params = QVariantMap())
    {
        return submit_(method, QJsonObject::fromVariantMap(params));
    }

    Q_INVOKABLE bool cancelRequest(const QString &id)
    {
        if (pending_.remove(id) == 0)
            return false;
        ++cancelled_;
        emit pendingRequestsChanged();
        return true;
    }

    Q_INVOKABLE QVariantMap stats() const
    {
        return QVariantMap{{QStringLiteral("transport"), transport_->describe()},
                           {QStringLiteral("pending"), pendingRequests()},
                           {QStringLiteral("handled"), handled_},
                           {QStringLiteral("failed"), failed_},
                           {QStringLiteral("timeouts"), timedOut_},
                           {QStringLiteral("cancelled"), cancelled_},
                           {QStringLiteral("bytesIn"), transport_->bytesIn()},
                           {QStringLiteral("bytesOut"), transport_->bytesOut()},
                           {QStringLiteral("queuedFrames"), transport_->queuedFrames()},
                           {QStringLiteral("droppedFrames"), transport_->droppedFrames()},
                           {QStringLiteral("lastError"), lastError_}};
    }

signals:
    void markdownRendered(const QString &id, const QString &html, const QString &error);
    void codeHighlighted(const QString &id, const QString &markup, const QString &error);
    void themeApplied(const QString &id, const QString &mode, bool ok, const QString &error);
    void fontScaleApplied(const QString &id, qreal scale, const QString &error);
    void settingRead(const QString &id, const QString &name, const QVariant &value, const QString &error);
    void settingSaved(const QString &id, const QString &name, bool accepted, const QString &error);
    void messageSent(const QString &id, const QString &text, bool accepted, const QString &error);
    void requestReplied(const QString &id, const QString &method, bool ok, const QVariant &result, const QString &error);
    void transportStateChanged();
    void pendingRequestsChanged();

private:
    struct Pending
    {
        QString method;
        QJsonObject params;
        qint64 startedMs = 0;
    };

    static constexpr int kRequestTimeoutMs = 5000;

    QString mintId_(const QString &prefix)
    {
        return prefix + QLatin1Char('-') + QString::number(++sequence_);
    }

    QString submit_(const QString &method, const QJsonObject &params)
    {
        const QString id = mintId_(QStringLiteral("req"));
        if (!transport_->isActive()) {
            // Deterministic failure instead of a request that never answers:
            // QML shows the plain-text fallback and can retry later.
            Pending pending;
            pending.method = method;
            pending.params = params;
            pending.startedMs = elapsed_.elapsed();
            pending_.insert(id, pending);
            emit pendingRequestsChanged();
            QMetaObject::invokeMethod(
                this,
                [this, id]() {
                    complete_(id, false, QVariant(),
                              QStringLiteral("unavailable: the Node host is not connected"));
                },
                Qt::QueuedConnection);
            return id;
        }

        Pending pending;
        pending.method = method;
        pending.params = params;
        pending.startedMs = elapsed_.elapsed();
        pending_.insert(id, pending);
        emit pendingRequestsChanged();

        transport_->send(QJsonObject{{QStringLiteral("id"), id},
                                     {QStringLiteral("method"), method},
                                     {QStringLiteral("params"), params}});
        return id;
    }

    void notifyNode_(const QString &method, const QJsonObject &params)
    {
        if (!transport_->isActive())
            return;
        transport_->send(QJsonObject{{QStringLiteral("type"), QStringLiteral("qml.notify")},
                                     {QStringLiteral("payload"), QJsonObject{{QStringLiteral("method"), method},
                                                                             {QStringLiteral("params"), params}}}});
    }

    void handleMessage_(const QJsonObject &message)
    {
        const QString type = message.value(QStringLiteral("type")).toString();
        if (type == QLatin1String("qml.event")) {
            handleEvent_(message.value(QStringLiteral("payload")).toObject());
            return;
        }
        const QString id = message.value(QStringLiteral("id")).toString();
        if (id.isEmpty())
            return;
        if (!pending_.contains(id))
            return; // late reply for a cancelled or timed-out request
        const Pending pending = pending_.take(id);
        const bool ok = message.value(QStringLiteral("ok")).toBool();
        const QVariant result = message.value(QStringLiteral("result")).toVariant();
        QString error;
        if (!ok) {
            const QJsonObject failure = message.value(QStringLiteral("error")).toObject();
            const QString code = failure.value(QStringLiteral("code")).toString();
            const QString text = failure.value(QStringLiteral("message")).toString();
            error = code.isEmpty() ? text : code + QStringLiteral(": ") + text;
        }
        emit pendingRequestsChanged();
        complete_(id, ok, result, error, pending.method, pending.params);
    }

    void handleEvent_(const QJsonObject &payload)
    {
        const QString event = payload.value(QStringLiteral("event")).toString();
        if (event == QLatin1String("theme.reload"))
            theme_->reload();
    }

    void handleTransportFailure_(const QString &reason)
    {
        lastError_ = reason;
        // Fail everything in flight: the peer cannot answer any more, and a QML
        // control stuck on "loading" is worse than an honest error.
        const QList<QString> ids = pending_.keys();
        for (const QString &id : ids) {
            if (!pending_.contains(id))
                continue;
            const Pending pending = pending_.take(id);
            complete_(id, false, QVariant(), QStringLiteral("unavailable: ") + reason, pending.method, pending.params);
        }
        ++failed_;
        emit pendingRequestsChanged();
    }

    void expirePending_()
    {
        if (pending_.isEmpty())
            return;
        const qint64 now = elapsed_.elapsed();
        const QList<QString> ids = pending_.keys();
        for (const QString &id : ids) {
            if (!pending_.contains(id))
                continue;
            const Pending pending = pending_.value(id);
            if (now - pending.startedMs < kRequestTimeoutMs)
                continue;
            pending_.remove(id);
            ++timedOut_;
            complete_(id, false, QVariant(), QStringLiteral("timeout: no reply within 5 s"), pending.method, pending.params);
        }
        emit pendingRequestsChanged();
    }

    /** Emit the method-specific signal plus the generic one. */
    void complete_(const QString &id, bool ok, const QVariant &result, const QString &error,
                   const QString &method = QString(), const QJsonObject &params = QJsonObject())
    {
        // Idempotent: the reply path already removed the entry, while the local
        // theme paths do not, and a leftover entry would later "time out" and
        // emit a contradictory second signal for the same id.
        if (pending_.remove(id) > 0)
            emit pendingRequestsChanged();

        if (ok)
            ++handled_;
        else
            ++failed_;
        if (!error.isEmpty())
            lastError_ = error;

        const QVariantMap map = result.toMap();
        if (method == QLatin1String("markdown.render")) {
            emit markdownRendered(id, ok ? result.toString() : QString(), error);
        } else if (method == QLatin1String("code.highlight")) {
            emit codeHighlighted(id, ok ? result.toString() : QString(), error);
        } else if (method == QLatin1String("theme.apply")) {
            emit themeApplied(id, map.value(QStringLiteral("mode")).toString(), ok, error);
        } else if (method == QLatin1String("theme.scale")) {
            emit fontScaleApplied(id, map.value(QStringLiteral("scale")).toDouble(), error);
        } else if (method == QLatin1String("settings.get")) {
            emit settingRead(id, map.value(QStringLiteral("name")).toString(),
                             map.value(QStringLiteral("value")), error);
        } else if (method == QLatin1String("settings.set")) {
            emit settingSaved(id, map.value(QStringLiteral("name")).toString(),
                              map.value(QStringLiteral("accepted")).toBool(), error);
        } else if (method == QLatin1String("composer.submit")) {
            // A composer may answer with `{accepted: bool}` or with a bare bool;
            // both mean the same thing to QML.
            const bool accepted = ok && (map.isEmpty() ? result.toBool()
                                                       : map.value(QStringLiteral("accepted")).toBool());
            emit messageSent(id, params.value(QStringLiteral("text")).toString(), accepted, error);
        }
        emit requestReplied(id, method, ok, result, error);
    }

    QString systemScheme_() const
    {
#if QT_VERSION >= QT_VERSION_CHECK(6, 5, 0)
        // Qt only exposes the platform scheme from 6.5; the CI Qt (6.7.3) has it.
        return QGuiApplication::styleHints()->colorScheme() == Qt::ColorScheme::Light
                   ? QString::fromLatin1(kLightThemeId)
                   : QString::fromLatin1(kDarkThemeId);
#else
        return QString::fromLatin1(kDarkThemeId);
#endif
    }

    ThemeBridge *theme_ = nullptr;
    StdioTransport *transport_ = nullptr;
    QTimer *sweepTimer_ = nullptr;
    QHash<QString, Pending> pending_;
    QElapsedTimer elapsed_{};
    qint64 sequence_ = 0;
    int handled_ = 0;
    int failed_ = 0;
    int timedOut_ = 0;
    int cancelled_ = 0;
    QString lastError_;
};

int main(int argc, char *argv[])
{
    QGuiApplication app(argc, argv);
    QGuiApplication::setApplicationName(QStringLiteral(DSH_QT_APP_NAME));
    QGuiApplication::setApplicationVersion(QStringLiteral(DSH_QT_APP_VERSION));
    QGuiApplication::setOrganizationName(QStringLiteral(DSH_QT_APP_ORGANIZATION));

    QQuickStyle::setStyle(QStringLiteral("Basic"));

    // Declared before the engine: the engine must not outlive the objects it
    // exposes through context properties.
    ThemeBridge themeBridge;
    DshQtBridge bridge(&themeBridge);
    bridge.connectToNode();

    QQmlApplicationEngine engine;

    // One namespace, two roles: the constant build metadata that AboutSettings
    // already reads (`dshQt.appName`), and the request API the chat views use.
    engine.rootContext()->setContextProperty(QStringLiteral("dshQt"), &bridge);
    engine.rootContext()->setContextProperty(QStringLiteral("ctx"), &bridge);

    QObject::connect(
        &engine, &QQmlApplicationEngine::objectCreationFailed, &app,
        []() { QCoreApplication::exit(EXIT_FAILURE); }, Qt::QueuedConnection);

    engine.load(QUrl(QStringLiteral(DSH_QT_QML_ENTRY)));
    if (engine.rootObjects().isEmpty())
        return EXIT_FAILURE;

    return app.exec();
}

// AUTOMOC generates main.moc for the Q_OBJECT classes defined in this file
// (CMAKE_AUTOMOC is on in CMakeLists.txt), so no extra header is needed.
#include "main.moc"
