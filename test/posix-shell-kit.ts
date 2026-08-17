import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// THE SHELL A SUITE DRIVES SHIPPED SCRIPTS WITH, CHOSEN BY EXECUTION RATHER THAN BY NAME.
//
// THE DEFECT THIS EXISTS FOR, WHICH HAS NOW BEEN PUBLISHED AS A PASSING FIGURE BY TWO DIFFERENT SUITES. A
// suite that drives a shipped shell program invokes it as `spawnSync('bash', …)` — whatever `bash` PATH
// happens to resolve first. On a stock Windows install that is `C:\WINDOWS\system32\bash.exe`, the WSL
// launcher, which cannot address a Windows drive path in any spelling: `bash -n C:\…\gate.sh` fails outright
// and `bash -c "C:/…/gate.sh"` answers 127, the status a shell returns for "command not found". The wrapper
// tests then FAIL rather than run, and the failure is indistinguishable from a real regression in the
// wrapper — a false alarm about the most important property in a gate, raised by a path separator.
//
// It passes only when the suite happens to be started from a shell that has already put Git Bash's `bin`
// first, which is why a figure recorded from Git Bash does not reproduce from an ordinary PowerShell launch.
// A verdict that depends on which terminal somebody happened to type into is not a verdict.
//
// SO THE SHELL IS CHOSEN BY ASKING IT TO DO THE JOB, NOT BY ASKING WHAT IT IS CALLED. Each candidate is made
// to execute a real script at the exact path spelling its suite will use, and to print a sentinel. A
// candidate that cannot is not a POSIX shell as far as these suites are concerned, whatever its name — and
// if none can, a caller SKIPS BY NAME rather than failing, because a suite that could not run the wrapper
// has not checked the wrapper and must not report either verdict.
//
// THE OTHER REPAIR, WHICH WAS TRIED AND IS NOT THE ONE. `test/projection-jellyfin-dataplane.ts` originally
// KEPT whatever `bash` it found and TRANSLATED the path into that shell's convention — a style probe, a
// `toBashPath` hard-coding WSL's `/mnt/c` against MSYS's `/c`, and a `WSLENV` entry so the stub variable
// survived the boundary at all. Three layers, each correct about its own symptom, none addressing the cause:
// the wrappers these suites drive run `npm`, `npx` and `docker` out of THIS checkout, and a WSL bash is a
// different machine with a different toolchain, so it is the wrong executable even in the cases where the
// translation worked. What they need is the shell the repository is actually operated with, which is what
// selecting by execution finds. That suite now imports this module like the rest.
//
// WHY THIS IS A MODULE RATHER THAN A COPY PER SUITE. `test/torbox-resolver.ts` worked this out first and
// paid for it twice. `test/projection-phase9-gate-audit.ts` then met the identical failure — nine of its
// eighteen controls failing from PowerShell, on `bash -n` and on 127 — because the reasoning lived in
// another suite's private functions. A copied harness is one more chance to weaken one assertion, so the
// discovery lives here once and every suite that drives a shipped script imports it.
//
// IT STARTS NOTHING, READS NO ENVIRONMENT IT DOES NOT NAME, AND CONTACTS NOTHING. The only processes it runs
// are `git --exec-path` and candidate shells against a throwaway probe script in a temporary directory.

export const SHELL_SENTINEL = 'projection-posix-shell-ok';

/** The reason a block cannot run, named for what is missing rather than for the platform. */
export const NO_SHELL = 'no POSIX shell on this host can execute a script at the workspace path';

/** A path in the spelling a POSIX shell reads. Backslashes are separators to Windows and escapes to a shell. */
export const shPath = (path: string): string => path.replace(/\\/g, '/');

/** Where a Git-for-Windows `bash.exe` lives, derived from the `git` that is installed rather than guessed. */
export function gitBashCandidates(): readonly string[] {
  const found: string[] = [];
  // `git --exec-path` answers e.g. `C:/Program Files/Git/mingw64/libexec/git-core`; the shell sits at
  // `<install root>/bin/bash.exe`. Walking up from the answer finds it wherever Git was installed, which a
  // hard-coded `C:\Program Files` would not.
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (execPath.status === 0) {
    let dir = String(execPath.stdout).trim().replace(/\\/g, '/');
    for (let up = 0; up < 4 && dir.includes('/'); up += 1) {
      found.push(`${dir}/bin/bash.exe`);
      dir = dir.slice(0, dir.lastIndexOf('/'));
    }
  }
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    if (root !== undefined && root !== '') found.push(`${shPath(root)}/Git/bin/bash.exe`);
  }
  return found;
}

/**
 * Candidates in the order they should be preferred.
 *
 * ON WINDOWS, BARE `bash` IS TRIED LAST AND THAT ORDERING IS THE WHOLE POINT: it is the one most likely to
 * be WSL. On a POSIX host bare `bash` is tried FIRST, because there it is the right answer — with the
 * absolute paths after it so that a PATH which has been poisoned, shadowed or emptied still resolves to a
 * real shell rather than making the suite skip a check it could have run.
 */
export function shellCandidates(): readonly string[] {
  if (process.platform === 'win32') return [...gitBashCandidates(), 'bash'];
  return ['bash', '/bin/bash', '/usr/bin/bash', '/bin/sh'];
}

/** Can this candidate actually execute a script at the spelling these suites hand out? */
export function shellCanRunAScript(command: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'shellprobe-'));
  const script = join(dir, 'probe.sh');
  writeFileSync(script, `#!/bin/sh\nprintf '%s' '${SHELL_SENTINEL}'\n`);
  try { chmodSync(script, 0o755); } catch { /* Windows has no executable bit; the shell is given the path */ }
  const result = spawnSync(command, [shPath(script)], { encoding: 'utf8', timeout: 30_000 });
  return result.status === 0 && String(result.stdout ?? '').includes(SHELL_SENTINEL);
}

let shellChoice: { readonly command: string | null } | undefined;

/** The chosen shell, or `null` when nothing on this host can run a script at this path. Memoised. */
export function posixShell(): string | null {
  if (shellChoice === undefined) {
    shellChoice = { command: shellCandidates().find(shellCanRunAScript) ?? null };
  }
  return shellChoice.command;
}

/**
 * The chosen shell where a caller has already established there is one.
 *
 * Every call site is behind a guard that skips by name when `posixShell()` is null, so reaching this with
 * nothing selected is a defect in the guard rather than a property of the host — and it throws rather than
 * quietly falling back to bare `bash`, which is the behaviour this whole mechanism exists to remove.
 */
export function shellOrThrow(): string {
  const command = posixShell();
  if (command === null) throw new Error('no POSIX shell was selected, and this block requires one');
  return command;
}

/** For the selection regression, which has to re-resolve under a deliberately poisoned PATH. */
export function resetShellChoice(): void { shellChoice = undefined; }
