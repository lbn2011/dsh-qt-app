/**
 * Schema validation for theme data (Phase 2f).
 *
 * Everything that does not come from this package is untrusted: a user theme
 * file, a value read back from `theme.json`, a fixture in a test. All of it goes
 * through {@link validateTheme} before the manager will apply it, so a malformed
 * theme can never reach QML and paint the window with `undefined`.
 *
 * Design notes:
 *
 *  - **Collect, don't throw.** Every problem is reported with the dotted path
 *    the settings UI needs to focus the offending field, so a user fixing a
 *    hand-edited file sees all the mistakes at once (`docs/PHASE-2-PLAN.md`
 *    §3.3 makes the same choice for the settings schema).
 *  - **No silent coercion.** `"8"` is not a number and `"#12345"` is not a
 *    colour; both are rejected rather than repaired, because a repaired theme
 *    hides the bug that produced it.
 *  - **Bounded output.** A file with 10 000 junk keys must not produce 10 000
 *    issues; the report is capped at {@link MAX_ISSUES}.
 */
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  SHADOW_TOKENS,
  METRICS_TOKENS,
  PALETTE_TOKENS,
  RADIUS_TOKENS,
  SPACING_TOKENS,
  THEME_SECTIONS,
  TYPOGRAPHY_TOKENS,
  isThemeAppearance,
} from './types.js'
import type {
  ThemeDefinition,
  ThemeSection,
  ThemeValidationIssue,
  ThemeValidationResult,
} from './types.js'

/** Upper bound of reported issues; a runaway report is itself a bug. */
export const MAX_ISSUES = 50

/** Largest accepted pixel / millisecond value for a size token. */
export const MAX_SIZE_VALUE = 4096

/** Lowercase slug: letters, digits, dot, dash, underscore. */
const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

/**
 * Accepted colour syntax: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, or
 * `transparent`.
 *
 * Deliberately narrower than Qt's colour parser: a theme file is a
 * configuration document, and `rgba(0,0,0,.4)` reaching a QML `color` property
 * through JSON would be rejected at runtime with a cryptic warning.
 */
const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** True when `value` is a colour in the accepted syntax. */
export function isThemeColor(value: unknown): value is string {
  return typeof value === 'string' && (value === 'transparent' || COLOR_PATTERN.test(value))
}

/** True when `value` is a finite number usable as a size token. */
function isSizeValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_SIZE_VALUE
}

/** Read a dotted path (`palette.accent`) out of a theme-shaped object. */
export function readThemePath(source: unknown, path: string): unknown {
  let current: unknown = source
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** True when `value` is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Validate untrusted data as a {@link ThemeDefinition}.
 *
 * Never throws. On success the returned theme is a fresh deep copy, so the
 * caller may mutate it without corrupting the input (and vice versa).
 */
export function validateTheme(value: unknown): ThemeValidationResult {
  const issues: ThemeValidationIssue[] = []
  const report = (path: string, message: string): void => {
    if (issues.length < MAX_ISSUES) issues.push({ path, message })
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: [{ path: '', message: 'theme must be a JSON object' }] }
  }

  const source = value as Record<string, unknown>

  // ---- Identity -----------------------------------------------------------
  const id = source['id']
  if (typeof id !== 'string' || !THEME_ID_PATTERN.test(id)) {
    report('id', 'id must be a lowercase slug (letters, digits, ".", "-", "_")')
  }

  const name = source['name']
  if (!isNonEmptyString(name)) report('name', 'name must be a non-empty string')

  const appearance = source['appearance']
  if (!isThemeAppearance(appearance)) report('appearance', 'appearance must be "dark" or "light"')

  // ---- Sections -----------------------------------------------------------
  for (const section of THEME_SECTIONS) {
    const sectionValue = source[section]
    if (sectionValue === null || typeof sectionValue !== 'object' || Array.isArray(sectionValue)) {
      report(section, `${section} must be an object`)
    }
  }

  // ---- Palette ------------------------------------------------------------
  for (const token of PALETTE_TOKENS) {
    const tokenValue = readThemePath(source, `palette.${token}`)
    if (!isThemeColor(tokenValue)) {
      report(`palette.${token}`, 'expected a colour like "#1b1c1f" or "transparent"')
    }
  }

  // ---- Typography ---------------------------------------------------------
  const fontFamily = readThemePath(source, 'typography.fontFamily')
  if (!isNonEmptyString(fontFamily)) {
    report('typography.fontFamily', 'fontFamily must be a non-empty string')
  }
  const codeFontFamily = readThemePath(source, 'typography.codeFontFamily')
  if (!isNonEmptyString(codeFontFamily)) {
    report('typography.codeFontFamily', 'codeFontFamily must be a non-empty string')
  }
  const fontScale = readThemePath(source, 'typography.fontScale')
  if (typeof fontScale !== 'number' || !Number.isFinite(fontScale)) {
    report('typography.fontScale', 'fontScale must be a finite number')
  } else if (fontScale < FONT_SCALE_MIN || fontScale > FONT_SCALE_MAX) {
    report(
      'typography.fontScale',
      `fontScale must be within ${FONT_SCALE_MIN} … ${FONT_SCALE_MAX}`,
    )
  }
  for (const token of TYPOGRAPHY_TOKENS) {
    if (token === 'fontFamily' || token === 'codeFontFamily' || token === 'fontScale') continue
    const tokenValue = readThemePath(source, `typography.${token}`)
    if (!isSizeValue(tokenValue) || tokenValue <= 0) {
      report(`typography.${token}`, 'expected a positive font size in pixels')
    }
  }

  // ---- Spacing / radius / metrics ----------------------------------------
  for (const token of SPACING_TOKENS) {
    const tokenValue = readThemePath(source, `spacing.${token}`)
    if (!isSizeValue(tokenValue)) report(`spacing.${token}`, 'expected a non-negative number')
  }
  for (const token of RADIUS_TOKENS) {
    const tokenValue = readThemePath(source, `radius.${token}`)
    if (!isSizeValue(tokenValue)) report(`radius.${token}`, 'expected a non-negative number')
  }
  for (const token of METRICS_TOKENS) {
    const tokenValue = readThemePath(source, `metrics.${token}`)
    if (!isSizeValue(tokenValue) || tokenValue <= 0) {
      report(`metrics.${token}`, 'expected a positive number')
    }
  }

  // ---- Shadows ------------------------------------------------------------
  for (const token of SHADOW_TOKENS) {
    const tokenValue = readThemePath(source, `shadow.${token}`)
    if (typeof tokenValue !== 'string') {
      report(`shadow.${token}`, 'expected a shadow string ("" for none)')
    } else if (token !== 'none' && tokenValue.length === 0) {
      report(`shadow.${token}`, 'shadow must be a non-empty string')
    }
  }

  if (issues.length > 0) return { ok: false, issues }

  // The checks above walk exactly the declared tokens, so a rebuilt object is
  // both a deep copy and a guarantee that unknown keys never reach QML.
  const theme: ThemeDefinition = {
    id: source['id'] as string,
    name: source['name'] as string,
    appearance: source['appearance'] as ThemeDefinition['appearance'],
    palette: readSection(source, 'palette', PALETTE_TOKENS),
    typography: readSection(source, 'typography', TYPOGRAPHY_TOKENS),
    spacing: readSection(source, 'spacing', SPACING_TOKENS),
    radius: readSection(source, 'radius', RADIUS_TOKENS),
    shadow: readSection(source, 'shadow', SHADOW_TOKENS),
    metrics: readSection(source, 'metrics', METRICS_TOKENS),
  } as ThemeDefinition

  return { ok: true, theme }
}

/**
 * Copy the declared tokens of one section into a fresh object.
 *
 * Validation has already proved every token is present and well typed; this
 * cast is the single place where that knowledge is asserted, instead of trusting
 * the input object wholesale.
 */
function readSection<T extends ThemeSection>(
  source: Record<string, unknown>,
  section: T,
  tokens: readonly string[],
): ThemeDefinition[T] {
  const sectionValue = source[section] as Record<string, unknown>
  const copy: Record<string, unknown> = {}
  for (const token of tokens) copy[token] = sectionValue[token]
  return copy as unknown as ThemeDefinition[T]
}

/** Deep copy of a valid theme (structuredClone keeps it JSON-safe). */
export function cloneTheme(theme: ThemeDefinition): ThemeDefinition {
  return structuredClone(theme)
}

/** One-line human summary of a failed validation, for logs and toasts. */
export function describeIssues(issues: readonly ThemeValidationIssue[]): string {
  if (issues.length === 0) return 'theme is valid'
  const rendered = issues.map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
  const head = rendered.slice(0, 5).join('; ')
  return issues.length > 5 ? `${head}; and ${issues.length - 5} more` : head
}
