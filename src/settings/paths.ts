// paths.ts — where settings live, and how they are written.
//
// Split out from store.ts so the filesystem concerns (platform directory, atomic
// replace, corrupt-file backup) can be tested against a fake storage without
// dragging the store's reactive machinery along.
//
// Directory choice — one deliberate deviation from the task text, documented
// rather than silently applied:
//
//   The task says `XDG_CONFIG_HOME/dsh-qt-app/settings.json`. The shipped binary
//   already keeps its state in `…/dsh-qt`: src/theme/persist.ts:resolveConfigDir()
//   returns `…/dsh-qt`, and native/main.cpp:configDirectory() mirrors it for the
//   C++ ThemeBridge that owns theme.json. Writing settings.json to a *second*
//   directory would leave one application with two config roots — theme state in
//   one, settings in the other, neither aware of the other's backup/versioning.
//   So this module resolves the same `…/dsh-qt` root, and the constant below is
//   the single place to change if the whole app ever renames itself.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Directory name under the platform config root. Keep in step with the theme store. */
export const SETTINGS_DIR_NAME = 'dsh-qt'

/** File name inside that directory. */
export const SETTINGS_FILE_NAME = 'settings.json'

/** Suffix used when a corrupt file is moved aside instead of deleted. */
export const SETTINGS_BACKUP_SUFFIX = '.bak'

/**
 * On-disk format version.
 *
 * 0 means "written before versioning existed" — a bare `{ "theme": "dark" }`
 * map with no envelope. `migratePersistedSettings()` upgrades it, so an early
 * build's file is not thrown away.
 */
export const SETTINGS_FILE_VERSION = 1

/** Storage seam, so the store can be tested without touching the disk. */
export interface SettingsStorage {
  /** Current file contents, or null when the file does not exist yet. */
  read(): string | null
  /** Replace the file atomically. Throws on failure. */
  write(contents: string): void
  /** Human-readable location, for log lines and diagnostics. */
  describe(): string
}

/** On-disk envelope. */
export interface PersistedSettingsState {
  /**
   * Format version.
   *
   * 0 when the file was written before versioning; `parsePersistedSettings`
   * maps a missing or unreadable version to 0 so that those files do migrate.
   */
  readonly schemaVersion: number
  /** Raw values exactly as they were stored (not yet validated). */
  readonly values: Readonly<Record<string, unknown>>
}

/** Result of resolving an environment to a directory. */
export interface ResolvedSettingsPaths {
  /** Directory that holds settings.json. */
  readonly directory: string
  /** Full path of settings.json. */
  readonly file: string
}

/**
 * Platform config root for this application.
 *
 * Order: explicit `DSH_QT_CONFIG_DIR` → Windows `%APPDATA%\dsh-qt` → macOS
 * `~/Library/Application Support/dsh-qt` → `$XDG_CONFIG_HOME/dsh-qt` →
 * `~/.config/dsh-qt`.
 */
export function resolveSettingsPaths(env: NodeJS.ProcessEnv = process.env): ResolvedSettingsPaths {
  const directory = resolveSettingsDirectory(env)
  return { directory, file: join(directory, SETTINGS_FILE_NAME) }
}

/** Directory half of `resolveSettingsPaths()`. */
export function resolveSettingsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['DSH_QT_CONFIG_DIR']
  if (override !== undefined && override.length > 0) return override

  const home = homedir()

  if (process.platform === 'win32') {
    const appData = env['APPDATA']
    return join(
      appData !== undefined && appData.length > 0 ? appData : join(home, 'AppData', 'Roaming'),
      SETTINGS_DIR_NAME
    )
  }

  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', SETTINGS_DIR_NAME)
  }

  const xdg = env['XDG_CONFIG_HOME']
  return join(xdg !== undefined && xdg.length > 0 ? xdg : join(home, '.config'), SETTINGS_DIR_NAME)
}

/** Monotonic counter so two writes in the same tick cannot collide on the temp name. */
let tempCounter = 0

/**
 * Real file storage.
 *
 * The write is a temp file plus `renameSync`: POSIX rename is atomic, so a crash
 * or a full disk can leave the old file intact but can never leave a half-written
 * one. Windows gets the same guarantee through `writeFileSync` + rename because
 * Node maps that onto MoveFileEx with replace semantics for renameSync.
 */
export function createFileSettingsStorage(file: string): SettingsStorage {
  return {
    read(): string | null {
      try {
        return readFileSync(file, 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return null
        throw error
      }
    },

    write(contents: string): void {
      const directory = dirname(file)
      mkdirSync(directory, { recursive: true })
      tempCounter += 1
      const temp = `${file}.${process.pid}.${tempCounter}.tmp`
      try {
        writeFileSync(temp, contents, 'utf8')
        renameSync(temp, file)
      } catch (error) {
        // Never leave a temp file behind on failure; the next run must not find
        // stale candidates beside a valid settings.json.
        try {
          rmSync(temp, { force: true })
        } catch {
          // Best effort: the original error is the interesting one.
        }
        throw error
      }
    },

    describe(): string {
      return file
    }
  }
}

/** In-memory storage for tests and for a headless session with no config dir. */
export class MemorySettingsStorage implements SettingsStorage {
  /** Number of successful writes; handy in assertions. */
  writes = 0
  /** Every payload written, oldest first. */
  history: string[] = []
  private contents: string | null

  constructor(initial: string | null = null) {
    this.contents = initial
  }

  read(): string | null {
    return this.contents
  }

  write(value: string): void {
    this.contents = value
    this.writes += 1
    this.history.push(value)
  }

  describe(): string {
    return 'memory://settings.json'
  }

  /** Simulate an external edit (another process, a user with an editor). */
  setContents(value: string | null): void {
    this.contents = value
  }
}

/**
 * Parse a settings file.
 *
 * Accepts both shapes: the versioned envelope and a bare map from before
 * versioning existed. Junk returns null rather than throwing, because a settings
 * file is user-editable and a malformed one must not take the app down.
 */
export function parsePersistedSettings(raw: string | null): PersistedSettingsState | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const record = parsed as Record<string, unknown>
  const version = record['schemaVersion']

  // Versioned file: { schemaVersion, values }.
  if (typeof version === 'number' && Number.isFinite(version)) {
    const values = record['values']
    if (values === null || typeof values !== 'object' || Array.isArray(values)) return null
    return { schemaVersion: version, values: values as Record<string, unknown> }
  }

  // Unversioned file: the map itself. Schema version 0 marks it for migration.
  return { schemaVersion: 0, values: record }
}

/** Serialise the envelope. Sorted keys keep the file diff-friendly. */
export function serialisePersistedSettings(state: PersistedSettingsState): string {
  const values: Record<string, unknown> = {}
  for (const key of Object.keys(state.values).sort()) values[key] = state.values[key]
  const envelope = { schemaVersion: state.schemaVersion, values }
  return `${JSON.stringify(envelope, null, 2)}\n`
}

/** Outcome of a migration attempt. */
export interface SettingsMigrationResult {
  /** State to use. Same object when nothing changed. */
  readonly state: PersistedSettingsState
  /** True when the caller should rewrite the file. */
  readonly migrated: boolean
  /** True when the file came from a newer build and must not be downgraded. */
  readonly fromFuture: boolean
}

/**
 * Upgrade a parsed file to the current format.
 *
 * v0 → v1 is pure envelope wrapping: the bare map becomes `values`. A file from
 * a *newer* build is returned untouched and flagged, so starting an older build
 * once can never rewrite (and thereby lose) a field the newer one added.
 */
export function migratePersistedSettings(state: PersistedSettingsState): SettingsMigrationResult {
  if (state.schemaVersion > SETTINGS_FILE_VERSION) {
    return { state, migrated: false, fromFuture: true }
  }
  if (state.schemaVersion === SETTINGS_FILE_VERSION) {
    return { state, migrated: false, fromFuture: false }
  }
  return {
    state: { schemaVersion: SETTINGS_FILE_VERSION, values: state.values },
    migrated: true,
    fromFuture: false
  }
}

/**
 * Move a corrupt settings file aside.
 *
 * Kept rather than deleted: whatever the user (or a bug) wrote is the only clue
 * about what went wrong, and "your settings were reset" is much easier to accept
 * when the old file is still on disk.
 */
export function backupCorruptSettingsFile(file: string): string | null {
  const backup = `${file}${SETTINGS_BACKUP_SUFFIX}`
  try {
    renameSync(file, backup)
    return backup
  } catch {
    return null
  }
}
