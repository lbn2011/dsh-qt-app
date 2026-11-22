/**
 * Public surface of the theme track (Phase 2f).
 *
 * Import from `./theme/index.js` (or, once t16 wires the plugin entry, from the
 * package root). The internal split is deliberate:
 *
 *  - `types.ts`     — the schema and the QML token parity map.
 *  - `builtins.ts`  — the `dark` (Phase 1, unchanged) and `light` themes.
 *  - `validate.ts`  — untrusted data in, issues or a clean theme out.
 *  - `persist.ts`   — atomic, injectable persistence of id + font scale.
 *  - `manager.ts`   — active theme, scaling, listeners.
 *  - `service.ts`   — `ctx.theme` for Cordis and the QML snapshot.
 */
export * from './types.js'
export * from './builtins.js'
export * from './validate.js'
export * from './persist.js'
export * from './manager.js'
export * from './service.js'
