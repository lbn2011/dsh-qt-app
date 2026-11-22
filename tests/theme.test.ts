/**
 * Unit tests for the theme track (t15 / Phase 2f).
 *
 * What is pinned here, and why:
 *
 *  - **Parity with `qml/components/Theme.qml`.** The test parses the QML file and
 *    diffs its `readonly property` declarations against `QML_TOKEN_MAP`, so a
 *    token added on either side without the other fails the build instead of
 *    surfacing as an invisible `undefined` at runtime.
 *  - **Phase 1 fidelity.** `dark` must still equal the values Phase 1 shipped,
 *    otherwise every existing screenshot and contrast decision silently changes.
 *  - **Rejection instead of repair.** Invalid theme data must be refused with a
 *    reason and leave the previous theme active — never partially applied.
 *  - **Persistence.** Chosen id and font scale survive a restart; a corrupt file
 *    is preserved and degraded from; a failed write is reported, not thrown.
 *
 * No Qt is involved: the scheme is data, so all of it is verifiable in plain
 * Node (team policy: Qt validation happens in CI, see t4).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import {
  BUILTIN_THEMES,
  BUILTIN_THEME_IDS,
  DARK_THEME,
  DEFAULT_THEME_ID,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  LIGHT_THEME,
  MAX_ISSUES,
  MemoryThemeStorage,
  PALETTE_TOKENS,
  QML_TOKEN_KINDS,
  QML_TOKEN_MAP,
  QML_TOKEN_NAMES,
  THEME_FILE_NAME,
  THEME_FILE_VERSION,
  THEME_SECTIONS,
  ThemeManager,
  ThemeNotFoundError,
  THEME_SERVICE_NAME,
  ThemeService,
  apply,
  backupCorruptThemeFile,
  clampFontScale,
  cloneTheme,
  createThemeManager,
  describeIssues,
  getBuiltinTheme,
  isBuiltinThemeId,
  isThemeColor,
  migratePersistedTheme,
  parsePersistedTheme,
  readThemePath,
  resolveConfigDir,
  scaleTheme,
  serialisePersistedTheme,
  themeToQmlTokens,
  validateTheme,
} from '../src/theme/index.js'
import type { ThemeDefinition, ThemeStorage } from '../src/theme/index.js'

// ---- helpers -------------------------------------------------------------

const THEME_JSON_DIR = new URL('../src/theme/themes/', import.meta.url)
const THEME_QML_URL = new URL('../qml/components/Theme.qml', import.meta.url)

const cleanupDirs: string[] = []

/** Fresh temp dir, removed after the suite. */
function tempDir(prefix = 'dsh-qt-theme-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanupDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true })
})

/** Manager wired to memory storage so tests never touch the real config dir. */
function newManager(
  options: Partial<ConstructorParameters<typeof ThemeManager>[0]> = {},
  storage: ThemeStorage = new MemoryThemeStorage(),
): ThemeManager {
  return new ThemeManager({ storage, configDir: tempDir(), ...options })
}

/** Deep-merge helper for building "almost valid" themes. */
function patch(base: ThemeDefinition, mutator: (draft: Record<string, unknown>) => void): unknown {
  const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>
  mutator(draft)
  return draft
}

/** Deterministic LCG, so a failing fuzz case is reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

// ---- schema and built-ins ------------------------------------------------

test('built-in themes validate against the schema', () => {
  for (const theme of BUILTIN_THEMES) {
    const result = validateTheme(theme)
    assert.equal(result.ok, true, `${theme.id} should validate: ${result.ok ? '' : describeIssues(result.issues)}`)
    if (result.ok) assert.equal(result.theme.id, theme.id)
  }
  assert.deepEqual(BUILTIN_THEME_IDS, ['dark', 'light'])
  assert.equal(DEFAULT_THEME_ID, 'dark')
})

test('dark keeps every Phase 1 token value (screenshots stay valid)', () => {
  // Mirrors qml/components/Theme.qml as shipped in Phase 1c.
  const expected: Record<string, string | number> = {
    background: '#1b1c1f',
    surface: '#24262b',
    surfaceAlt: '#26272b',
    surfaceAccent: '#2b3b57',
    border: '#33363d',
    text: '#e6e6e6',
    textMuted: '#8a8f98',
    textInverse: '#12141a',
    accent: '#4c8dff',
    accentHover: '#6ba1ff',
    danger: '#e5534b',
    warning: '#d29922',
    success: '#3fb950',
    fontSmall: 11,
    fontNormal: 13,
    fontLarge: 16,
    fontTitle: 20,
    fontFamily: 'Inter',
    spacing: 8,
    spacingLarge: 12,
    radius: 8,
    radiusLarge: 12,
    controlHeight: 32,
    composerHeight: 96,
    sidebarWidth: 240,
    headerHeight: 48,
    animationDuration: 120,
  }

  const tokens = themeToQmlTokens(DARK_THEME)
  assert.deepEqual(tokens, expected)
})

test('light differs from dark on every surface and text colour', () => {
  for (const token of ['background', 'surface', 'surfaceAlt', 'surfaceAccent', 'border', 'text', 'textMuted'] as const) {
    assert.notEqual(LIGHT_THEME.palette[token], DARK_THEME.palette[token], `${token} must differ`)
  }
  assert.equal(LIGHT_THEME.appearance, 'light')
  assert.equal(LIGHT_THEME.spacing.unit, DARK_THEME.spacing.unit)
})

test('themes serialise to JSON and back unchanged', () => {
  for (const theme of BUILTIN_THEMES) {
    const round = JSON.parse(JSON.stringify(theme)) as ThemeDefinition
    assert.deepEqual(round, theme)
  }
})

test('shipped theme files match the built-in constants (drift guard)', () => {
  for (const theme of BUILTIN_THEMES) {
    const raw = readFileSync(new URL(`${theme.id}.json`, THEME_JSON_DIR), 'utf8')
    const parsed = JSON.parse(raw) as ThemeDefinition
    assert.deepEqual(parsed, theme, `src/theme/themes/${theme.id}.json is out of date`)
  }
})

test('getBuiltinTheme and isBuiltinThemeId agree with BUILTIN_THEME_IDS', () => {
  assert.equal(getBuiltinTheme('light')?.name, 'Light')
  assert.equal(getBuiltinTheme('nope'), undefined)
  assert.equal(isBuiltinThemeId('dark'), true)
  assert.equal(isBuiltinThemeId('solarized'), false)
})

// ---- QML token parity ----------------------------------------------------

test('Theme.qml declares exactly the tokens the schema maps', () => {
  const source = readFileSync(THEME_QML_URL, 'utf8')
  const declared = [...source.matchAll(/readonly\s+property\s+(color|int|string)\s+([A-Za-z_]\w*)\s*:/g)].map(
    (match) => ({ kind: match[1] as 'color' | 'int' | 'string', name: match[2] as string }),
  )

  assert.equal(declared.length, 27, 'Phase 1 shipped 27 tokens; the parity map must not shrink or grow')
  assert.equal(new Set(declared.map((token) => token.name)).size, declared.length, 'duplicate token name in Theme.qml')

  // QML -> schema
  for (const token of declared) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(QML_TOKEN_MAP, token.name),
      `Theme.qml declares ${token.name} but the schema has no mapping`,
    )
    assert.equal(
      QML_TOKEN_KINDS[token.name as keyof typeof QML_TOKEN_KINDS],
      token.kind,
      `${token.name} is declared as ${token.kind} in QML`,
    )
  }

  // schema -> QML
  for (const name of QML_TOKEN_NAMES) {
    assert.ok(
      declared.some((token) => token.name === name),
      `schema maps ${name} but Theme.qml no longer declares it`,
    )
  }

  assert.equal(QML_TOKEN_NAMES.length, 27)
  assert.equal(PALETTE_TOKENS.length, 16, '13 Phase 1 colours + codeBackground, codeBorder, linkColor')
})

test('every mapped token resolves in both built-ins with the declared kind', () => {
  for (const theme of BUILTIN_THEMES) {
    for (const name of QML_TOKEN_NAMES) {
      const value = readThemePath(theme, QML_TOKEN_MAP[name])
      const kind = QML_TOKEN_KINDS[name]
      if (kind === 'color') {
        assert.equal(typeof value, 'string', `${theme.id}.${name} must be a colour`)
        assert.ok(isThemeColor(value), `${theme.id}.${name} = ${String(value)} is not a valid colour`)
      } else if (kind === 'int') {
        assert.equal(typeof value, 'number', `${theme.id}.${name} must be a number`)
        assert.ok(Number.isFinite(value as number))
      } else {
        assert.equal(typeof value, 'string', `${theme.id}.${name} must be a string`)
        assert.ok((value as string).length > 0)
      }
    }
  }
})

// ---- validation ----------------------------------------------------------

test('validateTheme rejects non-objects without throwing', () => {
  for (const candidate of [null, undefined, 42, 'dark', [], true]) {
    const result = validateTheme(candidate)
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.issues.length > 0)
  }
})

test('validateTheme reports id, name and appearance problems by path', () => {
  const result = validateTheme(
    patch(DARK_THEME, (draft) => {
      draft['id'] = 'Dark Theme!'
      draft['name'] = ''
      draft['appearance'] = 'sepia'
    }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) {
    const paths = result.issues.map((issue) => issue.path)
    assert.ok(paths.includes('id'))
    assert.ok(paths.includes('name'))
    assert.ok(paths.includes('appearance'))
  }
})

test('validateTheme rejects malformed colours', () => {
  for (const bad of ['#12345', 'red', '#gggggg', 'rgb(0,0,0)', 12]) {
    const result = validateTheme(
      patch(DARK_THEME, (draft) => {
        ;(draft['palette'] as Record<string, unknown>)['accent'] = bad
      }),
    )
    assert.equal(result.ok, false, `accent = ${String(bad)} should be rejected`)
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'palette.accent'))
  }
  // Accepted syntaxes.
  for (const good of ['#abc', '#abcd', '#aabbcc', '#aabbccdd', 'transparent']) {
    const result = validateTheme(
      patch(DARK_THEME, (draft) => {
        ;(draft['palette'] as Record<string, unknown>)['accent'] = good
      }),
    )
    assert.equal(result.ok, true, `accent = ${good} should be accepted`)
  }
})

test('validateTheme enforces the font-scale bounds', () => {
  for (const bad of [0.5, 2, Number.NaN, '1.2']) {
    const result = validateTheme(
      patch(DARK_THEME, (draft) => {
        ;(draft['typography'] as Record<string, unknown>)['fontScale'] = bad
      }),
    )
    assert.equal(result.ok, false, `fontScale = ${String(bad)} should be rejected`)
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'typography.fontScale'))
  }
})

test('validateTheme rejects missing sections and missing tokens', () => {
  const result = validateTheme(
    patch(DARK_THEME, (draft) => {
      delete draft['palette']
      delete (draft['metrics'] as Record<string, unknown>)['headerHeight']
      ;(draft['shadow'] as Record<string, unknown>)['md'] = ''
    }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) {
    const paths = result.issues.map((issue) => issue.path)
    assert.ok(paths.includes('palette'))
    assert.ok(paths.includes('metrics.headerHeight'))
    assert.ok(paths.includes('shadow.md'))
  }
})

test('validateTheme caps the issue list and describeIssues summarises it', () => {
  const junk: Record<string, unknown> = { id: 'x', name: '', appearance: 'nope' }
  const result = validateTheme(junk)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.issues.length <= MAX_ISSUES)
    const summary = describeIssues(result.issues)
    assert.ok(summary.length > 0)
    assert.ok(summary.includes('more') || result.issues.length <= 5)
  }
})

test('validateTheme returns a fresh copy that shares nothing with the input', () => {
  const input = cloneTheme(DARK_THEME)
  const result = validateTheme(input)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.notEqual(result.theme, input)
  result.theme.palette.accent = '#ffffff'
  assert.equal(input.palette.accent, DARK_THEME.palette.accent)
})

test('validateTheme never throws on adversarial input', () => {
  const random = makeRandom(987654321)
  const keys = ['id', 'name', 'appearance', 'palette', 'typography', 'spacing', 'radius', 'shadow', 'metrics']
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const candidate: Record<string, unknown> = {}
    for (const key of keys) {
      const roll = random()
      if (roll < 0.2) continue
      if (roll < 0.4) candidate[key] = null
      if (roll >= 0.4 && roll < 0.6) candidate[key] = [random(), random()]
      if (roll >= 0.6 && roll < 0.8) candidate[key] = { nested: { deeper: random() } }
      if (roll >= 0.8) candidate[key] = random() < 0.5 ? String(random()) : random() * 1000
    }
    const result = validateTheme(candidate)
    assert.equal(typeof result.ok, 'boolean')
  }
})

// ---- scaling -------------------------------------------------------------

test('clampFontScale pins the documented bounds', () => {
  assert.equal(clampFontScale(FONT_SCALE_MIN - 1), FONT_SCALE_MIN)
  assert.equal(clampFontScale(FONT_SCALE_MAX + 1), FONT_SCALE_MAX)
  assert.equal(clampFontScale(Number.NaN), 1)
  assert.equal(clampFontScale(Number.POSITIVE_INFINITY), FONT_SCALE_MAX)
  assert.equal(clampFontScale(1.234), 1.23)
})

test('scaleTheme scales fonts and text metrics but not layout width', () => {
  const scaled = scaleTheme(DARK_THEME, 1.5)
  assert.equal(scaled.typography.fontScale, 1.5)
  assert.equal(scaled.typography.fontNormal, Math.round(DARK_THEME.typography.fontNormal * 1.5))
  assert.equal(scaled.metrics.controlHeight, Math.round(DARK_THEME.metrics.controlHeight * 1.5))
  assert.equal(scaled.metrics.sidebarWidth, DARK_THEME.metrics.sidebarWidth)
  assert.equal(scaled.metrics.animationDuration, DARK_THEME.metrics.animationDuration)
  assert.equal(scaled.palette.background, DARK_THEME.palette.background)
  // The input theme is untouched.
  assert.equal(DARK_THEME.typography.fontScale, 1)
})

test('scaling is idempotent from the base, not compounding', () => {
  const manager = newManager()
  manager.setFontScale(1.5)
  const big = manager.active()
  manager.setFontScale(0.75)
  manager.setFontScale(1)
  const back = manager.active()
  assert.equal(back.typography.fontNormal, DARK_THEME.typography.fontNormal)
  assert.equal(back.metrics.controlHeight, DARK_THEME.metrics.controlHeight)
  assert.notEqual(big.typography.fontNormal, back.typography.fontNormal)
})

// ---- manager: registry and switching ------------------------------------

test('manager starts on dark with the default scale', () => {
  const manager = newManager()
  assert.equal(manager.activeId, 'dark')
  assert.equal(manager.fontScale, 1)
  assert.equal(manager.active().id, 'dark')
  assert.deepEqual(manager.ids(), ['dark', 'light'])
  assert.equal(manager.list().length, 2)
  assert.equal(manager.isBuiltin('dark'), true)
})

test('loadTheme returns the authored definition without the scale applied', () => {
  const manager = newManager({ fontScale: 1.5 })
  const authored = manager.loadTheme('dark')
  assert.equal(authored.typography.fontScale, 1)
  assert.equal(manager.active().typography.fontScale, 1.5)
  assert.throws(() => manager.loadTheme('nope'), ThemeNotFoundError)
})

test('setActive switches, persists and notifies', () => {
  const storage = new MemoryThemeStorage()
  const manager = newManager({}, storage)
  const seen: string[] = []
  manager.onChange((theme, meta) => seen.push(`${meta.reason}:${theme.id}`))

  manager.setActive('light')
  assert.equal(manager.activeId, 'light')
  assert.equal(manager.active().appearance, 'light')
  assert.deepEqual(seen, ['activate:light'])

  const persisted = parsePersistedTheme(storage.read())
  assert.equal(persisted?.themeId, 'light')
  assert.equal(persisted?.schemaVersion, THEME_FILE_VERSION)

  // Same id is a no-op: no extra write, no extra notification.
  const writes = storage.writes
  manager.setActive('light')
  assert.equal(storage.writes, writes)
  assert.deepEqual(seen, ['activate:light'])

  assert.throws(() => manager.setActive('nope'), ThemeNotFoundError)
})

test('onChange unsubscribe stops delivery and is idempotent', () => {
  const manager = newManager()
  let calls = 0
  const off = manager.onChange(() => {
    calls += 1
  })
  assert.equal(manager.listenerCount(), 1)
  manager.setActive('light')
  assert.equal(calls, 1)
  off()
  off()
  assert.equal(manager.listenerCount(), 0)
  manager.setActive('dark')
  assert.equal(calls, 1)
})

test('watch is an alias of onChange', () => {
  const manager = newManager()
  let calls = 0
  const off = manager.watch(() => {
    calls += 1
  })
  manager.setFontScale(1.2)
  assert.equal(calls, 1)
  off()
  manager.setFontScale(1)
  assert.equal(calls, 1)
})

test('a throwing listener cannot block the others and is reported', () => {
  const warnings: string[] = []
  const manager = newManager({ logger: { warn: (message: string) => warnings.push(message) } })
  let reached = 0
  manager.onChange(() => {
    throw new Error('listener exploded')
  })
  manager.onChange(() => {
    reached += 1
  })
  manager.setActive('light')
  assert.equal(reached, 1)
  assert.ok(warnings.some((warning) => warning.includes('listener exploded')))
})

test('setFontScale clamps, notifies with a dedicated reason and persists', () => {
  const storage = new MemoryThemeStorage()
  const manager = newManager({}, storage)
  const reasons: string[] = []
  manager.onChange((_theme, meta) => reasons.push(meta.reason))

  assert.equal(manager.setFontScale(0.1), FONT_SCALE_MIN)
  assert.equal(manager.setFontScale(9), FONT_SCALE_MAX)
  assert.equal(manager.fontScale, FONT_SCALE_MAX)
  assert.deepEqual(reasons, ['fontScale', 'fontScale'])

  // Setting the value already in effect changes nothing.
  const writes = storage.writes
  manager.setFontScale(FONT_SCALE_MAX)
  assert.equal(storage.writes, writes)

  assert.equal(parsePersistedTheme(storage.read())?.fontScale, FONT_SCALE_MAX)
})

// ---- manager: apply / register / custom files ---------------------------

test('applyTheme refuses an invalid theme and keeps the current one', () => {
  const warnings: string[] = []
  const manager = newManager({ logger: { warn: (message: string) => warnings.push(message) } })
  const broken = patch(DARK_THEME, (draft) => {
    draft['id'] = 'broken'
    ;(draft['palette'] as Record<string, unknown>)['background'] = 'not-a-colour'
  })

  const result = manager.applyTheme(broken)
  assert.equal(result.ok, false)
  assert.equal(manager.activeId, 'dark')
  assert.equal(manager.has('broken'), false)
  assert.ok(manager.rejected.has('broken'))
  assert.ok(warnings.some((warning) => warning.includes('rejected theme broken')))
})

test('applyTheme installs, activates and persists a valid custom theme', () => {
  const storage = new MemoryThemeStorage()
  const manager = newManager({}, storage)
  const custom = patch(DARK_THEME, (draft) => {
    draft['id'] = 'midnight'
    draft['name'] = 'Midnight'
    ;(draft['palette'] as Record<string, unknown>)['accent'] = '#ff00aa'
  })

  const result = manager.applyTheme(custom)
  assert.equal(result.ok, true)
  assert.equal(manager.activeId, 'midnight')
  assert.equal(manager.active().palette.accent, '#ff00aa')
  assert.equal(manager.isBuiltin('midnight'), false)
  assert.equal(parsePersistedTheme(storage.read())?.themeId, 'midnight')
})

test('register adds a theme without activating it', () => {
  const manager = newManager()
  let notified = 0
  manager.onChange(() => {
    notified += 1
  })
  const custom = patch(DARK_THEME, (draft) => {
    draft['id'] = 'solar'
  })
  const result = manager.register(custom)
  assert.equal(result.ok, true)
  assert.equal(manager.has('solar'), true)
  assert.equal(manager.activeId, 'dark')
  assert.equal(notified, 1, 'registering a new theme notifies once')

  // Registering the same id again does not notify again.
  manager.register(custom)
  assert.equal(notified, 1)
})

test('loadCustomThemes loads valid files and reports the rest', () => {
  const dir = tempDir('dsh-qt-themes-')
  const valid = {
    ...cloneTheme(LIGHT_THEME),
    id: 'paper',
    name: 'Paper',
  }
  writeFileSync(join(dir, 'paper.json'), `${JSON.stringify(valid, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'broken-schema.json'), '{"id":"broken-schema"}\n', 'utf8')
  writeFileSync(join(dir, 'broken-json.json'), '{ not json\n', 'utf8')
  writeFileSync(join(dir, 'notes.txt'), 'ignore me\n', 'utf8')

  const manager = newManager({ configDir: dir })
  const { loaded, rejected } = manager.loadCustomThemes(dir)

  assert.deepEqual(loaded, [{ file: 'paper.json', themeId: 'paper' }])
  assert.deepEqual(
    rejected.map((entry) => entry.file),
    ['broken-json.json', 'broken-schema.json'],
  )
  assert.equal(manager.has('paper'), true)
  assert.equal(manager.activeId, 'dark', 'loading custom themes must not switch the active one')

  // A missing directory is not an error.
  const empty = manager.loadCustomThemes(join(dir, 'does-not-exist'))
  assert.deepEqual(empty.loaded, [])
  assert.deepEqual(empty.rejected, [])
})

// ---- persistence ---------------------------------------------------------

test('theme choice survives a restart through the same storage', () => {
  const dir = tempDir('dsh-qt-persist-')
  const storage = new MemoryThemeStorage()

  const first = createThemeManager({ storage, configDir: dir })
  first.setActive('light')
  first.setFontScale(1.25)

  const second = createThemeManager({ storage, configDir: dir })
  assert.equal(second.activeId, 'light')
  assert.equal(second.fontScale, 1.25)
  assert.equal(second.active().typography.fontScale, 1.25)
})

test('a corrupt theme file is preserved as .bak and the default is used', () => {
  const dir = tempDir('dsh-qt-corrupt-')
  const file = join(dir, THEME_FILE_NAME)
  writeFileSync(file, 'this is not json', 'utf8')

  const warnings: string[] = []
  const manager = new ThemeManager({ configDir: dir, logger: { warn: (message) => warnings.push(message) } })

  assert.equal(manager.activeId, 'dark')
  assert.equal(manager.fontScale, 1)
  const backup = readFileSync(`${file}.bak`, 'utf8')
  assert.equal(backup, 'this is not json')
  assert.ok(warnings.some((warning) => warning.includes('unreadable')))
})

test('a persisted theme that is no longer installed falls back to the default', () => {
  const storage = new MemoryThemeStorage(
    serialisePersistedTheme({ schemaVersion: THEME_FILE_VERSION, themeId: 'gone', fontScale: 1.3 }),
  )
  const warnings: string[] = []
  const manager = newManager({ logger: { warn: (message: string) => warnings.push(message) } }, storage)
  assert.equal(manager.activeId, 'dark')
  assert.equal(manager.fontScale, 1.3, 'the scale is still honoured')
  assert.ok(warnings.some((warning) => warning.includes('not installed')))
})

test('a failed write is reported but never breaks the session', () => {
  const failing = {
    read: () => null,
    write: () => {
      throw new Error('EROFS: read-only file system')
    },
    describe: () => 'failing:theme.json',
  }
  const manager = newManager({}, failing)
  assert.equal(manager.save(), false)
  assert.ok(manager.lastPersistError?.includes('EROFS'))
  // The theme still switched in memory.
  manager.setActive('light')
  assert.equal(manager.activeId, 'light')
  assert.ok(manager.lastPersistError !== undefined)
})

test('a failed read degrades to the defaults', () => {
  const failing = {
    read: () => {
      throw new Error('EACCES')
    },
    write: () => undefined,
    describe: () => 'unreadable:theme.json',
  }
  const manager = newManager({}, failing)
  assert.equal(manager.activeId, 'dark')
  assert.ok(manager.lastPersistError !== undefined)
})

test('reset restores dark at scale 1 and persists it', () => {
  const storage = new MemoryThemeStorage()
  const manager = newManager({}, storage)
  manager.setActive('light')
  manager.setFontScale(1.4)

  let reason = ''
  manager.onChange((_theme, meta) => {
    reason = meta.reason
  })
  manager.reset()

  assert.equal(manager.activeId, 'dark')
  assert.equal(manager.fontScale, 1)
  assert.equal(reason, 'reset')
  assert.equal(parsePersistedTheme(storage.read())?.themeId, 'dark')
})

test('parsePersistedTheme tolerates junk and reports an unversioned file as version 0', () => {
  assert.equal(parsePersistedTheme(null), null)
  assert.equal(parsePersistedTheme(''), null)
  assert.equal(parsePersistedTheme('[]'), null)
  assert.equal(parsePersistedTheme('{"themeId":"light"}'), null, 'fontScale is required')
  assert.deepEqual(parsePersistedTheme('{"themeId":"light","fontScale":1}'), {
    schemaVersion: 0,
    themeId: 'light',
    fontScale: 1,
  })
  assert.equal(parsePersistedTheme('{"schemaVersion":"one","themeId":"light","fontScale":1}')?.schemaVersion, 0)
})

test('an unversioned theme file is migrated to the current version and rewritten', () => {
  const storage = new MemoryThemeStorage('{"themeId":"light","fontScale":1.1}')
  const warnings: string[] = []
  const manager = newManager({ logger: { warn: (message: string) => warnings.push(message) } }, storage)

  assert.equal(manager.activeId, 'light')
  assert.equal(manager.fontScale, 1.1)
  const rewritten = parsePersistedTheme(storage.read())
  assert.equal(rewritten?.schemaVersion, THEME_FILE_VERSION)
  assert.equal(rewritten?.themeId, 'light')
  assert.ok(warnings.some((warning) => warning.includes('migrated theme file')))
})

test('a theme file from a newer build is honoured but never rewritten', () => {
  const future = serialisePersistedTheme({
    schemaVersion: THEME_FILE_VERSION + 5,
    themeId: 'light',
    fontScale: 1,
  })
  const storage = new MemoryThemeStorage(future)
  const warnings: string[] = []
  const manager = newManager({ logger: { warn: (message: string) => warnings.push(message) } }, storage)

  assert.equal(manager.activeId, 'light')
  assert.equal(storage.writes, 0, 'a future file must not be downgraded on load')
  assert.ok(warnings.some((warning) => warning.includes('newer build')))
})

test('migratePersistedTheme is pure and reports what it did', () => {
  const legacy = { schemaVersion: 0, themeId: 'dark', fontScale: 1 }
  const result = migratePersistedTheme(legacy)
  assert.equal(result.migrated, true)
  assert.equal(result.fromFuture, false)
  assert.equal(result.state.schemaVersion, THEME_FILE_VERSION)
  assert.equal(legacy.schemaVersion, 0, 'input is untouched')

  const current = migratePersistedTheme({ schemaVersion: THEME_FILE_VERSION, themeId: 'dark', fontScale: 1 })
  assert.equal(current.migrated, false)
  assert.equal(current.fromFuture, false)

  const future = migratePersistedTheme({ schemaVersion: THEME_FILE_VERSION + 1, themeId: 'dark', fontScale: 1 })
  assert.equal(future.fromFuture, true)
})

test('resolveConfigDir honours DSH_QT_CONFIG_DIR and falls back to the platform default', () => {
  assert.equal(resolveConfigDir({ DSH_QT_CONFIG_DIR: '/tmp/custom' }), '/tmp/custom')
  const fallback = resolveConfigDir({})
  assert.ok(fallback.endsWith('dsh-qt'))
  assert.equal(resolveConfigDir({ XDG_CONFIG_HOME: '/tmp/xdg' }).startsWith('/tmp/xdg'), true)
})

test('backupCorruptThemeFile returns null when there is nothing to move', () => {
  const dir = tempDir('dsh-qt-empty-')
  assert.equal(backupCorruptThemeFile(dir), null)
})

// ---- QML snapshot --------------------------------------------------------

test('snapshot exposes every QML token flat, with the scale applied', () => {
  const manager = newManager()
  manager.setFontScale(1.5)
  const snapshot = manager.toQmlProperties()

  assert.equal(snapshot.id, 'dark')
  assert.equal(snapshot.appearance, 'dark')
  assert.equal(snapshot.fontScale, 1.5)
  assert.deepEqual(Object.keys(snapshot.tokens).sort(), [...QML_TOKEN_NAMES].sort())
  assert.equal(snapshot.tokens.fontNormal, Math.round(DARK_THEME.typography.fontNormal * 1.5))
  assert.equal(snapshot.tokens.background, DARK_THEME.palette.background)
  assert.deepEqual(snapshot, manager.snapshot())
})

test('themeToQmlTokens fails loudly when a token is missing', () => {
  const broken = cloneTheme(DARK_THEME) as unknown as Record<string, Record<string, unknown>>
  delete broken['palette']?.['background']
  assert.throws(() => themeToQmlTokens(broken as unknown as ThemeDefinition), TypeError)
})

// ---- Cordis service ------------------------------------------------------

test('apply() registers ctx.theme and serves the active theme', () => {
  const ctx = new Context()
  const service = apply(ctx, { storage: new MemoryThemeStorage(), configDir: tempDir() })

  assert.equal(THEME_SERVICE_NAME, 'theme')
  assert.ok(service instanceof ThemeService)
  assert.ok(ctx.theme instanceof ThemeService)
  assert.equal(ctx.theme.activeId, 'dark')
  assert.equal(ctx.theme.list().length, 2)

  ctx.theme.setActive('light')
  assert.equal(ctx.theme.snapshot().appearance, 'light')
  assert.equal(ctx.theme.setFontScale(0.1), FONT_SCALE_MIN)
  assert.equal(ctx.theme.revision > 0, true)
})

test('bindSink pushes the current snapshot and then every change', () => {
  const ctx = new Context()
  const service = apply(ctx, { storage: new MemoryThemeStorage(), configDir: tempDir() })
  const pushed: string[] = []

  const off = service.bindSink((snapshot) => pushed.push(`${snapshot.id}:${snapshot.fontScale}`))
  assert.deepEqual(pushed, ['dark:1'])

  service.setActive('light')
  service.setFontScale(1.2)
  assert.deepEqual(pushed, ['dark:1', 'light:1', 'light:1.2'])

  off()
  service.setActive('dark')
  assert.equal(pushed.length, 3)
})

test('service surfaces the manager for advanced callers', () => {
  const ctx = new Context()
  const service = apply(ctx, { storage: new MemoryThemeStorage(), configDir: tempDir() })
  assert.equal(service.manager.activeId, 'dark')
  assert.equal(service.manager.list().length, 2)

  const custom = patch(DARK_THEME, (draft) => {
    draft['id'] = 'custom'
  })
  assert.equal(service.manager.applyTheme(custom).ok, true)
  assert.equal(service.activeId, 'custom')
  service.reset()
  assert.equal(service.activeId, 'dark')
})

test('THEME_SECTIONS covers every section of a theme and nothing else', () => {
  const keys = Object.keys(DARK_THEME).filter((key) => !['id', 'name', 'appearance'].includes(key))
  assert.deepEqual([...THEME_SECTIONS].sort(), keys.sort())
})
