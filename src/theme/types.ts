/**
 * Theme token schema for the native Qt profile (Phase 2f).
 *
 * Phase 1 shipped a single hard-coded dark scheme in `qml/components/Theme.qml`
 * (27 tokens: 13 colours, 13 ints, 1 font family). This module turns those
 * tokens into a typed, validated, serialisable contract so the Qt side can
 * switch schemes at runtime instead of being compiled against one palette.
 *
 * Three invariants hold the design together:
 *
 *  1. **One source of truth per token.** {@link QML_TOKEN_MAP} names the schema
 *     path that backs every token `Theme.qml` exposes today; a unit test parses
 *     the QML file and fails if the two ever drift.
 *  2. **Everything is plain JSON.** A `ThemeDefinition` survives
 *     `JSON.parse(JSON.stringify(...))` unchanged, so themes can be persisted,
 *     shipped as files, or handed to QML through a context property without a
 *     translation layer.
 *  3. **Validation happens on the boundary.** Data coming from a user file is
 *     `unknown` until {@link ./validate.js} accepts it; an invalid theme is
 *     rejected with a reason and is never applied (see `docs/PHASE-2-PLAN.md`
 *     §3.2).
 *
 * The `dark` palette is byte-identical to the Phase 1 values so existing
 * screenshots and QML tests keep passing; `light` is the second built-in.
 */

/** Visual appearance of a theme. */
export type ThemeAppearance = 'dark' | 'light'

/** All appearances, in menu order. */
export const THEME_APPEARANCES: readonly ThemeAppearance[] = ['dark', 'light']

/**
 * Lower bound of the user-selectable font scale.
 *
 * Below ~0.75 the composer placeholder and the 11 px `fontSmall` token stop
 * being legible, so the manager clamps rather than persisting a value the UI
 * cannot render.
 */
export const FONT_SCALE_MIN = 0.75

/** Upper bound of the user-selectable font scale (see {@link FONT_SCALE_MIN}). */
export const FONT_SCALE_MAX = 1.5

/** Scale used when a theme does not override typography. */
export const DEFAULT_FONT_SCALE = 1

/**
 * Colour tokens.
 *
 * The first thirteen mirror `qml/components/Theme.qml` exactly; the last three
 * are semantic additions that the QML renderer needs once messages are rendered
 * as rich text (t12/t13) and that Phase 1 approximated by reusing `surface`.
 */
export interface ThemePalette {
  /** Window background. */
  background: string
  /** Raised panels: composer, sidebar, cards. */
  surface: string
  /** Assistant / tool message bubbles. */
  surfaceAlt: string
  /** User message bubbles. */
  surfaceAccent: string
  /** Hairline separators. */
  border: string
  /** Primary text. */
  text: string
  /** Secondary text, timestamps, hints. */
  textMuted: string
  /** Text drawn on top of `accent`. */
  textInverse: string
  /** Primary action colour. */
  accent: string
  /** `accent` under the pointer. */
  accentHover: string
  /** Destructive actions and errors. */
  danger: string
  /** Warnings and degraded states. */
  warning: string
  /** Success states. */
  success: string
  /** Background of fenced code blocks. */
  codeBackground: string
  /** Border / gutter of fenced code blocks. */
  codeBorder: string
  /** Inline and block links. */
  linkColor: string
}

/** Font families, base sizes and the user-controlled scale factor. */
export interface ThemeTypography {
  /** Preferred UI font family; falls back to the platform default. */
  fontFamily: string
  /** Monospace family used by code blocks and inline code. */
  codeFontFamily: string
  /**
   * Multiplier applied to every size in this section (and to the metric sizes
   * in {@link ThemeMetrics} that scale with text). Always within
   * `[FONT_SCALE_MIN, FONT_SCALE_MAX]` once it has passed through
   * `ThemeManager.setFontScale`.
   */
  fontScale: number
  /** Captions, timestamps. */
  fontSmall: number
  /** Body text. */
  fontNormal: number
  /** Emphasised body text. */
  fontLarge: number
  /** Window / section titles. */
  fontTitle: number
}

/** Layout rhythm. */
export interface ThemeSpacing {
  /** Base unit. */
  unit: number
  /** Section spacing. */
  large: number
}

/** Corner radii. */
export interface ThemeRadius {
  /** Controls, bubbles. */
  base: number
  /** Panels, cards. */
  large: number
}

/**
 * Box shadows, expressed as CSS-like strings.
 *
 * Qt Quick has no drop-shadow property; the QML layer (t16) renders these as
 * layered `Rectangle`s with a soft `RadialGradient` or as `MultiEffect` in
 * Qt 6.5+. Keeping the values here means the palette and the depth scale move
 * together and a future native renderer can parse the same strings.
 */
export interface ThemeShadows {
  /** No shadow. */
  none: string
  /** Menus, tooltips. */
  sm: string
  /** Popovers, dialogs. */
  md: string
  /** Modal overlays. */
  lg: string
}

/** Fixed component metrics. */
export interface ThemeMetrics {
  /** Height of buttons and single-line inputs. */
  controlHeight: number
  /** Collapsed composer height. */
  composerHeight: number
  /** Session sidebar width. */
  sidebarWidth: number
  /** Conversation header height. */
  headerHeight: number
  /** Duration of UI transitions, in milliseconds. */
  animationDuration: number
}

/**
 * A complete, self-contained theme.
 *
 * Every field is JSON-safe, so this is also the on-disk format of
 * `src/theme/themes/*.json` and of user-provided theme files.
 */
export interface ThemeDefinition {
  /** Stable identifier used by settings (`ui.themeId`) and the manager API. */
  id: string
  /** Human-readable name for the settings UI. */
  name: string
  /** Light or dark; drives the platform appearance request in t17. */
  appearance: ThemeAppearance
  /** Colour tokens. */
  palette: ThemePalette
  /** Typography tokens. */
  typography: ThemeTypography
  /** Spacing tokens. */
  spacing: ThemeSpacing
  /** Radius tokens. */
  radius: ThemeRadius
  /** Shadow tokens. */
  shadow: ThemeShadows
  /** Component metrics. */
  metrics: ThemeMetrics
}

/** Section names of {@link ThemeDefinition}, in settings-UI order. */
export type ThemeSection = 'palette' | 'typography' | 'spacing' | 'radius' | 'shadow' | 'metrics'

/** All sections, in settings-UI order. */
export const THEME_SECTIONS: readonly ThemeSection[] = [
  'palette',
  'typography',
  'spacing',
  'radius',
  'shadow',
  'metrics',
]

/** Palette token names, in the order `Theme.qml` declares them. */
export const PALETTE_TOKENS = [
  'background',
  'surface',
  'surfaceAlt',
  'surfaceAccent',
  'border',
  'text',
  'textMuted',
  'textInverse',
  'accent',
  'accentHover',
  'danger',
  'warning',
  'success',
  'codeBackground',
  'codeBorder',
  'linkColor',
] as const satisfies readonly (keyof ThemePalette)[]

/** Typography token names. */
export const TYPOGRAPHY_TOKENS = [
  'fontFamily',
  'codeFontFamily',
  'fontScale',
  'fontSmall',
  'fontNormal',
  'fontLarge',
  'fontTitle',
] as const satisfies readonly (keyof ThemeTypography)[]

/** Spacing token names. */
export const SPACING_TOKENS = ['unit', 'large'] as const satisfies readonly (keyof ThemeSpacing)[]

/** Radius token names. */
export const RADIUS_TOKENS = ['base', 'large'] as const satisfies readonly (keyof ThemeRadius)[]

/** Shadow token names. */
export const SHADOW_TOKENS = ['none', 'sm', 'md', 'lg'] as const satisfies readonly (keyof ThemeShadows)[]

/** Metric token names. */
export const METRICS_TOKENS = [
  'controlHeight',
  'composerHeight',
  'sidebarWidth',
  'headerHeight',
  'animationDuration',
] as const satisfies readonly (keyof ThemeMetrics)[]

/** Runtime value kind expected for a token. */
export type ThemeTokenKind = 'color' | 'int' | 'string' | 'shadow'

/**
 * QML token name -> schema path.
 *
 * This is the parity contract with `qml/components/Theme.qml`: the file must
 * declare exactly these properties and nothing else. `tests/theme.test.ts`
 * parses the QML file and compares both directions, so adding a token on
 * either side without the other fails the build.
 *
 * Phase 1 shipped 27 properties (13 colour, 13 int, 1 string).
 * Phase 2g added `appearance` (28 total): a derived string property that
 * resolves `themeId` to the actual scheme in use ("dark" | "light").
 */
export const QML_TOKEN_MAP = {
  // ---- Derived (1 string) -------------------------------------------------
  appearance: '__derived:appearance',
  // ---- Surfaces (5 colours) ----------------------------------------------
  background: 'palette.background',
  surface: 'palette.surface',
  surfaceAlt: 'palette.surfaceAlt',
  surfaceAccent: 'palette.surfaceAccent',
  border: 'palette.border',
  // ---- Text (3 colours) ---------------------------------------------------
  text: 'palette.text',
  textMuted: 'palette.textMuted',
  textInverse: 'palette.textInverse',
  // ---- Accents (5 colours) ------------------------------------------------
  accent: 'palette.accent',
  accentHover: 'palette.accentHover',
  danger: 'palette.danger',
  warning: 'palette.warning',
  success: 'palette.success',
  // ---- Typography (4 ints + 1 string) -------------------------------------
  fontSmall: 'typography.fontSmall',
  fontNormal: 'typography.fontNormal',
  fontLarge: 'typography.fontLarge',
  fontTitle: 'typography.fontTitle',
  fontFamily: 'typography.fontFamily',
  // ---- Metrics (8 ints) ---------------------------------------------------
  spacing: 'spacing.unit',
  spacingLarge: 'spacing.large',
  radius: 'radius.base',
  radiusLarge: 'radius.large',
  controlHeight: 'metrics.controlHeight',
  composerHeight: 'metrics.composerHeight',
  sidebarWidth: 'metrics.sidebarWidth',
  headerHeight: 'metrics.headerHeight',
  // ---- Behaviour (1 int) --------------------------------------------------
  animationDuration: 'metrics.animationDuration',
} as const satisfies Record<string, string>

/** A QML token name backed by the schema. */
export type QmlTokenName = keyof typeof QML_TOKEN_MAP

/** The 27 QML token names, in declaration order. */
export const QML_TOKEN_NAMES = Object.keys(QML_TOKEN_MAP) as QmlTokenName[]

/** QML property type of each token, used by the parity test. */
export const QML_TOKEN_KINDS: Readonly<Record<QmlTokenName, 'color' | 'int' | 'string'>> = {
  appearance: 'string',
  background: 'color',
  surface: 'color',
  surfaceAlt: 'color',
  surfaceAccent: 'color',
  border: 'color',
  text: 'color',
  textMuted: 'color',
  textInverse: 'color',
  accent: 'color',
  accentHover: 'color',
  danger: 'color',
  warning: 'color',
  success: 'color',
  fontSmall: 'int',
  fontNormal: 'int',
  fontLarge: 'int',
  fontTitle: 'int',
  fontFamily: 'string',
  spacing: 'int',
  spacingLarge: 'int',
  radius: 'int',
  radiusLarge: 'int',
  controlHeight: 'int',
  composerHeight: 'int',
  sidebarWidth: 'int',
  headerHeight: 'int',
  animationDuration: 'int',
}

/** Shadow tokens are the only non-`Theme.qml` values the QML layer needs. */
export interface ThemeShadowSet {
  /** Name of the QML token -> shadow value. */
  sm: string
  md: string
  lg: string
}

/**
 * One entry of the flat map handed to QML as a context property.
 *
 * Flat because QML property binding cannot read a `Map`, and because a single
 * `QVariantMap` avoids a `Q_PROPERTY` per token in `native/main.cpp` (t16).
 */
export interface ThemeQmlSnapshot {
  /** Theme id, so QML can react to a switch. */
  id: string
  /** Human-readable name. */
  name: string
  /** `dark` | `light`. */
  appearance: ThemeAppearance
  /** Current font scale, echoed for debugging. */
  fontScale: number
  /** Every `Theme.qml` token, keyed by its QML name. */
  tokens: Record<QmlTokenName, string | number>
}

/** A single schema violation, addressed to a field the settings UI can focus. */
export interface ThemeValidationIssue {
  /** Dotted path inside the theme, e.g. `palette.accent`. */
  path: string
  /** What is wrong. */
  message: string
}

/**
 * Result of validating untrusted theme data.
 *
 * A discriminated union rather than a thrown error: loading a user theme is a
 * routine operation that must degrade to the previous theme, not crash the host.
 */
export type ThemeValidationResult =
  | { ok: true; theme: ThemeDefinition }
  | { ok: false; issues: ThemeValidationIssue[] }

/** True when `value` is a schema-backed QML token name. */
export function isQmlTokenName(value: string): value is QmlTokenName {
  return Object.prototype.hasOwnProperty.call(QML_TOKEN_MAP, value)
}

/** True when `value` is a supported appearance. */
export function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return value === 'dark' || value === 'light'
}
