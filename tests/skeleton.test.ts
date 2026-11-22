/**
 * Skeleton smoke tests for the Phase 1a package layout.
 *
 * These assert the contract that later phases build on: the Cordis plugin
 * shape, the 10 ms event-loop budget, and the native slot-surface list. They
 * also prove that the test pipeline (tsx + node:test) is wired up.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import plugin, { apply, inject, name } from '../src/index.js'
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  EVENT_LOOP_TICK_MS,
  NATIVE_SLOT_SURFACES,
  PLUGIN_NAME,
  QML_ENTRY_URL,
  isNativeSlotSurface,
} from '../src/constants.js'

test('plugin exports a Cordis-compatible shape', () => {
  assert.equal(name, PLUGIN_NAME)
  assert.equal(typeof apply, 'function')
  assert.ok(Array.isArray(inject))
  assert.equal(plugin.name, PLUGIN_NAME)
  assert.equal(plugin.apply, apply)
})

test('event-loop tick matches the 10 ms budget', () => {
  assert.equal(EVENT_LOOP_TICK_MS, 10)
})

test('main window defaults match the design (1280x800)', () => {
  assert.equal(DEFAULT_WINDOW_WIDTH, 1280)
  assert.equal(DEFAULT_WINDOW_HEIGHT, 800)
})

test('QML entry points at the Qt resource registered by CMake', () => {
  assert.equal(QML_ENTRY_URL, 'qrc:/qml/main.qml')
})

test('slot surface guard separates native surfaces from WebView fallbacks', () => {
  assert.ok(NATIVE_SLOT_SURFACES.length > 0)
  assert.equal(isNativeSlotSurface('conversation.chat.flow'), true)
  assert.equal(isNativeSlotSurface('conversation.message.image'), false)
})
