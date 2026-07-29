import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandLedger, type CommandOutcome, type CommandRunner, type MaintenanceCommand } from '../../src/ops/maintenance-safety.js';

// Phases 277-280 acceptance harness — a docker/compose/pg toolchain that is a VALUE, not a daemon.
//
// WHY THIS RATHER THAN A STUB ON PATH. The maintenance commands take an injected `CommandRunner`, so a suite
// can drive the REAL planner and the REAL filesystem work while standing in for every process. Three things
// follow, and they are the reason the whole tranche is shaped this way:
//
//   * IT NEEDS NO DAEMON, no images and no network, so it runs identically on a laptop and on a CI runner
//     that has neither.
//   * IT CAN ASSERT THE ARGUMENT ARRAYS. What the product would actually run is inspected directly, so
//     "no pull, no registry, no media, no Jellyfin, no acquisition" is checked against the commands
//     themselves rather than against a description of them.
//   * IT CAN INJECT ANY FAILURE, at any step, deterministically — a stopped service that will not stop, a
//     dump that produces nothing, a restore that fails halfway. No timing, no flakes.
//
// The fake also WRITES what a real toolchain would write: `compose cp` creates the keystore directory it was
// asked to copy out, so the staged set on disk is a real set that the real verifier then reads.

export interface FakeToolchainOptions {
  /** Exit status for a command whose argv joins to something matching this key. Default 0. */
  readonly failWhen?: readonly { readonly contains: string; readonly status: number }[];
  /** What `pg_dump` writes to stdout. Default: a small plain dump carrying a schema_meta row. */
  readonly dumpText?: string;
  /** What `ops:doctor --json` answers. Default: a healthy report. */
  readonly doctorJson?: string;
  /** What `ops:version` answers. */
  readonly versionText?: string;
  /** Files the fake `compose cp` should create at its destination, as `relative path -> contents`. */
  readonly keystoreFiles?: Readonly<Record<string, string>>;
}

export interface FakeToolchain {
  readonly runner: CommandRunner;
  readonly ledger: CommandLedger;
  /** Every command, flattened, for a scan. */
  argv(): readonly string[];
  /** The commands in order, as `program arg arg …` strings. */
  lines(): readonly string[];
}

/** A plain dump the Phase 257 inspector recognises, carrying a schema version it can read. */
export function fakeDumpText(schemaVersion: number): string {
  return [
    '--',
    '-- PostgreSQL database dump',
    '--',
    'SET statement_timeout = 0;',
    'COPY public.schema_meta (id, version) FROM stdin;',
    `1\t${schemaVersion}`,
    '\\.',
    '',
  ].join('\n');
}

/** A doctor report in the shipped stable contract. */
export function fakeDoctorJson(states: readonly ('pass' | 'warn' | 'fail')[]): string {
  const checks = states.map((state, index) => ({ name: `check-${index}`, state, detail: 'a detail' }));
  return JSON.stringify({ reportVersion: 1, ok: !states.includes('fail'), checks });
}

export function fakeToolchain(options: FakeToolchainOptions = {}): FakeToolchain {
  const ledger = new CommandLedger();
  const dumpText = options.dumpText ?? fakeDumpText(9);
  const doctorJson = options.doctorJson ?? fakeDoctorJson(['pass', 'pass']);
  const versionText = options.versionText ?? 'catalog-authority v1.1.4\n';
  const keystoreFiles = options.keystoreFiles ?? { 'keys/.keep': 'k\n', 'tombstones/.keep': 't\n' };

  const runner: CommandRunner = (command: MaintenanceCommand): CommandOutcome => {
    const joined = [command.program, ...command.args].join(' ');
    for (const rule of options.failWhen ?? []) {
      if (joined.includes(rule.contains)) return { status: rule.status, stdout: '', stderr: 'injected failure\n' };
    }
    if (joined.includes('pg_dump')) return { status: 0, stdout: dumpText, stderr: '' };
    if (joined.includes('ops:doctor')) return { status: 0, stdout: doctorJson, stderr: '' };
    if (joined.includes('ops:version')) return { status: 0, stdout: versionText, stderr: '' };
    if (command.args.includes('cp')) {
      // A real `compose cp` of a directory creates it at the destination. The destination is the LAST
      // argument, and this writes a keystore-shaped tree there so the verifier downstream reads a real one.
      const destination = command.args[command.args.length - 1]!;
      for (const [relative, contents] of Object.entries(keystoreFiles)) {
        const target = join(destination, relative);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, contents, 'utf8');
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  return {
    runner,
    ledger,
    argv: () => ledger.flat(),
    lines: () => ledger.all().map((entry) => [entry.program, ...entry.args].join(' ')),
  };
}

/**
 * Words that must never appear in a maintenance run's command ledger.
 *
 * The absolute invariant, expressed as a scan over what was actually run: this product never downloads,
 * scrapes, plays or acquires media, never talks to a media server, and never reaches a registry.
 */
export const LEDGER_FORBIDDEN: readonly string[] = Object.freeze([
  'pull', 'login', 'push', 'build',
  'http://', 'https://', 'ghcr.io', 'docker.io', 'quay.io',
  'jellyfin', 'plex', 'emby',
  '/mnt/user/media', 'Movies', '.mkv', '.mp4',
  'nzb', 'torrent', 'magnet', 'usenet', 'sabnzbd',
  'curl', 'wget',
]);

/**
 * Assert a ledger contains none of the forbidden words, allowing the ones a legitimate flag spells.
 *
 * `--pull never` is the one place the word `pull` may appear, and it appears there BECAUSE it is the flag
 * that forbids pulling. The exemption is exact — the token must be the flag followed by `never` — so a bare
 * `pull` subcommand is still caught.
 */
export function assertLedgerIsClean(lines: readonly string[]): string[] {
  const problems: string[] = [];
  for (const line of lines) {
    const withoutPullNever = line.split('--pull never').join('--<the flag that forbids fetching>');
    const lower = withoutPullNever.toLowerCase();
    for (const forbidden of LEDGER_FORBIDDEN) {
      if (lower.includes(forbidden.toLowerCase())) {
        problems.push(`a maintenance command carried "${forbidden}"`);
      }
    }
  }
  return problems;
}
