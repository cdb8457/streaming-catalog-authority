import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Which interpreter can actually run a script HERE — which is not the same question as which one is
// installed, and answering the easy question instead is what shipped a broken release step.
//
// On Windows, `bash` on PATH is `C:\Windows\System32\bash.exe`: the WSL launcher. It answers `bash --version`
// perfectly happily —
//
//     GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)
//
// — and then cannot open a script at a Windows path, because the Linux filesystem it runs in has no
// `C:/Users/...`. The script never starts and the caller sees exit 127 with `No such file or directory`.
// Worse, when the path IS reachable as `/mnt/c/...` the script runs to completion inside the WSL distro,
// against a Linux `node` and a `node_modules` built for win32 — a failure that looks like a broken toolchain
// rather than a wrong shell. Started from Git Bash the same PATH lookup finds Git's own bash and everything
// works, so anything that probes with `--version` behaves differently depending on which terminal the
// operator happened to be standing in.
//
// So capability is probed by DOING the thing: write a script into a throwaway directory whose name contains a
// space, run it, and require the sentinel back on stdout. A candidate that cannot reach the file, or cannot
// cope with a space in the path, is not usable and the next candidate is tried.

export interface Shell {
  readonly command: string;
  readonly args: (script: string) => string[];
}

/**
 * How every probed child process is run.
 *
 * `stdin: 'ignore'` is the one that matters: a script that reads stdin — a prompt, a `sha256sum` with no file
 * argument, a shell waiting for input — gets EOF immediately instead of a console it can sit on until the
 * caller is killed by hand. The timeout is enforced with SIGKILL because a process that ignores SIGTERM is
 * exactly the process a timeout exists for, and `maxBuffer` bounds a runaway writer rather than letting a
 * full pipe deadlock the parent.
 */
export const SPAWN_DEFAULTS: {
  readonly encoding: 'utf8';
  readonly stdio: ['ignore', 'pipe', 'pipe'];
  readonly windowsHide: true;
  readonly killSignal: 'SIGKILL';
  readonly maxBuffer: number;
} = {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  killSignal: 'SIGKILL',
  maxBuffer: 16 * 1024 * 1024,
};

/** Long enough for a real build step, short enough that a wedged child fails the run instead of hanging it. */
export const PROBE_TIMEOUT_MS = 30_000;
export const SCRIPT_TIMEOUT_MS = 180_000;

function gitBashCandidates(): Shell[] {
  if (process.platform !== 'win32') return [];
  const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files']
    .filter((value): value is string => typeof value === 'string' && value !== '');
  return [...new Set(roots)].map((root) => ({ command: `${root}\\Git\\bin\\bash.exe`, args: (script: string) => [script] }));
}

/** PATH first — on POSIX that is the right answer — then the places Git for Windows installs bash. */
export const BASH_CANDIDATES: readonly Shell[] = [
  { command: 'bash', args: (script) => [script] },
  ...gitBashCandidates(),
];

export const POWERSHELL_CANDIDATES: readonly Shell[] = [
  { command: 'pwsh', args: (script) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] },
  { command: 'powershell', args: (script) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] },
];

const SENTINEL = 'shell-probe-ok';

/**
 * The first candidate that can execute a script written to disk here, or null.
 *
 * The probe directory deliberately contains a space: the scripts this repository ships are run from paths a
 * user chose, and "works unless the folder has a space in it" is a bug found by a user rather than by us.
 */
export function usableShell(candidates: readonly Shell[], probeName: string, probeBody: string): Shell | null {
  const workspace = mkdtempSync(join(tmpdir(), 'shell probe-'));
  try {
    const probe = join(workspace, probeName);
    writeFileSync(probe, probeBody);
    for (const shell of candidates) {
      const run = spawnSync(shell.command, shell.args(probe.replace(/\\/g, '/')),
        { ...SPAWN_DEFAULTS, cwd: workspace, timeout: PROBE_TIMEOUT_MS });
      if (run.status === 0 && (run.stdout ?? '').includes(SENTINEL)) return shell;
    }
    return null;
  } finally { removeQuietly(workspace); }
}

/**
 * Delete a throwaway directory, and never let the deletion become the failure.
 *
 * A spawned interpreter can still hold a handle for a moment after it exits — Windows then answers EBUSY —
 * and a `finally` that throws REPLACES whatever assertion was already failing. Losing the real diagnostic to
 * a cleanup error is how a one-line fix turns into an afternoon.
 */
export function removeQuietly(path: string): void {
  try { rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { /* a leftover temp directory is not worth a failed run */ }
}

let bash: Shell | null | undefined;
let powershell: Shell | null | undefined;

/** A bash that can run a script at a path this process can write to. Probed once per process. */
export function usableBash(): Shell | null {
  if (bash === undefined) bash = usableShell(BASH_CANDIDATES, 'probe.sh', `echo ${SENTINEL}\n`);
  return bash;
}

export function usablePowerShell(): Shell | null {
  if (powershell === undefined) powershell = usableShell(POWERSHELL_CANDIDATES, 'probe.ps1', `Write-Host '${SENTINEL}'\n`);
  return powershell;
}

/** What to tell an operator who has no bash we can use, in terms of something they can go and do. */
export const NO_USABLE_BASH =
  'no usable bash on this machine: `bash` on PATH cannot run a script at a Windows path (it is most likely '
  + 'the WSL launcher in C:\\Windows\\System32), and no Git for Windows bash was found under Program Files. '
  + 'Install Git for Windows, or run this from a Git Bash shell.';

/** Everything a failed run knows, so one line is enough to act on. */
export function describeRun(run: SpawnSyncReturns<string>): string {
  const parts = [
    `status=${run.status === null ? 'null' : run.status}`,
    ...(run.signal === null || run.signal === undefined ? [] : [`signal=${run.signal}`]),
    ...(run.error === undefined ? [] : [`error=${run.error.message}`]),
    `stdout=${JSON.stringify((run.stdout ?? '').trim().slice(-400))}`,
    `stderr=${JSON.stringify((run.stderr ?? '').trim().slice(-400))}`,
  ];
  return parts.join(' ');
}

export interface RunOptions {
  readonly cwd: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly timeout?: number;
}

/** Run a script with a probed shell, bounded and with no inherited stdin. */
export function runScript(shell: Shell, script: string, options: RunOptions): SpawnSyncReturns<string> {
  return spawnSync(shell.command, [...shell.args(script.replace(/\\/g, '/')), ...(options.args ?? [])], {
    ...SPAWN_DEFAULTS,
    cwd: options.cwd,
    timeout: options.timeout ?? SCRIPT_TIMEOUT_MS,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}
