// tokenizer.ts — the built-in, dependency-free tokenizer.
//
// A single forward scanner, same philosophy as the markdown parser in t10: one
// pass, no backtracking, no regex that can go quadratic on hostile input. Every
// step consumes at least one character, so the cost is linear in the input size.
//
// The tokenizer never validates the source. Half-written code, mixed tabs and
// spaces, an unterminated string or a stray brace all produce *some* token stream
// — a chat message is often a fragment, and refusing to colour it would be worse
// than colouring it approximately.
import { classifyWord } from './languages.js'
import type { LanguageSpec } from './languages.js'
import type { HighlightToken } from './types.js'

/** Characters that end an identifier. */
function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch)
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

const OPERATOR_CHARS = '+-*/%=<>!&|^~?:'
const PUNCTUATION_CHARS = '(){}[];,.'

/**
 * Tokenize `code` with `spec`.
 *
 * Adjacent uncoloured characters are merged into one `plain` token so the
 * rendered markup stays small: a 500-line block should not produce thousands of
 * one-character spans.
 */
export function tokenize(code: string, spec: LanguageSpec): HighlightToken[] {
  const tokens: HighlightToken[] = []
  let plain = ''
  const n = code.length
  let i = 0

  const flushPlain = (): void => {
    if (plain !== '') {
      tokens.push({ type: 'plain', value: plain })
      plain = ''
    }
  }
  const push = (type: HighlightToken['type'], value: string): void => {
    flushPlain()
    tokens.push({ type, value })
  }

  // A shebang is a comment even in languages whose comment marker is different.
  if (spec.shebang === true && code.startsWith('#!')) {
    let end = code.indexOf('\n')
    if (end === -1)
      end = n
    push('comment', code.slice(0, end))
    i = end
  }

  // Longest-first so `"""` wins over `"` and `//` over `/`.
  const lineComments = [...spec.lineComments].sort((a, b) => b.length - a.length)
  const strings = [...spec.strings].sort((a, b) => b.open.length - a.open.length)

  while (i < n) {
    const ch = code[i] as string

    // ---- line comment ----------------------------------------------------
    let matchedComment = false
    for (const marker of lineComments) {
      if (code.startsWith(marker, i)) {
        let end = code.indexOf('\n', i)
        if (end === -1)
          end = n
        push('comment', code.slice(i, end))
        i = end
        matchedComment = true
        break
      }
    }
    if (matchedComment)
      continue

    // ---- block comment ---------------------------------------------------
    if (spec.blockComment !== undefined && code.startsWith(spec.blockComment.open, i)) {
      const close = code.indexOf(spec.blockComment.close, i + spec.blockComment.open.length)
      const end = close === -1 ? n : close + spec.blockComment.close.length
      push('comment', code.slice(i, end))
      i = end
      continue
    }

    // ---- string ----------------------------------------------------------
    let matchedString = false
    for (const rule of strings) {
      if (!code.startsWith(rule.open, i))
        continue
      let j = i + rule.open.length
      let closed = false
      while (j < n) {
        const cur = code[j] as string
        if (rule.escape !== undefined && cur === rule.escape) {
          j += 2
          continue
        }
        if (code.startsWith(rule.close, j)) {
          j += rule.close.length
          closed = true
          break
        }
        if (cur === '\n' && rule.multiline !== true)
          break
        j += 1
      }
      // An unterminated single-line string stops at the newline; an unterminated
      // multi-line string runs to the end of the block. Either way the fragment is
      // emitted as a string token and the scanner moves on.
      push('string', code.slice(i, Math.min(j, n)))
      i = Math.min(j, n)
      matchedString = true
      if (!closed)
        break
      break
    }
    if (matchedString)
      continue

    // ---- bash-style variable reference ------------------------------------
    if (spec.variablePrefix !== undefined && ch === spec.variablePrefix) {
      let j = i + 1
      if (code[j] === '{') {
        const close = code.indexOf('}', j)
        j = close === -1 ? n : close + 1
      } else {
        while (j < n && (isWordChar(code[j] as string) || code[j] === '?' || code[j] === '#'))
          j += 1
      }
      if (j > i + 1) {
        push('variable', code.slice(i, j))
        i = j
        continue
      }
    }

    // ---- number ----------------------------------------------------------
    if (isDigit(ch) || (ch === '.' && isDigit(code[i + 1] ?? ''))) {
      let j = i
      if (ch === '0' && (code[j + 1] === 'x' || code[j + 1] === 'X' || code[j + 1] === 'b' || code[j + 1] === 'o')) {
        j += 2
        while (j < n && /[0-9a-fA-F_]/.test(code[j] as string))
          j += 1
      } else {
        while (j < n && /[0-9_]/.test(code[j] as string))
          j += 1
        if (code[j] === '.') {
          j += 1
          while (j < n && /[0-9_]/.test(code[j] as string))
            j += 1
        }
        if (code[j] === 'e' || code[j] === 'E') {
          let k = j + 1
          if (code[k] === '+' || code[k] === '-')
            k += 1
          if (isDigit(code[k] ?? '')) {
            j = k
            while (j < n && /[0-9_]/.test(code[j] as string))
              j += 1
          }
        }
      }
      push('number', code.slice(i, j))
      i = j
      continue
    }

    // ---- identifier / keyword -------------------------------------------
    if (isWordChar(ch)) {
      let j = i
      while (j < n && isWordChar(code[j] as string))
        j += 1
      const word = code.slice(i, j)
      // A word immediately followed by '(' reads as a call; this is the cheapest
      // useful heuristic and it never misfires on keywords (they are checked first).
      let lookahead = j
      while (lookahead < n && (code[lookahead] === ' ' || code[lookahead] === '\t'))
        lookahead += 1
      const base = classifyWord(word, spec)
      if (base === 'variable' && code[lookahead] === '(')
        push('function', word)
      else
        push(base, word)
      i = j
      continue
    }

    // ---- operators and punctuation --------------------------------------
    if (OPERATOR_CHARS.includes(ch)) {
      push('operator', ch)
      i += 1
      continue
    }
    if (PUNCTUATION_CHARS.includes(ch)) {
      push('punctuation', ch)
      i += 1
      continue
    }

    // ---- everything else (whitespace, unicode, stray characters) ---------
    plain += ch
    i += 1
  }

  flushPlain()
  return tokens
}
