/**
 * Persistence for the active theme choice (Phase 2f).
 *
 * Only two values survive a restart: the theme id and the font scale. Everything
 * else is derived from the theme definition, so there is nothing else to store —
 * and deliberately no copy of the palette on disk, which would otherwise shadow a
 * later built-in change.
 *
 * Storage is an injected interface ({@link ThemeStorage}) rather than direct
 * `node:fs` calls for three reasons:
 *
 *  1. Tests can swap in an in-memory or fault-injecting backend.
 *  2. t18's settings store can re-use the same theme id later without the theme
 *     manager caring where it lives.
 *  3. Failure is contained: a read-only home directory must degrade to
 *     "theme works for this session", never to a crash at startup.
 *
 * The file write is atomic (unique temp file + `rename`), so a process killed
 * mid-save leaves either the old file or the new one, never a truncated one.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Name of the file holding the active theme choice. */
export const THEME_FILE_NAME = 'theme.json'

/** Suffix used when a corrupt file is preserved instead of overwritten. */
export const THEME_BACKUP_SUFFIX = '.bak'

/** Current on-disk format version; bump when the shape changes. */
export const THEME_FILE_VERSION = 1

/** What is persisted between sessions. */
export interface PersistedThemeState {
  /** Format version, so a future change can migrate instead of guess. */
  schemaVersion: number
  /** Id of the active theme. */
  themeId: string
  /** User font scale. */
  fontScale: number
}

/** Minimal synchronous key/value backend for the theme choice. */
export interface ThemeStorage {
  /** Read the raw file contents, or `null` when nothing has been stored yet. */
  read(): string | null
  /** Replace the stored contents atomically. */
  write(contents: string): void
  /** Where the data lives, for diagnostics. */
  describe(): string
}

/**
 * Resolve the per-user configuration directory.
 *
 * `DSH_QT_CONFIG_DIR` wins (tests, portable installs, CI); otherwise the
 * platform convention with a `dsh-qt` leaf directory. Kept in this package
 * rather than imported from t18 because the theme manager must work before the
 * settings store exists.
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['DSH_QT_CONFIG_DIR']
  if (override !== undefined && override.length > 0) return override

  const home = homedir()
  if (process.platform === 'win32') {
    const appData = env['APPDATA']
    return join(appData !== undefined && appData.length > 0 ? appData : join(home, 'AppData', 'Roaming'), 'dsh-qt')
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'dsh-qt')
  }
  const xdg = env['XDG_CONFIG_HOME']
  return join(xdg !== undefined && xdg.length > 0 ? xdg : join(home, '.config'), 'dsh-qt')
}

/** Atomic file-backed {@link ThemeStorage}. */
export function createFileThemeStorage(directory: string): ThemeStorage {
  const filePath = join(directory, THEME_FILE_NAME)
  let sequence = 0

  return {
    read(): string | null {
      try {
        return readFileSync(filePath, 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // ENOENT is the normal first-run case, not a failure.
        if (code === 'ENOENT') return null
        throw error
      }
    },

    write(contents: string): void {
      mkdirSync(directory, { recursive: true })
      // Unique per write: two managers in the same process cannot clobber each
      // other's temp file before the rename.
      sequence += 1
      const tempPath = `${filePath}.${process.pid}.${sequence}.tmp`
      try {
        writeFileSync(tempPath, contents, 'utf8')
        renameSync(tempPath, filePath)
      } catch (error) {
        rmSync(tempPath, { force: true })
        throw error
      }
    },

    describe(): string {
      return filePath
    },
  }
}

/** In-memory {@link ThemeStorage}, for tests and single-session embedders. */
export class MemoryThemeStorage implements ThemeStorage {
  private contents: string | null
  private readonly label: string
  /** Number of completed writes, asserted by tests. */
  writes = 0

  constructor(initial: string | null = null, label = 'memory:theme.json') {
    this.contents = initial
    this.label = label
  }

  read(): string | null {
    return this.contents
  }

  write(contents: string): void {
    this.contents = contents
    this.writes += 1
  }

  describe(): string {
    return this.label
  }
}

/**
 * Parse a stored theme file.
 *
 * Returns `null` for anything unreadable. The caller decides whether corrupt
 * data is worth backing up — this layer only refuses to guess.
 */
export function parsePersistedTheme(raw: string | null): PersistedThemeState | null {
  if (raw === null || raw.trim().length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const source = parsed as Record<string, unknown>
  const themeId = source['themeId']
  const fontScale = source['fontScale']
  const schemaVersion = source['schemaVersion']
  if (typeof themeId !== 'string' || themeId.length === 0) return null
  if (typeof fontScale !== 'number' || !Number.isFinite(fontScale)) return null

  // A missing/unreadable version means "written before versioning existed",
  // which is version 0 — not the current version. Claiming it is current would
  // skip the migration that should stamp it.
  return {
    schemaVersion: typeof schemaVersion === 'number' && Number.isFinite(schemaVersion) ? schemaVersion : 0,
    themeId,
    fontScale,
  }
}

/** Outcome of {@link migratePersistedTheme}. */
export interface ThemeMigrationResult {
  /** State to use, migrated to the current version when possible. */
  state: PersistedThemeState
  /** True when the version was rewritten. */
  migrated: boolean
  /** True when the file came from a *newer* build than this one. */
  fromFuture: boolean
}

/**
 * Bring a parsed theme file up to {@link THEME_FILE_VERSION}.
 *
 * Only one step exists today (unversioned -> v1, which just stamps the version
 * and clamps the scale). The function is the seam the next version step plugs
 * into, so `ThemeManager.load()` never has to know what changed when.
 *
 * A file written by a newer build is *not* rewritten: its `themeId` is still
 * honoured (ids are forward compatible) and the caller can warn, but silently
 * downgrading a file we do not understand would lose the user's settings on the
 * next save.
 */
export function migratePersistedTheme(state: PersistedThemeState): ThemeMigrationResult {
  if (state.schemaVersion > THEME_FILE_VERSION) {
    return { state, migrated: false, fromFuture: true }
  }
  if (state.schemaVersion === THEME_FILE_VERSION) {
    return { state, migrated: false, fromFuture: false }
  }
  return {
    state: { ...state, schemaVersion: THEME_FILE_VERSION },
    migrated: true,
    fromFuture: false,
  }
}

/** Serialise the persisted state as stable, human-diffable JSON. */
export function serialisePersistedTheme(state: PersistedThemeState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

/**
 * Preserve an unreadable theme file as `theme.json.bak`.
 *
 * Losing the user's file would be worse than carrying a stale copy: the backup
 * is what a user attaches to a bug report when "my theme stopped loading".
 */
export function backupCorruptThemeFile(directory: string): string | null {
  const source = join(directory, THEME_FILE_NAME)
  const target = `${source}${THEME_BACKUP_SUFFIX}`
  try {
    renameSync(source, target)
    return target
  } catch {
    return null
  }
}
