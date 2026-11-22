// tests/settings-forms.test.ts — the settings form layer.
//
// Four things are pinned here:
//
//   1. **The descriptor contract.** `SettingsForm.qml` reads `field.minimum`
//      unconditionally, so every descriptor must carry every key — a missing one
//      would render as `undefined` and quietly disable a bound.
//   2. **The catalogue round trip.** Every built-in setting must survive
//      describe → coerce → validate unchanged, and the example forms shipped in
//      QML must name settings that actually exist.
//   3. **The slot contract.** A plugin contribution is either accepted whole or
//      refused with per-field issues; a half-accepted contribution would render
//      a broken tab.
//   4. **The bridge.** A QML-side write must reach the store *and* the file, and
//      a refused write must come back as `false` rather than throwing.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  BUILTIN_SETTINGS,
  MemorySettingsStorage,
  SETTINGS_FORM_SURFACE,
  SETTINGS_SECTION_SURFACE,
  SETTINGS_SECTIONS,
  SettingsSlotRegistry,
  SettingsStore,
  coerceFieldInput,
  createInMemorySettingsBridge,
  createSettingsQmlBridge,
  createSettingsSlotRegistry,
  DEFAULT_FORM_SECTION,
  describeSetting,
  formatFieldDisplay,
  humaniseSection,
  humaniseSettingName,
  isRenderableUiType,
  isSettingColor,
  normaliseFieldInput,
  normaliseSettingsSlotContribution,
  optionIndexOf,
  settingsFieldDescriptors,
  settingsFormFields,
  settingsFormSections,
  usesGeneratedForm,
  validateSchemaSet,
  type SettingsSchema
} from '../src/settings/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SETTINGS_QML_DIR = join(HERE, '..', 'qml', 'views', 'settings')

/** Descriptor keys the QML controls read. */
const DESCRIPTOR_KEYS = [
  'name',
  'label',
  'description',
  'section',
  'valueType',
  'uiType',
  'value',
  'defaultValue',
  'options',
  'placeholder',
  'unit',
  'minimum',
  'maximum',
  'step',
  'minLength',
  'maxLength',
  'requiresRestart',
  'transient',
  'order'
]

function schemaNamed(name: string): SettingsSchema {
  const entry = BUILTIN_SETTINGS.find((candidate) => candidate.name === name)
  assert.ok(entry !== undefined, `expected a built-in setting named ${name}`)
  return entry
}

function colourEntry(): SettingsSchema {
  return {
    name: 'accentColour',
    type: 'string',
    default: '#4c8dff',
    section: 'appearance',
    description: 'Accent colour used by the native shell.',
    ui: { type: 'color' }
  }
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

test('every descriptor carries every key the QML controls read', () => {
  for (const entry of BUILTIN_SETTINGS) {
    const descriptor = describeSetting(entry)
    for (const key of DESCRIPTOR_KEYS) {
      assert.ok(
        Object.hasOwn(descriptor, key),
        `${entry.name} descriptor is missing ${key}`
      )
    }
    // Scalar slots are null, never undefined: QML tests `!== null`.
    for (const key of ['minimum', 'maximum', 'step', 'minLength', 'maxLength']) {
      const value = (descriptor as unknown as Record<string, unknown>)[key]
      assert.ok(value === null || typeof value === 'number', `${entry.name}.${key} must be number|null`)
    }
  }
})

test('descriptor mirrors the catalogue entry it came from', () => {
  const fontSize = schemaNamed('fontSize')
  const descriptor = describeSetting(fontSize, 1.25)

  assert.equal(descriptor.name, 'fontSize')
  assert.equal(descriptor.valueType, 'number')
  assert.equal(descriptor.uiType, 'slider')
  assert.equal(descriptor.value, 1.25)
  assert.equal(descriptor.defaultValue, fontSize.default)
  assert.equal(descriptor.minimum, 0.8)
  assert.equal(descriptor.maximum, 1.5)
  assert.equal(descriptor.step, 0.05)
  assert.equal(descriptor.section, 'appearance')
  assert.equal(descriptor.label, 'Font scale')
})

test('a descriptor with no explicit value falls back to the catalogue default', () => {
  const descriptor = describeSetting(schemaNamed('theme'))
  assert.equal(descriptor.value, 'auto')
  assert.equal(descriptor.options.length, 3)
  assert.deepEqual(
    descriptor.options.map((option) => option.value),
    ['auto', 'dark', 'light']
  )
})

test('options are flattened to plain objects with a description key', () => {
  const descriptor = describeSetting(schemaNamed('theme'))
  for (const option of descriptor.options) {
    assert.deepEqual(Object.keys(option).sort(), ['description', 'label', 'value'])
    assert.equal(typeof option.description, 'string')
  }
  // A non-select entry has an empty array, not undefined.
  assert.deepEqual(describeSetting(schemaNamed('fontSize')).options, [])
})

test('labels default to a humanised name and never come out empty', () => {
  const entry: SettingsSchema = {
    name: 'hideSystemMessages',
    type: 'boolean',
    default: false,
    section: 'messages',
    description: 'x',
    ui: { type: 'toggle' }
  }
  assert.equal(describeSetting(entry).label, 'Hide system messages')
  assert.equal(humaniseSettingName('fontSize'), 'Font size')
  assert.equal(humaniseSettingName('a'), 'A')
  assert.equal(humaniseSettingName(''), '')
  assert.equal(humaniseSection('appearance'), 'Appearance')
})

test('settingsFieldDescriptors keeps catalogue order and honours overrides', () => {
  const descriptors = settingsFieldDescriptors(BUILTIN_SETTINGS, { fontSize: 1.3 })
  assert.equal(descriptors.length, BUILTIN_SETTINGS.length)
  assert.deepEqual(
    descriptors.map((field) => field.name),
    BUILTIN_SETTINGS.map((entry) => entry.name)
  )
  const fontSize = descriptors.find((field) => field.name === 'fontSize')
  assert.equal(fontSize?.value, 1.3)
})

test('settingsFormSections groups by section and drops empty sections', () => {
  const sections = settingsFormSections()
  assert.ok(sections.length > 0)
  for (const section of sections) {
    assert.ok(section.fields.length > 0, `${section.section} should not be empty`)
    assert.equal(section.title, humaniseSection(section.section))
    for (const field of section.fields) assert.equal(field.section, section.section)
  }
  const ids = sections.map((section) => section.section)
  // Every group is a known section and the order follows SETTINGS_SECTIONS.
  for (const id of ids) assert.ok((SETTINGS_SECTIONS as readonly string[]).includes(id))
  const positions = ids.map((id) => (SETTINGS_SECTIONS as readonly string[]).indexOf(id))
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right))
})

test('a plugin section name survives grouping instead of being dropped', () => {
  const pluginEntry: SettingsSchema = {
    name: 'telemetryOptIn',
    type: 'boolean',
    default: false,
    section: 'telemetry',
    description: 'Share anonymous usage counters.',
    ui: { type: 'toggle' }
  }
  const sections = settingsFormSections([...BUILTIN_SETTINGS, pluginEntry])
  const telemetry = sections.find((section) => section.section === 'telemetry')
  assert.ok(telemetry !== undefined, 'plugin section must get its own group')
  assert.equal(telemetry.fields[0]?.name, 'telemetryOptIn')
  // Built-in sections keep their lead positions.
  assert.equal(sections[0]?.section, SETTINGS_SECTIONS[0])
})

// ---------------------------------------------------------------------------
// Coercion and validation
// ---------------------------------------------------------------------------

test('coerceFieldInput converts text input only when the target type allows it', () => {
  const numberField = describeSetting(schemaNamed('fontSize'))
  const boolField = describeSetting(schemaNamed('hideSystemMessages'))
  const stringField = describeSetting(schemaNamed('language'))

  assert.equal(coerceFieldInput(numberField, '1.25'), 1.25)
  assert.equal(coerceFieldInput(numberField, 1.25), 1.25)
  assert.equal(coerceFieldInput(numberField, '  '), null)
  assert.equal(coerceFieldInput(numberField, 'abc'), null)
  assert.equal(coerceFieldInput(numberField, null), null)

  assert.equal(coerceFieldInput(boolField, 'true'), true)
  assert.equal(coerceFieldInput(boolField, 'FALSE'), false)
  assert.equal(coerceFieldInput(boolField, 'maybe'), null)
  assert.equal(coerceFieldInput(boolField, 1), true)

  assert.equal(coerceFieldInput(stringField, 'en'), 'en')
  assert.equal(coerceFieldInput(stringField, 42), '42')
})

test('normaliseFieldInput refuses values the store would refuse', () => {
  const fontSize = schemaNamed('fontSize')

  const accepted = normaliseFieldInput(fontSize, '1.15')
  assert.equal(accepted.ok, true)
  if (accepted.ok) assert.equal(accepted.value, 1.15)

  const tooBig = normaliseFieldInput(fontSize, '5')
  assert.equal(tooBig.ok, false)
  if (!tooBig.ok) assert.match(tooBig.message, /at most/)

  const nonsense = normaliseFieldInput(fontSize, 'wide')
  assert.equal(nonsense.ok, false)
})

test('a color control stores only the portable grammar', () => {
  const entry = colourEntry()
  assert.deepEqual(validateSchemaSet([entry]), [])

  assert.equal(isSettingColor('#abc'), true)
  assert.equal(isSettingColor('#abcd'), true)
  assert.equal(isSettingColor('#aabbcc'), true)
  assert.equal(isSettingColor('#aabbccdd'), true)
  assert.equal(isSettingColor('transparent'), true)
  assert.equal(isSettingColor('red'), false)
  assert.equal(isSettingColor('#12345'), false)
  assert.equal(isSettingColor('rgb(1,2,3)'), false)
  assert.equal(isSettingColor(7), false)

  const accepted = normaliseFieldInput(entry, '#ff8800')
  assert.equal(accepted.ok, true)

  const named = normaliseFieldInput(entry, 'red')
  assert.equal(named.ok, false)
  if (!named.ok) assert.match(named.message, /#rgb/)
})

test('a color control on a non-string setting is a schema error', () => {
  const broken: SettingsSchema = {
    name: 'tint',
    type: 'number',
    default: 1,
    section: 'appearance',
    description: 'x',
    ui: { type: 'color' }
  }
  const problems = validateSchemaSet([broken])
  assert.ok(problems.some((problem) => /string setting/.test(problem.message)))
})

test('formatFieldDisplay and optionIndexOf agree with the control behaviour', () => {
  const theme = describeSetting(schemaNamed('theme'), 'dark')
  assert.equal(formatFieldDisplay(theme), 'Dark')
  assert.equal(optionIndexOf(theme), 1)
  assert.equal(optionIndexOf(theme, 'light'), 2)
  assert.equal(optionIndexOf(theme, 'purple'), -1)

  const toggle = describeSetting(schemaNamed('showTimestamps'), true)
  assert.equal(formatFieldDisplay(toggle), 'On')

  const chars = describeSetting(schemaNamed('maxHighlightChars'), 20000)
  assert.equal(formatFieldDisplay(chars), '20000 chars')
})

test('every ui.type in the catalogue has a control', () => {
  for (const entry of BUILTIN_SETTINGS) {
    assert.ok(
      isRenderableUiType(entry.ui.type),
      `${entry.name} uses ${entry.ui.type}, which no control renders`
    )
  }
  assert.ok(isRenderableUiType('color'))
})

// ---------------------------------------------------------------------------
// Example forms shipped in QML
// ---------------------------------------------------------------------------

test('the example QML forms only name settings the catalogue declares', () => {
  const known = new Set(BUILTIN_SETTINGS.map((entry) => entry.name))
  const files = ['ThemeForm.qml', 'LanguageForm.qml', 'MessagesForm.qml']

  for (const file of files) {
    const source = readFileSync(join(SETTINGS_QML_DIR, file), 'utf8')
    const names = [...source.matchAll(/"name":\s*"([A-Za-z0-9_.-]+)"/g)].map((match) => match[1])
    assert.ok(names.length > 0, `${file} declares no settings`)
    for (const name of names) {
      if (name === undefined) continue
      assert.ok(known.has(name), `${file} names unknown setting ${name}`)
    }
  }
})

test('the example forms declare one form per section the catalogue uses', () => {
  const expected: Record<string, string> = {
    'ThemeForm.qml': 'appearance',
    'LanguageForm.qml': 'editor',
    'MessagesForm.qml': 'messages'
  }
  for (const [file, section] of Object.entries(expected)) {
    const source = readFileSync(join(SETTINGS_QML_DIR, file), 'utf8')
    assert.match(source, new RegExp(`formSection:\\s*"${section}"`), `${file} should draw ${section}`)
  }
})

// ---------------------------------------------------------------------------
// Slot handler
// ---------------------------------------------------------------------------

test('a well-formed form contribution is accepted with defaults filled in', () => {
  const result = normaliseSettingsSlotContribution(SETTINGS_FORM_SURFACE, {
    id: 'acme.telemetry',
    schema: [
      {
        name: 'telemetryOptIn',
        type: 'boolean',
        default: false,
        section: 'plugins',
        description: 'Share anonymous counters.',
        ui: { type: 'toggle' }
      }
    ]
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.contribution.surface, SETTINGS_FORM_SURFACE)
  assert.equal(result.contribution.section, DEFAULT_FORM_SECTION)
  assert.equal(result.contribution.order, 0)
  assert.equal(result.contribution.title.length > 0, true)
  assert.deepEqual(result.contribution.properties, {})
  assert.equal(result.contribution.schema.length, 1)
})

test('a contribution with nothing to render is refused', () => {
  const result = normaliseSettingsSlotContribution(SETTINGS_FORM_SURFACE, { id: 'acme.empty' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((problem) => /component, a url or a schema/.test(problem.message)))
})

test('a contribution is refused with every problem listed, not just the first', () => {
  const result = normaliseSettingsSlotContribution(SETTINGS_FORM_SURFACE, {
    id: 'bad id!',
    section: '',
    order: 'first',
    properties: 5
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  const paths = result.issues.map((problem) => problem.path)
  assert.ok(paths.includes('id'))
  assert.ok(paths.includes('section'))
  assert.ok(paths.includes('order'))
  assert.ok(paths.includes('properties'))
})

test('a broken schema inside a contribution is reported with a schema path', () => {
  const result = normaliseSettingsSlotContribution(SETTINGS_FORM_SURFACE, {
    id: 'acme.broken',
    schema: [
      {
        name: 'gesture',
        type: 'select',
        default: 'swipe',
        section: 'plugins',
        description: 'x',
        ui: { type: 'select' }
      }
    ]
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((problem) => problem.path.startsWith('schema.')))
})

test('the surface a contribution lands on is the one it was registered against', () => {
  const result = normaliseSettingsSlotContribution(SETTINGS_SECTION_SURFACE, {
    id: 'acme.tab',
    title: 'Acme',
    schema: [
      {
        name: 'acmeEnabled',
        type: 'boolean',
        default: true,
        section: 'acme',
        description: 'x',
        ui: { type: 'toggle' }
      }
    ]
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.contribution.surface, SETTINGS_SECTION_SURFACE)
})

test('the registry refuses a duplicate id instead of silently replacing', () => {
  const registry = createSettingsSlotRegistry()
  const contribution = {
    id: 'acme.one',
    schema: [
      {
        name: 'acmeOne',
        type: 'boolean' as const,
        default: false,
        section: 'plugins',
        description: 'x',
        ui: { type: 'toggle' as const }
      }
    ]
  }

  const first = registry.register(SETTINGS_FORM_SURFACE, contribution)
  assert.equal(first.ok, true)

  const second = registry.register(SETTINGS_FORM_SURFACE, contribution)
  assert.equal(second.ok, false)
  if (!second.ok) assert.ok(second.issues.some((problem) => /already exists/.test(problem.message)))

  // Ids are scoped per surface, so the same id on another surface is fine.
  const other = registry.register(SETTINGS_SECTION_SURFACE, contribution)
  assert.equal(other.ok, true)
  assert.equal(registry.size(), 2)
})

test('disposing a registration removes only that contribution', () => {
  const registry = new SettingsSlotRegistry()
  const make = (id: string) => ({
    id,
    schema: [
      {
        name: `${id.replace(/\./g, '_')}Enabled`,
        type: 'boolean' as const,
        default: false,
        section: 'plugins',
        description: 'x',
        ui: { type: 'toggle' as const }
      }
    ]
  })

  const first = registry.register(SETTINGS_FORM_SURFACE, make('acme.a'))
  const second = registry.register(SETTINGS_FORM_SURFACE, make('acme.b'))
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)

  if (first.ok) {
    first.dispose()
    first.dispose() // idempotent
  }

  const remaining = registry.contributions(SETTINGS_FORM_SURFACE)
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0]?.id, 'acme.b')
})

test('forms are grouped by section and ordered, with registration as tie-break', () => {
  const registry = createSettingsSlotRegistry()
  const make = (id: string, section: string, order: number) => ({
    id,
    section,
    order,
    schema: [
      {
        name: `${id.replace(/[.-]/g, '_')}Enabled`,
        type: 'boolean' as const,
        default: false,
        section,
        description: 'x',
        ui: { type: 'toggle' as const }
      }
    ]
  })

  // Registered out of order on purpose.
  assert.equal(registry.register(SETTINGS_FORM_SURFACE, make('acme.second', 'acme', 20)).ok, true)
  assert.equal(registry.register(SETTINGS_FORM_SURFACE, make('acme.first', 'acme', 10)).ok, true)
  assert.equal(registry.register(SETTINGS_FORM_SURFACE, make('acme.tie', 'acme', 10)).ok, true)
  assert.equal(registry.register(SETTINGS_FORM_SURFACE, make('other.form', 'other', 0)).ok, true)

  const acme = registry.formsFor('acme')
  assert.deepEqual(
    acme.map((contribution) => contribution.id),
    ['acme.first', 'acme.tie', 'acme.second']
  )

  // An unknown section is empty rather than everything.
  assert.deepEqual(registry.formsFor('nope'), [])
  // An empty section falls back to the plugins tab.
  assert.deepEqual(registry.formsFor(''), [])

  assert.deepEqual(registry.requestedSections(), ['other', 'acme'])
})

test('a schema-only contribution is rendered by the generator', () => {
  const registry = createSettingsSlotRegistry()
  const registered = registry.register(SETTINGS_FORM_SURFACE, {
    id: 'acme.generated',
    schema: [
      {
        name: 'acmeLevel',
        type: 'number',
        default: 2,
        minimum: 0,
        maximum: 5,
        step: 1,
        section: 'plugins',
        description: 'Verbosity.',
        ui: { type: 'number', unit: ' steps' }
      }
    ]
  })
  assert.equal(registered.ok, true)
  if (!registered.ok) return

  assert.equal(usesGeneratedForm(registered.contribution), true)
  const fields = settingsFormFields(registered.contribution)
  assert.equal(fields.length, 1)
  assert.equal(fields[0]?.name, 'acmeLevel')
  assert.equal(fields[0]?.minimum, 0)
  assert.equal(fields[0]?.unit, ' steps')
})

test('a contribution that ships a component is not sent to the generator', () => {
  const result = normaliseSettingsSlotContribution(SETTINGS_FORM_SURFACE, {
    id: 'acme.qml',
    component: { pretend: 'Component' },
    schema: [
      {
        name: 'acmeQmlFlag',
        type: 'boolean',
        default: false,
        section: 'plugins',
        description: 'x',
        ui: { type: 'toggle' }
      }
    ]
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(usesGeneratedForm(result.contribution), false)
})

test('clearing the registry drops every surface', () => {
  const registry = createSettingsSlotRegistry()
  assert.equal(
    registry.register(SETTINGS_SECTION_SURFACE, {
      id: 'acme.tab',
      component: { pretend: 'Component' }
    }).ok,
    true
  )
  assert.equal(registry.size(), 1)
  registry.clear()
  assert.equal(registry.size(), 0)
  assert.deepEqual(registry.sectionTabs(), [])
})

// ---------------------------------------------------------------------------
// The QML bridge over the real store
// ---------------------------------------------------------------------------

test('the bridge reads catalogue defaults before anything is loaded', () => {
  const bridge = createInMemorySettingsBridge()
  assert.equal(bridge.get('theme'), 'auto')
  assert.equal(bridge.get('fontSize'), 1)
  assert.equal(bridge.get('hideSystemMessages'), false)
  assert.equal(bridge.get('nope'), null)
  assert.match(bridge.location(), /^memory:/)
})

test('a bridge write reaches the store and the file', () => {
  const storage = new MemorySettingsStorage()
  const store = new SettingsStore({ storage })
  store.load()
  const bridge = createSettingsQmlBridge(store)

  const revisionBefore = bridge.revision()
  assert.equal(bridge.set('hideSystemMessages', true), true, 'a legal write must be accepted')
  assert.equal(store.get('hideSystemMessages'), true)
  assert.ok(bridge.revision() > revisionBefore, 'revision must move on an accepted write')

  const persisted = storage.read()
  assert.ok(persisted !== null)
  assert.match(persisted, /"hideSystemMessages": true/)
})

test('a refused write returns false, keeps the old value and explains itself', () => {
  const storage = new MemorySettingsStorage()
  const store = new SettingsStore({ storage })
  store.load()
  const bridge = createSettingsQmlBridge(store)

  assert.equal(bridge.set('fontSize', 5), false, 'out-of-range write must be refused')
  assert.equal(store.get('fontSize'), 1)
  assert.match(bridge.lastError(), /at most/)
  assert.equal(storage.writes, 0, 'a refused write must not touch the disk')
})

test('an unknown name is refused without throwing', () => {
  const bridge = createInMemorySettingsBridge()
  assert.equal(bridge.set('notASetting', 1), false)
  assert.match(bridge.lastError(), /unknown setting/)
  assert.equal(bridge.get('notASetting'), null)
})

test('fields() and formSections() describe the live catalogue', () => {
  const bridge = createInMemorySettingsBridge()
  bridge.set('fontSize', 1.25)

  const all = bridge.fields()
  assert.equal(all.length, BUILTIN_SETTINGS.length)
  const fontSize = all.find((field) => field.name === 'fontSize')
  assert.equal(fontSize?.value, 1.25, 'descriptors must reflect the live value')

  const appearance = bridge.fields('appearance')
  assert.ok(appearance.length > 0)
  for (const field of appearance) assert.equal(field.section, 'appearance')

  const sections = bridge.formSections()
  assert.ok(sections.length > 0)
  assert.deepEqual(
    bridge.sections(),
    sections.map((section) => section.section)
  )
})

test('all() hands back a frozen copy, so a QML holder cannot mutate the store', () => {
  const bridge = createInMemorySettingsBridge()
  const snapshot = bridge.all()
  assert.equal(Object.isFrozen(snapshot), true)
  assert.throws(() => {
    ;(snapshot as Record<string, unknown>)['fontSize'] = 9
  })
  assert.equal(bridge.get('fontSize'), 1)
})

test('names() matches the catalogue order', () => {
  const bridge = createInMemorySettingsBridge()
  assert.deepEqual(bridge.names(), BUILTIN_SETTINGS.map((entry) => entry.name))
})

test('a bridge over a custom schema reports that schema, not the built-ins', () => {
  const custom: SettingsSchema[] = [colourEntry()]
  const bridge = createInMemorySettingsBridge({ schema: custom })
  assert.deepEqual(bridge.names(), ['accentColour'])
  const fields = bridge.fields()
  assert.equal(fields.length, 1)
  assert.equal(fields[0]?.uiType, 'color')
  assert.equal(fields[0]?.value, '#4c8dff')
})
