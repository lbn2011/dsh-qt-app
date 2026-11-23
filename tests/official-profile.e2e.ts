// Real-host end-to-end proof for the Phase 3 acceptance criterion that the Qt
// application is exercised from a genuine DSH profile instead of from a fake
// service graph.
//
// Topology under test (see docs/PHASE-3-STATUS.md):
//
//   dsh --profile headless  (installed @deepseek-ai/dsh 0.2.2-rc.1)
//     └── this plugin (@deepseek-ai/dsh-qt-app, linked from this repo)
//           └── spawns the real build/dsh-qt-app and speaks NDJSON with it
//
// The model is a deterministic local Anthropic-Messages server: the first
// request yields one `bash` tool call, the follow-up request yields a text
// answer. That keeps the run offline and free of credentials while still
// driving the real agent loop, the real session event bus and the real tool
// projection. Boundaries that this test does NOT cover:
//
//   * no paid/production model and no user profile is touched (isolated
//     DSH_HOME, fake API key);
//   * the Qt process runs the `session-live` self-test mode (offscreen, trace
//     file) rather than the full interactive QML shell; the shipped QML entry
//     point is covered separately by `tests/host-e2e.e2e.ts`;
//   * no web listener is expected because the headless profile mounts no
//     webserver and the WebUI service is only opened on request.
//
// Run it explicitly: `pnpm exec tsx --test tests/official-profile.e2e.ts`
// (the file deliberately sits outside the `tests/*.test.ts` glob).

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const QT_BINARY = join(REPO_ROOT, 'build', 'dsh-qt-app')
const DSH_BIN = '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
const FAKE_KEY = 'sk-official-profile-fake-key-never-real'
const TOOL_MARKER = 'probe-tool-ok'

interface FakeModel {
  readonly server: Server
  readonly url: string
  readonly calls: number[]
}

function sse(response: import('node:http').ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/**
 * Minimal Anthropic-Messages streaming server. The title request (`thinking`
 * disabled, single human message) gets a fixed title; the first agent request
 * asks for a `bash` tool call; later agent requests answer in text.
 */
async function startFakeModel(): Promise<FakeModel> {
  const calls: number[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      if (request.url?.includes('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'deepseek-flash', type: 'model' }] }))
        return
      }
      const payload = JSON.parse(body || '{}') as {
        messages?: unknown[]
        thinking?: { type?: string }
      }
      const isTitle =
        payload.thinking?.type === 'disabled' && Array.isArray(payload.messages) && payload.messages.length === 1
      const agentCalls = calls.push(Date.now())
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      sse(response, 'message_start', {
        type: 'message_start',
        message: {
          id: `msg_fake_${agentCalls}`,
          type: 'message',
          role: 'assistant',
          model: 'deepseek-flash',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      })
      if (isTitle) {
        sse(response, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })
        sse(response, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'probe title' },
        })
        sse(response, 'content_block_stop', { type: 'content_block_stop', index: 0 })
        sse(response, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 },
        })
        sse(response, 'message_stop', { type: 'message_stop' })
        response.end()
        return
      }
      if (calls.length === 1) {
        sse(response, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_probe_1', name: 'bash', input: {} },
        })
        sse(response, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ command: `echo ${TOOL_MARKER}`, description: 'probe tool' }),
          },
        })
        sse(response, 'content_block_stop', { type: 'content_block_stop', index: 0 })
        sse(response, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 4 },
        })
        sse(response, 'message_stop', { type: 'message_stop' })
        response.end()
        return
      }
      sse(response, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
      sse(response, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'fake hello' },
      })
      sse(response, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(response, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
      })
      sse(response, 'message_stop', { type: 'message_stop' })
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, calls }
}

function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  onSpawn?: (pid: number) => void,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    if (child.pid !== undefined) onSpawn?.(child.pid)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
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

/** Listening TCP ports owned by `pid`, read from /proc (Linux only). */
function listeningPortsOf(pid: number): number[] {
  const inodes = new Set<string>()
  const proc = '/proc'
  if (!existsSync(proc)) return []
  try {
    for (const fd of readdirSync(join(proc, String(pid), 'fd'))) {
      try {
        const link = readlinkSync(join(proc, String(pid), 'fd', fd))
        const match = /^socket:\[(\d+)\]$/.exec(link)
        if (match) inodes.add(match[1] ?? '')
      } catch {
        // fd raced with process teardown
      }
    }
  } catch {
    return []
  }
  const ports: number[] = []
  for (const table of ['tcp', 'tcp6']) {
    const path = join(proc, 'net', table)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/)
      if (columns.length < 10) continue
      // 0A = LISTEN; columns[9] is the socket inode.
      if (columns[3] !== '0A' || !inodes.has(columns[9] ?? '')) continue
      const port = Number.parseInt((columns[1] ?? '').split(':').pop() ?? '', 16)
      if (Number.isFinite(port)) ports.push(port)
    }
  }
  return ports
}

let home = ''
let fake: FakeModel
let patchPath = ''

before(async () => {
  assert.ok(existsSync(QT_BINARY), `missing ${QT_BINARY}; build with cmake --build build`)
  fake = await startFakeModel()
  home = mkdtempSync(join(tmpdir(), 'dsh-qt-profile-'))
  const install = await runProcess(
    process.execPath,
    [DSH_BIN, 'plugin', '--profile', 'headless', 'add', REPO_ROOT],
    { ...process.env, DSH_HOME: home },
    120_000,
  )
  assert.equal(install.code, 0, `plugin add failed: ${install.stderr}`)
  patchPath = join(home, 'qt.patch.yml')
  // `insert` without an id appends a top-level loader entry (see
  // dsh-app-boot/lib/index.js applyPatches).
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    patchPath,
    ["- insert:", "    - id: dsh-qt-app", "      name: '@deepseek-ai/dsh-qt-app'", ''].join('\n'),
  )
})

after(() => {
  fake.server.close()
})

test('a real headless profile drives the real Qt process and tool projection', { timeout: 180_000 }, async () => {
  const tracePath = join(home, 'qt-trace.log')
  const observedPorts = new Set<number>()
  const result = await runProcess(
    process.execPath,
    [DSH_BIN, '--profile', 'headless', '--patch', patchPath, '--approval-policy', 'never', '--json', 'say hi'],
    {
      ...process.env,
      DSH_HOME: home,
      DEEPSEEK_BASE_URL: fake.url,
      DEEPSEEK_API_KEY: FAKE_KEY,
      DSH_QT_APP_BINARY: QT_BINARY,
      DSH_QT_HOST_SELFTEST: 'session-live',
      DSH_QT_SESSION_LINGER_MS: '4000',
      DSH_QT_SESSION_TRACE: tracePath,
      QT_QPA_PLATFORM: 'offscreen',
    },
    150_000,
    (pid) => {
      // Sample the profile process for listening sockets while it runs: the
      // WebUI service must stay Idle, so no port may appear at any moment.
      const timer = setInterval(() => {
        for (const port of listeningPortsOf(pid)) observedPorts.add(port)
      }, 150)
      timer.unref()
    },
  )

  assert.equal(result.timedOut, false, 'profile run timed out')
  assert.equal(result.code, 0, `profile run failed: ${result.stderr.slice(-2000)}`)

  // 1. The real official agent loop produced the deterministic answer.
  const records = result.stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
  const session = records.find((record) => record.type === 'session')
  const final = records.find((record) => record.type === 'final')
  assert.ok(session, `no session record in stdout: ${result.stdout.slice(0, 1000)}`)
  assert.ok(final, `no final record in stdout: ${result.stdout.slice(0, 1000)}`)
  assert.equal(final.text, 'fake hello')
  const sessionId = String(session.sessionId)
  assert.ok(sessionId.startsWith('session-'))

  // 2. The model really received a tool-use turn and the follow-up, so the
  //    tool call came from the agent loop rather than from a stub.
  assert.ok(fake.calls.length >= 2, `model saw ${fake.calls.length} agent request(s)`)

  // 3. The Qt process spawned by this plugin completed the v1 handshake.
  assert.ok(existsSync(tracePath), `missing Qt trace at ${tracePath}`)
  const trace = readFileSync(tracePath, 'utf8')
  assert.match(trace, /^state=connecting$/m)
  assert.match(trace, /^state=connected$/m)

  // 4. The tool call crossed the bridge as a `tool.row` event carrying the
  //    live session key, the bash row and both terminal states.
  const eventLines = trace.split('\n').filter((line) => line.startsWith('evt name='))
  assert.ok(eventLines.length >= 1, `no bridge events reached Qt:\n${trace}`)
  const toolRows = eventLines.filter((line) => line.includes('evt name=tool.row payload='))
  assert.ok(toolRows.length >= 2, `expected running+ok pushes, saw ${toolRows.length}:\n${trace}`)
  const payloads = toolRows.map((line) => JSON.parse(line.slice(line.indexOf('payload=') + 'payload='.length))[0] as {
    sessionKey: string
    epoch: string
    rows: Array<{ name: string; state: string; callId: string }>
  })
  for (const payload of payloads) {
    assert.equal(payload.sessionKey, sessionId)
    assert.ok(payload.epoch.length > 0)
    assert.equal(payload.rows[0]?.name, 'bash')
    assert.equal(payload.rows[0]?.callId, 'toolu_probe_1')
  }
  assert.deepEqual(
    payloads.map((payload) => payload.rows[0]?.state),
    ['running', 'ok'],
  )

  // 5. Default posture: the headless profile plus this plugin listen on no TCP
  //    port. (The plugin mounts a WebUI service, but it stays Idle until a
  //    `webui.open` request arrives.)
  assert.deepEqual([...observedPorts], [])
  assert.equal(result.stderr.includes('LEAK'), false, 'token sentinel leaked through the bridge')
  assert.equal(result.stderr.includes('sk-'), false, `credential-looking text in stderr: ${result.stderr.slice(-500)}`)
})