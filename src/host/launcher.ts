// src/host/launcher.ts — start the Qt process and wire its stdio.
//
// Decision S1: the Node host owns the Qt child process. Qt never spawns and
// never listens on a socket; it is a presentation process that speaks protocol
// v1 over stdin/stdout. This module is the only place that calls `spawn`.
//
// Binary resolution order (first existing file wins):
//
//   1. `options.binaryPath` (explicit config)
//   2. `DSH_QT_APP_BINARY` (packaging / e2e override)
//   3. `<packageRoot>/build/dsh-qt-app[.exe]` (the CMake default build dir)
//   4. `<packageRoot>/build/Release/dsh-qt-app[.exe]` (multi-config generators)
//
// A missing binary is a first-class, recoverable failure: the bridge reports
// `unavailable` and the rest of the DSH profile keeps running. That is why the
// error carries a code instead of being a bare `Error`.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HostTransport } from './transport.js'
import type { HostTransportLogger, HostTransportOptions } from './transport.js'

/** Environment override honoured before any built-in candidate. */
export const QT_APP_BINARY_ENV = 'DSH_QT_APP_BINARY'

/** Executable name for the current platform. */
export function qtAppExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'dsh-qt-app.exe' : 'dsh-qt-app'
}

/** Package root, from either `src/host/` (tsx) or `lib/host/` (built). */
export function packageRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url))
}

export interface QtBinaryCandidate {
  path: string
  source: 'explicit' | 'env' | 'build' | 'build-release'
}

export interface ResolveQtBinaryOptions {
  binaryPath?: string
  root?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

/**
 * Every candidate path, in priority order, whether or not it exists.
 *
 * Exposed so diagnostics can print what was tried; `resolveQtBinary()` filters
 * by existence.
 */
export function discoverQtBinaries(options: ResolveQtBinaryOptions = {}): QtBinaryCandidate[] {
  const root = options.root ?? packageRoot()
  const env = options.env ?? process.env
  const name = qtAppExecutableName(options.platform)
  const candidates: QtBinaryCandidate[] = []
  if (options.binaryPath !== undefined && options.binaryPath !== '') {
    candidates.push({ path: options.binaryPath, source: 'explicit' })
  }
  const fromEnv = env[QT_APP_BINARY_ENV]
  if (fromEnv !== undefined && fromEnv !== '') {
    candidates.push({ path: fromEnv, source: 'env' })
  }
  candidates.push({ path: join(root, 'build', name), source: 'build' })
  candidates.push({ path: join(root, 'build', 'Release', name), source: 'build-release' })
  return candidates
}

/** First existing candidate, or `null` when nothing is built yet. */
export function resolveQtBinary(options: ResolveQtBinaryOptions = {}): QtBinaryCandidate | null {
  for (const candidate of discoverQtBinaries(options)) {
    if (existsSync(candidate.path)) return candidate
  }
  return null
}

/** Raised when the Qt process cannot be started. */
export class QtLaunchError extends Error {
  readonly code = 'unavailable' as const

  constructor(message: string) {
    super(message)
    this.name = 'QtLaunchError'
  }
}

export interface LaunchQtHostOptions {
  /** Explicit binary; otherwise {@link resolveQtBinary} decides. */
  binaryPath?: string
  /** Package root for default candidate paths. */
  root?: string
  /** Extra arguments after argv[0]. */
  args?: string[]
  /** Environment merged over `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Working directory for the child. */
  cwd?: string
  /** Inbound frame limit override (tests). */
  maxInboundFrameBytes?: number
  logger?: HostTransportLogger
  /** Receives complete stderr lines (the pipe is always drained). */
  onStderr?: (line: string) => void
}

export interface LaunchedQtHost {
  child: ChildProcess
  transport: HostTransport
  binaryPath: string
  pid: number | undefined
}

/**
 * Spawn the Qt host and return its stdio transport.
 *
 * An explicit `binaryPath` (or an inherited `DSH_QT_APP_BINARY`) is
 * authoritative: if the operator names a binary, silently falling back to
 * `build/` would run a different build than the one requested. Both therefore
 * fail with `unavailable` when they point at nothing.
 *
 * stderr is piped and always drained: an unread pipe fills up and blocks the
 * child mid-frame, which would look like a protocol bug. Lines are forwarded to
 * `onStderr` (e2e assertions) and the logger.
 */
export function launchQtHost(options: LaunchQtHostOptions = {}): LaunchedQtHost {
  const env = options.env ?? process.env
  const named =
    options.binaryPath !== undefined && options.binaryPath !== ''
      ? options.binaryPath
      : env[QT_APP_BINARY_ENV] !== undefined && env[QT_APP_BINARY_ENV] !== ''
        ? env[QT_APP_BINARY_ENV]
        : undefined
  if (named !== undefined && !existsSync(named)) {
    throw new QtLaunchError(`Qt host binary not found at ${named}`)
  }
  const resolveOptions = {
    ...(options.binaryPath === undefined ? {} : { binaryPath: options.binaryPath }),
    ...(options.root === undefined ? {} : { root: options.root }),
    env,
  }
  const resolved = named === undefined ? resolveQtBinary(resolveOptions) : { path: named, source: options.binaryPath === undefined ? ('env' as const) : ('explicit' as const) }
  if (resolved === null) {
    const tried = discoverQtBinaries(resolveOptions)
      .map((candidate) => candidate.path)
      .join(', ')
    throw new QtLaunchError(`Qt host binary not found; tried: ${tried}`)
  }

  const child = spawn(resolved.path, options.args ?? [], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  if (child.stdin === null || child.stdout === null) {
    child.kill()
    throw new QtLaunchError('Qt host was spawned without piped stdio')
  }

  forwardStderr(child, options.onStderr, options.logger)

  const transportOptions: HostTransportOptions = {
    input: child.stdout,
    output: child.stdin,
    ...(options.maxInboundFrameBytes === undefined
      ? {}
      : { maxInboundFrameBytes: options.maxInboundFrameBytes }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  }
  const transport = new HostTransport(transportOptions)
  return {
    child,
    transport,
    binaryPath: resolved.path,
    pid: child.pid,
  }
}

function forwardStderr(
  child: ChildProcess,
  onStderr: ((line: string) => void) | undefined,
  logger: HostTransportLogger | undefined,
): void {
  const stderr = child.stderr
  if (stderr === null) return
  let buffered = ''
  stderr.on('data', (chunk: Buffer | string) => {
    buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let index = buffered.indexOf('\n')
    while (index !== -1) {
      const line = buffered.slice(0, index).replace(/\r$/, '')
      buffered = buffered.slice(index + 1)
      if (line.length > 0) {
        onStderr?.(line)
        logger?.warn('qt: %s', line)
      }
      index = buffered.indexOf('\n')
    }
    // Keep a runaway unterminated line from growing without bound.
    if (buffered.length > 8 * 1024) buffered = buffered.slice(-1024)
  })
  stderr.on('error', () => {
    // The child died; exit/close handlers report the failure itself.
  })
}