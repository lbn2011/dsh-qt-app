/**
 * Build-time constants shared by the TypeScript side of the Qt profile.
 *
 * The C++/QML side mirrors these values in `qml/config.h`; keep both files in
 * sync when a value changes (see `docs/architecture.md`).
 */

/** Cordis plugin name, reused for logger names and fiber diagnostics. */
export const PLUGIN_NAME = 'dsh-qt-app'

/** Plugin version; mirrored by `DSH_QT_APP_VERSION` in `qml/config.h`. */
export const PLUGIN_VERSION = '0.1.0'

/**
 * libuv timer tick that pumps the QML -> Node message queue.
 *
 * 10 ms is the budget fixed by the implementation plan (design decision
 * "10ms libuv timer"): frequent enough for interactive UI, cheap enough to
 * never block the Qt main thread.
 */
export const EVENT_LOOP_TICK_MS = 10

/** npm package name of the N-API bridge (maintained in a separate repository). */
export const NAPI_PACKAGE_NAME = 'dsh-qt-napi'

/** Compiled addon file name inside the N-API bridge package. */
export const NAPI_BINARY_NAME = 'qt-bridge'

/**
 * Upper bound of the QML -> Node message queue. Mirrors
 * `DSH_QT_MESSAGE_QUEUE_MAX` in `qml/config.h`; older messages are dropped once
 * the queue is full so a stalled consumer can never grow memory without bound.
 */
export const MESSAGE_QUEUE_MAX = 4096

/** Environment variable that overrides N-API binding discovery. */
export const NAPI_PATH_ENV = 'DSH_QT_NAPI_PATH'

/** QML entry point; registered as a Qt resource by `CMakeLists.txt`. */
export const QML_ENTRY_URL = 'qrc:/qml/main.qml'

/** Window geometry of the skeleton main window (`qml/main.qml`). */
export const DEFAULT_WINDOW_WIDTH = 1280
export const DEFAULT_WINDOW_HEIGHT = 800

/**
 * Slot surfaces owned by the settings panel (`qml/views/settings/`).
 *
 * `conversation.settings.section` contributions become extra tabs next to the
 * built-in Theme / Plugins / About ones; `conversation.settings.form`
 * contributions are rendered as forms *inside* the tab named by their
 * `section` field. Keeping them separate lets a plugin ship a whole tab without
 * having to learn the panel's layout.
 */
export const SETTINGS_SLOT_SURFACES = [
  'conversation.settings.section',
  'conversation.settings.form',
] as const

/** A surface the settings panel hosts. */
export type SettingsSlotSurface = (typeof SETTINGS_SLOT_SURFACES)[number]

/**
 * Slot surfaces that the native Qt UI renders itself instead of falling back to
 * an embedded WebView (implementation plan §1.2 "插件集成点").
 */
export const NATIVE_SLOT_SURFACES = [
  'conversation.chat.flow',
  'conversation.input.composer',
  'conversation.session.header',
  'sidebar.left.panel',
  'settings.general',
  'session.panel.section',
  ...SETTINGS_SLOT_SURFACES,
] as const

export type NativeSlotSurface = (typeof NATIVE_SLOT_SURFACES)[number]

/** True when `surface` is rendered natively by QML rather than by a WebView. */
export function isNativeSlotSurface(surface: string): surface is NativeSlotSurface {
  return (NATIVE_SLOT_SURFACES as readonly string[]).includes(surface)
}
