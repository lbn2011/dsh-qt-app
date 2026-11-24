#!/usr/bin/env node
/**
 * Exit-code-faithful gate wrapper (I-GATE1).
 *
 * Runs one command with inherited stdio and exits with exactly the child's exit
 * code, so a failing step can never be recorded as passing. It prints a single
 * machine-readable summary line on stderr for CI logs:
 *
 *   [gate] exit=0 command=bash -lc 'pnpm typecheck'
 *
 * On Windows, bare commands such as `pnpm` are `pnpm.cmd` and CreateProcess
 * cannot launch them directly. Those are resolved through PATHEXT and run via
 * `cmd.exe /d /s /c`, with every argument quoted for cmd's parser; real
 * executables are still spawned directly, so `shell: true` is never applied
 * indiscriminately. Signals are reported as 128+n.
 *
 * Usage: node scripts/gate.mjs -- <command ...>
 */
import { spawn } from 'node:child_process'
import {
  launcherFor,
  resolveExecutable,
  signalExitCode,
} from './gate-lib.mjs'

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const command = separator >= 0 ? argv.slice(separator + 1) : argv

if (command.length === 0) {
  process.stderr.write('usage: node scripts/gate.mjs -- <command ...>\n')
  process.exit(2)
}

const resolved = resolveExecutable(command[0])
if (resolved === null) {
  process.stderr.write(`[gate] spawn-error spawn ${command[0]} ENOENT\n`)
  process.stderr.write(`[gate] exit=127 command=${command.join(' ')}\n`)
  process.exit(127)
}

const launch = launcherFor(resolved, command.slice(1))
const child = spawn(launch.file, launch.args, {
  ...launch.options,
  stdio: 'inherit',
  env: process.env,
})
let spawnFailed = false
const code = await new Promise((resolve) => {
  child.on('error', (error) => {
    spawnFailed = true
    process.stderr.write(`[gate] spawn-error ${error.message}\n`)
    resolve(127)
  })
  child.on('exit', (exitCode, signal) => {
    if (signal !== null) {
      process.stderr.write(`[gate] signal=${signal}\n`)
      resolve(signalExitCode(signal))
    } else {
      resolve(exitCode ?? 1)
    }
  })
})

if (!spawnFailed) {
  process.stderr.write(`[gate] exit=${String(code)} command=${command.join(' ')}\n`)
}
process.exit(code)
