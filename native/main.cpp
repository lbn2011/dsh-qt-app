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
#include <QDesktopServices>
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
#include <QQmlComponent>
#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickItem>
#include <QQuickWindow>
#include <QQuickStyle>
#include <QSaveFile>
#include <QSharedPointer>
#include <QSocketNotifier>
#include <QStandardPaths>
#include <QString>
#include <QStringList>
#include <QStyleHints>
#include <QTimer>
#include <QUuid>
#include <QUrl>
#include <QVariant>
#include <QVariantMap>
#include <QWindow>
#include <QtGlobal>

#if defined(Q_OS_WIN)
#include <io.h>
#include <windows.h>
#else
#include <cerrno>
#include <cstring>
#include <poll.h>
#include <unistd.h>
#endif

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <future>
#include <memory>
#include <mutex>
#include <thread>

#include "config.h"
#include "webview_host.h"

#if defined(DSH_QT_HAS_WEBENGINE) && DSH_QT_HAS_WEBENGINE
#include <QtWebEngineQuick/QtWebEngineQuick>
#endif

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

/**
 * The desktop hand-off is real in production and in the isolated browser e2e.
 *
 * A normal launch always dispatches through QDesktopServices. The dedicated
 * browser test (`DSH_QT_SELFTEST_REAL_BROWSER=1`) opts a self-test run into the
 * same dispatch so the harness can observe a real xdg-open/browser chain in a
 * throw-away profile; every other self-test keeps the headless outcome without
 * touching the desktop. No URL is ever written to a log.
 */
bool desktopHandOffEnabled()
{
    // The offscreen/minimal QPA plugins have no QPlatformServices::openUrl and
    // Qt's "not supported" warning embeds the whole URL, including the token.
    // Refuse before the call so a headless run can never leak it; the isolated
    // browser e2e runs on xcb under Xvfb and reaches the real dispatch.
    const QString platform = QGuiApplication::platformName();
    if (platform == QLatin1String("offscreen") || platform == QLatin1String("minimal"))
        return false;
    return qEnvironmentVariableIsEmpty("DSH_QT_HOST_SELFTEST") ||
           qEnvironmentVariableIsSet("DSH_QT_SELFTEST_REAL_BROWSER");
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
 * Every byte that has been queued but not yet written, plus the drop policy.
 *
 * Kept as its own class so the accounting can be exercised without a pipe:
 * `DSH_QT_OUTBOUND_QUEUE_SELFTEST=1` replays a scripted sequence through
 * exactly this code (tests/outbound-queue.test.ts), including the paths that
 * need a stalled writer.
 *
 * The single queue is the point. An earlier revision kept one list on the GUI
 * side and a second one inside the Windows writer thread, which meant the cap
 * only ever saw half the backlog: once the writer held the frames, `send()`
 * could no longer drop anything and the GUI list grew without bound. Now one
 * counter covers frames waiting for the writer and frames the writer is
 * chewing on, and a drop removes whole frames from the head of that queue.
 */
class OutboundQueue
{
public:
    qint64 bytes() const { return bytes_; }
    int frames() const { return static_cast<int>(frames_.size()); }
    bool isEmpty() const { return frames_.isEmpty(); }

    void append(const QByteArray &frame)
    {
        if (frame.isEmpty())
            return;
        frames_.append(frame);
        bytes_ += frame.size();
    }

    /** Pops the front frame; the caller owns those bytes until it requeues them. */
    bool take(QByteArray &frame)
    {
        if (frames_.isEmpty())
            return false;
        frame = frames_.takeFirst();
        bytes_ -= frame.size();
        return true;
    }

    /** Puts an unwritten tail back at the head, so ordering is preserved. */
    void requeueFront(const QByteArray &frame)
    {
        if (frame.isEmpty())
            return;
        frames_.prepend(frame);
        bytes_ += frame.size();
    }

    /** Drops whole frames from the head until `incoming` more bytes fit. */
    int dropOldestToFit(qint64 incoming, qint64 cap)
    {
        int dropped = 0;
        while (!frames_.isEmpty() && bytes_ + incoming > cap) {
            bytes_ -= frames_.first().size();
            frames_.removeFirst();
            ++dropped;
        }
        return dropped;
    }

    void clear()
    {
        frames_.clear();
        bytes_ = 0;
    }

private:
    QList<QByteArray> frames_;
    qint64 bytes_ = 0;
};

/**
 * State the Windows writer thread shares with the transport.
 *
 * It lives in a `shared_ptr` so a thread that could not be joined in time can
 * still be detached safely: after `orphaned` is set the thread only touches
 * this struct, never the transport object, and the struct outlives both.
 */
struct WriterState
{
    mutable std::mutex mutex;
    std::condition_variable wake;
    OutboundQueue queue;
    std::atomic<qint64> bytesOut{0};
    std::atomic<int> droppedFrames{0};
    std::atomic<bool> overflowReported{false};
    bool stop = false;
    bool orphaned = false;
};

/**
 * Non-blocking newline-delimited JSON over the host's standard streams.
 *
 * The Node side writes one JSON object per line to our stdin and reads replies
 * the same way. Four properties matter more than throughput here:
 *
 *   1. **Never block the UI thread.** Reads happen only when the descriptor is
 *      readable; writes are handed to the writer thread on Windows and, on
 *      POSIX, written in `<= PIPE_BUF` chunks only after `poll(POLLOUT)` says
 *      the pipe can take bytes. No path on the GUI thread can park in a
 *      blocking read or a blocking write.
 *   2. **Never grow without bound.** A peer that stops reading must not turn
 *      into an out-of-memory crash, so one queue with one byte counter covers
 *      everything that has not been written yet, and the oldest frames are
 *      dropped first.
 *   3. **A broken pipe is not fatal.** The application keeps running with the
 *      QML-only behaviour it had before this phase; it simply reports the state
 *      so the UI can say "not connected to Node".
 *   4. **Shutting down is bounded.** `stop()` cancels a writer that is parked
 *      inside `WriteFile` and waits a fixed two seconds; a writer that still
 *      has not returned is detached with the shared state above, so the process
 *      always exits instead of hanging on `join()`.
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
        // Windows has no QSocketNotifier support for pipes, so the timer path is
        // the only option there. POSIX keeps the notifier by default and opts
        // into the same timer path with DSH_QT_STDIO_POLL=1, which is how the
        // regression suite drives the Windows read loop on a Linux runner.
#if defined(Q_OS_WIN)
        polledReads_ = true;
#else
        polledReads_ = qEnvironmentVariableIsSet("DSH_QT_STDIO_POLL");
#endif
        // Test-only: reproduce the pre-fix read loop (a blocking ::read on every
        // tick, with no readiness check) so the regression can prove it fails
        // there. Nothing outside the test suite sets this.
        legacyBlockingRead_ = qEnvironmentVariableIsSet("DSH_QT_STDIO_TEST_LEGACY_READ");
#if defined(Q_OS_WIN)
        // Only a pipe needs the peek-before-read dance. A redirected file or a
        // console has no byte count to peek at, and reading from those at EOF
        // returns 0 rather than blocking, so they take the plain read path.
        const HANDLE stdinHandle = GetStdHandle(STD_INPUT_HANDLE);
        stdinIsPipe_ = stdinHandle != nullptr && stdinHandle != INVALID_HANDLE_VALUE
                       && GetFileType(stdinHandle) == FILE_TYPE_PIPE;
#else
        stdinIsPipe_ = true;
#endif
    }

    ~StdioTransport() override { stop(); }

    bool start()
    {
        if (active_)
            return true;
        active_ = true;
        if (polledReads_) {
            // Short enough to feel instant, long enough to cost nothing
            // measurable. The read itself is readiness-gated (see
            // stdinReadiness_), so an idle pipe costs one PeekNamedPipe/poll per
            // tick instead of parking the GUI thread inside ::read.
            pollTimer_ = new QTimer(this);
            pollTimer_->setInterval(25);
            connect(pollTimer_, &QTimer::timeout, this, &StdioTransport::readAvailable);
            pollTimer_->start();
        } else {
            readNotifier_ = new QSocketNotifier(0, QSocketNotifier::Read, this);
            connect(readNotifier_, &QSocketNotifier::activated, this, [this]() { readAvailable(); });
        }
#if defined(Q_OS_WIN)
        // stdout is written from a worker thread on Windows: an anonymous pipe
        // has no writability probe, so a peer that stops reading would park the
        // GUI thread inside WriteFile forever.
        {
            std::lock_guard<std::mutex> lock(state_->mutex);
            state_->stop = false;
            state_->orphaned = false;
            state_->queue.clear();
        }
        std::packaged_task<void()> task([this, state = state_]() { writerLoop_(state); });
        writerDone_ = task.get_future();
        writer_ = std::thread(std::move(task));
#endif
        emit stateChanged();
        return true;
    }

    void stop()
    {
#if defined(Q_OS_WIN)
        const bool writerBusy = writer_.joinable();
#else
        const bool writerBusy = false;
#endif
        if (!active_ && pollTimer_ == nullptr && readNotifier_ == nullptr && !writerBusy)
            return;
        active_ = false;
        delete readNotifier_;
        readNotifier_ = nullptr;
        delete pollTimer_;
        pollTimer_ = nullptr;
#if defined(Q_OS_WIN)
        if (writer_.joinable()) {
            {
                std::lock_guard<std::mutex> lock(state_->mutex);
                state_->stop = true;
                state_->queue.clear();
            }
            state_->wake.notify_all();
            // A writer parked inside WriteFile on a full pipe never observes
            // `stop` on its own, and joining it would hang the GUI thread. So
            // cancel that one call and wait a fixed budget; past it the thread
            // is detached and may only touch the shared state.
            ::CancelSynchronousIo(writer_.native_handle());
            if (writerDone_.wait_for(std::chrono::milliseconds(kWriterJoinTimeoutMs))
                == std::future_status::ready) {
                writer_.join();
            } else {
                {
                    std::lock_guard<std::mutex> lock(state_->mutex);
                    state_->orphaned = true;
                }
                writer_.detach();
                emit failed(QStringLiteral("stdout writer did not stop within %1 ms; detached it")
                                .arg(kWriterJoinTimeoutMs));
            }
        }
#endif
        {
            std::lock_guard<std::mutex> lock(state_->mutex);
            state_->queue.clear();
        }
        state_->overflowReported = false;
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

    qint64 bytesOut() const { return state_->bytesOut.load(); }

    /** Frames still queued for the writer, on either side of the hand-off. */
    int queuedFrames() const
    {
        std::lock_guard<std::mutex> lock(state_->mutex);
        return state_->queue.frames();
    }

    /** Bytes still owed to the peer: the single cap from `kMaxOutboundBytes`. */
    qint64 queuedBytes() const
    {
        std::lock_guard<std::mutex> lock(state_->mutex);
        return state_->queue.bytes();
    }

    int droppedFrames() const { return state_->droppedFrames.load(); }

    /** Queue one message; flushes immediately when the pipe accepts it. */
    void send(const QJsonObject &message)
    {
        if (!active_)
            return;
        QByteArray line = QJsonDocument(message).toJson(QJsonDocument::Compact);
        line.append('\n');
        int dropped = 0;
        {
            std::lock_guard<std::mutex> lock(state_->mutex);
            // Drop from the head of the one queue: a stale reply is worth less
            // than staying alive, and the requester has already timed out.
            dropped = state_->queue.dropOldestToFit(line.size(), kMaxOutboundBytes);
            state_->droppedFrames += dropped;
            state_->queue.append(line);
        }
        if (dropped > 0 && !state_->overflowReported.exchange(true))
            emit failed(QStringLiteral("outbound queue overflow; dropping the oldest replies"));
        flush_();
    }

signals:
    void messageReceived(const QJsonObject &message);
    void failed(const QString &reason);
    void stateChanged();

private:
    static constexpr int kMaxInboundBytes = 4 * 1024 * 1024;
    static constexpr int kMaxOutboundBytes = 8 * 1024 * 1024;
    // Bytes we are willing to move per read tick. Draining a burst in one tick
    // keeps throughput in the MB/s range instead of one 4 KB chunk per timer
    // shot, while the budget keeps a firehose peer from starving the GUI.
    static constexpr int kReadBudgetPerTick = 64 * 1024;
    // PIPE_BUF is 4096 on both platforms; writing more than that in one call can
    // block until the reader drains the whole buffer.
    static constexpr int kWriteChunkBytes = 4096;
    // How long stop() waits for a writer parked in WriteFile before detaching it.
    static constexpr int kWriterJoinTimeoutMs = 2000;

    void scheduleFlush_(int delayMs = 5)
    {
        if (!flushTimer_->isActive())
            flushTimer_->start(delayMs);
    }

    void flush_()
    {
#if defined(Q_OS_WIN)
        // The frame is already in the queue; the writer thread owns WriteFile.
        state_->wake.notify_one();
#else
        for (;;) {
            QByteArray frame;
            if (!state_->queue.take(frame))
                return;
            while (!frame.isEmpty()) {
                // Ask the kernel whether the pipe can take bytes right now.
                // Writing blind is what turns a slow reader into a frozen UI.
                struct pollfd writable = {1, POLLOUT, 0};
                const int ready = ::poll(&writable, 1, 0);
                if (ready == 0) {
                    state_->queue.requeueFront(frame);
                    scheduleFlush_();
                    return;
                }
                if (ready < 0) {
                    if (errno == EINTR)
                        continue;
                    state_->queue.requeueFront(frame);
                    emit failed(QStringLiteral("stdout poll failed: ")
                                + QString::fromLocal8Bit(std::strerror(errno)));
                    stop();
                    return;
                }
                // At most PIPE_BUF per call: a larger blocking write can park
                // until the whole buffer drains, which is the very thing this
                // class promises never to do on the GUI thread.
                const int chunk = frame.size() > kWriteChunkBytes ? kWriteChunkBytes : frame.size();
                const ssize_t written = ::write(1, frame.constData(), static_cast<size_t>(chunk));
                if (written < 0) {
                    if (errno == EINTR)
                        continue;
                    state_->queue.requeueFront(frame);
                    if (errno == EAGAIN || errno == EWOULDBLOCK) {
                        scheduleFlush_();
                        return;
                    }
                    emit failed(QStringLiteral("stdout write failed: ")
                                + QString::fromLocal8Bit(std::strerror(errno)));
                    stop();
                    return;
                }
                state_->bytesOut += written;
                frame.remove(0, static_cast<int>(written));
            }
        }
#endif
    }

#if defined(Q_OS_WIN)
    /**
     * Drains the shared queue on its own thread; the GUI thread only appends.
     *
     * It may block in `_write` — that is the whole point of moving it off the
     * GUI thread — and it stops touching the transport as soon as `orphaned`
     * is set, so `stop()` can detach it instead of hanging on `join()`.
     */
    void writerLoop_(const std::shared_ptr<WriterState> &state)
    {
        std::unique_lock<std::mutex> lock(state->mutex);
        for (;;) {
            state->wake.wait(lock, [&state]() { return state->stop || !state->queue.isEmpty(); });
            if (state->queue.isEmpty()) {
                if (state->stop)
                    return;
                continue;
            }
            QByteArray frame;
            if (!state->queue.take(frame))
                continue;
            const int chunk = frame.size() > kWriteChunkBytes ? kWriteChunkBytes : frame.size();
            lock.unlock();
            const int written = ::_write(1, frame.constData(), static_cast<unsigned int>(chunk));
            const int error = written < 0 ? errno : 0;
            lock.lock();
            if (written < 0) {
                state->queue.clear();
                state->stop = true;
                const bool report = !state->orphaned;
                lock.unlock();
                if (report) {
                    const QString reason = QStringLiteral("stdout write failed (error %1)")
                                               .arg(error);
                    QMetaObject::invokeMethod(
                        this,
                        [this, reason]() {
                            emit failed(reason);
                            stop();
                        },
                        Qt::QueuedConnection);
                }
                return;
            }
            state->bytesOut += written;
            if (written < frame.size()) {
                // Partial write: keep the remainder at the head of the queue and
                // pause briefly so a stalled reader cannot spin a core.
                state->queue.requeueFront(frame.mid(written));
                lock.unlock();
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
                lock.lock();
            }
        }
    }
#endif

    /**
     * True when stdin has bytes (or has reached EOF/error) waiting right now.
     *
     * This is the whole fix for the Windows freeze: ::read on an idle anonymous
     * pipe blocks, and a blocked GUI thread stops repainting, stops every QTimer
     * (including the 5 s handshake deadline) and looks exactly like "the process
     * is alive but the window is dead". PeekNamedPipe reports the queued byte
     * count without consuming anything, so the read below can never wait.
     */
    /**
     * What stdin looks like right now, without touching it.
     *
     * `Ready` means a read cannot block; `Idle` means wait for the next tick;
     * `Broken` means the peer closed, which is an ordinary EOF and not an error.
     * A pipe that has data but no longer a reader reports `Broken` too, because
     * `PeekNamedPipe` fails with ERROR_BROKEN_PIPE and `::_read` then returns 0.
     */
    enum class StdinReadiness
    {
        Ready,
        Idle,
        Broken,
        Failed
    };

    StdinReadiness stdinReadiness_(QString *reason = nullptr)
    {
#if defined(Q_OS_WIN)
        const HANDLE handle = GetStdHandle(STD_INPUT_HANDLE);
        if (handle == nullptr || handle == INVALID_HANDLE_VALUE) {
            if (reason != nullptr)
                *reason = QStringLiteral("stdin handle is not available");
            return StdinReadiness::Failed;
        }
        // Only pipes get the peek treatment. A redirected file or console has no
        // byte count to peek at, and ::read on a file at EOF simply returns 0, so
        // those fall back to the plain blocking read this class always used.
        if (!stdinIsPipe_)
            return StdinReadiness::Ready;
        DWORD available = 0;
        if (!PeekNamedPipe(handle, nullptr, 0, nullptr, &available, nullptr)) {
            const DWORD error = GetLastError();
            if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED)
                return StdinReadiness::Broken;
            if (reason != nullptr) {
                *reason = QStringLiteral("stdin peek failed (error %1)").arg(error);
            }
            return StdinReadiness::Failed;
        }
        return available > 0 ? StdinReadiness::Ready : StdinReadiness::Idle;
#else
        Q_UNUSED(reason);
        struct pollfd descriptor = {0, POLLIN, 0};
        const int ready = ::poll(&descriptor, 1, 0);
        if (ready < 0)
            return errno == EINTR ? StdinReadiness::Idle : StdinReadiness::Failed;
        if (ready == 0)
            return StdinReadiness::Idle;
        if ((descriptor.revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) == 0)
            return StdinReadiness::Idle;
        return StdinReadiness::Ready;
#endif
    }

    /**
     * Moves up to `kReadBudgetPerTick` bytes and returns how many it moved.
     *
     * Returns -1 when the peer closed. The budget is what keeps the GUI fair: a
     * peer that never stops writing would otherwise keep this loop (and the
     * event loop) busy indefinitely.
     */
    qint64 readOnce_()
    {
        char chunk[4096];
        qint64 moved = 0;
        while (moved < kReadBudgetPerTick) {
            if (!legacyBlockingRead_) {
                const StdinReadiness readiness = stdinReadiness_();
                if (readiness == StdinReadiness::Broken)
                    return moved > 0 ? moved : -1;
                if (readiness != StdinReadiness::Ready)
                    return moved;
            }
            qint64 got = 0;
#if defined(Q_OS_WIN)
            got = ::_read(0, chunk, static_cast<unsigned int>(sizeof(chunk)));
            if (got < 0)
                return moved;
#else
            got = ::read(0, chunk, sizeof(chunk));
            if (got < 0) {
                if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)
                    return moved;
                emit failed(QStringLiteral("stdin read failed: ")
                            + QString::fromLocal8Bit(std::strerror(errno)));
                stop();
                return moved;
            }
#endif
            if (got == 0)
                return moved > 0 ? moved : -1;
            moved += got;
            bytesIn_ += got;
            inbound_.append(chunk, static_cast<int>(got));
            if (legacyBlockingRead_) {
                // The fixture has to keep the pre-fix shape exactly: one
                // blocking read per tick, then back to the event loop.
                return moved;
            }
        }
        return moved;
    }

    void readAvailable()
    {
        if (!active_)
            return;
        // Never enter ::read without proof that it cannot block. The legacy
        // switch exists only so the regression suite can demonstrate the
        // pre-fix behaviour on a silent-but-open pipe.
        if (!legacyBlockingRead_) {
            QString reason;
            const StdinReadiness readiness = stdinReadiness_(&reason);
            if (readiness == StdinReadiness::Failed) {
                emit failed(reason);
                stop();
                return;
            }
            if (readiness == StdinReadiness::Idle)
                return;
        }
        const qint64 moved = readOnce_();
        if (moved < 0) {
            emit failed(QStringLiteral("stdin closed"));
            stop();
            return;
        }
        if (moved == 0)
            return;
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
    QSocketNotifier *readNotifier_ = nullptr;
    QTimer *pollTimer_ = nullptr;
    QByteArray inbound_;
    // One queue for every byte not yet written, shared with the Windows writer
    // thread, so the outbound cap sees the writer's backlog as well.
    std::shared_ptr<WriterState> state_ = std::make_shared<WriterState>();
    qint64 bytesIn_ = 0;
    bool active_ = false;
    bool polledReads_ = false;
    bool legacyBlockingRead_ = false;
    bool stdinIsPipe_ = false;
#if defined(Q_OS_WIN)
    std::thread writer_;
    std::future<void> writerDone_;
#endif
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

    QString transportState() const
    {
        if (connecting_)
            return QStringLiteral("connecting");
        if (connected_)
            return QStringLiteral("connected");
        return QStringLiteral("disconnected");
    }
    int pendingRequests() const { return static_cast<int>(pending_.size()); }

    ThemeBridge *theme() const { return theme_; }

    /**
     * Start listening on stdin and announce this session with a `hello` frame.
     *
     * The bridge stays in `connecting` until the host answers `hello.ack`.
     * There is deliberately no optimistic "connected": before protocol v1 the
     * UI reported connected as soon as stdin was open, which made a standalone
     * launch wait five seconds for a reply that could never arrive.
     */
    Q_INVOKABLE bool connectToNode()
    {
        if (transport_->isActive())
            return false;
        connecting_ = true;
        if (!transport_->start()) {
            connecting_ = false;
            emit transportStateChanged();
            return false;
        }
        beginHandshake_();
        return true;
    }

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
        // Repaint first: the host owns theme.json and must not wait for a round
        // trip, but the change is still announced so Node-side plugins observe
        // it. The reply carries the effective id back into QML.
        const QString requested = mode.trimmed().toLower();
        const QString resolved = (requested.isEmpty() || requested == QLatin1String("auto")) ? systemScheme_() : requested;
        theme_->setThemeId(resolved);
        return submit_(QStringLiteral("theme.apply"),
                       QJsonObject{{QStringLiteral("mode"), requested.isEmpty() ? QStringLiteral("auto") : requested},
                                   {QStringLiteral("themeId"), theme_->themeId()}});
    }

    Q_INVOKABLE QString setFontScale(qreal scale)
    {
        theme_->setFontScale(scale);
        return submit_(QStringLiteral("theme.scale"), QJsonObject{{QStringLiteral("scale"), theme_->fontScale()}});
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

    /**
     * Ask the host for the one-shot authenticated WebUI URL.
     *
     * QML never receives that URL: the reply is consumed here (or in
     * WebviewHost) and only `maskedUrl` leaves this object. Both calls are
     * no-ops when the host is not connected — `request()` already reports
     * `unavailable` through `requestReplied`.
     */
    Q_INVOKABLE void openWebuiEmbedded() { beginWebuiToken_(QStringLiteral("embed")); }

    Q_INVOKABLE void openWebuiExternally() { beginWebuiToken_(QStringLiteral("browser")); }

    Q_INVOKABLE void closeWebui()
    {
        // Intent is bound to the request id, so a close only has to forget the
        // outstanding ids: a late `webui.token` reply for one of them lands in
        // `resolveWebuiToken_` with no intent and is dropped as `cancelled`.
        webuiIntents_.clear();
        if (webview_ != nullptr)
            webview_->close();
        request(QStringLiteral("webui.close"));
    }

    /** True when this build can embed a WebEngine view (own Chromium). */
    Q_INVOKABLE bool canEmbedWebui() const
    {
        return webview_ != nullptr && webview_->available();
    }

    void setWebviewHost(WebviewHost *view) { webview_ = view; }

    Q_INVOKABLE QVariantMap stats() const
    {
        return QVariantMap{{QStringLiteral("transport"), transportState()},
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
    // Safe summary of a `webui.token` reply: never carries the authenticated URL.
    void webuiTokenResolved(const QString &id, const QString &intent, const QString &outcome,
                            const QString &maskedUrl, const QString &error);
    void transportStateChanged();
    void pendingRequestsChanged();

    /**
     * Every v1 `evt` frame, already validated by the host, forwarded to QML.
     *
     * `payload` is the event payload object; `topic` carries the optional
     * `{session, turn}` scope. Known names additionally drive native state
     * (`theme.reload`, `webui.state`); everything else is consumed by QML.
     */
    void eventReceived(const QString &name, const QVariant &topic, const QVariant &payload);

    /** WebUI fallback state machine, mirrored for the QML panel. */
    void webuiStateChanged(const QVariantMap &status);

private:
    struct Pending
    {
        QString method;
        QJsonObject params;
        qint64 startedMs = 0;
        bool sent = false;
    };

    static constexpr int kRequestTimeoutMs = 5000;
    static constexpr int kHandshakeTimeoutMs = 5000;

    QString mintId_(const QString &prefix)
    {
        return prefix + QLatin1Char('-') + QString::number(++sequence_);
    }

    QString submit_(const QString &method, const QJsonObject &params)
    {
        const QString id = mintId_(QStringLiteral("req"));
        Pending pending;
        pending.method = method;
        pending.params = params;
        pending.startedMs = elapsed_.elapsed();
        pending_.insert(id, pending);
        emit pendingRequestsChanged();

        if (connecting_) {
            // Held until hello.ack: the hello frame must be the first frame the
            // host sees, so requests may only follow the handshake.
            return id;
        }
        if (!connected_) {
            // Deterministic failure instead of a request that never answers:
            // QML shows the plain-text fallback and can retry later.
            QMetaObject::invokeMethod(
                this,
                [this, id]() {
                    complete_(id, false, QVariant(),
                              QStringLiteral("unavailable: the Node host is not connected"));
                },
                Qt::QueuedConnection);
            return id;
        }
        flushPending_(id);
        return id;
    }

    /** Write a queued request once the handshake finished. */
    void flushPending_(const QString &id)
    {
        auto it = pending_.find(id);
        if (it == pending_.end() || it->sent)
            return;
        QJsonObject frame{{QStringLiteral("kind"), QStringLiteral("req")},
                          {QStringLiteral("id"), id},
                          {QStringLiteral("method"), it->method}};
        if (!it->params.isEmpty())
            frame.insert(QStringLiteral("params"), it->params);
        if (!sendFrame_(frame)) {
            complete_(id, false, QVariant(), QStringLiteral("unavailable: could not write to the Node host"),
                      it->method, it->params);
            return;
        }
        it->sent = true;
    }

    void flushAllPending_()
    {
        const QList<QString> ids = pending_.keys();
        for (const QString &id : ids)
            flushPending_(id);
    }

    /**
     * Add the protocol version and write one frame.
     *
     * @returns false when the transport is no longer live, so callers can turn
     *   that into a request failure instead of a silent drop.
     */
    bool sendFrame_(const QJsonObject &frame)
    {
        if (!transport_->isActive())
            return false;
        QJsonObject outbound = frame;
        outbound.insert(QStringLiteral("v"), 1);
        transport_->send(outbound);
        return true;
    }

    /** Tell Node what the UI is showing; seq is monotonic for this epoch. */
    void announceState_()
    {
        if (!transport_->isActive())
            return;
        sendFrame_(QJsonObject{{QStringLiteral("kind"), QStringLiteral("evt")},
                               {QStringLiteral("seq"), eventSeq_++},
                               {QStringLiteral("epoch"), epoch_},
                               {QStringLiteral("name"), QStringLiteral("transport.state")},
                               {QStringLiteral("payload"), QJsonObject{{QStringLiteral("state"), transportState()}}}});
    }

    void beginHandshake_()
    {
        epoch_ = QUuid::createUuid().toString(QUuid::WithoutBraces);
        connected_ = false;
        lastError_.clear();
        eventSeq_ = 0;

        const QJsonObject hello{{QStringLiteral("kind"), QStringLiteral("hello")},
                                {QStringLiteral("role"), QStringLiteral("qt")},
                                {QStringLiteral("epoch"), epoch_},
                                {QStringLiteral("app"), QStringLiteral(DSH_QT_APP_NAME) + QLatin1Char('/') + QStringLiteral(DSH_QT_APP_VERSION)},
                                {QStringLiteral("qt"), QString::fromLatin1(qVersion())},
                                {QStringLiteral("caps"), QJsonArray{
                                     QStringLiteral("markdown.parse"),
                                     QStringLiteral("markdown.render"),
                                     QStringLiteral("code.highlight"),
                                     QStringLiteral("theme.apply"),
                                     QStringLiteral("theme.scale"),
                                     QStringLiteral("settings.get"),
                                     QStringLiteral("settings.set"),
                                     QStringLiteral("settings.save"),
                                     QStringLiteral("settings.all"),
                                     QStringLiteral("composer.submit"),
                                     QStringLiteral("ping"),
                                 }}};
        if (!sendFrame_(hello)) {
            failConnection_(QStringLiteral("could not write hello to the Node host"));
            return;
        }
        announceState_();

        if (handshakeTimer_ == nullptr) {
            handshakeTimer_ = new QTimer(this);
            handshakeTimer_->setSingleShot(true);
            connect(handshakeTimer_, &QTimer::timeout, this, &DshQtBridge::handshakeTimedOut_);
        }
        handshakeTimer_->start(kHandshakeTimeoutMs);
    }

    void handshakeTimedOut_()
    {
        if (connected_ || !connecting_)
            return;
        failConnection_(QStringLiteral("timeout: no hello.ack within 5 s"));
    }

    void handleHelloAck_(const QJsonObject &frame)
    {
        if (!connecting_)
            return; // duplicate ack: the first one already won
        const QString epoch = frame.value(QStringLiteral("epoch")).toString();
        if (epoch != epoch_) {
            rejectProtocol_(QStringLiteral("protocol"), QStringLiteral("hello.ack epoch does not match this session"));
            return;
        }
        connecting_ = false;
        connected_ = true;
        hadConnected_ = true;
        if (handshakeTimer_ != nullptr)
            handshakeTimer_->stop();
        emit transportStateChanged();
        announceState_();
        flushAllPending_();
    }

    void handleReply_(const QJsonObject &message)
    {
        const QString id = message.value(QStringLiteral("id")).toString();
        if (id.isEmpty())
            return;
        auto it = pending_.find(id);
        if (it == pending_.end())
            return; // late reply for a cancelled, timed-out or flushed request
        const Pending pending = *it;
        pending_.remove(id);
        emit pendingRequestsChanged();

        const bool ok = message.value(QStringLiteral("ok")).toBool();
        const QVariant result = message.value(QStringLiteral("result")).toVariant();
        QString error;
        if (!ok) {
            const QJsonObject failure = message.value(QStringLiteral("error")).toObject();
            const QString code = failure.value(QStringLiteral("code")).toString();
            const QString text = failure.value(QStringLiteral("message")).toString();
            error = code.isEmpty() ? text : code + QStringLiteral(": ") + text;
        }
        complete_(id, ok, result, error, pending.method, pending.params);
    }

    /** Answer a request the host sent to this UI process. */
    void handleHostRequest_(const QJsonObject &frame)
    {
        const QString id = frame.value(QStringLiteral("id")).toString();
        if (id.isEmpty()) {
            rejectProtocol_(QStringLiteral("bad-params"), QStringLiteral("req.id must be a non-empty string"));
            return;
        }
        const QString method = frame.value(QStringLiteral("method")).toString();
        if (!connected_) {
            sendRes_(id, false, QJsonValue(), QStringLiteral("unavailable"),
                     QStringLiteral("the Qt host is not connected"));
            return;
        }
        if (method == QLatin1String("host.ping")) {
            sendRes_(id, true, QJsonObject{{QStringLiteral("state"), transportState()},
                                           {QStringLiteral("pending"), pendingRequests()}});
            return;
        }
        // Test-only echo: lets the regression drive frames of a chosen size in
        // both directions, which is how the chunked writer and the read budget
        // are exercised. Registered only when DSH_QT_TEST_HOOKS is set, so the
        // production method set is unchanged.
        if (testHooks_ && method == QLatin1String("host.echo")) {
            const QJsonObject params = frame.value(QStringLiteral("params")).toObject();
            const int bytes = qBound(0, params.value(QStringLiteral("bytes")).toInt(), 8 * 1024 * 1024);
            sendRes_(id, true,
                     QJsonObject{{QStringLiteral("bytes"), bytes},
                                 {QStringLiteral("payload"), QString(bytes, QLatin1Char('x'))}});
            return;
        }
        if (method == QLatin1String("host.quit")) {
            sendRes_(id, true, QJsonObject{{QStringLiteral("accepted"), true}});
            QTimer::singleShot(0, qApp, &QCoreApplication::quit);
            return;
        }
        sendRes_(id, false, QJsonValue(), QStringLiteral("unknown-method"),
                 QStringLiteral("unknown Qt method: ") + method);
    }

    void sendRes_(const QString &id, bool ok, const QJsonValue &result,
                  const QString &code = QString(), const QString &message = QString())
    {
        QJsonObject frame{{QStringLiteral("kind"), QStringLiteral("res")},
                          {QStringLiteral("id"), id},
                          {QStringLiteral("ok"), ok}};
        if (ok) {
            if (!result.isUndefined() && !result.isNull())
                frame.insert(QStringLiteral("result"), result);
        } else {
            frame.insert(QStringLiteral("error"),
                         QJsonObject{{QStringLiteral("code"), code.isEmpty() ? QStringLiteral("internal") : code},
                                     {QStringLiteral("message"), message}});
        }
        sendFrame_(frame);
    }

    void handleMessage_(const QJsonObject &message)
    {
        const int version = message.value(QStringLiteral("v")).toInt(-1);
        if (version != 1) {
            rejectProtocol_(QStringLiteral("bad-params"),
                            QStringLiteral("frame is missing protocol version v; expected 1"));
            return;
        }
        const QString kind = message.value(QStringLiteral("kind")).toString();
        if (kind == QLatin1String("hello.ack")) {
            handleHelloAck_(message);
        } else if (kind == QLatin1String("nack")) {
            const QString code = message.value(QStringLiteral("code")).toString();
            const QString text = message.value(QStringLiteral("message")).toString();
            failConnection_(QStringLiteral("protocol: host rejected the handshake")
                            + (code.isEmpty() ? QString() : QStringLiteral(" (") + code + QLatin1Char(')'))
                            + QStringLiteral(": ") + text);
        } else if (kind == QLatin1String("res")) {
            handleReply_(message);
        } else if (kind == QLatin1String("req")) {
            handleHostRequest_(message);
        } else if (kind == QLatin1String("evt")) {
            handleEvent_(message);
        }
        // Unknown kinds are forward-compatible by contract: ignore, do not answer.
    }

    void handleEvent_(const QJsonObject &frame)
    {
        // Events are host→Qt; Qt never replies to one. Unknown names are
        // ignored so a newer host can add events without breaking this build.
        const QString name = frame.value(QStringLiteral("name")).toString();
        const QJsonValue payloadValue = frame.value(QStringLiteral("payload"));
        const QVariant payload = payloadValue.toVariant();
        const QVariant topic = frame.value(QStringLiteral("topic")).toVariant();

        if (name == QLatin1String("theme.reload"))
            theme_->reload();
        else if (name == QLatin1String("webui.state")) {
            const QVariantMap status = payloadValue.toObject().toVariantMap();
            if (webview_ != nullptr)
                webview_->applyStatus(status);
            emit webuiStateChanged(status);
        }

        // Everything (including the two handled above) is forwarded once, so
        // QML consumers do not need a second subscription path.
        emit eventReceived(name, topic, payload);
    }

    void rejectProtocol_(const QString &code, const QString &message)
    {
        if (transport_->isActive()) {
            sendFrame_(QJsonObject{{QStringLiteral("kind"), QStringLiteral("nack")},
                                   {QStringLiteral("code"), code},
                                   {QStringLiteral("message"), message}});
        }
        failConnection_(QStringLiteral("protocol: ") + message);
    }

    void failConnection_(const QString &reason)
    {
        lastError_ = reason;
        const bool wasConnected = connected_ || hadConnected_;
        connecting_ = false;
        connected_ = false;
        if (handshakeTimer_ != nullptr)
            handshakeTimer_->stop();
        if (transport_->isActive())
            transport_->stop();
        rejectAllPending_(QStringLiteral("unavailable: ") + reason);
        emit transportStateChanged();
        if (wasConnected)
            scheduleQuitAfterDisconnect_();
    }

    void rejectAllPending_(const QString &reason)
    {
        const QList<QString> ids = pending_.keys();
        for (const QString &id : ids) {
            auto it = pending_.find(id);
            if (it == pending_.end())
                continue;
            const Pending pending = *it;
            complete_(id, false, QVariant(), reason, pending.method, pending.params);
        }
    }

    /** EOF after a live session means the host died: do not linger as a ghost window. */
    void scheduleQuitAfterDisconnect_()
    {
        if (quitScheduled_)
            return;
        quitScheduled_ = true;
        QTimer::singleShot(500, qApp, &QCoreApplication::quit);
    }

    void handleTransportFailure_(const QString &reason)
    {
        failConnection_(reason);
    }

    void expirePending_()
    {
        if (pending_.isEmpty())
            return;
        const qint64 now = elapsed_.elapsed();
        const QList<QString> ids = pending_.keys();
        for (const QString &id : ids) {
            auto it = pending_.find(id);
            if (it == pending_.end() || !it->sent)
                continue; // unsent requests are bounded by the handshake timer
            if (now - it->startedMs < kRequestTimeoutMs)
                continue;
            const Pending pending = *it;
            pending_.remove(id);
            ++timedOut_;
            complete_(id, false, QVariant(), QStringLiteral("timeout: no reply within 5 s"),
                      pending.method, pending.params);
        }
        emit pendingRequestsChanged();
    }

    /** Remember which surface asked for the one-shot URL, keyed by request id. */
    void beginWebuiToken_(const QString &intent)
    {
        const QString id = request(QStringLiteral("webui.token"));
        if (!id.isEmpty())
            webuiIntents_.insert(id, intent);
    }

    /** `token=...` becomes `token=***`; the rest of the URL is display-safe. */
    static QString maskToken_(const QString &authenticatedUrl)
    {
        if (authenticatedUrl.isEmpty())
            return QString();
        const int tokenAt = authenticatedUrl.indexOf(QStringLiteral("token="));
        if (tokenAt < 0)
            return authenticatedUrl;
        const int valueStart = tokenAt + 6;
        int valueEnd = authenticatedUrl.indexOf(QLatin1Char('&'), valueStart);
        if (valueEnd < 0)
            valueEnd = authenticatedUrl.indexOf(QLatin1Char('#'), valueStart);
        if (valueEnd < 0)
            valueEnd = authenticatedUrl.size();
        return authenticatedUrl.left(valueStart) + QStringLiteral("***") + authenticatedUrl.mid(valueEnd);
    }

    /**
     * Consume a `webui.token` reply.
     *
     * This is the only place the authenticated URL exists: it is handed to the
     * embedded view (`loadAuthenticated`) or to the desktop browser, then
     * dropped. QML only ever receives `maskedUrl` plus an outcome/error code,
     * which is why the generic `requestReplied` signal is deliberately not
     * emitted for this method (it would carry the URL into QML's signal
     * namespace).
     *
     * Outcomes: `embedded`, `external`, `cancelled` (closed before the reply),
     * `failed` (host error, missing URL, or the browser refused the hand-off).
     */
    void resolveWebuiToken_(const QString &id, bool ok, const QVariant &result, const QString &error)
    {
        const QString intent = webuiIntents_.take(id);
        const QVariantMap map = result.toMap();
        QString url = map.value(QStringLiteral("authenticatedUrl")).toString();
        if (url.isEmpty())
            url = map.value(QStringLiteral("url")).toString();
        if (url.isEmpty())
            url = result.toString();
        QString masked = map.value(QStringLiteral("maskedUrl")).toString();
        if (masked.isEmpty())
            masked = maskToken_(url);

        QString outcome;
        QString failure = error;
        if (intent.isEmpty()) {
            outcome = QStringLiteral("cancelled");
            if (failure.isEmpty())
                failure = QStringLiteral("cancelled: the WebUI was closed before the token arrived");
        } else if (!ok || url.isEmpty()) {
            outcome = QStringLiteral("failed");
            if (failure.isEmpty())
                failure = QStringLiteral("invalid-url: the host returned no authenticated URL");
        } else if (intent == QLatin1String("embed") && webview_ != nullptr && webview_->available() &&
                   webview_->loadAuthenticated(url, masked)) {
            outcome = QStringLiteral("embedded");
        } else if (desktopHandOffEnabled()) {
            // Production path, and the isolated-profile browser e2e. The token
            // URL is handed to the desktop exactly once; nothing records it.
            if (QDesktopServices::openUrl(QUrl(url)))
                outcome = QStringLiteral("external");
            else {
                outcome = QStringLiteral("failed");
                failure = QStringLiteral("open-failed: the desktop refused the WebUI URL");
            }
        } else if (!qEnvironmentVariableIsEmpty("DSH_QT_HOST_SELFTEST")) {
            // Headless self-tests without a desktop assert the hand-off outcome
            // only; the isolated browser e2e above performs the real dispatch.
            outcome = QStringLiteral("external");
        } else {
            outcome = QStringLiteral("failed");
            failure = QStringLiteral("open-failed: the desktop refused the WebUI URL");
        }
        // Spend the secret: clear it before any signal can observe it.
        url.fill(QLatin1Char('\0'));
        url.clear();
        emit webuiTokenResolved(id, intent, outcome, masked, failure);
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

        if (method == QLatin1String("webui.token")) {
            // The token reply has its own consumer; it must never reach the
            // generic signal (which would hand the URL to QML).
            resolveWebuiToken_(id, ok, result, error);
            return;
        }

        const QVariantMap map = result.toMap();
        if (method == QLatin1String("markdown.render")) {
            emit markdownRendered(id, ok ? result.toString() : QString(), error);
        } else if (method == QLatin1String("code.highlight")) {
            emit codeHighlighted(id, ok ? result.toString() : QString(), error);
        } else if (method == QLatin1String("theme.apply")) {
            QString applied = map.value(QStringLiteral("applied")).toString();
            if (applied.isEmpty())
                applied = map.value(QStringLiteral("mode")).toString();
            if (applied.isEmpty())
                applied = params.value(QStringLiteral("mode")).toString();
            emit themeApplied(id, applied, ok, error);
        } else if (method == QLatin1String("theme.scale")) {
            qreal scale = map.value(QStringLiteral("scale")).toDouble();
            if (map.isEmpty())
                scale = params.value(QStringLiteral("scale")).toDouble();
            emit fontScaleApplied(id, scale, error);
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
    QTimer *handshakeTimer_ = nullptr;
    QHash<QString, Pending> pending_;
    QElapsedTimer elapsed_{};
    QString epoch_;
    qint64 sequence_ = 0;
    qint64 eventSeq_ = 0;
    bool connecting_ = false;
    bool connected_ = false;
    // Test-only method set (host.echo); see handleHostRequest_.
    bool testHooks_ = qEnvironmentVariableIsSet("DSH_QT_TEST_HOOKS");
    bool hadConnected_ = false;
    bool quitScheduled_ = false;
    int handled_ = 0;
    int failed_ = 0;
    int timedOut_ = 0;
    int cancelled_ = 0;
    QString lastError_;

    /** Optional embedded WebUI view; owned by main(), may stay null. */
    WebviewHost *webview_ = nullptr;

    /** Request id -> "embed" | "browser"; consumed by `resolveWebuiToken_`. */
    QHash<QString, QString> webuiIntents_;
};

/**
 * GUI-thread heartbeat, for the pipe-blocking regression
 * (tests/gui-heartbeat.e2e.ts).
 *
 * One line per tick, written straight to the file and flushed, so a reader that
 * polls the file sees the event loop turning in real time. If something parks
 * the GUI thread — the pre-fix Windows read loop did exactly that — the file
 * stops growing while the process stays alive, which is the failure mode users
 * see as "the window never appears".
 *
 *   hb <sequence> <elapsed-ms> <top-level-windows> <exposed> <visible>
 *
 * Off unless DSH_QT_HEARTBEAT_FILE is set, so production runs pay nothing.
 */
static void startGuiHeartbeat(QCoreApplication &app)
{
    const QString path = qEnvironmentVariable("DSH_QT_HEARTBEAT_FILE");
    if (path.isEmpty())
        return;
    // Item I: a silent failure here would look exactly like "the GUI thread is
    // frozen", which is the one thing this channel exists to distinguish. Say why.
    auto *file = new QFile(path, &app);
    if (!file->open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        std::fprintf(stderr,
                     "dsh-qt-app: heartbeat file '%s' could not be opened: %s\n",
                     qPrintable(path),
                     qPrintable(file->errorString()));
        std::fflush(stderr);
        delete file;
        return;
    }
    // The path has to be unique per instance: two processes appending to one file
    // would interleave their `hb` lines and make the sequence meaningless.
    struct Beat
    {
        QElapsedTimer elapsed;
        int sequence = 0;
    };
    auto beat = QSharedPointer<Beat>::create();
    beat->elapsed.start();
    auto *timer = new QTimer(&app);
    timer->setInterval(50);
    QObject::connect(timer, &QTimer::timeout, &app, [file, beat]() {
        int windows = 0;
        int exposed = 0;
        int visible = 0;
        const QWindowList topLevel = QGuiApplication::topLevelWindows();
        for (QWindow *window : topLevel) {
            if (window == nullptr)
                continue;
            ++windows;
            if (window->isExposed())
                ++exposed;
            if (window->isVisible())
                ++visible;
        }
        file->write(QStringLiteral("hb %1 %2 %3 %4 %5\n")
                        .arg(++beat->sequence)
                        .arg(beat->elapsed.elapsed())
                        .arg(windows)
                        .arg(exposed)
                        .arg(visible)
                        .toUtf8());
        file->flush();
    });
    timer->start();
}

/**
 * Replays the outbound accounting without a pipe.
 *
 * Item B of the review: the drop policy used to be spread over two lists, so
 * the cap could not see the frames the Windows writer was holding. That made
 * the interesting case — a stalled reader plus a live producer — impossible to
 * test on demand. The queue is now one object, so it can be driven directly.
 */
static int runOutboundQueueSelftest()
{
    int failures = 0;
    const auto check = [&failures](bool ok, const char *what) {
        std::printf("%s %s\n", ok ? "ok" : "not ok", what);
        if (!ok)
            ++failures;
    };
    {
        OutboundQueue queue;
        queue.append(QByteArray(10, 'a'));
        queue.append(QByteArray(20, 'b'));
        check(queue.bytes() == 30 && queue.frames() == 2,
              "counts bytes and frames across the whole queue");
        check(queue.dropOldestToFit(5, 30) == 1,
              "drops the oldest frame when the incoming one would exceed the cap");
        check(queue.bytes() == 20 && queue.frames() == 1, "recounts after a drop");
        QByteArray frame;
        check(queue.take(frame) && frame.size() == 20, "take pops the surviving frame");
        check(queue.bytes() == 0 && queue.isEmpty(), "take leaves nothing owed");
        queue.requeueFront(frame);
        check(queue.bytes() == 20 && queue.frames() == 1,
              "requeueFront puts an unwritten tail back at the head");
        queue.clear();
        check(queue.bytes() == 0 && queue.isEmpty(), "clear zeroes the counter");
    }
    {
        OutboundQueue queue;
        queue.append(QByteArray(10, 'a'));
        queue.append(QByteArray(20, 'b'));
        queue.append(QByteArray(30, 'c'));
        check(queue.dropOldestToFit(45, 60) == 3,
              "drops as many frames as the incoming one needs");
    }
    {
        OutboundQueue queue;
        for (int i = 0; i < 5; ++i)
            queue.append(QByteArray(100, 'x'));
        check(queue.dropOldestToFit(100, 500) == 1,
              "frees exactly enough room for the incoming frame");
        check(queue.frames() == 4, "removes whole frames only");
    }
    {
        // The writer holds one frame while another arrives past the cap. With a
        // single queue this still drops; the old two-list version could not.
        OutboundQueue queue;
        QByteArray inFlight;
        queue.append(QByteArray(400, 'a'));
        check(queue.take(inFlight) && inFlight.size() == 400,
              "take models the writer holding a frame");
        queue.append(QByteArray(400, 'b'));
        check(queue.bytes() == 400 && queue.frames() == 1,
              "the in-flight frame is not counted twice");
        queue.requeueFront(inFlight);
        check(queue.dropOldestToFit(400, 800) == 1 && queue.bytes() == 400,
              "a partially written frame can still be dropped to make room");
    }
    std::printf("outbound-queue selftest: %s\n", failures == 0 ? "pass" : "FAIL");
    std::fflush(stdout);
    return failures == 0 ? 0 : 1;
}

int main(int argc, char *argv[])
{
    // Test hook for the outbound accounting; nothing else sets this.
    if (qEnvironmentVariableIsSet("DSH_QT_OUTBOUND_QUEUE_SELFTEST"))
        return runOutboundQueueSelftest();
#if defined(DSH_QT_HAS_WEBENGINE) && DSH_QT_HAS_WEBENGINE
    // Must run before QGuiApplication is constructed (Qt WebEngine contract).
    QtWebEngineQuick::initialize();
#endif
    QGuiApplication app(argc, argv);
    QGuiApplication::setApplicationName(QStringLiteral(DSH_QT_APP_NAME));
    QGuiApplication::setApplicationVersion(QStringLiteral(DSH_QT_APP_VERSION));
    QGuiApplication::setOrganizationName(QStringLiteral(DSH_QT_APP_ORGANIZATION));

    QQuickStyle::setStyle(QStringLiteral("Basic"));

    // Before anything can block: the regression reads this file to tell a live
    // GUI thread from a parked one.
    startGuiHeartbeat(app);

    // Declared before the engine: the engine must not outlive the objects it
    // exposes through context properties.
    ThemeBridge themeBridge;
    DshQtBridge bridge(&themeBridge);

    // Created before the self-test branches on purpose: the WebEngine
    // acceptance test (`webui-chromium`) drives this same object through the
    // real `webui.open` → `webui.token` → `loadAuthenticated` chain, so it has
    // to exist in the self-test path too. In a build without WebEngine it is
    // cheap and reports itself unavailable.
    WebviewHost webview;
    bridge.setWebviewHost(&webview);

    // Headless protocol self-test (tests/host-e2e.e2e.ts).
    //
    // The real transport, the real handshake and the real binary are exercised;
    // only the QML engine is skipped, so a failure here is a protocol failure,
    // not a rendering one. stdout carries frames, so diagnostics go to stderr.
    const bool selfTest = qEnvironmentVariableIsSet("DSH_QT_HOST_SELFTEST");
    const QString selfTestMode = qEnvironmentVariable("DSH_QT_HOST_SELFTEST");
    if (selfTest && selfTestMode.startsWith(QLatin1String("webui"))) {
        // WebUI token self-test: the host script answers `webui.token` with a
        // sentinel URL, and this harness proves that the URL reaches a native
        // consumer while the generic QML signal never sees it.
        const QString sentinel = qEnvironmentVariable("DSH_QT_WEBUI_SENTINEL");
        const bool chromium = selfTestMode == QLatin1String("webui-chromium");
        bool started = false;
        // Headless container for the WebEngine acceptance test. The product
        // path injects WebFallbackPanel.qml's `embedSlot`; the self-test has no
        // QML window, so it supplies an equivalent off-screen Item here. This
        // is the only test-specific object: the engine, the token and the
        // close path are the production ones.
        // Heap-allocated on purpose: the self-test block ends before
        // `app.exec()`, so a stack engine/window would be destroyed exactly
        // when the embedded page starts loading. Ownership goes to `app`.
        QQmlEngine *selftestEngine = nullptr;
        QQuickWindow *selftestWindow = nullptr;
        if (chromium) {
            selftestEngine = new QQmlEngine(&app);
            selftestWindow = new QQuickWindow;
            QQmlComponent containerComponent(selftestEngine);
            containerComponent.setData(
                QByteArrayLiteral("import QtQuick\nItem { anchors.fill: parent }"),
                QUrl(QStringLiteral("qrc:/dsh/selftest_container.qml")));
            QQuickItem *container = qobject_cast<QQuickItem *>(containerComponent.create());
            if (container == nullptr) {
                std::fprintf(stderr, "[selftest] webview.container=0 %s\n",
                             qUtf8Printable(containerComponent.errorString()));
                QCoreApplication::exit(7);
            } else {
                container->setParentItem(selftestWindow->contentItem());
                webview.setContainer(container);
                selftestWindow->resize(1024, 768);
                selftestWindow->show();
                std::fprintf(stderr, "[selftest] webview.container=1\n");
            }
        }
        QObject::connect(&bridge, &DshQtBridge::transportStateChanged, &app,
                         [&bridge, &started, selfTestMode, chromium]() {
            const QString state = bridge.transportState();
            std::fprintf(stderr, "[selftest] state=%s\n", qUtf8Printable(state));
            if (state != QLatin1String("connected") || started)
                return;
            started = true;
            // Whether this build can embed decides the expected outcome below;
            // a build without WebEngine must never be reported as embedded.
            std::fprintf(stderr, "[selftest] webview.available=%d\n", bridge.canEmbedWebui() ? 1 : 0);
            if (selfTestMode == QLatin1String("webui-live") || chromium) {
                // Real fallback chain: ask the mounted service to open, wait for
                // its Ready event, then hand the token to the native consumer.
                bridge.request(QStringLiteral("webui.open"));
                return;
            }
            if (selfTestMode == QLatin1String("webui-browser"))
                bridge.openWebuiExternally();
            else
                bridge.openWebuiEmbedded();
            if (selfTestMode == QLatin1String("webui-close"))
                bridge.closeWebui();
        });
        bool liveOpened = false;
        QObject::connect(&bridge, &DshQtBridge::eventReceived, &app,
                         [&bridge, &liveOpened, chromium, selfTestMode](const QString &name, const QVariant &,
                                                              const QVariant &payload) {
            if (selfTestMode != QLatin1String("webui-live") && !chromium)
                return;
            if (liveOpened || name != QLatin1String("webui.state"))
                return;
            const QVariantMap status = payload.toMap();
            if (status.value(QStringLiteral("state")).toString() != QLatin1String("Ready"))
                return;
            liveOpened = true;
            std::fprintf(stderr, "[selftest] webui.state=Ready mode=%s\n",
                         qUtf8Printable(status.value(QStringLiteral("mode")).toString()));
            bridge.openWebuiEmbedded();
        });
        QObject::connect(&bridge, &DshQtBridge::requestReplied, &app,
                         [sentinel](const QString &, const QString &method, bool, const QVariant &result,
                                    const QString &error) {
            const QByteArray json =
                QJsonDocument(QJsonArray{QJsonValue::fromVariant(result)}).toJson(QJsonDocument::Compact);
            if (!sentinel.isEmpty() && (json.contains(sentinel.toUtf8()) || error.contains(sentinel))) {
                std::fprintf(stderr, "[selftest] LEAK method=%s\n", qUtf8Printable(method));
                QCoreApplication::exit(4);
            }
        });
        QObject::connect(&bridge, &DshQtBridge::webuiTokenResolved, &app,
                         [&bridge, chromium, selfTestMode](const QString &, const QString &intent,
                            const QString &outcome, const QString &masked, const QString &error) {
            std::fprintf(stderr, "[selftest] webui.token intent=%s outcome=%s masked=%s error=%s\n",
                         qUtf8Printable(intent), qUtf8Printable(outcome), qUtf8Printable(masked),
                         qUtf8Printable(error));
            if (chromium) {
                // The embedded view is the consumer here: a load result (or the
                // hard timeout) decides the exit code, not this reply.
                if (outcome != QLatin1String("embedded")) {
                    std::fprintf(stderr, "[selftest] webview.load state=not-started\n");
                    QCoreApplication::exit(5);
                }
                return;
            }
            // The duplicate-reply case waits here so a second `res` for the
            // same id can arrive (and must be dropped) before the process exits.
            if (selfTestMode == QLatin1String("webui-live"))
                bridge.closeWebui();
            const int linger = qEnvironmentVariableIntValue("DSH_QT_WEBUI_LINGER_MS");
            QTimer::singleShot(linger, qApp, &QCoreApplication::quit);
        });
        if (chromium || selfTestMode == QLatin1String("webui-browser")) {
            QObject::connect(&webview, &WebviewHost::loadFailed, &app,
                             [](const QString &reason) {
                std::fprintf(stderr, "[selftest] webview.failed reason=%s\n",
                             qUtf8Printable(reason));
            });
        }
        if (chromium) {
            // The WebEngine acceptance test (T28-2): report every engine load
            // transition, close only after Chromium committed the marker page,
            // then require the close itself to commit `about:blank` before the
            // process exits 0.
            bool loadSettled = false;
            bool loadFailed = false;
            QObject::connect(&webview, &WebviewHost::loadStateChanged, &app,
                             [&bridge, &webview, &loadSettled, &loadFailed]() {
                const QString state = webview.loadState();
                std::fprintf(stderr, "[selftest] webview.load state=%s title=%s url=%s\n",
                             qUtf8Printable(state), qUtf8Printable(webview.pageTitle()),
                             qUtf8Printable(webview.currentUrlMasked()));
                if ((state == QLatin1String("loaded") || state == QLatin1String("failed"))
                    && !loadSettled) {
                    loadSettled = true;
                    loadFailed = state == QLatin1String("failed");
                    bridge.closeWebui();
                } else if (state == QLatin1String("closed")) {
                    std::fprintf(stderr, "[selftest] webview.close visible=%d url=%s\n",
                                 webview.visible() ? 1 : 0,
                                 qUtf8Printable(webview.currentUrlMasked()));
                    QCoreApplication::exit(loadFailed ? 6 : 0);
                }
            });
            QTimer::singleShot(60000, qApp, []() { QCoreApplication::exit(3); });
        } else {
            QTimer::singleShot(10000, qApp, []() { QCoreApplication::exit(3); });
        }
    } else if (selfTestMode == QLatin1String("session-live")) {
        // Mounted inside a real DSH profile: print every event the host pushes
        // so the e2e test can prove the session/tool projection arrives intact.
        // The host spawns this process with piped stderr, so the e2e test reads
        // the trace file named by DSH_QT_SESSION_TRACE instead.
        const QString tracePath = qEnvironmentVariable("DSH_QT_SESSION_TRACE");
        auto trace = [tracePath](const QString &line) {
            std::fprintf(stderr, "[selftest] %s\n", qUtf8Printable(line));
            if (tracePath.isEmpty())
                return;
            QFile file(tracePath);
            if (file.open(QIODevice::WriteOnly | QIODevice::Append))
                file.write(line.toUtf8() + '\n');
        };
        QObject::connect(&bridge, &DshQtBridge::eventReceived, &app,
                         [trace](const QString &name, const QVariant &, const QVariant &payload) {
            const QByteArray json = QJsonDocument(
                                        QJsonArray{QJsonValue::fromVariant(payload)})
                                        .toJson(QJsonDocument::Compact);
            trace(QStringLiteral("evt name=%1 payload=%2").arg(name, QString::fromUtf8(json)));
        });
        QObject::connect(&bridge, &DshQtBridge::transportStateChanged, &app, [&bridge, trace]() {
            trace(QStringLiteral("state=%1").arg(bridge.transportState()));
        });
        const int linger = qEnvironmentVariableIntValue("DSH_QT_SESSION_LINGER_MS");
        QTimer::singleShot(linger > 0 ? linger : 5000, qApp, &QCoreApplication::quit);
    } else if (selfTest) {
        // Each request proves one real route of the shipped bridge: the
        // handshake (`ping`), the renderer (`markdown.parse`) and the theme
        // service (`theme.scale`). The sequence is fixed so the e2e test can
        // assert exact stderr lines instead of scraping timings.
        const QStringList methods = {QStringLiteral("ping"), QStringLiteral("markdown.parse"),
                                     QStringLiteral("theme.scale")};
        const auto paramsFor = [](const QString &method) {
            if (method == QLatin1String("markdown.parse"))
                return QVariantMap{{QStringLiteral("text"), QStringLiteral("# hi")}};
            if (method == QLatin1String("theme.scale"))
                return QVariantMap{{QStringLiteral("scale"), 1.25}};
            return QVariantMap{};
        };
        auto next = std::make_shared<int>(0);
        bool started = false;
        QObject::connect(&bridge, &DshQtBridge::transportStateChanged, &app, [&bridge, &started, methods, next, paramsFor]() {
            const QString state = bridge.transportState();
            std::fprintf(stderr, "[selftest] state=%s\n", qUtf8Printable(state));
            if (state == QLatin1String("connected") && !started) {
                started = true;
                bridge.request(methods.at(*next), paramsFor(methods.at(*next)));
            }
        });
        QObject::connect(
            &bridge, &DshQtBridge::requestReplied, &app,
            [&bridge, methods, next, paramsFor](const QString &, const QString &method, bool ok, const QVariant &result,
                                     const QString &error) {
                std::fprintf(stderr, "[selftest] %s=%s error=%s\n", qUtf8Printable(method),
                             ok ? "ok" : "failed", qUtf8Printable(error));
                if (method == QLatin1String("ping")) {
                    const QVariantMap map = result.toMap();
                    std::fprintf(stderr, "[selftest] pong=%d\n",
                                 map.value(QStringLiteral("pong")).toBool() ? 1 : 0);
                }
                ++*next;
                if (*next >= methods.size()) {
                    QTimer::singleShot(0, qApp, &QCoreApplication::quit);
                    return;
                }
                bridge.request(methods.at(*next), paramsFor(methods.at(*next)));
            });
        // Hard stop: a handshake that never completes must not hang the suite.
        QTimer::singleShot(10000, qApp, []() { QCoreApplication::exit(3); });
    }

    bridge.connectToNode();

    if (selfTest)
        return app.exec();

    QQmlApplicationEngine engine;

    // One namespace, two roles: the constant build metadata that AboutSettings
    // already reads (`dshQt.appName`), and the request API the chat views use.
    engine.rootContext()->setContextProperty(QStringLiteral("dshQt"), &bridge);
    engine.rootContext()->setContextProperty(QStringLiteral("ctx"), &bridge);
    engine.rootContext()->setContextProperty(QStringLiteral("webviewHost"), &webview);

    QObject::connect(
        &engine, &QQmlApplicationEngine::objectCreationFailed, &app,
        []() { QCoreApplication::exit(EXIT_FAILURE); }, Qt::QueuedConnection);

    // The shipped entry is the compiled default; tests and integrators may point
    // the same binary at a harness to exercise a single view in isolation.
    const QString qmlEntry =
        qEnvironmentVariable("DSH_QT_QML_ENTRY", QStringLiteral(DSH_QT_QML_ENTRY));
    engine.load(QUrl(qmlEntry));
    if (engine.rootObjects().isEmpty())
        return EXIT_FAILURE;

    return app.exec();
}

// AUTOMOC generates main.moc for the Q_OBJECT classes defined in this file
// (CMAKE_AUTOMOC is on in CMakeLists.txt), so no extra header is needed.
#include "main.moc"
