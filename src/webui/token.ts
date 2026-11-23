/**
 * Token hygiene for the WebUI fallback.
 *
 * The official browser flow hands the launcher a one-shot URL of the form
 * `http://127.0.0.1:<port>/?token=<32 random bytes>` (`authenticatedUrl()` in
 * `dsh-client-connection`). That token is a bearer credential for the *whole*
 * session, so it is confined to the native side:
 *
 *   * `webui.state` / `webui.open` / `webui.probe` carry `maskedUrl` only,
 *   * the raw URL leaves the Node process exactly once, through `webui.token`,
 *     which the C++ host intercepts and never republishes to QML,
 *   * log lines go through {@link maskTokenInText}.
 */

const TOKEN_QUERY = 'token'
const MASK = '***'
const TOKEN_PATTERN = /([?&]token=)[^&#\s"']*/gu

/**
 * Replace the token value in a URL, keeping the rest intact.
 *
 * @param url - an `authenticatedUrl` (or any string that may contain one).
 * @returns the same URL with `token=***`; unchanged when no token is present.
 */
export function maskAuthenticatedUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.has(TOKEN_QUERY)) {
      parsed.searchParams.set(TOKEN_QUERY, MASK)
      return parsed.toString()
    }
    return url
  } catch {
    return maskTokenInText(url)
  }
}

/**
 * Mask every `token=` occurrence inside free text (log lines, error messages,
 * stack traces that embedded a URL).
 */
export function maskTokenInText(text: string): string {
  return text.replace(TOKEN_PATTERN, `$1${MASK}`)
}

/**
 * @returns `true` when the text still contains a token value.
 *   Used by the tests and by the log guard.
 */
export function containsRawToken(text: string): boolean {
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const value = match[0].slice(match[1]?.length ?? 0)
    if (value !== '' && value !== MASK) return true
  }
  return false
}
