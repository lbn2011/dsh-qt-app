/**
 * Real `ctx.pluginManager` exercise for t32 acceptance ⑤.
 *
 * An isolated DSH_HOME installs two local, offline fixture packages:
 *
 *   @dsh-fixture/profile-plugin        — an empty Cordis plugin (the target)
 *   @dsh-fixture/plugin-manager-probe  — a plugin that, from inside a real
 *                                        headless profile, calls the public
 *                                        `ctx.pluginManager.listPlugins`,
 *                                        disables the target, and re-enables it
 *
 * The probe prints the inventory and each ChangeResult as JSON on stderr and
 * exits the profile process. Nothing here fakes the manager: the profile's own
 * Cordis service graph is what answers. Boundaries: the run is offline, the
 * profile lives in a temp DSH_HOME, and only the public management API is used
 * (no bundle layers, no installs, no network).
 *
 * Run explicitly: `pnpm exec tsx --test tests/plugin-manager-live.e2e.ts`.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const DSH_BIN = '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
const TARGET = '@dsh-fixture/profile-plugin'
const PROBE = '@dsh-fixture/plugin-manager-probe'

function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

let home = ''
let patchPath = ''

before(async () => {
  assert.ok(existsSync(DSH_BIN), `missing installed DSH at ${DSH_BIN}`)
  home = mkdtempSync(join(tmpdir(), 'dsh-qt-plugin-manager-'))
  for (const fixture of ['profile-plugin', 'plugin-manager-probe']) {
    const directory = join(REPO_ROOT, 'tests', 'fixtures', fixture)
    const install = await runProcess(
      process.execPath,
      [DSH_BIN, 'plugin', '--profile', 'headless', 'add', directory],
      { ...process.env, DSH_HOME: home },
      120_000,
    )
    assert.equal(install.code, 0, `plugin add ${fixture} failed: ${install.stderr.slice(-1500)}`)
  }
  patchPath = join(home, 'plugin-manager.patch.yml')
  writeFileSync(
    patchPath,
    [
      '- insert:',
      '    - id: fixture-target',
      `      name: '${TARGET}'`,
      '    - id: fixture-probe',
      `      name: '${PROBE}'`,
      '',
    ].join('\n'),
  )
})

after(() => {
  // temp home is intentionally left for post-mortem; OS cleans it up.
})

test('the real ctx.pluginManager lists and toggles a local fixture plugin', { timeout: 120_000 }, async () => {
  const result = await runProcess(
    process.execPath,
    [DSH_BIN, '--profile', 'headless', '--patch', patchPath, '--approval-policy', 'never', '--json', 'hi'],
    { ...process.env, DSH_HOME: home },
    100_000,
  )

  assert.equal(result.timedOut, false, 'the probe profile timed out')
  assert.equal(result.code, 0, `probe profile failed: ${result.stderr.slice(-2000)}`)

  const listLine = /\[probe\] list (\[.*\])/u.exec(result.stderr)
  assert.ok(listLine, `the probe never reported the inventory: ${result.stderr.slice(-1500)}`)
  const entries = JSON.parse(listLine[1] ?? '[]') as {
    entryId: string
    moduleName: string
    enabled: boolean
    fiberPhase: string | null
    patchId?: string
  }[]

  const target = entries.find((entry) => entry.moduleName === TARGET)
  assert.ok(target, `the fixture plugin is missing from the inventory: ${listLine[1]}`)
  assert.equal(target.enabled, true, 'the fixture starts enabled')
  assert.equal(target.patchId, 'fixture-target', 'the inventory exposes its patch row id')
  assert.ok(entries.some((entry) => entry.moduleName === PROBE), 'the probe itself is listed')

  const disabled = /\[probe\] disabled (.*)/u.exec(result.stderr)
  assert.ok(disabled, `no disable ChangeResult: ${result.stderr.slice(-1500)}`)
  const disabledResult = JSON.parse(disabled[1] ?? '{}') as Record<string, unknown>
  assert.equal(disabledResult.stage, 'enable', 'the disable result is settled')
  assert.match(String(disabledResult.target), /fixture-plugin|fixture-target/u)

  const enabled = /\[probe\] enabled (.*)/u.exec(result.stderr)
  assert.ok(enabled, `no enable ChangeResult: ${result.stderr.slice(-1500)}`)
  const enabledResult = JSON.parse(enabled[1] ?? '{}') as Record<string, unknown>
  assert.equal(enabledResult.stage, 'enable', 'the enable result is settled')
})
