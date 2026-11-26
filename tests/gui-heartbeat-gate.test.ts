// The `qt-gui-heartbeat` job ends with a step that reads gui-heartbeat.log and
// decides whether the run this job claims to have made actually happened. That
// step is shell inside .github/workflows/test.yml, so nothing type-checks it and
// nothing exercises it: a wrong pattern there turns a red run green and no local
// suite notices.
//
// This file runs the step's own script — extracted from the workflow at test
// time, not copied here — against synthetic logs. Extraction is the point: a
// copy would drift, and the thing under test is the text CI actually executes.
//
// The two false positives this file started from (t124 supplemental evidence,
// measured against 42591fb):
//
//   tests 170 / pass 170 / fail 0 / cancelled 0 / skipped 0   → old gate exited 0
//   tests 18  / pass 17  / fail 0 / cancelled 1 / skipped 0   → old gate exited 0
//
// The first passed because `grep 'pass 17'` also matches `pass 170`; the second
// because nothing in the old gate ever looked at the cancelled count. Both are
// rejected below, and the summary fields are now read whole-line and checked
// for internal consistency.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const workflowPath = join(repoRoot, '.github', 'workflows', 'test.yml')

/** Pull one step's `run: |` body out of the workflow, dedented. */
function stepScript(stepName: string): string {
  const lines = readFileSync(workflowPath, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`)
  assert.notEqual(start, -1, `no step named "${stepName}" in ${workflowPath}`)

  let runIndex = -1
  let runIndent = 0
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (/^\s*-\s+name:/.test(line) || /^\s{0,4}[a-z-]+:$/.test(line) && !line.trimStart().startsWith('-')) {
      // The step ended without a `run:` block.
      break
    }
    const match = /^(\s*)run:\s*\|\s*$/.exec(line)
    if (match !== null) {
      runIndex = index
      runIndent = (match[1] ?? '').length
      break
    }
  }
  assert.notEqual(runIndex, -1, `step "${stepName}" has no "run: |" block`)

  const body: string[] = []
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      body.push('')
      continue
    }
    const indent = line.length - line.trimStart().length
    if (indent <= runIndent) break
    body.push(line)
  }

  const indents = body.filter((line) => line.trim() !== '').map((line) => line.length - line.trimStart().length)
  const common = indents.length === 0 ? 0 : Math.min(...indents)
  return body.map((line) => (line.trim() === '' ? '' : line.slice(common))).join('\n')
}

type Counts = {
  tests?: number
  pass?: number
  fail?: number
  cancelled?: number
  skipped?: number
}

/** A log shaped like the node test reporter's real output. */
function heartbeatLog(counts: Counts, options: { stages?: boolean; park?: boolean; skipMarkers?: boolean } = {}): string {
  const lines: string[] = ['✔ the heartbeat keeps ticking while stdin is idle (812ms)']
  if (options.skipMarkers === true) lines.push('﹣ a case that skipped itself (1ms) # SKIP')
  if (options.stages !== false) {
    lines.push('# stages silent: {"connectedMs":89,"firstTickMs":170,"firstWindowMs":170,"firstTickElapsedMs":78,"observerBeforeFirstTick":1}')
  }
  if (options.park !== false) lines.push('# park: 1200 ms parked, 0 GUI ticks inside the park, 24 observer ticks meanwhile')
  lines.push('ℹ suites 0')
  for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped'] as const) {
    const value = counts[field]
    if (value !== undefined) lines.push(`ℹ ${field} ${value}`)
  }
  lines.push('ℹ duration_ms 12034.51')
  return `${lines.join('\n')}\n`
}

/** Run the gate step exactly as CI runs it, inside a throwaway directory. */
function runGate(log: string | null): { status: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 't130-gate-'))
  if (log !== null) writeFileSync(join(dir, 'gui-heartbeat.log'), log)
  const result = spawnSync('bash', ['-c', stepScript('Assert the regression really ran')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, 'summary.md') },
  })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const GREEN: Counts = { tests: 17, pass: 17, fail: 0, cancelled: 0, skipped: 0 }

/** A run that really did what the job claims: accepted. */
test('a real seventeen-case run is accepted', () => {
  const run = runGate(heartbeatLog(GREEN))
  assert.equal(run.status, 0, `expected acceptance, got ${run.status}\n${run.stdout}${run.stderr}`)
})

/**
 * False positive 1 (t124 supplemental evidence): 170 passing cases satisfied
 * `grep 'pass 17'`, because a substring match cannot see the trailing zero.
 */
test('a 170-case run is rejected', () => {
  const run = runGate(heartbeatLog({ tests: 170, pass: 170, fail: 0, cancelled: 0, skipped: 0 }))
  assert.notEqual(run.status, 0, '170 passing cases were accepted as the seventeen-case run')
})

/**
 * False positive 2 (t124 supplemental evidence): a cancelled case next to the
 * seventeen that passed was invisible to the old gate.
 */
test('a run with a cancelled case is rejected', () => {
  const run = runGate(heartbeatLog({ tests: 18, pass: 17, fail: 0, cancelled: 1, skipped: 0 }))
  assert.notEqual(run.status, 0, 'a cancelled case was accepted')
})

test('a run with a skipped case is rejected', () => {
  const run = runGate(heartbeatLog({ tests: 18, pass: 17, fail: 0, cancelled: 0, skipped: 1 }, { skipMarkers: true }))
  assert.notEqual(run.status, 0, 'a skipped case was accepted')
})

test('a run with a failing case is rejected', () => {
  const run = runGate(heartbeatLog({ tests: 17, pass: 16, fail: 1, cancelled: 0, skipped: 0 }))
  assert.notEqual(run.status, 0, 'a failing case was accepted')
})

test('a run that lost a case is rejected', () => {
  const run = runGate(heartbeatLog({ tests: 16, pass: 16, fail: 0, cancelled: 0, skipped: 0 }))
  assert.notEqual(run.status, 0, 'sixteen passing cases were accepted')
})

test('a summary with a missing field is rejected', () => {
  const run = runGate(heartbeatLog({ tests: 17, pass: 17, fail: 0, cancelled: 0 }))
  assert.notEqual(run.status, 0, 'a summary without a skipped count was accepted')
})

test('a summary whose counts do not add up is rejected', () => {
  // tests says 17, the parts say 18: one of the two blocks is lying.
  const run = runGate(heartbeatLog({ tests: 17, pass: 17, fail: 0, cancelled: 1, skipped: 0 }))
  assert.notEqual(run.status, 0, 'an internally inconsistent summary was accepted')
})

test('two disagreeing summary blocks are rejected', () => {
  const log = `${heartbeatLog(GREEN)}${heartbeatLog({ tests: 170, pass: 170, fail: 0, cancelled: 0, skipped: 0 })}`
  const run = runGate(log)
  assert.notEqual(run.status, 0, 'two summary blocks were accepted')
})

test('two identical summary blocks are rejected as well', () => {
  // Not because the numbers are wrong, but because a single run reports once:
  // a repeated block means the log is not one run's output.
  const run = runGate(`${heartbeatLog(GREEN)}${heartbeatLog(GREEN)}`)
  assert.notEqual(run.status, 0, 'a doubled summary block was accepted')
})

test('a log with no summary at all is rejected', () => {
  const run = runGate('✔ the heartbeat keeps ticking (812ms)\n# stages silent: {}\n# park: ok\n')
  assert.notEqual(run.status, 0, 'a log without a summary was accepted')
})

test('a missing log file is rejected', () => {
  const run = runGate(null)
  assert.notEqual(run.status, 0, 'a missing gui-heartbeat.log was accepted')
})

// The measured evidence this job exists to publish: without these lines the run
// is not the run the job claims, so they stay gates.
test('a log without the measured start-up stages is rejected', () => {
  const run = runGate(heartbeatLog(GREEN, { stages: false }))
  assert.notEqual(run.status, 0, 'a log without "# stages " was accepted')
})

test('a log without the parked-GUI control is rejected', () => {
  const run = runGate(heartbeatLog(GREEN, { park: false }))
  assert.notEqual(run.status, 0, 'a log without "# park: " was accepted')
})

// A non-zero exit from the test command must keep failing the job on its own:
// the summary check is an addition to that signal, never a replacement.
test('the test step still pipes with pipefail so a non-zero exit fails the job', () => {
  const script = stepScript('Run the GUI heartbeat regression')
  assert.match(script, /set -o pipefail/, 'the test step lost its pipefail')
  assert.match(script, /tests\/gui-heartbeat\.e2e\.ts/, 'the test step no longer runs the heartbeat suite')
})
