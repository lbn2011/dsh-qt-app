/*
 * config.h — build-time macros for the dsh-qt-app Qt host.
 *
 * Single source of truth for the values that C++ needs at compile time and that
 * QML needs at run time. native/main.cpp republishes them as the `dshQt` context
 * property; the Phase 1c QML tree does not read that property (it takes its
 * title from Qt.application.name and declares its geometry in qml/main.qml), so
 * keep the numbers below in sync with qml/main.qml by hand. The TypeScript
 * mirror lives in src/constants.ts — change all three together.
 */
#ifndef DSH_QT_APP_CONFIG_H
#define DSH_QT_APP_CONFIG_H

/* Application identity (also used by package.json). */
#define DSH_QT_APP_NAME "dsh-qt-app"
#define DSH_QT_APP_VERSION "0.1.0"
#define DSH_QT_APP_ORGANIZATION "DSH"

/* Minimum Qt runtime this host is built against (see CMakeLists.txt). */
#define DSH_QT_MIN_QT_VERSION "6.5"

/* QML entry point inside the resource bundle registered by qt_add_resources(). */
#define DSH_QT_QML_ENTRY "qrc:/qml/main.qml"

/* Main window geometry, mirrored by qml/main.qml. */
#define DSH_QT_DEFAULT_WINDOW_WIDTH 1280
#define DSH_QT_DEFAULT_WINDOW_HEIGHT 800

/* N-API bridge: package name and compiled addon file name (dsh-qt-napi repo). */
#define DSH_QT_NAPI_PACKAGE_NAME "dsh-qt-napi"
#define DSH_QT_NAPI_BINARY_NAME "qt-bridge"

/* libuv timer tick that pumps the QML <-> Node message queue (milliseconds). */
#define DSH_QT_EVENT_LOOP_TICK_MS 10

/* Message-queue safety valve: drop-oldest threshold for pending UI events. */
#define DSH_QT_MESSAGE_QUEUE_MAX 4096

#endif /* DSH_QT_APP_CONFIG_H */
