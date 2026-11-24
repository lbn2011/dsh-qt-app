import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
    'pnpm.com', 'pnpm.exe', 'pnpm.bat', 'pnpm.cmd',
  ])
  assert.deepEqual(candidateNames('C:\\tools\\pnpm', 'win32', env), ['C:\\tools\\pnpm'])
  assert.deepEqual(candidateNames('pnpm', 'linux', env), ['pnpm'])
})

test('resolveExecutable searches PATH with an injectable filesystem', () => {
  // The fixture directories are real host paths and the resolver joins with the
  // host's `path.join`, so the fixture has to be host-flavoured: the hard-coded
  // `/opt/tools` turned into `\opt\tools\pnpm` on the Windows runner, never
  // matched the injected set and the lookup returned null (T44-4). On Windows the
  // command carries its own extension so PATHEXT expansion stays out of the way
  // and only the PATH walk is under test.
  const isWindowsHost = process.platform === 'win32'
  const platform = isWindowsHost ? 'win32' : 'linux'
  const separator = isWindowsHost ? ';' : ':'
  const command = isWindowsHost ? 'pnpm.cmd' : 'pnpm'
  const bin = join(tmpdir(), 't45-path-bin')
  const tools = join(tmpdir(), 't45-path-tools')
  const files = new Set([join(bin, 'node'), join(tools, command)])
  const isFile = (candidate: string) => files.has(candidate)

  assert.equal(
    resolveExecutable(command, { platform, env: { PATH: `${bin}${separator}${tools}` }, isFile }),
    join(tools, command),
  )
  assert.equal(resolveExecutable('missing', { platform, env: { PATH: bin }, isFile }), null)
})

test('signalExitCode follows the shell convention', () => {
  assert.equal(signalExitCode('SIGTERM'), 143)
  assert.equal(signalExitCode('SIGINT'), 130)
  assert.equal(signalExitCode('SIGWEIRD'), 129)
})

test('Windows resolution prefers pnpm.cmd over the extensionless setup-pnpm shim', () => {
  // Simulated on Linux with `/`; the layout and the win32 branch are the point.
  // The real runner has the same two files under .../setup-pnpm/node_modules/.bin.
  const dir = join(tmpdir(), 'setup-pnpm', 'node_modules', '.bin')
  const shim = join(dir, 'pnpm')
  const cmd = join(dir, 'pnpm.cmd')
  const files = new Set([shim, cmd, join(dir, 'pnpm.ps1')])
  const isFile = (candidate: string) => files.has(candidate)
  const env = {
    PATH: dir,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  }

  const resolved = resolveExecutable('pnpm', { platform: 'win32', env, isFile })
  assert.equal(resolved, cmd, 'must not select the extensionless Unix shim')

  const launch = launcherFor(resolved!, ['build', 'a b'], { platform: 'win32', env })
  assert.equal(launch.file, env.ComSpec)
  assert.deepEqual(launch.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(launch.args[3], `""${cmd}" "build" "a b""`)
  assert.equal(launch.options.windowsVerbatimArguments, true)
})

test('Windows resolution returns null when only an extensionless shim exists', () => {
  const dir = join(tmpdir(), 'setup-pnpm', 'node_modules', '.bin')
  const files = new Set([join(dir, 'pnpm')])
  const isFile = (candidate: string) => files.has(candidate)
  const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  assert.equal(resolveExecutable('pnpm', { platform: 'win32', env, isFile }), null)
})
