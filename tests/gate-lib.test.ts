import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildCmdCommandLine,
  candidateNames,
  launcherFor,
  quoteForCmd,
  resolveExecutable,
  signalExitCode,
} from '../scripts/gate-lib.mjs'

test('quoteForCmd quotes one cmd.exe argument', () => {
  assert.equal(quoteForCmd('plain'), '"plain"')
  assert.equal(quoteForCmd('a b'), '"a b"')
  assert.equal(quoteForCmd(''), '""')
  assert.equal(quoteForCmd('c"d'), '"c\\"d"')
})

test('buildCmdCommandLine keeps every argument quoted', () => {
  assert.equal(
    buildCmdCommandLine('C:\\tools\\pnpm.cmd', ['build', 'a b']),
    '"C:\\tools\\pnpm.cmd" "build" "a b"',
  )
})

test('launcherFor sends .cmd through cmd.exe and rc.exe directly', () => {
  const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
  const cmd = launcherFor('C:\\tools\\pnpm.cmd', ['typecheck'], { platform: 'win32', env })
  assert.equal(cmd.file, env.ComSpec)
  assert.deepEqual(cmd.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.match(cmd.args[3]!, /^""C:\\tools\\pnpm\.cmd" "typecheck""$/)
  assert.equal(cmd.options.windowsVerbatimArguments, true)

  const exe = launcherFor('C:\\tools\\node.exe', ['--version'], { platform: 'win32', env })
  assert.equal(exe.file, 'C:\\tools\\node.exe')
  assert.deepEqual(exe.args, ['--version'])
  assert.deepEqual(exe.options, {})
})

test('candidateNames expands PATHEXT only for bare Windows commands', () => {
  const env = { PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  assert.deepEqual(candidateNames('pnpm', 'win32', env), [
    'pnpm', 'pnpm.com', 'pnpm.exe', 'pnpm.bat', 'pnpm.cmd',
  ])
  assert.deepEqual(candidateNames('C:\\tools\\pnpm', 'win32', env), ['C:\\tools\\pnpm'])
  assert.deepEqual(candidateNames('pnpm', 'linux', env), ['pnpm'])
})

test('resolveExecutable searches PATH with an injectable filesystem', () => {
  const files = new Set(['/opt/tools/pnpm', '/bin/node'])
  const isFile = (candidate: string) => files.has(candidate)
  assert.equal(
    resolveExecutable('pnpm', { platform: 'linux', env: { PATH: '/bin:/opt/tools' }, isFile }),
    '/opt/tools/pnpm',
  )
  assert.equal(resolveExecutable('missing', { platform: 'linux', env: { PATH: '/bin' }, isFile }), null)
})

test('signalExitCode follows the shell convention', () => {
  assert.equal(signalExitCode('SIGTERM'), 143)
  assert.equal(signalExitCode('SIGINT'), 130)
  assert.equal(signalExitCode('SIGWEIRD'), 129)
})
