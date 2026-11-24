// Pure helpers for scripts/gate.mjs. Kept separate so the process-spawning
// wrapper stays small and the platform-sensitive resolution/quoting logic can
// be unit tested on any host.
import { statSync } from 'node:fs';
import path from 'node:path';

const WINDOWS = 'win32';

/** Extensions that cmd.exe can execute but CreateProcess cannot launch directly. */
export function isCmdScript(file) {
  return /\.(cmd|bat)$/i.test(file);
}

/**
 * Candidate file names for a bare command on Windows (PATHEXT expansion).
 *
 * The bare name must not be tried first: npm's global `.bin` directories hold
 * an extension-less POSIX shim next to the real `pnpm.cmd`. cmd.exe resolves
 * `pnpm` through PATHEXT and runs the `.cmd`; CreateProcess cannot execute the
 * shim at all. Trying the bare name first made the gate spawn that shim and
 * fail with ENOENT on the Windows runner. We deliberately do not fall back to
 * an extension-less file: failing resolution (exit 127) is more honest than a
 * spawn that can never work.
 */
export function candidateNames(command, platform = process.platform, env = process.env) {
  if (platform !== WINDOWS) return [command];
  if (/[\\/]/.test(command) || path.win32.extname(command) !== '') return [command];
  const pathext = (env['PATHEXT'] || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return pathext.map((ext) => `${command}${ext.toLowerCase()}`);
}

/**
 * Resolve `command` the way a shell would: explicit paths are used as-is,
 * bare names are looked up in PATH (with PATHEXT variants on Windows).
 * `isFile` is injectable so tests do not need a Windows filesystem.
 */
export function resolveExecutable(
  command,
  { platform = process.platform, env = process.env, isFile = defaultIsFile } = {},
) {
  const hasSeparator = /[\\/]/.test(command);
  if (hasSeparator || path.isAbsolute(command)) {
    return isFile(command) ? command : null;
  }
  const pathValue = env['PATH'] || env['Path'] || '';
  const separator = platform === WINDOWS ? ';' : ':';
  const dirs = pathValue.split(separator).filter(Boolean);
  const names = candidateNames(command, platform, env);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function defaultIsFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Quote one argument for a cmd.exe command line. The escaping follows the
 * CommandLineToArgvW rules used by Node's own Windows argument handling:
 * backslashes before a quote are doubled, and the quote is escaped.
 */
export function quoteForCmd(arg) {
  if (arg === '') return '""';
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

/** Build the single command-line string passed to `cmd.exe /d /s /c`. */
export function buildCmdCommandLine(file, args) {
  return [file, ...args].map(quoteForCmd).join(' ');
}

/**
 * Decide how to launch a resolved command. `.cmd`/`.bat` need cmd.exe;
 * `.exe` and POSIX executables are spawned directly (never blindly shell:true).
 */
export function launcherFor(
  resolved,
  args,
  { platform = process.platform, env = process.env } = {},
) {
  if (platform === WINDOWS && isCmdScript(resolved)) {
    return {
      file: env['ComSpec'] || env['COMSPEC'] || 'cmd.exe',
      // Wrap the whole command line in one extra pair of quotes: cmd.exe /s
      // strips only that outer pair and keeps the per-argument quotes.
      args: ['/d', '/s', '/c', `"${buildCmdCommandLine(resolved, args)}"`],
      options: { windowsVerbatimArguments: true },
    };
  }
  return { file: resolved, args, options: {} };
}

/** Map a terminating signal to the conventional 128+n exit status. */
export function signalExitCode(signal) {
  const signals = { SIGINT: 2, SIGILL: 4, SIGABRT: 6, SIGFPE: 8, SIGKILL: 9, SIGSEGV: 11, SIGTERM: 15 };
  return 128 + (signals[signal] ?? 1);
}