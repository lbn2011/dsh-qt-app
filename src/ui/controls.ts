/**
 * The frozen vocabulary of the native rendering layer (I4, plan §3.6).
 *
 * Everything the converter is allowed to emit lives here: the element names it
 * accepts, the props and events each element may carry, and the QML component
 * each native node kind maps onto. Keeping the tables in one file is what makes
 * the conversion *closed*: a prop that is not listed is refused with F2 rather
 * than passed through and silently dropped later.
 *
 * Two vocabularies are deliberately separate:
 *  - `UI_TYPES` is the settings-form control catalogue (six controls, the same
 *    list `src/settings/schema.ts` validates against). An unknown `ui.type` is
 *    reported as `ui.unsupported` and never reaches the converter.
 *  - `SUPPORTED_ELEMENTS` is the React element subset that the converter maps to
 *    native nodes. Anything outside it is F1.
 */
import type { NativeNode } from './converter.js'

/** The six controls the settings form knows how to draw. */
export const UI_TYPES = ['select', 'slider', 'toggle', 'text', 'number', 'color'] as const

export type UiType = (typeof UI_TYPES)[number]

/** True only for a control the native layer can actually draw. */
export function isSupportedUiType(value: unknown): value is UiType {
  return typeof value === 'string' && (UI_TYPES as readonly string[]).includes(value)
}

/** QML control used for each generated-form control type. */
export const CONTROL_FOR_UI_TYPE: Readonly<Record<UiType, string>> = {
  select: 'Select',
  slider: 'Slider',
  toggle: 'CheckBox',
  text: 'TextInput',
  number: 'Number',
  color: 'ColorPicker',
}

export type NativeKind = NativeNode['kind']

/**
 * QML component that renders each native node kind. The Qt side instantiates
 * these by name, so a kind without an entry would render as nothing at all —
 * `tests/ui-converter.test.ts` walks every kind to keep that from happening.
 */
export const QML_COMPONENT_FOR_KIND: Readonly<Record<NativeKind, string>> = {
  paragraph: 'SlotParagraph',
  heading: 'SlotHeading',
  list: 'SlotList',
  pre: 'SlotPre',
  container: 'SlotContainer',
  separator: 'SlotSeparator',
  button: 'SlotButton',
  field: 'SlotField',
  select: 'SlotSelect',
  checkbox: 'SlotCheckbox',
  radiogroup: 'SlotRadioGroup',
  slider: 'SlotSlider',
}

/** Block containers that only lay children out. */
export const LAYOUT_ELEMENTS = ['div', 'section', 'form'] as const

/** Inline containers that only pass text through. */
export const INLINE_ELEMENTS = ['span'] as const

export const TEXT_BLOCK_ELEMENTS = ['p', 'h1', 'h2', 'h3', 'li', 'label'] as const

export const LIST_ELEMENTS = ['ul', 'ol'] as const

/**
 * Every element the converter understands. `h4`..`h6`, `table`, `iframe`,
 * `canvas`, `svg` and anything custom are intentionally absent: they fall back
 * with F1 instead of being approximated by a lookalike.
 */
export const SUPPORTED_ELEMENTS: readonly string[] = [
  ...LAYOUT_ELEMENTS,
  ...INLINE_ELEMENTS,
  ...TEXT_BLOCK_ELEMENTS,
  ...LIST_ELEMENTS,
  'pre',
  'a',
  'hr',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'code',
  'button',
  'input',
  'textarea',
  'select',
  'option',
]

/** Events the native layer can route back to the plugin. */
export const SUPPORTED_EVENTS = ['onClick', 'onChange', 'onSubmit'] as const

export type SupportedEvent = (typeof SUPPORTED_EVENTS)[number]

/** Slot action event each React prop maps onto. */
export const EVENT_FOR_PROP: Readonly<Record<SupportedEvent, 'click' | 'change' | 'submit'>> = {
  onClick: 'click',
  onChange: 'change',
  onSubmit: 'submit',
}

/** React bookkeeping props that carry no rendering meaning. */
export const IGNORED_PROPS: readonly string[] = ['key', 'children', 'ref']

/** Props that mean "run code we cannot see" — always refused, never sanitised. */
export const DYNAMIC_CODE_PROPS: readonly string[] = [
  'dangerouslySetInnerHTML',
  'innerHTML',
  'eval',
  'require',
  'Function',
]

/**
 * Props each element may carry. Anything else is F2. `style` is not in any list
 * on purpose: the converter does not implement a CSS subset, so a style object
 * is refused as complex DOM (F5) rather than half-applied.
 */
export const PROPS_FOR_ELEMENT: Readonly<Record<string, readonly string[]>> = {
  div: ['display', 'flexDirection', 'gap', 'padding', 'alignItems', 'justifyContent', 'overflow', 'role', 'value'],
  section: ['display', 'flexDirection', 'gap', 'padding', 'alignItems', 'justifyContent', 'overflow', 'role', 'value'],
  form: ['display', 'flexDirection', 'gap', 'padding', 'alignItems', 'justifyContent', 'overflow', 'role'],
  span: [],
  p: [],
  h1: [],
  h2: [],
  h3: [],
  li: [],
  label: [],
  ul: [],
  ol: [],
  pre: ['data-language', 'language'],
  a: ['href'],
  hr: [],
  br: [],
  button: ['disabled', 'variant', 'type'],
  input: [
    'type',
    'value',
    'placeholder',
    'maxLength',
    'disabled',
    'readOnly',
    'checked',
    'label',
    'min',
    'max',
    'step',
    'name',
    'rows',
  ],
  textarea: ['value', 'placeholder', 'maxLength', 'disabled', 'readOnly', 'rows'],
  select: ['value', 'disabled'],
  option: ['value', 'label'],
}

/** Events each element may carry. An event outside this table is F3. */
export const EVENTS_FOR_ELEMENT: Readonly<Record<string, readonly SupportedEvent[]>> = {
  form: ['onSubmit'],
  button: ['onClick'],
  input: ['onChange', 'onClick'],
  textarea: ['onChange'],
  select: ['onChange'],
  option: [],
  div: ['onClick'],
  section: ['onClick'],
  span: ['onClick'],
}

/** Allowed values of the layout props, mapped to their native spelling. */
export const ALIGN_VALUES: Readonly<Record<string, string>> = {
  'flex-start': 'start',
  start: 'start',
  center: 'center',
  'flex-end': 'end',
  end: 'end',
  stretch: 'stretch',
  baseline: 'baseline',
}

export const JUSTIFY_VALUES: Readonly<Record<string, string>> = {
  'flex-start': 'start',
  start: 'start',
  center: 'center',
  'flex-end': 'end',
  end: 'end',
  'space-between': 'space-between',
  'space-around': 'space-around',
  'space-evenly': 'space-evenly',
}

export const DISPLAY_VALUES: Readonly<Record<string, 'row' | 'column'>> = {
  flex: 'row',
  block: 'column',
}

export const FLEX_DIRECTION_VALUES: Readonly<Record<string, 'row' | 'column'>> = {
  row: 'row',
  column: 'column',
}

/** Overflow values that mean "scroll this container". */
export const SCROLL_VALUES: Readonly<Record<string, boolean>> = {
  auto: true,
  scroll: true,
  visible: false,
  hidden: false,
}

/** Input `type` values the converter maps onto native fields. */
export const INPUT_TYPES: readonly string[] = ['text', 'password', 'number', 'checkbox', 'radio', 'range']

/** Button `variant` values, mapped onto the QML button tone. */
export const BUTTON_TONES: Readonly<Record<string, 'default' | 'danger'>> = {
  default: 'default',
  primary: 'default',
  danger: 'danger',
}

/** Notice shown when a slot degrades to text because the host cannot render it. */
export const UNSUPPORTED_CONTROL_NOTICE =
  'This control is not supported in the Qt interface. Open it in the WebUI to edit it.'
