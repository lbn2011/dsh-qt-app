/**
 * Shared types for the DSH Qt6/QML profile.
 *
 * These mirror the public surface described in the implementation plan
 * (§ 2.1 "Cordis 接口设计") and are consumed by both the TypeScript service
 * (`src/index.ts`) and the N-API loader (`src/qt-bridge/napi-loader.ts`).
 */

/** Options accepted by `qtRenderer.renderMarkdown()`. */
export interface MarkdownOptions {
  /** Render GitHub-flavoured tables. */
  enableTables?: boolean
  /** Render mermaid diagrams through the QML/WebView layer. */
  enableMermaid?: boolean
  /** Render LaTeX math. */
  enableLatex?: boolean
  /** Which highlighter backend to use. */
  codeHighlight?: 'cmark' | 'shiki'
  /** Prefix code blocks with line numbers. */
  lineNumbers?: boolean
  /** Colour theme for rendered code. */
  theme?: 'light' | 'dark'
}

/** Options accepted by `qtRenderer.highlightCode()`. */
export interface CodeBlockOptions extends MarkdownOptions {
  /** Show a copy-to-clipboard affordance. */
  copyButton?: boolean
  /** Collapse blocks longer than `maxLines`. */
  expandable?: boolean
  /** Line budget before collapsing. */
  maxLines?: number
}

/** A single button of a native dialog. */
export interface DialogButton {
  label: string
  id: string
  default?: boolean
}

/** Options accepted by `qtRenderer.showDialog()`. */
export interface DialogOptions {
  title: string
  message?: string
  buttons: DialogButton[]
  icon?: 'info' | 'warning' | 'error' | 'question'
}

/** Result of a native dialog once the user picked a button. */
export interface DialogResult {
  button: string
  value?: unknown
}

/**
 * A plugin contribution rendered by the native Qt UI.
 *
 * `render` stays opaque (`unknown`) on purpose: the QML bridge decides how to
 * turn a contribution into widgets, so this package never imports a UI runtime.
 */
export interface QtSlotContribution {
  /** Slot surface id, e.g. `conversation.chat.flow` (see implementation plan § 1.2). */
  surface: string
  /** Contribution id, unique per surface. */
  id: string
  label?: string
  icon?: string
  /** Render callback; opaque to the Cordis layer. */
  render?: (props: Record<string, unknown>) => unknown
  /**
   * Action handler for gestures raised by the rendered tree (`click`, `change`,
   * `submit`). Mirrored into the slot registry so `ui.action` can reach it.
   */
  action?: (
    event: string,
    payload: unknown,
    props: Record<string, unknown>,
  ) => Record<string, unknown> | void
}

/** A QML view registered with the Qt host. */
export interface QtViewRegistration {
  id: string
  qmlPath: string
}
