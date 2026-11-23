/**
 * Unit tests for the limited React-tree → native QML conversion (I4, plan §3.6).
 *
 * The converter is a pure function: it takes the element tree a slot produced
 * and either maps it onto the frozen native vocabulary or refuses with one of
 * the six reason codes. There is no React runtime here and no guessing — the
 * point of these tests is that the *supported* subset converts exactly and the
 * *unsupported* subset falls back explicitly instead of being approximated.
 *
 * Fallback direction depends on the slot's `client.webEntry` declaration: a slot
 * that ships a web entry is sent to the WebView, everything else degrades to
 * text (P1/P3). Both directions are asserted here.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  convertSlotTree,
  CONVERSION_REASON_NAMES,
} from '../src/ui/converter.js'
import type { ConversionReasonCode, NativeNode } from '../src/ui/converter.js'
import { QML_COMPONENT_FOR_KIND, isSupportedUiType } from '../src/ui/controls.js'

const h = (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => ({
  type,
  ...(props === undefined || props === null ? {} : { props }),
  ...(children.length === 0 ? {} : { children }),
})

/** Convert and require success, so a refusal names itself in the failure. */
function native(input: unknown, options: Record<string, unknown> = {}): NativeNode {
  const result = convertSlotTree(input, { slotId: 'acme.panel', ...options })
  assert.equal(
    result.status,
    'native',
    `expected a native tree, got ${result.status}: ${JSON.stringify(result)}`,
  )
  return (result as { tree: NativeNode }).tree
}

/** Convert and require a refusal with the expected reason code. */
function refused(input: unknown, code: ConversionReasonCode, options: Record<string, unknown> = {}) {
  const result = convertSlotTree(input, { slotId: 'acme.panel', ...options })
  assert.notEqual(result.status, 'native', 'expected a refusal, got a native tree')
  const reason = (result as { reason: { code: ConversionReasonCode; name: string } }).reason
  assert.equal(reason.code, code, `expected ${code}, got ${reason.code}: ${JSON.stringify(result)}`)
  assert.equal(reason.name, CONVERSION_REASON_NAMES[code])
  return result as { status: 'web' | 'text'; reason: { detail: string }; text?: string }
}

test('text, headings, lists and emphasis convert to the native text vocabulary', () => {
  const tree = native(
    h(
      'div',
      { display: 'flex', flexDirection: 'column', gap: 8 },
      h('h1', null, 'Plugins'),
      h('h2', null, 'Installed'),
      h('p', null, 'Two bundles are ', h('strong', null, 'active'), ' and one is ', h('em', null, 'idle'), '.'),
      h('ul', null, h('li', null, 'alpha'), h('li', null, 'beta')),
      h('ol', null, h('li', null, 'first'), h('li', null, 'second')),
    ),
  )

  assert.deepEqual(tree, {
    kind: 'container',
    direction: 'column',
    gap: 8,
    children: [
      { kind: 'heading', level: 1, children: [{ kind: 'text', text: 'Plugins' }] },
      { kind: 'heading', level: 2, children: [{ kind: 'text', text: 'Installed' }] },
      {
        kind: 'paragraph',
        children: [
          { kind: 'text', text: 'Two bundles are ' },
          { kind: 'strong', children: [{ kind: 'text', text: 'active' }] },
          { kind: 'text', text: ' and one is ' },
          { kind: 'emphasis', children: [{ kind: 'text', text: 'idle' }] },
          { kind: 'text', text: '.' },
        ],
      },
      {
        kind: 'list',
        ordered: false,
        items: [[{ kind: 'text', text: 'alpha' }], [{ kind: 'text', text: 'beta' }]],
      },
      {
        kind: 'list',
        ordered: true,
        items: [[{ kind: 'text', text: 'first' }], [{ kind: 'text', text: 'second' }]],
      },
    ],
  })
})

test('inline code, preformatted blocks and https links convert', () => {
  const tree = native(
    h(
      'div',
      { display: 'flex', flexDirection: 'column' },
      h('p', null, 'Set ', h('code', null, 'retries'), ' first.'),
      h('pre', { 'data-language': 'toml' }, 'retries = 3'),
      h('p', null, h('a', { href: 'https://example.com/docs' }, 'docs')),
    ),
  )

  assert.deepEqual(tree, {
    kind: 'container',
    direction: 'column',
    children: [
      {
        kind: 'paragraph',
        children: [
          { kind: 'text', text: 'Set ' },
          { kind: 'code', children: [{ kind: 'text', text: 'retries' }] },
          { kind: 'text', text: ' first.' },
        ],
      },
      { kind: 'pre', text: 'retries = 3', language: 'toml' },
      {
        kind: 'paragraph',
        children: [
          {
            kind: 'link',
            href: 'https://example.com/docs',
            children: [{ kind: 'text', text: 'docs' }],
          },
        ],
      },
    ],
  })
})

test('layout containers carry direction, spacing and scroll intent', () => {
  const tree = native(
    h(
      'div',
      {
        display: 'flex',
        flexDirection: 'row',
        gap: 4,
        padding: 12,
        alignItems: 'center',
        justifyContent: 'space-between',
        overflow: 'auto',
      },
      h('p', null, 'left'),
      h('hr'),
      h('p', null, 'right'),
    ),
  )

  assert.deepEqual(tree, {
    kind: 'container',
    direction: 'row',
    gap: 4,
    padding: 12,
    align: 'center',
    justify: 'space-between',
    scroll: true,
    children: [
      { kind: 'paragraph', children: [{ kind: 'text', text: 'left' }] },
      { kind: 'separator' },
      { kind: 'paragraph', children: [{ kind: 'text', text: 'right' }] },
    ],
  })
})

test('buttons map to the QML button variants and carry a declarative action', () => {
  const tree = native(
    h(
      'div',
      { display: 'flex', flexDirection: 'row' },
      h('button', { onClick: { handler: 'disable' } }, 'Disable'),
      h('button', { onClick: { handler: 'remove' }, variant: 'danger', disabled: true }, 'Remove'),
    ),
  )

  assert.deepEqual(tree, {
    kind: 'container',
    direction: 'row',
    children: [
      {
        kind: 'button',
        label: 'Disable',
        disabled: false,
        tone: 'default',
        action: { slotId: 'acme.panel', event: 'click' },
      },
      {
        kind: 'button',
        label: 'Remove',
        disabled: true,
        tone: 'danger',
        action: { slotId: 'acme.panel', event: 'click' },
      },
    ],
  })
})

test('text inputs, multiline inputs and their controlled props convert', () => {
  const tree = native(
    h(
      'div',
      { display: 'flex', flexDirection: 'column' },
      h('input', {
        type: 'text',
        value: 'acme',
        placeholder: 'package name',
        maxLength: 64,
        onChange: { handler: 'rename' },
      }),
      h('input', { type: 'password', value: '', readOnly: true, disabled: true }),
      h('textarea', { value: 'notes', rows: 3, onChange: { handler: 'note' } }),
    ),
  )

  assert.deepEqual(tree, {
    kind: 'container',
    direction: 'column',
    children: [
      {
        kind: 'field',
        control: 'text',
        disabled: false,
        readOnly: false,
        value: 'acme',
        placeholder: 'package name',
        maxLength: 64,
        action: { slotId: 'acme.panel', event: 'change' },
      },
      {
        kind: 'field',
        control: 'password',
        disabled: true,
        readOnly: true,
        value: '',
      },
      {
        kind: 'field',
        control: 'multiline',
        disabled: false,
        readOnly: false,
        value: 'notes',
        action: { slotId: 'acme.panel', event: 'change' },
      },
    ],
  })
})

test('selects, checkboxes, radio groups and sliders convert', () => {
  const tree = native(
    h(
      'div',
      { display: 'flex', flexDirection: 'column' },
      h(
        'select',
        { value: 'warn', onChange: { handler: 'level' } },
        h('option', { value: 'info' }, 'Info'),
        h('option', { value: 'warn' }, 'Warning'),
      ),
      h('input', { type: 'checkbox', checked: true, label: 'Auto-update', onChange: { handler: 'auto' } }),
      h(
        'div',
        { role: 'radiogroup', value: 'b' },
        h('input', { type: 'radio', value: 'a', label: 'A', onChange: { handler: 'pick' } }),
        h('input', { type: 'radio', value: 'b', label: 'B', onChange: { handler: 'pick' } }),
      ),
      h('input', { type: 'range', min: 1, max: 8, step: 1, value: 4, onChange: { handler: 'pool' } }),
    ),
  )

  assert.deepEqual(tree, {
    kind: 'container',
    direction: 'column',
    children: [
      {
        kind: 'select',
        options: [
          { value: 'info', label: 'Info' },
          { value: 'warn', label: 'Warning' },
        ],
        disabled: false,
        value: 'warn',
        action: { slotId: 'acme.panel', event: 'change' },
      },
      {
        kind: 'checkbox',
        checked: true,
        disabled: false,
        label: 'Auto-update',
        action: { slotId: 'acme.panel', event: 'change' },
      },
      {
        kind: 'radiogroup',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        disabled: false,
        value: 'b',
        action: { slotId: 'acme.panel', event: 'change' },
      },
      {
        kind: 'slider',
        min: 1,
        max: 8,
        step: 1,
        value: 4,
        disabled: false,
        action: { slotId: 'acme.panel', event: 'change' },
      },
    ],
  })
})

test('a form submit handler becomes a submit action on the form container', () => {
  const tree = native(
    h(
      'form',
      { onSubmit: { handler: 'save' }, display: 'flex', flexDirection: 'column' },
      h('input', { type: 'text', value: 'x' }),
    ),
  )

  assert.deepEqual(tree, {
    kind: 'container',
    direction: 'column',
    action: { slotId: 'acme.panel', event: 'submit' },
    children: [
      { kind: 'field', control: 'text', disabled: false, readOnly: false, value: 'x' },
    ],
  })
})

test('an interactive div is complex DOM and falls back instead of being guessed', () => {
  const refusedTree = refused(h('div', { onClick: { handler: 'open' } }, 'Open'), 'F5')
  assert.equal(refusedTree.status, 'text')
  assert.match(refusedTree.text ?? '', /Open/)

  // Same tree, but the slot ships a web entry: the WebView takes it instead.
  const toWeb = refused(h('div', { onClick: { handler: 'open' } }, 'Open'), 'F5', {
    webEntry: { kind: 'declared', url: 'https://example.com/plugin' },
  })
  assert.equal(toWeb.status, 'web')
})

test('absolute positioning and rich style objects are complex DOM', () => {
  refused(h('div', { style: { position: 'absolute', top: 0, color: 'red' } }, 'x'), 'F5')
  refused(h('span', { style: { background: 'linear-gradient(red, blue)' } }, 'x'), 'F5')
})

test('a third-party component is refused as F4, never rendered as a div', () => {
  function ThirdPartyChart() {
    return null
  }
  refused(h(ThirdPartyChart), 'F4')
  refused(h({ $$typeof: Symbol.for('react.memo'), type: ThirdPartyChart }), 'F4')
})

test('dangerouslySetInnerHTML and javascript: URLs are refused as dynamic code', () => {
  refused(h('div', { dangerouslySetInnerHTML: { __html: '<b>x</b>' } }, 'x'), 'F6')
  refused(h('a', { href: 'javascript:alert(1)' }, 'click'), 'F6')
  refused(h('p', null, 'x', h('code', { eval: 'require("fs")' }, 'y')), 'F6')
})

test('a non-https link is an unsupported prop, not a silent rewrite', () => {
  refused(h('a', { href: 'http://example.com' }, 'docs'), 'F2')
})

test('unknown elements are F1, and iframe/canvas are never approximated', () => {
  refused(h('marquee', null, 'hello'), 'F1')
  refused(h('iframe', { src: 'https://example.com' }), 'F1')
  refused(h('canvas', { width: 100, height: 100 }), 'F1')
  refused(h('svg', { viewBox: '0 0 10 10' }), 'F1')
})

test('an unknown prop is F2 and an unknown event is F3', () => {
  refused(h('button', { onClick: { handler: 'go' }, className: 'primary' }, 'Go'), 'F2')
  refused(h('button', { onMouseEnter: { handler: 'hover' } }, 'Go'), 'F3')
})

test('the refusal keeps the reason code names frozen by the plan', () => {
  assert.deepEqual(CONVERSION_REASON_NAMES, {
    F1: 'unsupported-element',
    F2: 'unsupported-prop',
    F3: 'unsupported-event',
    F4: 'third-party-component',
    F5: 'complex-dom',
    F6: 'dynamic-code',
  })
})

test('the fallback text keeps what the user can still read', () => {
  const result = refused(
    h('div', null, h('h2', null, 'Status'), h('p', null, 'two bundles active'), h('canvas')),
    'F1',
  )
  assert.equal(result.status, 'text')
  assert.match(result.text ?? '', /Status/)
  assert.match(result.text ?? '', /two bundles active/)
  assert.match(result.reason.detail, /canvas/)
})

test('a tree without any schema still converts: schema is not the conversion path', () => {
  // Nothing here declares a schema or a ui.type; the conversion must stand alone.
  const tree = native(h('p', null, 'plain'))
  assert.deepEqual(tree, { kind: 'paragraph', children: [{ kind: 'text', text: 'plain' }] })
})

test('every native kind names a QML component the settings panel can host', () => {
  const kinds: NativeNode['kind'][] = [
    'paragraph',
    'heading',
    'list',
    'pre',
    'container',
    'separator',
    'button',
    'field',
    'select',
    'checkbox',
    'radiogroup',
    'slider',
  ]
  for (const kind of kinds) {
    assert.equal(typeof QML_COMPONENT_FOR_KIND[kind], 'string', `no QML component for ${kind}`)
    assert.ok(QML_COMPONENT_FOR_KIND[kind].length > 0)
  }
})

test('the ui.type catalogue is closed and unknown control types are reported', () => {
  for (const type of ['select', 'slider', 'toggle', 'text', 'number', 'color']) {
    assert.equal(isSupportedUiType(type), true, `${type} should be supported`)
  }
  for (const type of ['rich-editor', 'chart', '', null, 42, undefined]) {
    assert.equal(isSupportedUiType(type), false, `${String(type)} should not be supported`)
  }
})

test('a cyclic tree is refused instead of hanging the host', () => {
  const node: Record<string, unknown> = { type: 'div', props: { display: 'flex', flexDirection: 'column' } }
  const children: unknown[] = []
  children.push({ type: 'div', props: { display: 'flex', flexDirection: 'column' }, children })
  node['children'] = children
  refused(node, 'F1')
})

test('a tree that exceeds the node budget is refused', () => {
  const many: unknown[] = []
  for (let index = 0; index < 5001; index += 1) many.push(h('p', null, `row ${index}`))
  refused(h('div', { display: 'flex', flexDirection: 'column' }, ...many), 'F1')
})

test('plain strings and arrays are accepted as the slot root', () => {
  assert.deepEqual(convertSlotTree('hello'), {
    status: 'native',
    tree: { kind: 'paragraph', children: [{ kind: 'text', text: 'hello' }] },
  })
  const list = convertSlotTree([h('p', null, 'a'), h('p', null, 'b')], { slotId: 's' })
  assert.equal(list.status, 'native')
  assert.deepEqual((list as { tree: NativeNode }).tree, {
    kind: 'container',
    direction: 'column',
    children: [
      { kind: 'paragraph', children: [{ kind: 'text', text: 'a' }] },
      { kind: 'paragraph', children: [{ kind: 'text', text: 'b' }] },
    ],
  })
})

test('actions are omitted when the caller cannot name a slot', () => {
  const result = convertSlotTree(h('button', { onClick: { handler: 'go' } }, 'Go'))
  assert.equal(result.status, 'native')
  assert.deepEqual((result as { tree: NativeNode }).tree, {
    kind: 'button',
    label: 'Go',
    disabled: false,
    tone: 'default',
  })
})
