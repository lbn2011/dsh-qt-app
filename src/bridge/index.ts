// src/bridge/index.ts — the QML ⇄ Node bridge.
//
// Two layers, exported together because callers almost always want both:
//
//   * {@link QmlBridge} — transport-agnostic request/response bookkeeping over
//     the 10 ms event loop: ids, replies, bounded concurrency, timeouts, and a
//     promise-returning `request()` for Node-side callers.
//   * the adapters in `services.ts` — the only place that knows the real Cordis
//     services, turning `ctx.qtRenderer` / `ctx.theme` / the settings store into
//     the narrow interfaces the bridge talks to.

export {
  QmlBridge,
  QmlBridgeCallError,
  QML_BRIDGE_METHODS,
  QML_NOTIFY_TYPE,
  QML_REQUEST_TYPE,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_PENDING,
  createQmlBridge,
  type QmlBridgeComposer,
  type QmlBridgeError,
  type QmlBridgeErrorCode,
  type QmlBridgeEventSource,
  type QmlBridgeLogger,
  type QmlBridgeMethod,
  type QmlBridgeOptions,
  type QmlBridgeOutbound,
  type QmlBridgeParser,
  type QmlBridgeRenderer,
  type QmlBridgeReply,
  type QmlBridgeRequest,
  type QmlBridgeSettings,
  type QmlBridgeSink,
  type QmlBridgeStats,
  type QmlBridgeTheme,
} from './qml-bridge.js'

export {
  composerFromHandler,
  fallbackParserAdapter,
  createContextBridge,
  createServiceBridge,
  rendererFromService,
  settingsFromStore,
  themeFromService,
  type BridgeContextLike,
  type BridgeServices,
  type RendererLike,
  type SettingsLike,
  type ThemeServiceLike,
} from './services.js'
