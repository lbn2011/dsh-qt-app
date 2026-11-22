// Settings slot surfaces are declared in three places on purpose:
//
//   src/constants.ts   the protocol whitelist (NATIVE_SLOT_SURFACES)
//   src/index.ts        the plugin-facing export plugins read to discover them
//   qml/views/settings  what the panel actually hosts
//
// Duplication across the TS/QML boundary cannot be removed (QML cannot import a
// TS module), so this suite pins the copies together. Without it, adding a
// surface on one side and forgetting the other is a silent no-op: the panel would
// simply never receive contributions for the surface a plugin was told to use.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  NATIVE_SLOT_SURFACES,
  SETTINGS_SLOT_SURFACES,
  isNativeSlotSurface,
} from '../src/constants.js'
import { SETTINGS_SLOT_SURFACES as EXPORTED_SETTINGS_SURFACES } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const sourceRoot = join(packageRoot, 'src')
const qmlRoot = join(packageRoot, 'qml')

function readSource(...segments: string[]): string {
  return readFileSync(join(sourceRoot, ...segments), 'utf8')
}

function readQml(...segments: string[]): string {
  return readFileSync(join(qmlRoot, ...segments), 'utf8')
}

/** Every double-quoted surface id in a `name: [ "a", "b" ]` QML declaration. */
function qmlSurfaceList(source: string, property: string): string[] {
  const declaration = new RegExp(`${property}\\s*:\\s*\\[([\\s\\S]*?)\\]`).exec(source)
  assert.ok(declaration !== null, `could not find ${property} in the QML source`)
  const ids = [...declaration[1]!.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!)
  return ids
}

test('the plugin-facing export matches the protocol whitelist', () => {
  assert.deepEqual([...EXPORTED_SETTINGS_SURFACES], [...SETTINGS_SLOT_SURFACES])
})

test('every settings surface is a declared native surface', () => {
  for (const surface of SETTINGS_SLOT_SURFACES) {
    assert.ok(
      (NATIVE_SLOT_SURFACES as readonly string[]).includes(surface),
      `${surface} is missing from NATIVE_SLOT_SURFACES`,
    )
    assert.equal(isNativeSlotSurface(surface), true)
  }
})

test('the whitelist has no duplicates', () => {
  assert.equal(new Set(NATIVE_SLOT_SURFACES).size, NATIVE_SLOT_SURFACES.length)
})

test('the plugin entry documents the settings surfaces', () => {
  const source = readSource('index.ts')
  for (const surface of SETTINGS_SLOT_SURFACES)
    assert.ok(source.includes(surface), `src/index.ts does not mention ${surface}`)
})

test('the settings panel hosts exactly the declared surfaces', () => {
  const panel = readQml('views', 'settings', 'SettingsPanel.qml')
  assert.deepEqual(qmlSurfaceList(panel, 'acceptedSurfaces'), [...SETTINGS_SLOT_SURFACES])
})

test('the panel filters contributions by the declared surface names', () => {
  const panel = readQml('views', 'settings', 'SettingsPanel.qml')
  for (const surface of SETTINGS_SLOT_SURFACES)
    assert.ok(panel.includes(`"${surface}"`), `SettingsPanel.qml does not handle ${surface}`)
})

test('the plugins tab advertises the same surfaces to the user', () => {
  const plugins = readQml('views', 'settings', 'PluginsSettings.qml')
  assert.deepEqual(qmlSurfaceList(plugins, 'acceptedSurfaces'), [...SETTINGS_SLOT_SURFACES])
})

test('the session header can ask for the settings panel', () => {
  const header = readQml('components', 'SessionHeader.qml')
  assert.match(header, /signal\s+settingsRequested\s*\(/)
  assert.match(header, /objectName:\s*"sessionSettingsButton"/)
  assert.match(header, /onClicked:\s*header\.settingsRequested\(\)/)
})

test('the chat view re-emits the header request', () => {
  const chatView = readQml('views', 'ChatView.qml')
  assert.match(chatView, /signal\s+settingsRequested\s*\(/)
  assert.match(chatView, /onSettingsRequested:\s*chatView\.settingsRequested\(\)/)
})
