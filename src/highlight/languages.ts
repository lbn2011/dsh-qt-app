// languages.ts — the languages the built-in tokenizer understands, and alias
// resolution for the fence info string.
//
// The tokenizer is intentionally small: Phase 2d needs python, javascript and
// bash to be genuinely coloured (they are what the agent emits), plus a generic
// fallback for everything else. Adding a language is a data edit here, not a code
// change, and an unknown language degrades to plain text rather than guessing.
import type { HighlightTokenType } from './types.js'

/** String delimiters a language accepts. */
export interface StringRule {
  open: string
  close: string
  /** True when the string may span lines (bash does, JS does not). */
  multiline?: boolean
  /** Escape character, if the language supports one. */
  escape?: string
}

/** A language the built-in tokenizer can colour. */
export interface LanguageSpec {
  id: string
  aliases: string[]
  keywords: string[]
  literals: string[]
  types: string[]
  lineComments: string[]
  blockComment?: { open: string; close: string }
  strings: StringRule[]
  /** True when `#`-style shebang lines should be treated as comments. */
  shebang?: boolean
  /** Character that starts a property/variable reference (e.g. bash `$`). */
  variablePrefix?: string
}

const JS_KEYWORDS = [
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
  'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'of', 'return', 'set', 'static',
  'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'yield', 'enum', 'namespace', 'declare', 'readonly', 'private',
  'protected', 'public', 'abstract', 'satisfies', 'keyof', 'infer',
]

const JS_LITERALS = ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']

const JS_TYPES = [
  'any', 'bigint', 'boolean', 'never', 'number', 'object', 'string', 'symbol',
  'unknown', 'Array', 'Promise', 'Map', 'Set', 'Record', 'Partial', 'Readonly',
]

const PYTHON_KEYWORDS = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if',
  'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield', 'match', 'case',
]

const PYTHON_LITERALS = ['True', 'False', 'None', 'NotImplemented', 'Ellipsis']

const PYTHON_TYPES = [
  'bool', 'bytes', 'dict', 'float', 'int', 'list', 'object', 'set', 'str',
  'tuple', 'type', 'Optional', 'List', 'Dict', 'Any', 'Callable', 'Iterable',
]

const BASH_KEYWORDS = [
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'in', 'function', 'select', 'time', 'return', 'break',
  'continue', 'local', 'export', 'readonly', 'declare', 'unset', 'shift',
  'source', 'alias', 'echo', 'printf', 'cd', 'set', 'exit', 'trap', 'wait',
]

const BASH_LITERALS = ['true', 'false']

const BASH_TYPES: string[] = []

const JSON_KEYWORDS: string[] = []
const JSON_LITERALS = ['true', 'false', 'null']
const JSON_TYPES: string[] = []

/** Every built-in language, keyed by canonical id. */
export const LANGUAGES: Record<string, LanguageSpec> = {
  javascript: {
    id: 'javascript',
    aliases: ['js', 'jsx', 'mjs', 'cjs', 'node'],
    keywords: JS_KEYWORDS,
    literals: JS_LITERALS,
    types: JS_TYPES,
    lineComments: ['//'],
    blockComment: { open: '/*', close: '*/' },
    strings: [
      { open: '"', close: '"', escape: '\\' },
      { open: "'", close: "'", escape: '\\' },
      { open: '`', close: '`', escape: '\\', multiline: true },
    ],
  },
  typescript: {
    id: 'typescript',
    aliases: ['ts', 'tsx', 'mts', 'cts'],
    keywords: JS_KEYWORDS,
    literals: JS_LITERALS,
    types: JS_TYPES,
    lineComments: ['//'],
    blockComment: { open: '/*', close: '*/' },
    strings: [
      { open: '"', close: '"', escape: '\\' },
      { open: "'", close: "'", escape: '\\' },
      { open: '`', close: '`', escape: '\\', multiline: true },
    ],
  },
  python: {
    id: 'python',
    aliases: ['py', 'python3', 'py3'],
    keywords: PYTHON_KEYWORDS,
    literals: PYTHON_LITERALS,
    types: PYTHON_TYPES,
    lineComments: ['#'],
    strings: [
      { open: '"""', close: '"""', multiline: true, escape: '\\' },
      { open: "'''", close: "'''", multiline: true, escape: '\\' },
      { open: '"', close: '"', escape: '\\' },
      { open: "'", close: "'", escape: '\\' },
    ],
    shebang: true,
  },
  bash: {
    id: 'bash',
    aliases: ['sh', 'shell', 'zsh', 'console', 'shellsession'],
    keywords: BASH_KEYWORDS,
    literals: BASH_LITERALS,
    types: BASH_TYPES,
    lineComments: ['#'],
    strings: [
      { open: '"', close: '"', multiline: true, escape: '\\' },
      { open: "'", close: "'", multiline: true },
    ],
    shebang: true,
    variablePrefix: '$',
  },
  json: {
    id: 'json',
    aliases: ['jsonc', 'json5'],
    keywords: JSON_KEYWORDS,
    literals: JSON_LITERALS,
    types: JSON_TYPES,
    lineComments: [],
    strings: [{ open: '"', close: '"', escape: '\\' }],
  },
  /** Generic fallback for languages we do not model: comments, strings, numbers. */
  plaintext: {
    id: 'plaintext',
    aliases: ['text', 'txt', 'plain', 'none', ''],
    keywords: [],
    literals: [],
    types: [],
    lineComments: [],
    strings: [],
  },
}

/** Canonical ids in menu order. */
export const LANGUAGE_IDS: string[] = Object.keys(LANGUAGES)

/** Alias → canonical id, including the canonical ids themselves. */
const ALIAS_INDEX: Map<string, string> = (() => {
  const index = new Map<string, string>()
  for (const [id, spec] of Object.entries(LANGUAGES)) {
    index.set(id, id)
    for (const alias of spec.aliases)
      index.set(alias, id)
  }
  return index
})()

/**
 * Resolve a fence info string to a canonical language id.
 *
 * The info string is often decorated (`js title="x"`, `{.python}`), so only the
 * first word is considered and a leading dot/brace is stripped. Unknown languages
 * return `null` — the caller decides whether that means "plain" or "detect".
 */
export function resolveLanguage(info: string | null | undefined): string | null {
  if (info === null || info === undefined)
    return null
  // A fence info string can be "python", "python {.foo}", "{.python}" or "js title".
  // Strip the decorative braces/dots first, then take the first word.
  const trimmed = info.trim().replace(/^[.{}]+/, '').replace(/[}]+$/, '')
  const first = trimmed.split(/[\s{]/)[0] ?? ''
  const cleaned = first.replace(/^[.{}]+/, '').replace(/[}]+$/, '').toLowerCase()
  if (cleaned === '')
    return null
  return ALIAS_INDEX.get(cleaned) ?? null
}

/** True when the language is modelled well enough to colour. */
export function isKnownLanguage(id: string | null | undefined): boolean {
  if (id === null || id === undefined)
    return false
  return ALIAS_INDEX.has(id) && id !== 'plaintext'
}

/** Token type used for a keyword/literal/type word. */
export function classifyWord(word: string, spec: LanguageSpec): HighlightTokenType {
  if (spec.keywords.includes(word))
    return 'keyword'
  if (spec.literals.includes(word))
    return 'literal'
  if (spec.types.includes(word))
    return 'type'
  return 'variable'
}
