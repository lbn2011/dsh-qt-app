/**
 * Probe plugin for tests/plugin-manager-live.e2e.ts.
 *
 * It runs inside a real headless profile with an isolated DSH_HOME and touches
 * only public `ctx.pluginManager` methods: list, then disable + re-enable the
 * fixture plugin installed next to it, printing each ChangeResult as JSON on
 * stderr (stdout belongs to the CLI). No network and no DSH installation edits.
 */
export const inject = ['pluginManager']

const report = (line) => process.stderr.write(`[probe] ${line}\n`)

export function apply(ctx) {
  const manager = ctx.pluginManager
  void (async () => {
    try {
      const entries = await manager.listPlugins()
      report(`list ${JSON.stringify(entries.map((entry) => ({
        entryId: entry.entryId,
        moduleName: entry.moduleName,
        enabled: entry.enabled,
        fiberPhase: entry.fiberPhase,
        patchId: entry.patchId,
      })))}`)
      const target = entries.find((entry) => entry.moduleName.includes('profile-plugin'))
      if (target === undefined) {
        report('missing-fixture')
        process.exit(2)
        return
      }
      const disabled = await manager.setPluginEnabled(target.entryId, false)
      report(`disabled ${JSON.stringify(disabled)}`)
      const enabled = await manager.setPluginEnabled(target.entryId, true)
      report(`enabled ${JSON.stringify(enabled)}`)
      process.exit(0)
    } catch (error) {
      report(`error ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      process.exit(1)
    }
  })()
}
