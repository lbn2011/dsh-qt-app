// Settings: schema, persistence and the reactive store.
//
// Re-exported as one module so callers do not have to know how the package is
// split internally. Public surface:
//
//   schema.ts  — what a setting is, the built-in catalogue, strict validation
//   paths.ts   — where settings live, atomic writes, corrupt-file recovery
//   store.ts   — SettingsStore: get / set / watch over that file
//   forms.ts   — schema entry + value → a descriptor a QML control can draw
//   slots.ts   — validation and registry for plugin settings contributions
//   qml-bridge.ts — the plain-object seam QML calls into
export {
  BUILTIN_SETTINGS,
  DEFAULT_SETTINGS,
  SETTING_COLOR_PATTERN,
  isSettingColor,
  MAX_FONT_SIZE,
  MAX_HIGHLIGHT_CHARS,
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
} from './schema.js'

export type {
  SettingOption,
  SettingType,
  SettingUiDescriptor,
  SettingUiType,
  SettingValidationIssue,
  SettingValidationResult,
  SettingValue,
  SettingValues,
  SettingsSchema,
  SettingsSchemaSet,
  SettingsSection,
  SettingsValidationResult
} from './schema.js'

export {
  SETTINGS_BACKUP_SUFFIX,
  SETTINGS_DIR_NAME,
  SETTINGS_FILE_NAME,
  SETTINGS_FILE_VERSION,
  MemorySettingsStorage,
  backupCorruptSettingsFile,
  createFileSettingsStorage,
  migratePersistedSettings,
  parsePersistedSettings,
  resolveSettingsDirectory,
  resolveSettingsPaths,
  serialisePersistedSettings
} from './paths.js'

export type {
  PersistedSettingsState,
  ResolvedSettingsPaths,
  SettingsMigrationResult,
  SettingsStorage
} from './paths.js'

export {
  SettingValidationError,
  SettingsStore,
  UnknownSettingError,
  createSettingsStore
} from './store.js'

export type {
  SettingsChange,
  SettingsChangeListener,
  SettingsListener,
  SettingsLoadResult,
  SettingsLogger,
  SettingsSetResult,
  SettingsStoreOptions
} from './store.js'

export {
  RENDERABLE_UI_TYPES,
  coerceFieldInput,
  describeSetting,
  formatFieldDisplay,
  humaniseSection,
  humaniseSettingName,
  isRenderableUiType,
  normaliseFieldInput,
  optionIndexOf,
  settingsFieldDescriptors,
  settingsFormSections
} from './forms.js'

export type {
  SettingsFieldDescriptor,
  SettingsFieldOption,
  SettingsFormSection
} from './forms.js'

export {
  DEFAULT_FORM_SECTION,
  SETTINGS_FORM_SURFACE,
  SETTINGS_SECTION_SURFACE,
  SettingsSlotRegistry,
  createSettingsSlotRegistry,
  normaliseSettingsSlotContribution,
  settingsFormFields,
  usesGeneratedForm
} from './slots.js'

export type {
  SettingsSlotContribution,
  SettingsSlotIssue,
  SettingsSlotNormalisation,
  SettingsSlotRefusal,
  SettingsSlotRegisterResult,
  SettingsSlotRegistration
} from './slots.js'

export {
  createInMemorySettingsBridge,
  createSettingsQmlBridge,
  settingSchemaOrNull
} from './qml-bridge.js'

export type { SettingsBridgeLogger, SettingsQmlBridge } from './qml-bridge.js'
