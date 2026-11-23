/**
 * On-demand WebUI fallback (`I5`).
 *
 * The plugin entrypoint does not import this module yet: wiring it into
 * `src/index.ts` / `main.cpp` is the integration task's job (single-writer),
 * so the three lines it needs are spelled out in `docs/handoff/I5-webui.md`.
 */
export { WebuiService, attachWebuiToHost, WEBUI_METHODS, SHARED_SESSION_NOTICE } from './service.js'
export type { WebuiServiceConfig, WebuiLogger } from './service.js'
export { createInProcessBackend, createHostRootLoader, defaultHostRoot, DSH_HOST_ROOT_ENV } from './in-process.js'
export type { InProcessBackendOptions, OfficialModuleLoader } from './in-process.js'
export { createChildBackend, parseAnnouncement, DSH_WEB_BIN_ENV, DSH_WEB_ANNOUNCE_PREFIX } from './process.js'
export type { ChildBackendOptions } from './process.js'
export { maskAuthenticatedUrl, maskTokenInText, containsRawToken } from './token.js'
export { WebuiError, failureReasonOf } from './types.js'
export type {
  WebuiBackend,
  WebuiBackendHandle,
  WebuiBackendStartOptions,
  WebuiFailureReason,
  WebuiMode,
  WebuiOpenResult,
  WebuiProbeResult,
  WebuiReady,
  WebuiState,
  WebuiStatus,
} from './types.js'
