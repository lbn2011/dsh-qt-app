import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const gate = join(root, 'scripts', 'gate.mjs')

function run(...command: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [gate, '--', ...command], { encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr }
}

test('gate preserves a zero exit code and reports it', () => {
  const { status, stderr } = run(process.execPath, '-e', 'process.exit(0)')
  assert.equal(status, 0)
  assert.match(stderr, /\[gate\] exit=0 /u)
})

test('gate preserves a failing exit code instead of masking it', () => {
  const { status, stderr } = run(process.execPath, '-e', 'process.exit(7)')
  assert.equal(status, 7)
  assert.match(stderr, /\[gate\] exit=7 /u)
})

test('gate without a command exits 2 and explains itself', () => {
  const result = spawnSync(process.execPath, [gate], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /usage: node scripts\/gate\.mjs/u)
})
