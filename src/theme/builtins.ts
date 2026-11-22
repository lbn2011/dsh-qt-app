/**
 * Built-in themes (Phase 2f).
 *
 * `dark` is byte-identical to the Phase 1 palette in `qml/components/Theme.qml`,
 * so every existing screenshot, QML test and contrast decision stays valid;
 * `light` is the second scheme the settings panel offers.
 *
 * The same data also ships as `themes/dark.json` and `themes/light.json`. Those
 * files are the canonical serialised form (and the template a user copies to
 * write a custom theme); `tests/theme.test.ts` re-reads them and deep-compares
 * against these constants, so the two can never drift. Keeping the runtime copy
 * in TypeScript means no `resolveJsonModule`, no file lookup relative to
 * `import.meta.url`, and no failure mode when the package is bundled.
 */
import { DEFAULT_FONT_SCALE } from './types.js'
import type { ThemeDefinition } from './types.js'

/** Id of the theme used when nothing has been chosen yet. */
export const DEFAULT_THEME_ID = 'dark'

/** Phase 1 palette, unchanged. */
export const DARK_THEME: ThemeDefinition = {
  id: 'dark',
  name: 'Dark',
  appearance: 'dark',
  palette: {
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
    codeBackground: '#15161a',
    codeBorder: '#2c2f36',
    linkColor: '#7fb1ff',
  },
  typography: {
    fontFamily: 'Inter',
    codeFontFamily: 'JetBrains Mono',
    fontScale: DEFAULT_FONT_SCALE,
    fontSmall: 11,
    fontNormal: 13,
    fontLarge: 16,
    fontTitle: 20,
  },
  spacing: { unit: 8, large: 12 },
  radius: { base: 8, large: 12 },
  shadow: {
    none: '',
    sm: '0 1px 2px rgba(0,0,0,0.45)',
    md: '0 4px 12px rgba(0,0,0,0.50)',
    lg: '0 12px 32px rgba(0,0,0,0.55)',
  },
  metrics: {
    controlHeight: 32,
    composerHeight: 96,
    sidebarWidth: 240,
    headerHeight: 48,
    animationDuration: 120,
  },
}

/** Light counterpart; same geometry, inverted surfaces, darker accents for AA contrast. */
export const LIGHT_THEME: ThemeDefinition = {
  id: 'light',
  name: 'Light',
  appearance: 'light',
  palette: {
    background: '#f7f8fa',
    surface: '#ffffff',
    surfaceAlt: '#f1f2f5',
    surfaceAccent: '#dbe8ff',
    border: '#d8dbe2',
    text: '#1b1c1f',
    textMuted: '#5c626d',
    textInverse: '#ffffff',
    accent: '#2f6fd0',
    accentHover: '#2559ad',
    danger: '#c93c34',
    warning: '#8a5d00',
    success: '#1f7f36',
    codeBackground: '#f3f4f7',
    codeBorder: '#dde0e6',
    linkColor: '#1f5fbf',
  },
  typography: {
    fontFamily: 'Inter',
    codeFontFamily: 'JetBrains Mono',
    fontScale: DEFAULT_FONT_SCALE,
    fontSmall: 11,
    fontNormal: 13,
    fontLarge: 16,
    fontTitle: 20,
  },
  spacing: { unit: 8, large: 12 },
  radius: { base: 8, large: 12 },
  shadow: {
    none: '',
    sm: '0 1px 2px rgba(16,24,40,0.08)',
    md: '0 4px 12px rgba(16,24,40,0.12)',
    lg: '0 12px 32px rgba(16,24,40,0.16)',
  },
  metrics: {
    controlHeight: 32,
    composerHeight: 96,
    sidebarWidth: 240,
    headerHeight: 48,
    animationDuration: 120,
  },
}

/** Built-in themes, in settings-UI order (default first). */
export const BUILTIN_THEMES: readonly ThemeDefinition[] = [DARK_THEME, LIGHT_THEME]

/** Ids of every built-in theme. */
export const BUILTIN_THEME_IDS: readonly string[] = BUILTIN_THEMES.map((theme) => theme.id)

/** Look up a built-in theme by id; `undefined` when `id` is not built in. */
export function getBuiltinTheme(id: string): ThemeDefinition | undefined {
  return BUILTIN_THEMES.find((theme) => theme.id === id)
}

/** True when `id` names a built-in theme. */
export function isBuiltinThemeId(id: string): boolean {
  return BUILTIN_THEME_IDS.includes(id)
}
