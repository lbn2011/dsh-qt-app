// The smallest possible Cordis plugin: no services, no network, no config.
// `official-profile.e2e.ts` installs it into an isolated DSH profile and then
// asserts that the real ctx.pluginManager lists it next to @deepseek-ai/dsh-qt-app.
export const name = '@dsh-fixture/profile-plugin'

export function apply() {}
