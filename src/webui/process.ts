/**
 * Candidate B: bind the WebUI in a *second* DSH process (`dsh web`).
 *
 * Ownership rules (see `docs/PHASE-3-WEB-FALLBACK.md` §6, re-stated here because
 * this is the only file that touches another process):
 *
 *   1. We only ever signal the `ChildProcess` handle we created. No `pkill`,
 *      no `taskkill /IM`, no "kill whatever holds this port".
 *   2. We never scan ports to decide what to kill: a listener we did not spawn
 *      is someone else's (a user's own `dsh web`, another app) and must survive.
 *   3. Readiness comes from the official announcement line, not from probing a
 *      port, so a stale listener on the same port can never be mistaken for
 *      our child.
 *   4. Shutdown is SIGTERM → grace → SIGKILL, and only while our child is
 *      still alive.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

import { maskTokenInText } from './token.js'
import { WebuiError } from './types.js'
import type {
  WebuiBackend,
  WebuiBackendHandle,
  WebuiBackendStartOptions,
  WebuiFailureReason,
  WebuiReady,
} from './types.js'

/** Overrides the `dsh` executable used for the fallback child. */
export const DSH_WEB_BIN_ENV = 'DSH_WEB_BIN'
/** Prefix of the official ready line: `dsh web: <authenticatedUrl>`. */
export const DSH_WEB_ANNOUNCE_PREFIX = 'dsh web: '
/** Grace period between SIGTERM and SIGKILL. */
export const DEFAULT_CLOSE_GRACE_MS = 3_000
const STDERR_LIMIT = 4_096

/**
 * Extract the authenticated URL from one stdout line.
 *
 * @param line - one line of child stdout.
 * @returns the URL, or `null` for every other line.
 */
export function parseAnnouncement(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith(DSH_WEB_ANNOUNCE_PREFIX)) return null
  const url = trimmed.slice(DSH_WEB_ANNOUNCE_PREFIX.length).trim()
  if (url === '') return null
  // `dsh web` prints more than one `dsh web:` line (the browser hand-off notice
  // is one), so the payload must actually be an http(s) URL. Anything else is
  // not a readiness signal.
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return url
}

export interface ChildBackendLogger {
  info?(message: string): void
  warn?(message: string): void
}

export interface ChildBackendOptions {
  /** Executable; defaults to `$DSH_WEB_BIN` or `dsh`. */
  readonly command?: string
  /** Extra/overriding argv; the profile subcommand is always `web`. */
  readonly args?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly graceMs?: number
  readonly logger?: ChildBackendLogger
  /** Injection point for tests. */
  readonly spawnFn?: typeof spawn
}

class ChildBackendHandle implements WebuiBackendHandle {
  readonly mode = 'child' as const
  /** A child `dsh web` has its own session tree. */
  readonly sharedSession = false
  readonly reusedCredentials = false

  private readonly child: ChildProcess
  private readonly graceMs: number
  private readonly logger: ChildBackendLogger | undefined
  private readonly readyPromise: Promise<WebuiReady>
  private readonly exitListeners = new Set<(reason: WebuiFailureReason) => void>()
  private closed_ = false
  private exited = false

  constructor(child: ChildProcess, ready: Promise<WebuiReady>, graceMs: number, logger: ChildBackendLogger | undefined) {
    this.child = child
    this.readyPromise = ready
    this.graceMs = graceMs
    this.logger = logger
  }

  /** Attach the exit hook that turns a crash into a `Failed` state. */
  watchExit(): void {
    this.child.once('exit', (code, signal) => {
      this.exited = true
      if (this.closed_) return
      const detail = signal === null ? `code ${String(code)}` : `signal ${signal}`
      this.logger?.warn?.(`webui: fallback child exited unexpectedly (${detail})`)
      for (const listener of this.exitListeners) listener('crashed')
    })
  }

  ready(): Promise<WebuiReady> {
    return this.readyPromise
  }

  onExit(listener: (reason: WebuiFailureReason) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  async close(): Promise<void> {
    if (this.closed_) return
    this.closed_ = true
    if (this.exited || this.child.exitCode !== null || this.child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.child.removeListener('exit', done)
        resolve()
      }
      const timer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          this.logger?.warn?.('webui: fallback child ignored SIGTERM; sending SIGKILL')
          this.child.kill('SIGKILL')
        }
        done()
      }, this.graceMs)
      timer.unref?.()
      this.child.once('exit', done)
      this.child.kill('SIGTERM')
    })
  }
}

/**
 * Candidate B backend.
 *
 * @param options - executable override, env and shutdown grace.
 * @returns a backend that spawns `dsh web --port <n> --no-open --host <host>`.
 */
export function createChildBackend(options: ChildBackendOptions = {}): WebuiBackend {
  const command = options.command ?? process.env[DSH_WEB_BIN_ENV] ?? 'dsh'
  const graceMs = options.graceMs ?? DEFAULT_CLOSE_GRACE_MS
  const logger = options.logger
  const spawnFn = options.spawnFn ?? spawn

  return {
    mode: 'child',
    async start(startOptions: WebuiBackendStartOptions): Promise<WebuiBackendHandle> {
      const argv = [
        ...(options.args ?? [
          'web',
          '--host',
          startOptions.host,
          '--port',
          String(startOptions.port),
          // The Qt window is the surface; never hand the URL to a system browser.
          '--no-open',
        ]),
      ]
      const child = spawnFn(command, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...options.env },
        windowsHide: true,
      })

      let stderr = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_LIMIT)
      })

      const ready = new Promise<WebuiReady>((resolve, reject) => {
        let settled = false
        const settleError = (reason: WebuiFailureReason, message: string): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new WebuiError(reason, maskTokenInText(message)))
        }
        const timer = setTimeout(() => {
          settleError('timeout', `webui: dsh web did not announce a URL within ${String(startOptions.readyTimeoutMs)}ms`)
          // We own this child: an unannounced child is a failed attempt.
          child.kill('SIGKILL')
        }, startOptions.readyTimeoutMs)
        timer.unref?.()

        let buffered = ''
        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => {
          buffered += chunk
          let index = buffered.indexOf('\n')
          while (index >= 0) {
            const line = buffered.slice(0, index)
            buffered = buffered.slice(index + 1)
            const url = parseAnnouncement(line)
            if (url !== null && !settled) {
              settled = true
              clearTimeout(timer)
              let origin: string
              try {
                origin = new URL(url).origin
              } catch {
                settleError('spawn-failed', `webui: dsh web announced an unusable URL (${maskTokenInText(url)})`)
                return
              }
              logger?.info?.(`webui: fallback child listening on ${origin}`)
              resolve({ origin, authenticatedUrl: url })
            }
            index = buffered.indexOf('\n')
          }
        })

        child.once('error', (error: Error) => {
          settleError('spawn-failed', `webui: could not start ${command}: ${error.message}`)
        })
        child.once('exit', (code, signal) => {
          const detail = signal === null ? `code ${String(code)}` : `signal ${signal}`
          settleError(
            'crashed',
            `webui: dsh web exited before announcing a URL (${detail})${stderr === '' ? '' : `: ${stderr.trim()}`}`,
          )
        })
      })

      const handle = new ChildBackendHandle(child, ready, graceMs, logger)
      handle.watchExit()
      // A rejected `ready()` must not leave an orphan behind.
      ready.catch(() => {
        void handle.close()
      })
      return handle
    },
  }
}
