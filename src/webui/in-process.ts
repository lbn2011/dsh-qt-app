/**
 * Candidate A: bind the WebUI inside the host process via `ctx.plugin`.
 *
 * Why this is the preferred candidate (evidence in
 * `docs/PHASE-3-WEB-FALLBACK.md` §3):
 *
 *   * `WebServer` only listens because a plugin mounts it — there is no ambient
 *     listener in `dsh-base`;
 *   * a Cordis service registration is an effect of the owning fiber, and
 *     `Service[Service.init]` returns the disposer that closes the socket, so
 *     unloading the fiber really does release the port;
 *   * mounting `client-connection` here makes the embedded WebEngine an
 *     *owner* client of this process (`browserPeer`), i.e. the same session tree
 *     and the same settings instance as the Qt window — no second history.
 *
 * Nothing in this file is imported by the plugin entrypoint: `main.cpp` and
 * `src/index.ts` are owned by the integration task, so this module is wired
 * through `docs/handoff/I5-webui.md`.
 */
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'

import { maskTokenInText } from './token.js'
import { WebuiError } from './types.js'
import type {
  WebuiBackend,
  WebuiBackendHandle,
  WebuiBackendStartOptions,
  WebuiFailureReason,
  WebuiReady,
} from './types.js'

/** Points at the `node_modules` directory that holds the official packages. */
export const DSH_HOST_ROOT_ENV = 'DSH_HOST_ROOT'
const READY_POLL_MS = 25
/** Matches the service default so a bare `start()` still has a deadline. */
const DEFAULT_READY_TIMEOUT_MS = 8_000

/** Resolves a package specifier to its ES module namespace. */
export type OfficialModuleLoader = (specifier: string) => Promise<unknown>

/**
 * Build a loader rooted at the host installation.
 *
 * The Qt app does not depend on `@deepseek-ai/dsh-*` (they are host packages),
 * so bare specifiers are resolved from the host's own `node_modules` instead of
 * from this package.
 *
 * @param hostRoot - directory used as the resolution root.
 */
export function createHostRootLoader(hostRoot: string): OfficialModuleLoader {
  const requireFromHost = createRequire(join(hostRoot, 'noop.js'))
  return async (specifier: string): Promise<unknown> => {
    const resolved = requireFromHost.resolve(specifier)
    return await import(pathToFileURL(resolved).href)
  }
}

/**
 * @returns the configured host module root, or `null` when the environment does
 *   not point at an installed DSH tree (the backend then reports `unavailable`
 *   instead of guessing).
 */
export function defaultHostRoot(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): string | null {
  for (const root of hostRootCandidates(env, execPath)) {
    if (existsSync(join(root, '@deepseek-ai', 'dsh', 'package.json'))) {
      return join(root, '@deepseek-ai', 'dsh', 'node_modules')
    }
  }
  return null
}

/**
 * Where an installed DSH tree can live, most specific first.
 *
 * The Qt app normally runs *inside* the host process, so step 2 usually wins; a
 * global install (npm/Homebrew/Windows `%APPDATA%\\npm`) is not a dependency of
 * this package, which is why the CLI location on `PATH` and the interpreter
 * prefix are consulted too.
 */
function hostRootCandidates(env: NodeJS.ProcessEnv, execPath: string): string[] {
  const roots: string[] = []
  const configured = env[DSH_HOST_ROOT_ENV]
  if (configured !== undefined && configured !== '') roots.push(configured)
  try {
    roots.push(join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')), 'node_modules'))
  } catch {
    // not a dependency of this package
  }
  // Every `dsh` on PATH, not just the first one: a shim from a package-manager
  // bin directory (pnpm, volta, nvm) often shadows the real install, and the
  // shadow's prefix has no `@deepseek-ai/dsh` under it.
  for (const binDir of findAllOnPath(env['PATH'], process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'])) {
    const prefix = dirname(binDir)
    roots.push(join(prefix, 'lib', 'node_modules'), join(prefix, 'node_modules'), join(binDir, 'node_modules'))
  }
  const prefix = dirname(dirname(execPath))
  roots.push(join(prefix, 'lib', 'node_modules'), join(prefix, 'node_modules'), join(dirname(execPath), 'node_modules'))
  return roots
}

/**
 * @returns every PATH directory that holds one of `names`, in PATH order.
 *
 * All of them, not the first: see the caller for why a shadowing shim must not
 * end the search.
 */
function findAllOnPath(pathValue: string | undefined, names: readonly string[]): string[] {
  if (pathValue === undefined || pathValue === '') return []
  const found: string[] = []
  const entries = pathValue.split(process.platform === 'win32' ? ';' : ':')
  for (const entry of entries) {
    if (entry === '') continue
    for (const name of names) {
      const candidate = join(entry, name)
      let hit = false
      try {
        hit = existsSync(candidate) && statSync(candidate).isFile()
      } catch {
        // unreadable PATH entry
      }
      if (hit) {
        if (!found.includes(entry)) found.push(entry)
        break
      }
    }
  }
  return found
}

export interface InProcessBackendOptions {
  /** Module root for the official packages; defaults to {@link defaultHostRoot}. */
  readonly hostRoot?: string | null
  /** Injection point for tests. */
  readonly load?: OfficialModuleLoader
  readonly logger?: { info?(message: string): void; warn?(message: string): void }
}

interface PluginLike {
  readonly name?: string
}

interface FiberLike {
  dispose(): unknown
}

interface WebServerLike {
  readonly port?: number
  readonly host?: string
  getOrigin(): string
}

interface ConnectionLike {
  authenticatedUrl(baseUrl: string): string
}

/**
 * Mount an official package as a Cordis plugin.
 *
 * Most of these packages export the plugin as the module namespace itself
 * (`apply` + `inject` + `name`), which is what the profile patch mounts; a few
 * export the plugin class instead. Prefer the namespace so the config schema and
 * the dependency list stay exactly the ones the official profile uses.
 */
function pickPlugin(namespace: unknown, fallbackExport?: string): PluginLike {
  const record = namespace as Record<string, unknown> | null
  if (typeof record?.['apply'] === 'function') return record as unknown as PluginLike
  if (fallbackExport !== undefined) return pickExport(namespace, fallbackExport)
  throw new WebuiError('unavailable', 'webui: the host installation does not export a mountable plugin')
}

function pickExport(namespace: unknown, name: string): PluginLike {
  const record = namespace as Record<string, unknown> | null
  const candidate = record?.[name] ?? record?.['default']
  if (typeof candidate !== 'function' && (typeof candidate !== 'object' || candidate === null)) {
    throw new WebuiError('unavailable', `webui: ${name} is not exported by the host installation`)
  }
  return candidate as PluginLike
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) {
      throw new WebuiError('mount-failed', `webui: ${what} did not become available within ${String(timeoutMs)}ms`)
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, READY_POLL_MS)
      timer.unref?.()
    })
  }
}

class InProcessBackendHandle implements WebuiBackendHandle {
  readonly mode = 'in-process' as const
  /** Same process ⇒ same session tree and settings instance. */
  readonly sharedSession = true

  private readonly fibers: FiberLike[]
  private readonly readyPromise: Promise<WebuiReady>
  private readonly exitListeners = new Set<(reason: WebuiFailureReason) => void>()
  private closed_ = false

  constructor(fibers: FiberLike[], ready: Promise<WebuiReady>, readonly reusedCredentials: boolean) {
    this.fibers = fibers
    this.readyPromise = ready
  }

  ready(): Promise<WebuiReady> {
    return this.readyPromise
  }

  onExit(listener: (reason: WebuiFailureReason) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /** Unload our fibers newest-first; each `dispose()` is idempotent. */
  async close(): Promise<void> {
    if (this.closed_) return
    this.closed_ = true
    for (const fiber of [...this.fibers].reverse()) {
      try {
        await fiber.dispose()
      } catch {
        // A half-mounted chain must not mask the original failure.
      }
    }
    this.fibers.length = 0
  }
}

/**
 * Candidate A backend.
 *
 * @param ctx - the host context the fallback services mount onto.
 * @param options - module root / loader override.
 */
export function createInProcessBackend(ctx: Context, options: InProcessBackendOptions = {}): WebuiBackend {
  const logger = options.logger

  return {
    mode: 'in-process',
    async start(
      startOptions: WebuiBackendStartOptions = { host: '127.0.0.1', port: 0, readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS },
    ): Promise<WebuiBackendHandle> {
      const load =
        options.load ??
        ((): OfficialModuleLoader | null => {
          const hostRoot = options.hostRoot ?? defaultHostRoot()
          return hostRoot === null ? null : createHostRootLoader(hostRoot)
        })()
      if (load === null) {
        throw new WebuiError(
          'unavailable',
          `webui: no host module root configured (set ${DSH_HOST_ROOT_ENV} to the installed dsh node_modules)`,
        )
      }

      let modules: [unknown, unknown, unknown, unknown]
      try {
        modules = await Promise.all([
          load('@deepseek-ai/dsh-host-webserver'),
          load('@deepseek-ai/dsh-client-connection'),
          load('@deepseek-ai/dsh-web-app'),
          load('@deepseek-ai/dsh-credentials-local').catch(() => null),
        ])
      } catch (error) {
        throw new WebuiError(
          'unavailable',
          `webui: the host installation does not expose the web packages: ${maskTokenInText(
            error instanceof Error ? error.message : String(error),
          )}`,
        )
      }

      const [webserverNamespace, connectionNamespace, webAppNamespace, credentialsNamespace] = modules
      const WebServer = pickExport(webserverNamespace, 'WebServer')
      const ClientConnection = pickPlugin(connectionNamespace, 'HostConnectionService')
      const WebApp = pickPlugin(webAppNamespace)

      const fibers: FiberLike[] = []
      const mount = (plugin: PluginLike, config: Record<string, unknown>): void => {
        fibers.push(ctx.plugin(plugin as never, config as never) as unknown as FiberLike)
      }

      try {
        // S6: never re-register a service the host already provides.
        const existingCredentials = ctx.get('credentials')
        const reusedCredentials = existingCredentials !== undefined
        if (!reusedCredentials) {
          if (credentialsNamespace === null) {
            throw new WebuiError('unavailable', 'webui: no credential provider available for the in-process listener')
          }
          mount(pickExport(credentialsNamespace, 'LocalCredentialProvider'), {})
          await waitFor(() => ctx.get('credentials'), startOptions.readyTimeoutMs, 'credentials')
        }

        mount(WebServer, {
          host: startOptions.host,
          port: startOptions.port,
          compression: 'gzip',
          compressionLevel: 1,
          compressionThresholdBytes: 1024,
        })
        const server = await waitFor<WebServerLike>(
          () => {
            const instance = ctx.get('webServer') as WebServerLike | undefined
            return instance !== undefined && instance.port !== undefined ? instance : undefined
          },
          startOptions.readyTimeoutMs,
          'webServer listener',
        )

        mount(ClientConnection, { trustedHosts: [], cookieMaxAgeDays: 30 })
        const connection = await waitFor<ConnectionLike>(
          () => ctx.get('connection') as ConnectionLike | undefined,
          startOptions.readyTimeoutMs,
          'connection service',
        )

        mount(WebApp, { openBrowser: false, printUrl: false, surfaceContext: false })

        const origin = server.getOrigin()
        const authenticatedUrl = connection.authenticatedUrl(origin)
        logger?.info?.(`webui: in-process listener bound at ${origin}`)
        return new InProcessBackendHandle(fibers, Promise.resolve({ origin, authenticatedUrl }), reusedCredentials)
      } catch (error) {
        for (const fiber of [...fibers].reverse()) {
          try {
            await fiber.dispose()
          } catch {
            // keep unwinding
          }
        }
        if (error instanceof WebuiError) throw error
        throw new WebuiError(
          'mount-failed',
          `webui: in-process mount failed: ${maskTokenInText(
            error instanceof Error ? error.message : String(error),
          )}`,
        )
      }
    },
  }
}
