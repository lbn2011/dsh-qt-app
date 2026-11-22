// native/main.cpp — minimal Qt host for the DSH Qt6/QML profile.
//
// Responsibilities of this skeleton:
//   1. create the QGuiApplication (Qt Quick Controls 2 style)
//   2. publish the build-time macros from qml/config.h as the `dshQt` context
//      property so QML never hardcodes versions/paths
//   3. load the embedded qrc:/qml/main.qml entry point
//
// The N-API bridge (dsh-qt-napi) and the libuv message pump are attached here
// in later phases; nothing in this file starts a second event loop.
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickStyle>
#include <QStringLiteral>
#include <QUrl>
#include <QVariantMap>

#include "config.h"

int main(int argc, char *argv[])
{
    QGuiApplication app(argc, argv);
    QGuiApplication::setApplicationName(QStringLiteral(DSH_QT_APP_NAME));
    QGuiApplication::setApplicationVersion(QStringLiteral(DSH_QT_APP_VERSION));
    QGuiApplication::setOrganizationName(QStringLiteral(DSH_QT_APP_ORGANIZATION));

    QQuickStyle::setStyle(QStringLiteral("Basic"));

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

    QObject::connect(
        &engine, &QQmlApplicationEngine::objectCreationFailed, &app,
        []() { QCoreApplication::exit(EXIT_FAILURE); }, Qt::QueuedConnection);

    engine.load(QUrl(QStringLiteral(DSH_QT_QML_ENTRY)));
    if (engine.rootObjects().isEmpty())
        return EXIT_FAILURE;

    return app.exec();
}
