// llm/directory.ts — provider directory for the Qt models page.
//
// The Host keeps two provider registries that look similar and are not:
//
//   * `listProviders()`            — every provider that can answer requests.
//   * `listConfigurableProviders()` — providers that own a settings namespace,
//                                    i.e. the ones a settings UI can configure.
//
// A provider may be live without being configurable (composed by the profile)
// or configurable without being live (dormant). The models page needs both
// facts, so this module merges the two lists by provider id and keeps the
// settings coordinate for the configurable ones. No discovery happens here —
// `operations.ts` owns the network-touching part.

/** One entry of `llm.listProviders()` (`dsh-llm/types.d.ts`). */
export interface LlmProviderInfo {
  id: string
  name: string
}

/** One entry of `llm.listConfigurableProviders()`. */
export interface LlmConfigurableProvider {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
}

/**
 * The slice of the Host `llm` service this module consumes.
 *
 * `resolveModel` and `registerModelDiscovery` are intentionally absent: the Qt
 * page lists and configures models, it does not execute them.
 */
export interface LlmServiceLike {
  listProviders(): LlmProviderInfo[]
  listConfigurableProviders(): LlmConfigurableProvider[]
  discoverModels(
    settingsNs: string,
    request: LlmModelDiscoveryRequest,
    signal?: AbortSignal,
  ): Promise<LlmDiscoveredModel[]>
}

export interface LlmModelDiscoveryRequest {
  provider?: string
  baseURL?: string
  api?: string
  apiKey?: string
}

export interface LlmDiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: readonly string[]
}

/** What QML receives per provider: JSON-safe and null-defaulted. */
export interface LlmProviderView {
  id: string
  name: string
  configurable: boolean
  settingsNs: string | null
  settingsPath: string[] | null
}

export interface LlmDirectory {
  providers(): LlmProviderView[]
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return null
    out.push(entry)
  }
  return out
}

/**
 * @throws when the Host returns something that is not a provider list; the
 *   caller maps that to `internal` rather than rendering a half directory.
 */
export function createLlmDirectory(llm: LlmServiceLike): LlmDirectory {
  return {
    providers(): LlmProviderView[] {
      const live = llm.listProviders()
      const configurable = llm.listConfigurableProviders()
      if (!Array.isArray(live) || !Array.isArray(configurable)) {
        throw new Error('the Host llm service returned a non-array provider list')
      }
      const views = new Map<string, LlmProviderView>()
      for (const entry of configurable) {
        const settingsPath = readStringArray(entry.settingsPath)
        views.set(entry.provider, {
          id: entry.provider,
          name: entry.displayName,
          configurable: true,
          settingsNs: entry.settingsNs,
          settingsPath,
        })
      }
      for (const entry of live) {
        const existing = views.get(entry.id)
        if (existing !== undefined) {
          // A configurable provider is also live: keep its settings coordinate
          // and prefer the display name the configuration surface advertises.
          existing.name = existing.name === '' ? entry.name : existing.name
          continue
        }
        views.set(entry.id, {
          id: entry.id,
          name: entry.name,
          configurable: false,
          settingsNs: null,
          settingsPath: null,
        })
      }
      return [...views.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    },
  }
}