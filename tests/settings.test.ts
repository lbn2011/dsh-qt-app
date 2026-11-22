// Tests for the settings schema, its persistence layer and the store.
//
// The suite is organised the way the task's acceptance criteria are, so a
// failure points at a claim rather than at a helper:
//
//   1. the catalogue describes itself coherently
//   2. values are validated strictly, never coerced
//   3. defaults are what a fresh install sees
//   4. the file format round-trips, migrates, and survives corruption
//   5. the store gets, sets, watches and isolates listener failures
//
// Nothing here touches the real user config directory: every store is given a
// MemorySettingsStorage or an explicit temp dir, so running the suite twice on
// the same machine cannot pass or fail differently.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  BUILTIN_SETTINGS,
  DEFAULT_SETTINGS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  SETTINGS_SECTIONS,
  THEME_MODES,
  defaultSettings,
  getSettingSchema,
  settingNames,
  settingsInSection,
  validateSchemaSet,
  validateSettingValue,
  validateSettings
} from '../src/settings/schema.js'
import type { SettingsSchema, SettingValue } from '../src/settings/schema.js'
import {
  SETTINGS_FILE_NAME,
  SETTINGS_FILE_VERSION,
  MemorySettingsStorage,
  createFileSettingsStorage,
  migratePersistedSettings,
  parsePersistedSettings,
  resolveSettingsDirectory,
  resolveSettingsPaths,
  serialisePersistedSettings
} from '../src/settings/paths.js'
import {
  SettingValidationError,
  SettingsStore,
  UnknownSettingError,
  createSettingsStore
} from '../src/settings/store.js'
import type { SettingsChange } from '../src/settings/store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A store over in-memory storage, with no logger noise. */
function newStore(initial: string | null = null, options: { autoSave?: boolean } = {}) {
  const storage = new MemorySettingsStorage(initial)
  const store = new SettingsStore({ storage, ...options })
  return { store, storage }
}

/** A throwaway directory that is removed when `fn` returns. */
function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qt-settings-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A logger that records the messages it was given. */
function recorder() {
  const warnings: string[] = []
  return {
    warnings,
    logger: {
      warn(message: string): void {
        warnings.push(message)
      }
    }
  }
}

/** Minimal valid envelope around a value map. */
function envelope(values: Record<string, unknown>, schemaVersion = SETTINGS_FILE_VERSION): string {
  return `${JSON.stringify({ schemaVersion, values }, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// 1. The catalogue is coherent
// ---------------------------------------------------------------------------

test('the built-in schema describes itself consistently', () => {
  assert.deepEqual(validateSchemaSet(), [])
})

test('every schema entry carries the fields the contract promises', () => {
  for (const entry of BUILTIN_SETTINGS) {
    assert.equal(typeof entry.name, 'string')
    assert.ok(entry.name.length > 0)
    assert.ok(['string', 'number', 'boolean'].includes(entry.type))
    assert.ok(['select', 'slider', 'toggle', 'text', 'number'].includes(entry.ui.type))
    assert.equal(typeof entry.description, 'string')
    assert.ok(SETTINGS_SECTIONS.includes(entry.section as (typeof SETTINGS_SECTIONS)[number]))
  }
})

test('the four settings named by the contract exist with the documented types', () => {
  // theme / fontSize / language / hideSystemMessages are called out explicitly.
  assert.equal(getSettingSchema('theme')?.type, 'string')
  assert.equal(getSettingSchema('theme')?.ui.type, 'select')
  assert.equal(getSettingSchema('fontSize')?.type, 'number')
  assert.equal(getSettingSchema('fontSize')?.ui.type, 'slider')
  assert.equal(getSettingSchema('language')?.type, 'string')
  assert.equal(getSettingSchema('language')?.ui.type, 'select')
  assert.equal(getSettingSchema('hideSystemMessages')?.type, 'boolean')
  assert.equal(getSettingSchema('hideSystemMessages')?.ui.type, 'toggle')
})

test('select entries enumerate their whole value space', () => {
  const theme = getSettingSchema('theme')
  assert.ok(theme?.options)
  const values = theme.options.map((option) => option.value)
  assert.deepEqual(values, [...THEME_MODES])
  for (const option of theme.options) assert.equal(typeof option.label, 'string')

  for (const entry of BUILTIN_SETTINGS) {
    if (entry.ui.type !== 'select') continue
    assert.ok((entry.options?.length ?? 0) > 0, `${entry.name} needs options`)
  }
})

test('font bounds match the C++ theme bridge', () => {
  const fontSize = getSettingSchema('fontSize')
  assert.equal(fontSize?.minimum, MIN_FONT_SIZE)
  assert.equal(fontSize?.maximum, MAX_FONT_SIZE)
  // native/main.cpp clamps to 0.8 … 1.5; the schema must not disagree.
  assert.equal(MIN_FONT_SIZE, 0.8)
  assert.equal(MAX_FONT_SIZE, 1.5)
})

test('names are unique and settingsInSection orders by ui.order', () => {
  const names = settingNames()
  assert.equal(new Set(names).size, names.length)

  const appearance = settingsInSection('appearance')
  assert.ok(appearance.length >= 3)
  const orders = appearance.map((entry) => entry.ui.order ?? 0)
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b))
  assert.deepEqual(settingsInSection('nonexistent'), [])
})

test('validateSchemaSet catches a malformed catalogue', () => {
  const broken: SettingsSchema[] = [
    { ...BUILTIN_SETTINGS[0]!, name: '' },
    {
      name: 'dupe',
      type: 'number',
      default: 5,
      minimum: 10,
      maximum: 1,
      ui: { type: 'number' },
      section: 'advanced',
      description: 'bounds inverted'
    },
    {
      name: 'dupe',
      type: 'string',
      default: 'x',
      ui: { type: 'select' },
      section: 'advanced',
      description: 'select without options'
    }
  ]
  const problems = validateSchemaSet(broken)
  const paths = problems.map((problem) => problem.path)
  assert.ok(paths.includes(''))
  assert.ok(paths.includes('dupe'))
  assert.ok(problems.some((problem) => problem.message.includes('minimum is greater')))
  assert.ok(problems.some((problem) => problem.message.includes('select control needs options')))
})

// ---------------------------------------------------------------------------
// 2. Validation is strict
// ---------------------------------------------------------------------------

test('validateSettingValue accepts legal values and rejects wrong types', () => {
  const fontSize = getSettingSchema('fontSize')!
  assert.equal(validateSettingValue(fontSize, 1).ok, true)
  assert.equal(validateSettingValue(fontSize, 1.25).ok, true)

  for (const bad of ['1.5', null, undefined, true, {}, []]) {
    const result = validateSettingValue(fontSize, bad)
    assert.equal(result.ok, false, `should reject ${JSON.stringify(bad)}`)
    if (!result.ok) assert.equal(result.issue.reason, 'wrong-type')
  }
})

test('numbers are checked against bounds, finiteness and step', () => {
  const fontSize = getSettingSchema('fontSize')!

  const below = validateSettingValue(fontSize, 0.5)
  assert.equal(below.ok, false)
  if (!below.ok) assert.equal(below.issue.reason, 'below-minimum')

  const above = validateSettingValue(fontSize, 2)
  assert.equal(above.ok, false)
  if (!above.ok) assert.equal(above.issue.reason, 'above-maximum')

  for (const infinite of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = validateSettingValue(fontSize, infinite)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.issue.reason, 'not-finite')
  }

  const offStep = validateSettingValue(fontSize, 1.07)
  assert.equal(offStep.ok, false)
  if (!offStep.ok) assert.equal(offStep.issue.reason, 'not-on-step')

  // 0.05 * 21 = 1.0500000000000003 in binary; dust must not fail the check.
  assert.equal(validateSettingValue(fontSize, 1.05).ok, true)
})

test('select values must be one of the declared options', () => {
  const theme = getSettingSchema('theme')!
  assert.equal(validateSettingValue(theme, 'dark').ok, true)

  const bogus = validateSettingValue(theme, 'sepia')
  assert.equal(bogus.ok, false)
  if (!bogus.ok) {
    assert.equal(bogus.issue.reason, 'not-an-option')
    assert.match(bogus.issue.message, /auto/)
    assert.match(bogus.issue.message, /dark/)
    assert.match(bogus.issue.message, /light/)
  }
})

test('string length bounds are enforced', () => {
  const family = getSettingSchema('codeFontFamily')!
  assert.equal(validateSettingValue(family, 'monospace').ok, true)

  const empty = validateSettingValue(family, '')
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.equal(empty.issue.reason, 'too-short')

  const long = validateSettingValue(family, 'x'.repeat(200))
  assert.equal(long.ok, false)
  if (!long.ok) assert.equal(long.issue.reason, 'too-long')
})

test('booleans are booleans, not truthy strings', () => {
  const hide = getSettingSchema('hideSystemMessages')!
  assert.equal(validateSettingValue(hide, true).ok, true)
  assert.equal(validateSettingValue(hide, false).ok, true)

  for (const bad of ['true', 1, 0, null]) {
    const result = validateSettingValue(hide, bad)
    assert.equal(result.ok, false)
  }
})

test('validateSettings fills defaults, keeps unknown keys and reports issues', () => {
  const result = validateSettings({
    theme: 'light',
    fontSize: 'huge',
    somethingNew: 42,
    alsoNew: 'kept'
  })

  assert.equal(result.ok, false)
  assert.equal(result.values['theme'], 'light')
  // The bad value degrades to its default instead of poisoning the whole file.
  assert.equal(result.values['fontSize'], 1)
  assert.deepEqual(result.unknown, { somethingNew: 42, alsoNew: 'kept' })
  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0]?.path, 'fontSize')
})

test('validateSettings tolerates non-objects', () => {
  for (const junk of [null, undefined, 42, 'text', [], true]) {
    const result = validateSettings(junk)
    assert.equal(result.ok, true)
    assert.deepEqual(result.values, { ...defaultSettings() })
  }
})

// ---------------------------------------------------------------------------
// 3. Defaults
// ---------------------------------------------------------------------------

test('DEFAULT_SETTINGS covers the schema exactly and validates cleanly', () => {
  const names = settingNames()
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS).sort(), [...names].sort())
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS).issues, [])

  for (const entry of BUILTIN_SETTINGS) {
    assert.equal(DEFAULT_SETTINGS[entry.name], entry.default)
  }
})

test('DEFAULT_SETTINGS is frozen', () => {
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS), true)
  assert.throws(() => {
    // @ts-expect-error — intentional write to a frozen object
    DEFAULT_SETTINGS['theme'] = 'light'
  }, TypeError)
})

test('the shipped settings.json matches the schema defaults', () => {
  // Drift guard: the file is a template users copy, so it must not describe a
  // different set of defaults than the code. Same pattern as the theme JSONs.
  const path = new URL('../src/settings/builtin/settings.json', import.meta.url)
  const parsed = parsePersistedSettings(readFileSync(path, 'utf8'))
  assert.ok(parsed)
  assert.equal(parsed.schemaVersion, SETTINGS_FILE_VERSION)
  assert.deepEqual(parsed.values, { ...defaultSettings() })
})

// ---------------------------------------------------------------------------
// 4. File format, persistence and recovery
// ---------------------------------------------------------------------------

test('the persisted format round-trips with sorted keys', () => {
  const text = serialisePersistedSettings({
    schemaVersion: SETTINGS_FILE_VERSION,
    values: { zeta: 1, alpha: 2, mid: 'x' }
  })
  assert.ok(text.endsWith('\n'))
  assert.deepEqual(Object.keys(JSON.parse(text).values), ['alpha', 'mid', 'zeta'])
  assert.deepEqual(parsePersistedSettings(text), {
    schemaVersion: SETTINGS_FILE_VERSION,
    values: { alpha: 2, mid: 'x', zeta: 1 }
  })
})

test('parsePersistedSettings accepts the unversioned shape as version 0', () => {
  const parsed = parsePersistedSettings('{"theme":"dark","fontSize":1.2}')
  assert.ok(parsed)
  assert.equal(parsed.schemaVersion, 0)
  assert.equal(parsed.values['theme'], 'dark')
})

test('parsePersistedSettings returns null for junk', () => {
  for (const junk of [null, '', '   ', '{', '[]', 'null', '"text"', '42', '{"schemaVersion":1}']) {
    assert.equal(parsePersistedSettings(junk), null, `should reject ${String(junk)}`)
  }
})

test('migration upgrades version 0 and never downgrades a newer file', () => {
  const old = { schemaVersion: 0, values: { theme: 'light' } }
  const upgraded = migratePersistedSettings(old)
  assert.equal(upgraded.migrated, true)
  assert.equal(upgraded.fromFuture, false)
  assert.equal(upgraded.state.schemaVersion, SETTINGS_FILE_VERSION)
  assert.equal(upgraded.state.values['theme'], 'light')

  const current = migratePersistedSettings({ schemaVersion: SETTINGS_FILE_VERSION, values: {} })
  assert.equal(current.migrated, false)
  assert.equal(current.fromFuture, false)

  const future = migratePersistedSettings({ schemaVersion: SETTINGS_FILE_VERSION + 5, values: { a: 1 } })
  assert.equal(future.fromFuture, true)
  assert.equal(future.migrated, false)
  assert.equal(future.state.schemaVersion, SETTINGS_FILE_VERSION + 5)
})

test('resolveSettingsDirectory honours DSH_QT_CONFIG_DIR and the platform root', () => {
  assert.equal(resolveSettingsDirectory({ DSH_QT_CONFIG_DIR: '/tmp/explicit' }), '/tmp/explicit')

  const unix = resolveSettingsDirectory({ XDG_CONFIG_HOME: '/tmp/xdg' })
  if (process.platform === 'linux') assert.equal(unix, '/tmp/xdg/dsh-qt')

  // The default root must agree with the theme store, never a second directory.
  const defaults = resolveSettingsPaths({})
  assert.ok(defaults.file.endsWith(SETTINGS_FILE_NAME))
  assert.equal(defaults.directory, resolveSettingsDirectory({}))
})

test('file storage writes atomically and leaves no temp files behind', () => {
  withTempDir((dir) => {
    const file = join(dir, SETTINGS_FILE_NAME)
    const storage = createFileSettingsStorage(file)

    assert.equal(storage.read(), null)
    storage.write(envelope({ theme: 'dark' }))
    assert.match(storage.read() ?? '', /"theme": "dark"/)
    assert.equal(storage.describe(), file)

    // A directory that does not exist yet is created on demand.
    const nested = createFileSettingsStorage(join(dir, 'a', 'b', SETTINGS_FILE_NAME))
    nested.write(envelope({ theme: 'light' }))
    assert.ok(existsSync(join(dir, 'a', 'b', SETTINGS_FILE_NAME)))

    const leftovers = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((entry) => entry.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  })
})

test('a corrupt file is moved aside and defaults come into force', () => {
  withTempDir((dir) => {
    const file = join(dir, SETTINGS_FILE_NAME)
    writeFileSync(file, '{ this is not json', 'utf8')
    const storage = createFileSettingsStorage(file)
    const { warnings, logger } = recorder()

    const store = new SettingsStore({ storage, logger })
    const result = store.load()

    assert.equal(result.loaded, false)
    assert.equal(result.recovered, true)
    assert.ok(existsSync(`${file}.bak`))
    assert.equal(store.get('theme'), DEFAULT_SETTINGS['theme'])
    assert.ok(warnings.some((line) => line.includes('not valid settings JSON')))
  })
})

test('a missing file is a first run, not an error and not a write', () => {
  const storage = new MemorySettingsStorage(null)
  const store = new SettingsStore({ storage })

  const result = store.load()
  assert.equal(result.loaded, false)
  assert.equal(result.recovered, false)
  assert.deepEqual(result.issues, [])
  assert.equal(storage.writes, 0)
  assert.equal(store.get('theme'), 'auto')
})

test('load applies stored values, preserves unknown keys and migrates once', () => {
  const storage = new MemorySettingsStorage('{"theme":"light","futureKey":7}')
  const { warnings, logger } = recorder()
  const store = new SettingsStore({ storage, logger })

  const result = store.load()
  assert.equal(result.loaded, true)
  assert.equal(result.migrated, true)
  assert.equal(store.get('theme'), 'light')
  assert.equal(store.schemaVersion, SETTINGS_FILE_VERSION)

  // The rewrite happened after the state was applied, so it carries the new
  // value and the preserved unknown key — not the pre-migration defaults.
  const rewritten = parsePersistedSettings(storage.read())
  assert.ok(rewritten)
  assert.equal(rewritten.schemaVersion, SETTINGS_FILE_VERSION)
  assert.equal(rewritten.values['theme'], 'light')
  assert.equal(rewritten.values['futureKey'], 7)
  assert.ok(warnings.some((line) => line.includes('migrated') || line.includes('schemaVersion')))
})

test('a file from a newer build is read but never rewritten', () => {
  const storage = new MemorySettingsStorage(
    envelope({ theme: 'light', brandNew: 'keep me' }, SETTINGS_FILE_VERSION + 3)
  )
  const { warnings, logger } = recorder()
  const store = new SettingsStore({ storage, logger })

  const result = store.load()
  assert.equal(result.fromFuture, true)
  assert.equal(result.migrated, false)
  assert.equal(store.get('theme'), 'light')
  assert.equal(storage.writes, 0, 'a newer file must not be downgraded')
  assert.ok(warnings.some((line) => line.includes('newer build')))
})

test('a rejected stored value falls back to its default and is reported', () => {
  const storage = new MemorySettingsStorage(envelope({ fontSize: 99, theme: 'light' }))
  const { warnings, logger } = recorder()
  const store = new SettingsStore({ storage, logger })

  const result = store.load()
  assert.equal(store.get('fontSize'), 1)
  assert.equal(store.get('theme'), 'light')
  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0]?.path, 'fontSize')
  assert.ok(warnings.some((line) => line.includes('fell back to default')))
})

test('save() persists the live values and reports failure instead of throwing', () => {
  const storage = new MemorySettingsStorage(null)
  const store = new SettingsStore({ storage, autoSave: false })

  store.set('theme', 'light', { persist: false })
  assert.equal(storage.writes, 0)
  assert.equal(store.save(), true)
  assert.equal(storage.writes, 1)

  const broken = {
    read: () => null,
    write: () => {
      throw new Error('read-only filesystem')
    },
    describe: () => '/readonly/settings.json'
  }
  const { warnings, logger } = recorder()
  const failing = new SettingsStore({ storage: broken, logger })
  assert.equal(failing.save(), false)
  assert.equal(failing.lastError, 'read-only filesystem')
  assert.ok(warnings.some((line) => line.includes('could not write')))
  // The value is still live for this session even though the write failed.
  failing.set('theme', 'dark')
  assert.equal(failing.get('theme'), 'dark')
})

// ---------------------------------------------------------------------------
// 5. Store semantics
// ---------------------------------------------------------------------------

test('get returns defaults before load and throws for unknown names', () => {
  const { store } = newStore()
  assert.equal(store.get('theme'), 'auto')
  assert.equal(store.get('fontSize'), 1)
  assert.equal(store.get('hideSystemMessages'), false)

  assert.throws(() => store.get('nope'), UnknownSettingError)
  assert.equal(store.has('theme'), true)
  assert.equal(store.has('nope'), false)
  assert.equal(store.getOr('nope', 'fallback'), 'fallback')
})

test('set persists, notifies once and is a no-op for an unchanged value', () => {
  const { store, storage } = newStore()
  const seen: Array<[SettingValue, SettingValue | undefined]> = []
  store.watch('theme', (value, previous) => seen.push([value, previous]))

  assert.equal(store.set('theme', 'dark'), 'dark')
  assert.equal(store.get('theme'), 'dark')
  assert.equal(storage.writes, 1)
  assert.deepEqual(seen, [['dark', 'auto']])

  // Same value again: no write, no notification, no revision bump.
  const revision = store.revision
  store.set('theme', 'dark')
  assert.equal(storage.writes, 1)
  assert.deepEqual(seen, [['dark', 'auto']])
  assert.equal(store.revision, revision)
})

test('set rejects a bad value without changing the value or the file', () => {
  const { store, storage } = newStore()
  store.set('fontSize', 1.2)
  const writes = storage.writes
  const revision = store.revision

  assert.throws(() => store.set('fontSize', 9), SettingValidationError)
  assert.equal(store.get('fontSize'), 1.2)
  assert.equal(storage.writes, writes)
  assert.equal(store.revision, revision)

  const rejection = store.rejections().find((issue) => issue.path === 'fontSize')
  assert.ok(rejection)
  assert.equal(rejection.reason, 'above-maximum')
})

test('trySet reports failures as values instead of throwing', () => {
  const { store } = newStore()

  const good = store.trySet('theme', 'light')
  assert.equal(good.ok, true)
  if (good.ok) {
    assert.equal(good.value, 'light')
    assert.equal(good.changed, true)
  }

  const unknown = store.trySet('nope', 1)
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.equal(unknown.issue.reason, 'unknown-setting')

  const invalid = store.trySet('fontSize', 'big')
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.issue.reason, 'wrong-type')
})

test('watch notifies only its own key and unsubscribes cleanly', () => {
  const { store } = newStore()
  const themeSeen: SettingValue[] = []
  const fontSizeSeen: SettingValue[] = []

  const offTheme = store.watch('theme', (value) => themeSeen.push(value))
  store.watch('fontSize', (value) => fontSizeSeen.push(value))
  assert.equal(store.listenerCount('theme'), 1)
  assert.equal(store.listenerCount(), 2)

  store.set('theme', 'light')
  store.set('fontSize', 1.25)
  assert.deepEqual(themeSeen, ['light'])
  assert.deepEqual(fontSizeSeen, [1.25])

  offTheme()
  offTheme() // secondary call must be harmless
  store.set('theme', 'dark')
  assert.deepEqual(themeSeen, ['light'])
  assert.equal(store.listenerCount('theme'), 0)
  assert.equal(store.listenerCount('fontSize'), 1)
})

test('watch(immediate) pushes the current value on subscribe', () => {
  const { store } = newStore(envelope({ theme: 'light' }))
  store.load()

  const seen: Array<SettingValue | undefined> = []
  store.watch('theme', (value, previous) => seen.push(previous === undefined ? value : previous), {
    immediate: true
  })
  assert.deepEqual(seen, ['light'])
})

test('a throwing listener cannot break the store or other listeners', () => {
  const { store } = newStore()
  const seen: SettingValue[] = []
  const { warnings, logger } = recorder()
  const loud = new SettingsStore({ storage: new MemorySettingsStorage(null), logger })

  loud.watch('theme', () => {
    throw new Error('listener exploded')
  })
  loud.watch('theme', (value) => seen.push(value))

  assert.equal(loud.set('theme', 'light'), 'light')
  assert.deepEqual(seen, ['light'])
  assert.ok(warnings.some((line) => line.includes('listener for theme threw')))

  // The per-store version used elsethread behaves identically.
  store.watch('theme', () => {
    throw new Error('nope')
  })
  assert.equal(store.set('theme', 'dark'), 'dark')
})

test('watchAll sees every change including the bulk ones', () => {
  const { store } = newStore()
  const changes: SettingsChange[] = []
  store.watchAll((change) => changes.push(change))

  store.set('theme', 'light')
  store.setMany({ fontSize: 1.1, showTimestamps: true })
  store.reset()

  assert.equal(changes[0]?.name, 'theme')
  assert.equal(changes[0]?.persisted, true)
  assert.ok(changes.some((change) => change.name === 'fontSize'))
  // reset() reports a bulk change under '*'.
  assert.equal(changes[changes.length - 1]?.name, '*')
})

test('setMany applies the valid keys, reports the rest and persists once', () => {
  const { store, storage } = newStore()

  const result = store.setMany({ theme: 'light', fontSize: 99, unknownKey: 1 })
  assert.deepEqual(result.applied, ['theme'])
  assert.equal(result.issues.length, 2)
  assert.equal(store.get('theme'), 'light')
  assert.equal(store.get('fontSize'), 1)
  assert.equal(storage.writes, 1)
})

test('reset restores one default or all of them', () => {
  const { store } = newStore()
  store.set('theme', 'light')
  store.set('fontSize', 1.3)

  store.reset('theme')
  assert.equal(store.get('theme'), 'auto')
  assert.equal(store.get('fontSize'), 1.3)

  store.reset()
  assert.equal(store.get('fontSize'), 1)
})

test('all() and unknown() are frozen snapshots', () => {
  const { store } = newStore(envelope({ theme: 'light', extra: 'kept' }))
  store.load()

  const snapshot = store.all()
  assert.equal(snapshot['theme'], 'light')
  assert.equal(Object.isFrozen(snapshot), true)
  assert.deepEqual(store.unknown(), { extra: 'kept' })
})

test('values survive a restart through the same storage', () => {
  const storage = new MemorySettingsStorage(null)

  const first = new SettingsStore({ storage })
  first.load()
  first.set('theme', 'light')
  first.set('fontSize', 1.25)
  first.set('hideSystemMessages', true)

  const second = new SettingsStore({ storage })
  const result = second.load()
  assert.equal(result.loaded, true)
  assert.equal(second.get('theme'), 'light')
  assert.equal(second.get('fontSize'), 1.25)
  assert.equal(second.get('hideSystemMessages'), true)
})

test('a custom schema is honoured by the store', () => {
  const schema: SettingsSchema[] = [
    {
      name: 'beta',
      type: 'boolean',
      default: true,
      ui: { type: 'toggle' },
      section: 'advanced',
      description: 'testing a smaller catalogue'
    }
  ]
  const store = createSettingsStore({ schema, storage: new MemorySettingsStorage(null) })

  assert.deepEqual(store.names(), ['beta'])
  assert.equal(store.get('beta'), true)
  assert.throws(() => store.get('theme'), UnknownSettingError, 'built-ins are not in this catalogue')
})

test('the store accepts a temp config directory end to end', () => {
  withTempDir((dir) => {
    const store = new SettingsStore({ configDir: dir })
    store.load()
    store.set('theme', 'light')

    const onDisk = JSON.parse(readFileSync(join(dir, SETTINGS_FILE_NAME), 'utf8')) as {
      schemaVersion: number
      values: Record<string, unknown>
    }
    assert.equal(onDisk.schemaVersion, SETTINGS_FILE_VERSION)
    assert.equal(onDisk.values['theme'], 'light')

    const reopened = new SettingsStore({ configDir: dir })
    reopened.load()
    assert.equal(reopened.get('theme'), 'light')
  })
})

test('transient settings are never written', () => {
  const schema: SettingsSchema[] = [
    { ...BUILTIN_SETTINGS[0]!, name: 'volatile', transient: true },
    BUILTIN_SETTINGS[1]!
  ]
  const storage = new MemorySettingsStorage(null)
  const store = new SettingsStore({ schema, storage })

  // A concrete value first, so the file exists and the assertion below is about
  // the transient key rather than about the file being absent.
  store.set('fontSize', 1.1)
  store.set('volatile', 'light')

  const persisted = parsePersistedSettings(storage.read())
  assert.ok(persisted)
  assert.equal(persisted.values['volatile'], undefined)
})
