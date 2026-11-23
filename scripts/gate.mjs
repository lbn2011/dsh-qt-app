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
 * Usage: node scripts/gate.mjs -- <command ...>
 */
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const command = separator >= 0 ? argv.slice(separator + 1) : argv

if (command.length === 0) {
  process.stderr.write('usage: node scripts/gate.mjs -- <command ...>\n')
  process.exit(2)
}

const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: process.env })
const code = await new Promise((resolve) => {
  child.on('error', (error) => {
    process.stderr.write(`[gate] spawn-error ${error.message}\n`)
    resolve(127)
  })
  child.on('exit', (exitCode, signal) => {
    resolve(exitCode ?? (signal === null ? 1 : 128))
  })
})

process.stderr.write(`[gate] exit=${String(code)} command=${command.join(' ')}\n`)
process.exit(code)
