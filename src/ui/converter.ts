/**
 * Limited React-tree → native QML conversion (I4, plan §3.6).
 *
 * The slot renderer runs in Node and hands back an element tree
 * `{type, props, children}`. This module turns that tree into the closed native
 * vocabulary in `controls.ts`, or refuses it with one of six reason codes. It is
 * a pure function: no React runtime, no registry, no I/O, and it never throws —
 * a refusal is a value, because the caller has to decide between the WebView and
 * a text fallback and cannot do that from an exception.
 *
 * What this is *not*: a general React renderer. The supported subset is frozen
 * and narrow on purpose. Anything outside it (third-party components, complex
 * DOM, dynamic code) is refused so the caller can fall back explicitly — the one
 * thing this must never do is approximate an unknown component into something
 * that looks similar but behaves differently.
 */
import {
  ALIGN_VALUES,
  BUTTON_TONES,
  DISPLAY_VALUES,
  DYNAMIC_CODE_PROPS,
  EVENT_FOR_PROP,
  EVENTS_FOR_ELEMENT,
  FLEX_DIRECTION_VALUES,
  IGNORED_PROPS,
  INLINE_ELEMENTS,
  INPUT_TYPES,
  JUSTIFY_VALUES,
  LAYOUT_ELEMENTS,
  LIST_ELEMENTS,
  PROPS_FOR_ELEMENT,
  SCROLL_VALUES,
  SUPPORTED_ELEMENTS,
  SUPPORTED_EVENTS,
  TEXT_BLOCK_ELEMENTS,
} from './controls.js'
import type { SupportedEvent } from './controls.js'
import type { SlotWebEntry } from '../plugins/slot-contract.js'

/** The six refusal codes frozen by the plan; the names are part of the contract. */
export const CONVERSION_REASON_NAMES = {
  F1: 'unsupported-element',
  F2: 'unsupported-prop',
  F3: 'unsupported-event',
  F4: 'third-party-component',
  F5: 'complex-dom',
  F6: 'dynamic-code',
} as const

export type ConversionReasonCode = keyof typeof CONVERSION_REASON_NAMES

export interface ConversionReason {
  readonly code: ConversionReasonCode
  readonly name: string
  readonly detail: string
  readonly path: string
}

/** Declarative reference to a plugin action; the host routes it back to the slot. */
export interface SlotAction {
  readonly slotId: string
  readonly event: 'click' | 'change' | 'submit'
}

export interface SelectOption {
  readonly value: string
  readonly label: string
}

export type NativeInline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: NativeInline[] }
  | { readonly kind: 'emphasis'; readonly children: NativeInline[] }
  | { readonly kind: 'code'; readonly children: NativeInline[] }
  | { readonly kind: 'link'; readonly href: string; readonly children: NativeInline[] }

export type NativeNode =
  | { readonly kind: 'paragraph'; readonly children: NativeInline[] }
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly children: NativeInline[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: NativeInline[][] }
  | { readonly kind: 'pre'; readonly text: string; readonly language?: string }
  | {
      readonly kind: 'container'
      readonly direction: 'row' | 'column'
      readonly children: NativeNode[]
      readonly gap?: number
      readonly padding?: number
      readonly align?: string
      readonly justify?: string
      readonly scroll?: boolean
      readonly action?: SlotAction
    }
  | { readonly kind: 'separator' }
  | {
      readonly kind: 'button'
      readonly label: string
      readonly disabled: boolean
      readonly tone: 'default' | 'danger'
      readonly action?: SlotAction
    }
  | {
      readonly kind: 'field'
      readonly control: 'text' | 'password' | 'multiline' | 'number'
      readonly disabled: boolean
      readonly readOnly: boolean
      readonly value?: string | number
      readonly placeholder?: string
      readonly maxLength?: number
      readonly action?: SlotAction
    }
  | {
      readonly kind: 'select'
      readonly options: SelectOption[]
      readonly disabled: boolean
      readonly value?: string
      readonly action?: SlotAction
    }
  | {
      readonly kind: 'checkbox'
      readonly checked: boolean
      readonly disabled: boolean
      readonly label?: string
      readonly action?: SlotAction
    }
  | {
      readonly kind: 'radiogroup'
      readonly options: SelectOption[]
      readonly disabled: boolean
      readonly value?: string
      readonly action?: SlotAction
    }
  | {
      readonly kind: 'slider'
      readonly min: number
      readonly max: number
      readonly step: number
      readonly value: number
      readonly disabled: boolean
      readonly action?: SlotAction
    }

export type ConversionResult =
  | { readonly status: 'native'; readonly tree: NativeNode }
  | { readonly status: 'web'; readonly reason: ConversionReason }
  | { readonly status: 'text'; readonly reason: ConversionReason; readonly text: string }

export interface ConvertOptions {
  /** Slot the tree came from; without it the tree converts but carries no actions. */
  readonly slotId?: string
  /** The slot's `client.webEntry` declaration, which picks the fallback target. */
  readonly webEntry?: SlotWebEntry
}

const MAX_NODES = 5000
const MAX_DEPTH = 32
const MAX_FALLBACK_TEXT = 2000

interface Ctx {
  readonly slotId: string | undefined
  readonly stack: Set<object>
  readonly budget: { nodes: number }
  depth: number
}

type Refusal = { readonly ok: false; readonly reason: ConversionReason }
type Attempt<T> = { readonly ok: true; readonly value: T } | Refusal

function refusal(code: ConversionReasonCode, detail: string, path: string): Refusal {
  return {
    ok: false,
    reason: { code, name: CONVERSION_REASON_NAMES[code], detail, path },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function enter(target: object, ctx: Ctx, path: string): Refusal | null {
  ctx.budget.nodes += 1
  if (ctx.budget.nodes > MAX_NODES) {
    return refusal('F1', `the element tree exceeds the ${MAX_NODES} node conversion budget`, path)
  }
  if (ctx.stack.has(target)) {
    return refusal('F1', 'the element tree contains a cycle, so it cannot be converted', path)
  }
  ctx.stack.add(target)
  return null
}

function leave(target: object, ctx: Ctx): void {
  ctx.stack.delete(target)
}

interface ElementParts {
  readonly type: unknown
  readonly props: Record<string, unknown>
  readonly children: unknown[]
}

function readElement(node: object): ElementParts {
  const record = node as Record<string, unknown>
  const props = isRecord(record['props']) ? record['props'] : {}
  const explicit = record['children']
  const nested = props['children']
  let children: unknown[] = []
  if (Array.isArray(explicit)) children = explicit
  else if (explicit !== undefined) children = [explicit]
  else if (Array.isArray(nested)) children = nested
  else if (nested !== undefined) children = [nested]
  return { type: record['type'], props, children }
}

function actionForEvent(
  event: SupportedEvent,
  props: Record<string, unknown>,
  ctx: Ctx,
): SlotAction | undefined {
  if (ctx.slotId === undefined) return undefined
  if (props[event] === undefined) return undefined
  return { slotId: ctx.slotId, event: EVENT_FOR_PROP[event] }
}

/**
 * Reject props we cannot honour. Order matters: dynamic code is refused before
 * anything else so a `dangerouslySetInnerHTML` tree is F6 even when it also
 * carries an unknown class name, and `style` is complex DOM rather than a prop
 * we quietly ignore.
 */
function checkProps(tag: string, props: Record<string, unknown>, path: string): Refusal | null {
  const allowedProps = PROPS_FOR_ELEMENT[tag] ?? []
  const allowedEvents = EVENTS_FOR_ELEMENT[tag] ?? []
  const isLayoutLike = (LAYOUT_ELEMENTS as readonly string[]).includes(tag) ||
    (INLINE_ELEMENTS as readonly string[]).includes(tag)

  for (const key of Object.keys(props)) {
    if (IGNORED_PROPS.includes(key)) continue
    if (DYNAMIC_CODE_PROPS.includes(key)) {
      return refusal('F6', `prop "${key}" runs code the host cannot see`, `${path}.${key}`)
    }
    if (key === 'style') {
      return refusal(
        'F5',
        'style objects are CSS the converter does not implement; use layout props or fall back',
        `${path}.style`,
      )
    }
    if (key.startsWith('on')) {
      if (!(SUPPORTED_EVENTS as readonly string[]).includes(key)) {
        return refusal('F3', `event "${key}" has no native equivalent`, `${path}.${key}`)
      }
      if (isLayoutLike && tag !== 'form') {
        return refusal(
          'F5',
          `an interactive <${tag}> is complex DOM: a click handler on a layout element has no native node`,
          `${path}.${key}`,
        )
      }
      if (!allowedEvents.includes(key as SupportedEvent)) {
        return refusal('F3', `event "${key}" is not supported on <${tag}>`, `${path}.${key}`)
      }
      continue
    }
    if (!allowedProps.includes(key)) {
      return refusal('F2', `prop "${key}" is not supported on <${tag}>`, `${path}.${key}`)
    }
  }

  if (tag === 'a') {
    const href = props['href']
    if (typeof href !== 'string' || href.length === 0) {
      return refusal('F2', 'a link needs a string href', `${path}.href`)
    }
    if (/^\s*javascript:/i.test(href)) {
      return refusal('F6', 'javascript: URLs execute code and are never rendered', `${path}.href`)
    }
    if (!/^https:\/\//i.test(href)) {
      return refusal('F2', 'only https links are supported, so the href is refused', `${path}.href`)
    }
  }

  return null
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  return ''
}

/** Plain text of an inline subtree, used for labels and the text fallback. */
function inlineText(nodes: readonly unknown[], ctx: Ctx): string {
  let text = ''
  for (const node of nodes) {
    if (typeof node === 'string' || typeof node === 'number') {
      text += textOf(node)
      continue
    }
    if (Array.isArray(node)) {
      text += inlineText(node, ctx)
      continue
    }
    if (!isRecord(node)) continue
    const parts = readElement(node)
    text += inlineText(parts.children, ctx)
  }
  return text
}

function convertInline(node: unknown, ctx: Ctx, path: string): Attempt<NativeInline[]> {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return { ok: true, value: [] }
  }
  if (typeof node === 'string' || typeof node === 'number') {
    const text = textOf(node)
    return text.length === 0 ? { ok: true, value: [] } : { ok: true, value: [{ kind: 'text', text }] }
  }
  if (typeof node === 'function' || typeof node === 'symbol') {
    return refusal('F4', 'a component type cannot be converted without a React runtime', path)
  }
  if (Array.isArray(node)) {
    const entered = enter(node, ctx, path)
    if (entered !== null) return entered
    const collected: NativeInline[] = []
    for (let index = 0; index < node.length; index += 1) {
      const child = convertInline(node[index], ctx, `${path}[${index}]`)
      if (!child.ok) {
        leave(node, ctx)
        return child
      }
      collected.push(...child.value)
    }
    leave(node, ctx)
    return { ok: true, value: collected }
  }
  if (!isRecord(node)) {
    return refusal('F1', `a ${typeof node} value is not a renderable element`, path)
  }

  const entered = enter(node, ctx, path)
  if (entered !== null) return entered
  ctx.depth += 1
  if (ctx.depth > MAX_DEPTH) {
    ctx.depth -= 1
    leave(node, ctx)
    return refusal('F1', `the element tree is deeper than ${MAX_DEPTH} levels`, path)
  }

  const result = convertInlineElement(node, ctx, path)
  ctx.depth -= 1
  leave(node, ctx)
  return result
}

function convertInlineElement(node: object, ctx: Ctx, path: string): Attempt<NativeInline[]> {
  const { type, props, children } = readElement(node)
  if (typeof type === 'function' || typeof type === 'symbol') {
    return refusal('F4', 'a component type cannot be converted without a React runtime', path)
  }
  if (typeof type !== 'string') {
    return refusal('F4', 'a component object cannot be converted without a React runtime', path)
  }
  if (!SUPPORTED_ELEMENTS.includes(type)) {
    return refusal('F1', `element <${type}> is outside the supported subset`, path)
  }

  const refused = checkProps(type, props, path)
  if (refused !== null) return refused

  switch (type) {
    case 'strong':
    case 'b': {
      const inner = convertInlineChildren(children, ctx, path)
      if (!inner.ok) return inner
      return { ok: true, value: [{ kind: 'strong', children: inner.value }] }
    }
    case 'em':
    case 'i': {
      const inner = convertInlineChildren(children, ctx, path)
      if (!inner.ok) return inner
      return { ok: true, value: [{ kind: 'emphasis', children: inner.value }] }
    }
    case 'code': {
      const inner = convertInlineChildren(children, ctx, path)
      if (!inner.ok) return inner
      return { ok: true, value: [{ kind: 'code', children: inner.value }] }
    }
    case 'a': {
      const href = props['href']
      if (typeof href !== 'string') {
        return refusal('F2', 'a link needs a string href', `${path}.href`)
      }
      const inner = convertInlineChildren(children, ctx, path)
      if (!inner.ok) return inner
      return { ok: true, value: [{ kind: 'link', href, children: inner.value }] }
    }
    case 'span': {
      return convertInlineChildren(children, ctx, path)
    }
    case 'br': {
      return { ok: true, value: [{ kind: 'text', text: '\n' }] }
    }
    default:
      return refusal(
        'F1',
        `element <${type}> is a block element and cannot sit inside inline text`,
        path,
      )
  }
}

function convertInlineChildren(
  children: readonly unknown[],
  ctx: Ctx,
  path: string,
): Attempt<NativeInline[]> {
  const collected: NativeInline[] = []
  for (let index = 0; index < children.length; index += 1) {
    const child = convertInline(children[index], ctx, `${path}.children[${index}]`)
    if (!child.ok) return child
    collected.push(...child.value)
  }
  return { ok: true, value: collected }
}

function convertBlock(node: unknown, ctx: Ctx, path: string): Attempt<NativeNode | null> {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return { ok: true, value: null }
  }
  if (typeof node === 'string' || typeof node === 'number') {
    const text = textOf(node)
    if (text.length === 0) return { ok: true, value: null }
    return { ok: true, value: { kind: 'paragraph', children: [{ kind: 'text', text }] } }
  }
  if (typeof node === 'function' || typeof node === 'symbol') {
    return refusal('F4', 'a component type cannot be converted without a React runtime', path)
  }
  if (Array.isArray(node)) {
    const entered = enter(node, ctx, path)
    if (entered !== null) return entered
    const children: NativeNode[] = []
    for (let index = 0; index < node.length; index += 1) {
      const child = convertBlock(node[index], ctx, `${path}[${index}]`)
      if (!child.ok) {
        leave(node, ctx)
        return child
      }
      if (child.value !== null) children.push(child.value)
    }
    leave(node, ctx)
    return { ok: true, value: { kind: 'container', direction: 'column', children } }
  }
  if (!isRecord(node)) {
    return refusal('F1', `a ${typeof node} value is not a renderable element`, path)
  }

  const entered = enter(node, ctx, path)
  if (entered !== null) return entered
  ctx.depth += 1
  if (ctx.depth > MAX_DEPTH) {
    ctx.depth -= 1
    leave(node, ctx)
    return refusal('F1', `the element tree is deeper than ${MAX_DEPTH} levels`, path)
  }

  const result = convertBlockElement(node, ctx, path)
  ctx.depth -= 1
  leave(node, ctx)
  return result
}

function convertBlockElement(node: object, ctx: Ctx, path: string): Attempt<NativeNode | null> {
  const { type, props, children } = readElement(node)
  if (typeof type === 'function' || typeof type === 'symbol') {
    return refusal('F4', 'a component type cannot be converted without a React runtime', path)
  }
  if (typeof type !== 'string') {
    return refusal('F4', 'a component object cannot be converted without a React runtime', path)
  }
  if (!SUPPORTED_ELEMENTS.includes(type)) {
    return refusal('F1', `element <${type}> is outside the supported subset`, path)
  }

  const refused = checkProps(type, props, path)
  if (refused !== null) return refused

  if ((LAYOUT_ELEMENTS as readonly string[]).includes(type)) {
    return convertLayout(type, props, children, ctx, path)
  }
  if (type === 'hr') {
    return { ok: true, value: { kind: 'separator' } }
  }
  if (type === 'pre') {
    const language = props['data-language'] ?? props['language']
    const text = inlineText(children, ctx)
    return {
      ok: true,
      value: {
        kind: 'pre',
        text,
        ...(typeof language === 'string' && language.length > 0 ? { language } : {}),
      },
    }
  }
  if ((LIST_ELEMENTS as readonly string[]).includes(type)) {
    return convertList(type === 'ol', children, ctx, path)
  }
  if (type === 'h1' || type === 'h2' || type === 'h3') {
    const level = Number(type.slice(1)) as 1 | 2 | 3
    const inner = convertInlineChildren(children, ctx, path)
    if (!inner.ok) return inner
    return { ok: true, value: { kind: 'heading', level, children: inner.value } }
  }
  if ((TEXT_BLOCK_ELEMENTS as readonly string[]).includes(type)) {
    const inner = convertInlineChildren(children, ctx, path)
    if (!inner.ok) return inner
    return { ok: true, value: { kind: 'paragraph', children: inner.value } }
  }
  if (type === 'button') {
    const action = actionForEvent('onClick', props, ctx)
    const variant = props['variant']
    const tone = typeof variant === 'string' ? BUTTON_TONES[variant] : 'default'
    if (tone === undefined) {
      return refusal('F2', `button variant "${String(variant)}" has no native tone`, `${path}.variant`)
    }
    return {
      ok: true,
      value: {
        kind: 'button',
        label: inlineText(children, ctx),
        disabled: props['disabled'] === true,
        tone,
        ...(action === undefined ? {} : { action }),
      },
    }
  }
  if (type === 'input' || type === 'textarea' || type === 'select') {
    return convertControl(type, props, children, ctx, path)
  }
  // Inline-only elements used in block position still render as text.
  const inner = convertInlineChildren(children, ctx, path)
  if (!inner.ok) return inner
  if (type === 'a') {
    const href = props['href']
    if (typeof href !== 'string') return refusal('F2', 'a link needs a string href', `${path}.href`)
    return { ok: true, value: { kind: 'paragraph', children: [{ kind: 'link', href, children: inner.value }] } }
  }
  return { ok: true, value: { kind: 'paragraph', children: inner.value } }
}

function convertLayout(
  tag: string,
  props: Record<string, unknown>,
  children: readonly unknown[],
  ctx: Ctx,
  path: string,
): Attempt<NativeNode | null> {
  const role = props['role']
  if (role === 'radiogroup') {
    return convertRadioGroup(props, children, ctx, path)
  }
  if (role !== undefined && role !== 'group' && role !== 'radiogroup') {
    return refusal('F2', `role "${String(role)}" has no native meaning`, `${path}.role`)
  }

  let direction: 'row' | 'column' = 'column'
  const display = props['display']
  if (display !== undefined) {
    if (typeof display !== 'string') {
      return refusal('F2', 'display must be a string', `${path}.display`)
    }
    const mapped = DISPLAY_VALUES[display]
    if (mapped === undefined) {
      return refusal('F2', `display "${display}" is not a supported layout`, `${path}.display`)
    }
    direction = mapped
  }
  const flexDirection = props['flexDirection']
  if (flexDirection !== undefined) {
    if (typeof flexDirection !== 'string') {
      return refusal('F2', 'flexDirection must be a string', `${path}.flexDirection`)
    }
    const mapped = FLEX_DIRECTION_VALUES[flexDirection]
    if (mapped === undefined) {
      return refusal(
        'F2',
        `flexDirection "${flexDirection}" is not supported (row and column only)`,
        `${path}.flexDirection`,
      )
    }
    direction = mapped
  }

  const gap = props['gap'] === undefined ? undefined : finiteNumber(props['gap'])
  if (props['gap'] !== undefined && gap === undefined) {
    return refusal('F2', 'gap must be a finite number', `${path}.gap`)
  }
  const padding = props['padding'] === undefined ? undefined : finiteNumber(props['padding'])
  if (props['padding'] !== undefined && padding === undefined) {
    return refusal('F2', 'padding must be a finite number', `${path}.padding`)
  }

  const alignItems = props['alignItems']
  let align: string | undefined
  if (alignItems !== undefined) {
    if (typeof alignItems !== 'string') {
      return refusal('F2', 'alignItems must be a string', `${path}.alignItems`)
    }
    align = ALIGN_VALUES[alignItems]
    if (align === undefined) {
      return refusal('F2', `alignItems "${alignItems}" is not supported`, `${path}.alignItems`)
    }
  }

  const justifyContent = props['justifyContent']
  let justify: string | undefined
  if (justifyContent !== undefined) {
    if (typeof justifyContent !== 'string') {
      return refusal('F2', 'justifyContent must be a string', `${path}.justifyContent`)
    }
    justify = JUSTIFY_VALUES[justifyContent]
    if (justify === undefined) {
      return refusal('F2', `justifyContent "${justifyContent}" is not supported`, `${path}.justifyContent`)
    }
  }

  const overflow = props['overflow']
  let scroll: boolean | undefined
  if (overflow !== undefined) {
    if (typeof overflow !== 'string') {
      return refusal('F2', 'overflow must be a string', `${path}.overflow`)
    }
    scroll = SCROLL_VALUES[overflow]
    if (scroll === undefined) {
      return refusal('F2', `overflow "${overflow}" is not supported`, `${path}.overflow`)
    }
  }

  const childrenNodes: NativeNode[] = []
  for (let index = 0; index < children.length; index += 1) {
    const child = convertBlock(children[index], ctx, `${path}.children[${index}]`)
    if (!child.ok) return child
    if (child.value !== null) childrenNodes.push(child.value)
  }

  const action = tag === 'form' ? actionForEvent('onSubmit', props, ctx) : undefined

  return {
    ok: true,
    value: {
      kind: 'container',
      direction,
      children: childrenNodes,
      ...(gap === undefined ? {} : { gap }),
      ...(padding === undefined ? {} : { padding }),
      ...(align === undefined ? {} : { align }),
      ...(justify === undefined ? {} : { justify }),
      ...(scroll === undefined ? {} : { scroll }),
      ...(action === undefined ? {} : { action }),
    },
  }
}

function convertRadioGroup(
  props: Record<string, unknown>,
  children: readonly unknown[],
  ctx: Ctx,
  path: string,
): Attempt<NativeNode> {
  const options: SelectOption[] = []
  let action: SlotAction | undefined
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (!isRecord(child)) {
      return refusal('F1', 'a radiogroup may only contain radio inputs', `${path}.children[${index}]`)
    }
    const parts = readElement(child)
    if (parts.type !== 'input' || parts.props['type'] !== 'radio') {
      return refusal('F1', 'a radiogroup may only contain radio inputs', `${path}.children[${index}]`)
    }
    const refused = checkProps('input', parts.props, `${path}.children[${index}]`)
    if (refused !== null) return refused
    const value = parts.props['value']
    if (typeof value !== 'string' || value.length === 0) {
      return refusal('F2', 'a radio input needs a string value', `${path}.children[${index}].value`)
    }
    const label = parts.props['label']
    options.push({ value, label: typeof label === 'string' ? label : value })
    action ??= actionForEvent('onChange', parts.props, ctx)
  }

  const value = props['value']
  if (value !== undefined && typeof value !== 'string') {
    return refusal('F2', 'a radiogroup value must be a string', `${path}.value`)
  }

  return {
    ok: true,
    value: {
      kind: 'radiogroup',
      options,
      disabled: props['disabled'] === true,
      ...(value === undefined ? {} : { value }),
      ...(action === undefined ? {} : { action }),
    },
  }
}

function convertControl(
  tag: string,
  props: Record<string, unknown>,
  children: readonly unknown[],
  ctx: Ctx,
  path: string,
): Attempt<NativeNode> {
  const disabled = props['disabled'] === true

  if (tag === 'select') {
    const options: SelectOption[] = []
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]
      if (!isRecord(child)) {
        return refusal('F1', 'a select may only contain option elements', `${path}.children[${index}]`)
      }
      const parts = readElement(child)
      if (parts.type !== 'option') {
        return refusal('F1', 'a select may only contain option elements', `${path}.children[${index}]`)
      }
      const value = parts.props['value']
      const text = inlineText(parts.children, ctx)
      const optionValue = typeof value === 'string' ? value : text
      if (optionValue.length === 0) {
        return refusal('F2', 'an option needs a value', `${path}.children[${index}]`)
      }
      const label = parts.props['label']
      options.push({ value: optionValue, label: typeof label === 'string' ? label : text || optionValue })
    }
    const value = props['value']
    if (value !== undefined && typeof value !== 'string') {
      return refusal('F2', 'a select value must be a string', `${path}.value`)
    }
    const action = actionForEvent('onChange', props, ctx)
    return {
      ok: true,
      value: {
        kind: 'select',
        options,
        disabled,
        ...(value === undefined ? {} : { value }),
        ...(action === undefined ? {} : { action }),
      },
    }
  }

  const action = actionForEvent('onChange', props, ctx)

  if (tag === 'textarea') {
    const value = props['value']
    const placeholder = props['placeholder']
    const maxLength = props['maxLength'] === undefined ? undefined : finiteNumber(props['maxLength'])
    if (props['maxLength'] !== undefined && maxLength === undefined) {
      return refusal('F2', 'maxLength must be a finite number', `${path}.maxLength`)
    }
    return {
      ok: true,
      value: {
        kind: 'field',
        control: 'multiline',
        disabled,
        readOnly: props['readOnly'] === true,
        ...(typeof value === 'string' || typeof value === 'number' ? { value } : {}),
        ...(typeof placeholder === 'string' ? { placeholder } : {}),
        ...(maxLength === undefined ? {} : { maxLength }),
        ...(action === undefined ? {} : { action }),
      },
    }
  }

  // <input>
  const type = props['type'] === undefined ? 'text' : props['type']
  if (typeof type !== 'string' || !INPUT_TYPES.includes(type)) {
    return refusal('F2', `input type "${String(type)}" is not supported`, `${path}.type`)
  }

  if (type === 'checkbox') {
    const label = props['label']
    return {
      ok: true,
      value: {
        kind: 'checkbox',
        checked: props['checked'] === true,
        disabled,
        ...(typeof label === 'string' ? { label } : {}),
        ...(action === undefined ? {} : { action }),
      },
    }
  }

  if (type === 'radio') {
    return refusal(
      'F1',
      'a radio input must sit inside a radiogroup so the group can carry the value',
      path,
    )
  }

  if (type === 'range') {
    const min = finiteNumber(props['min']) ?? 0
    const max = finiteNumber(props['max']) ?? 100
    const step = finiteNumber(props['step']) ?? 1
    if (max <= min) {
      return refusal('F2', 'a slider needs max greater than min', `${path}.max`)
    }
    const rawValue = finiteNumber(props['value']) ?? min
    const value = Math.min(Math.max(rawValue, min), max)
    return {
      ok: true,
      value: {
        kind: 'slider',
        min,
        max,
        step: step > 0 ? step : 1,
        value,
        disabled,
        ...(action === undefined ? {} : { action }),
      },
    }
  }

  const control = type === 'password' ? 'password' : type === 'number' ? 'number' : 'text'
  const value = props['value']
  const placeholder = props['placeholder']
  const maxLength = props['maxLength'] === undefined ? undefined : finiteNumber(props['maxLength'])
  if (props['maxLength'] !== undefined && maxLength === undefined) {
    return refusal('F2', 'maxLength must be a finite number', `${path}.maxLength`)
  }
  return {
    ok: true,
    value: {
      kind: 'field',
      control,
      disabled,
      readOnly: props['readOnly'] === true,
      ...(typeof value === 'string' || typeof value === 'number' ? { value } : {}),
      ...(typeof placeholder === 'string' ? { placeholder } : {}),
      ...(maxLength === undefined ? {} : { maxLength }),
      ...(action === undefined ? {} : { action }),
    },
  }
}

function convertList(
  ordered: boolean,
  children: readonly unknown[],
  ctx: Ctx,
  path: string,
): Attempt<NativeNode> {
  const items: NativeInline[][] = []
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (!isRecord(child)) {
      return refusal('F1', 'a list may only contain list items', `${path}.children[${index}]`)
    }
    const parts = readElement(child)
    if (parts.type !== 'li') {
      return refusal('F1', 'a list may only contain list items', `${path}.children[${index}]`)
    }
    const refused = checkProps('li', parts.props, `${path}.children[${index}]`)
    if (refused !== null) return refused
    const inner = convertInlineChildren(parts.children, ctx, `${path}.children[${index}]`)
    if (!inner.ok) return inner
    items.push(inner.value)
  }
  return { ok: true, value: { kind: 'list', ordered, items } }
}

/**
 * Best-effort readable text for the text fallback. Cycle-safe and budgeted: a
 * malformed tree must degrade to *some* text, never to a hang.
 */
function extractText(input: unknown): string {
  const parts: string[] = []
  const seen = new Set<object>()
  let budget = MAX_NODES
  const walk = (node: unknown): void => {
    if (budget <= 0) return
    budget -= 1
    if (typeof node === 'string') {
      parts.push(node)
      return
    }
    if (typeof node === 'number') {
      parts.push(String(node))
      return
    }
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    const record = node as Record<string, unknown>
    walk(record['children'])
    const props = record['props']
    if (isRecord(props)) walk(props['children'])
  }
  walk(input)
  const text = parts.join(' ').replace(/\s+/g, ' ').trim()
  return text.length > MAX_FALLBACK_TEXT ? `${text.slice(0, MAX_FALLBACK_TEXT)}…` : text
}

/**
 * Convert a slot render result.
 *
 * A refusal becomes `web` when the slot declared a web entry and `text`
 * otherwise — the caller must never be left with an empty panel, and this
 * function never guesses which of the two the user would have preferred.
 */
export function convertSlotTree(input: unknown, options: ConvertOptions = {}): ConversionResult {
  const ctx: Ctx = {
    slotId: options.slotId,
    stack: new Set<object>(),
    budget: { nodes: 0 },
    depth: 0,
  }

  const attempt = convertBlock(input, ctx, '$')
  if (attempt.ok) {
    return {
      status: 'native',
      tree: attempt.value ?? { kind: 'container', direction: 'column', children: [] },
    }
  }

  const reason = attempt.reason
  const text = extractText(input)
  if (options.webEntry !== undefined && options.webEntry.kind === 'declared') {
    return { status: 'web', reason }
  }
  return { status: 'text', reason, text }
}
