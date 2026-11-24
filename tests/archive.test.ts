import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const script = join(root, 'scripts', 'check-archive.sh')

function buildArchive(options: { notices?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-archive-'))
  const tree = join(dir, 'dsh-qt-app-0.1.0-Linux-x86_64')
  mkdirSync(join(tree, 'bin'), { recursive: true })
  writeFileSync(join(tree, 'LICENSE'), 'MIT\n')
  if (options.notices !== false) writeFileSync(join(tree, 'THIRD-PARTY-NOTICES.md'), 'cmark-gfm\n')
  writeFileSync(join(tree, 'bin', 'dsh-qt-app'), '#!/bin/sh\n')
  const archive = join(dir, 'dsh-qt-app-0.1.0-Linux-x86_64.tar.gz')
  const tar = spawnSync('tar', ['-czf', archive, '-C', dir, 'dsh-qt-app-0.1.0-Linux-x86_64'], { encoding: 'utf8' })
  assert.equal(tar.status, 0, tar.stderr)
  const hash = createHash('sha256').update(readFileSync(archive)).digest('hex')
  writeFileSync(`${archive}.sha256`, `${hash}  ${'dsh-qt-app-0.1.0-Linux-x86_64.tar.gz'}\n`)
  return archive
}

function check(archive: string): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync('bash', [script, archive], { encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr, stdout: result.stdout }
}

test('check-archive accepts a real archive with license material', () => {
  const archive = buildArchive()
  try {
    const result = check(archive)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /carries LICENSE and THIRD-PARTY-NOTICES\.md/u)
  } finally {
    rmSync(join(archive, '..'), { recursive: true, force: true })
  }
})

test('check-archive rejects an archive missing THIRD-PARTY-NOTICES.md', () => {
  const archive = buildArchive({ notices: false })
  try {
    const result = check(archive)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /is missing THIRD-PARTY-NOTICES\.md/u)
  } finally {
    rmSync(join(archive, '..'), { recursive: true, force: true })
  }
})

test('check-archive rejects a corrupted checksum instead of trusting the file', () => {
  const archive = buildArchive()
  try {
    writeFileSync(`${archive}.sha256`, `${'0'.repeat(64)}  dsh-qt-app-0.1.0-Linux-x86_64.tar.gz\n`)
    const result = check(archive)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /FAILED|checksum/u)
  } finally {
    rmSync(join(archive, '..'), { recursive: true, force: true })
  }
})

test('check-archive without an argument exits 2 with usage', () => {
  const result = spawnSync('bash', [script], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /usage: check-archive\.sh/u)
})
