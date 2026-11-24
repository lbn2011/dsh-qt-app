// Types for gate-lib.mjs (the implementation stays plain ESM so the wrapper
// runs without a build step).
export interface LaunchPlan {
  file: string;
  args: string[];
  options: { windowsVerbatimArguments?: boolean };
}
export function isCmdScript(file: string): boolean;
export function candidateNames(
  command: string,
  platform?: string,
  env?: NodeJS.ProcessEnv,
): string[];
export function resolveExecutable(
  command: string,
  options?: {
    platform?: string;
    env?: NodeJS.ProcessEnv;
    isFile?: (candidate: string) => boolean;
  },
): string | null;
export function quoteForCmd(arg: string): string;
export function buildCmdCommandLine(file: string, args: string[]): string;
export function launcherFor(
  resolved: string,
  args: string[],
  options?: { platform?: string; env?: NodeJS.ProcessEnv },
): LaunchPlan;
export function signalExitCode(signal: string): number;
