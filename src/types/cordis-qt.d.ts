/**
 * Cordis module augmentation for the Qt profile.
 *
 * The Qt plugin registers a single service named `qtRenderer`. Augmenting the
 * `Context` interface lets every consumer (this package, the N-API bridge, and
 * any plugin that wants native UI) use `ctx.qtRenderer` with full typing instead
 * of a cast.
 *
 * This file lives under `src/` rather than a top-level `types/` directory so it
 * stays inside the package's TypeScript root and is picked up by both
 * `tsconfig.json` and `tsconfig.test.json` automatically.
 */
import type { QtRendererService } from '../index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Native Qt renderer service, provided by the `dsh-qt-app` plugin.
     *
     * Available only in the Qt profile; a plain Node/Web profile has no such
     * service, so plugins that use it should declare `inject: ['qtRenderer']`.
     */
    qtRenderer: QtRendererService
  }
}
