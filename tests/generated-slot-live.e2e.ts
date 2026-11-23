/**
 * End-to-end proof for t32 acceptance ④: a real Qt process renders a converted
 * slot, performs a gesture, and shows the re-rendered tree produced after the
 * Node side handled the action.
 *
 * Both halves are real: the binary is the shipped executable loading the
 * shipped `GeneratedView`/`GeneratedNode`, and `ui.render` / `ui.action` are
 * served by a real `PluginService`. The fixture supplies only the plugin
 * callback (its natural job); the bridge, registry mirror and converter all run
 * in production form.
 *
 * Not part of `pnpm test`; run after a build:
 * `pnpm exec tsx --test tests/generated-slot-live.e2e.ts`.
 */
import assert from 'node:assert/strict'
import { appendFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { HostBridgeService } from '../src/host/bridge-service.js'
import { HostTransport } from '../src/host/transport.js'
import { createPluginService } from '../src/plugins/service.js'
import type { PluginManagerPort } from '../src/plugins/service.js'
import { createSlotRegistry } from '../src/plugins/slot-contract.js'
import { mirrorRendererSlots } from '../src/plugins/slot-bridge.js'
import type { QtSlotContribution } from '../src/types.js'

const root = resolve(import.meta.dirname, '..')
const binary = join(root, 'build', process.platform === 'win32' ? 'dsh-qt-app.exe' : 'dsh-qt-app')
const harness = join(root, 'tests', 'fixtures', 'generated-slot-harness.qml')
const skip = !existsSync(binary) ? `no Qt binary at ${binary}; run cmake --build build first`
  : !existsSync(harness) ? `no harness at ${harness}` : false

test(
  'a generated slot renders, clicks, and re-renders through the real bridge',
  { skip, timeout: 90_000 },
  async () => {
    const host = new HostBridgeService(new Context(), { autoLaunch: false, handshakeTimeoutMs: 10_000 })
    host.onStateChange(() => {})

    // The fixture is the plugin: its render callback is the only fake part.
    const renderer = {
      slots: new Map<string, QtSlotContribution>(),
      subscribeSlots: () => () => {},
      change: (): void => {},
    }
    renderer.slots.set('conversation.settings.form:fixture.slot', {
      surface: 'conversation.settings.form',
      id: 'fixture.slot',
      label: 'Fixture slot',
      render: (props) => ({
        type: 'button',
        props: { onClick: 'fixture-click' },
        children: [`Count ${String(props['count'] ?? 0)}`],
      }),
      action: (_event, _payload, props) => ({ count: Number(props['count'] ?? 0) + 1 }),
    })

    const registry = createSlotRegistry()
    const detachSlots = mirrorRendererSlots(renderer, registry)
    const plugins = createPluginService({
      manager: {} as PluginManagerPort,
      host,
      slots: registry,
    })
    plugins.attach()

    const child = spawn(binary, [], {
      cwd: root,
      env: {
        ...process.env,
        DSH_QT_QML_ENTRY: harness,
        QT_QPA_PLATFORM: process.platform === 'win32' ? 'windows' : 'offscreen',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    assert.ok(child.stdout !== null && child.stdin !== null && child.stderr !== null)

    const stderr: string[] = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      appendFileSync('/tmp/harness-stderr.log', chunk)
      for (const line of chunk.split(/\r?\n/)) if (line.trim() !== '') stderr.push(line)
    })
    child.on('exit', (code, signal) => { appendFileSync('/tmp/harness-stderr.log', `\n[exit] ${String(code)} ${String(signal)}\n`) })
    child.on('error', (error) => { appendFileSync('/tmp/harness-stderr.log', `\n[error] ${error.message}\n`) })

    const transport = new HostTransport({ input: child.stdout, output: child.stdin })
    host.attach({ transport, child })

    const { code } = await new Promise<{ code: number | null }>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill()
        rejectExit(new Error(`the Qt host did not exit; stderr:\n${stderr.join('\n')}`))
      }, 60_000)
      child.once('exit', (exitCode) => {
        clearTimeout(timer)
        resolveExit({ code: exitCode })
      })
    })

    detachSlots()
    plugins.dispose()

    const output = stderr.join('\n')
    assert.match(output, /\[harness\] render status=native/u)
    assert.match(output, /\[harness\] clicking label=Count 0/u)
    assert.match(output, /\[harness\] rerender status=native label=Count 1/u)
    assert.equal(code, 0, `harness exited ${String(code)}; stderr:\n${output}`)
  },
)
