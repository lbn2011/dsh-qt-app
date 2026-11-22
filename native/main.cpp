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
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QFileSystemWatcher>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QObject>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickStyle>
#include <QSaveFile>
#include <QStandardPaths>
#include <QString>
#include <QStringList>
#include <QTimer>
#include <QUrl>
#include <QVariantMap>
#include <QtGlobal>

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
 * The `ctx` context property.
 *
 * Today it only carries the theme bridge; the QtRenderer bridge and the session
 * services join it in later phases. Keeping one object instead of a pile of
 * loose context properties means QML reads `ctx.theme`, `ctx.qtRenderer`, … and
 * qmllint/IDE tooling has a single place to point at.
 */
class DshQtContext : public QObject
{
    Q_OBJECT
    Q_PROPERTY(ThemeBridge *theme READ theme CONSTANT)

public:
    explicit DshQtContext(ThemeBridge *theme, QObject *parent = nullptr)
        : QObject(parent)
        , theme_(theme)
    {
    }

    ThemeBridge *theme() const { return theme_; }

private:
    ThemeBridge *theme_ = nullptr;
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
    DshQtContext context(&themeBridge);

    QQmlApplicationEngine engine;

    QVariantMap dshQt;
    dshQt.insert(QStringLiteral("appName"), QStringLiteral(DSH_QT_APP_NAME));
    dshQt.insert(QStringLiteral("appVersion"), QStringLiteral(DSH_QT_APP_VERSION));
    dshQt.insert(QStringLiteral("minQtVersion"), QStringLiteral(DSH_QT_MIN_QT_VERSION));
    dshQt.insert(QStringLiteral("eventLoopTickMs"), DSH_QT_EVENT_LOOP_TICK_MS);
    dshQt.insert(QStringLiteral("napiPackageName"), QStringLiteral(DSH_QT_NAPI_PACKAGE_NAME));
    dshQt.insert(QStringLiteral("napiBinaryName"), QStringLiteral(DSH_QT_NAPI_BINARY_NAME));
    dshQt.insert(QStringLiteral("defaultWindowWidth"), DSH_QT_DEFAULT_WINDOW_WIDTH);
    dshQt.insert(QStringLiteral("defaultWindowHeight"), DSH_QT_DEFAULT_WINDOW_HEIGHT);
    engine.rootContext()->setContextProperty(QStringLiteral("dshQt"), dshQt);
    engine.rootContext()->setContextProperty(QStringLiteral("ctx"), &context);

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
