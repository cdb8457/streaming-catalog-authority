import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildOperatorConsole,
  CONSOLE_ARTIFACT_FILENAMES,
  CONSOLE_PHASES,
  type ArtifactStatus,
  type OperatorConsoleInput,
} from './promotion-operator-console.js';

// Phase 242 operator console CLI. ONE command over the whole Phase 231-241 chain: point it at a directory of
// artifacts (or hand it a bundle) and it says what the chain proves, how far it actually reaches, what is
// missing next, and exactly what a human should safely do about it.
//
// It replaces ten per-phase flags with one intake, and a machine verdict with a readable one. It adds NO
// evidence semantics: the Phase 241 packet reaches the verdict, unchanged, and this only makes it legible.
//
// DISCOVERY IS ALLOWLISTED. In --dir mode it looks ONLY for the fixed filenames published by the module,
// joined to that one directory, NON-RECURSIVELY. No filename, glob or path is ever taken from the data being
// read, so a hostile artifact cannot steer a read. Anything else in the directory is counted and left
// untouched -- never read, never named, never echoed. Two accepted names for one phase is a DUPLICATE and
// fails closed: the console will not guess which artifact was meant.
//
// It never echoes its input. The directory, the filenames, and every value inside the artifacts stay out of
// stdout, out of stderr and out of the report.
//
// It CREATES NOTHING and DECIDES NOTHING: no approval, no execution, no observation, no custody, no archive,
// no judgment, no inferred human decision. It never runs the promotion launcher, reads or writes the real
// Movies library, contacts Jellyfin, reads the secret approval file, touches the network, or merges, tags or
// pushes anything.
//
// Absence is normal: a chain that legitimately stops partway is AUDIT_OPEN with no blockers, not an error.
//
// Exit 0 = AUDIT_CLOSED, 1 = AUDIT_INVALID (fail closed), 2 = usage or input read error, 3 = AUDIT_OPEN,
// 5 = NOT_ELIGIBLE. These are the Phase 241 exit codes, deliberately: the same verdict exits the same way.

const EXIT: Readonly<Record<string, number>> = {
  AUDIT_CLOSED: 0,
  AUDIT_INVALID: 1,
  AUDIT_OPEN: 3,
  NOT_ELIGIBLE: 5,
};

// HOW TO INVOKE IT, on any shell. `npm run <script> -- <args>` is NOT reliable here: PowerShell consumes the
// first `--` itself, so npm receives the tool's flags as its OWN and swallows them -- `-- --help` prints npm's
// help, and `-- --dir X` reaches this tool with no arguments at all. The direct form below has no `--` to lose
// and behaves identically on PowerShell, cmd and bash, so it is what every usage string and doc quotes.
const DIRECT_INVOCATION = 'npx tsx src/ops/promotion-operator-console-cli.ts';

function usage(): string {
  return [
    `usage: ${DIRECT_INVOCATION} (--dir <artifact-directory> | --bundle <bundle.json>) \\`,
    '         [--out <report.json>] [--json] [--quiet]',
    '',
    'Invoke it directly, as above -- that form works on every shell. `npm run ops:promotion-operator-console`',
    'runs it too, but passing FLAGS through npm is not portable: PowerShell eats the first `--`, so npm takes',
    '`-- --help` as its own help and `-- --dir X` never reaches this tool at all. For the help text with no',
    'arguments to lose, `npm run ops:promotion-operator-console:help` is safe on any shell.',
    '',
    'Local, non-live. One command over the whole promotion record chain (Phases 231-241). It collects the',
    'artifacts, hands them to the Phase 241 audit UNCHANGED, and reports the outcome in a form a person can',
    'act on: what the chain proves, the phase it actually reaches, the phase missing next, every blocker with',
    'what it means, and the exact safe next human steps.',
    '',
    '--dir     discover artifacts by ALLOWLISTED FILENAME in one directory, non-recursively. Two names are',
    '          accepted per phase and nothing else is ever read:',
    ...CONSOLE_PHASES.map((p) => `            ${p}  ${CONSOLE_ARTIFACT_FILENAMES[p]!.join('   or   ')}`),
    '          Other entries in the directory are counted and left alone -- never read, never echoed. Two',
    '          accepted names for one phase is a DUPLICATE and fails closed rather than guessing.',
    '--bundle  an explicit JSON object keyed by phase number ("231".."240"). Unknown keys fail closed and are',
    '          neither read nor echoed. An array under one phase is a DUPLICATE.',
    '--out     write the full redaction-safe JSON report (mode 0600).',
    '--json    print the full JSON report instead of the human summary.',
    '--quiet   print nothing; use the exit code.',
    '',
    'ABSENT, MALFORMED, MISFILED and DUPLICATE are reported separately and mean different things. Only ABSENT',
    'is normal: the chain legitimately stops where no human has taken it further, and a clean prefix reports',
    'AUDIT_OPEN with ZERO blockers. The other three are defects.',
    '',
    'It CREATES nothing, DECIDES nothing and INFERS no human decision. Every next step it prints is a fixed',
    'lookup from the outcome and the phase actually outstanding -- a phase that is PRESENT but not yet in its',
    'terminal state comes before the first absent one, because it is the step still open. None of it is advice',
    'about whether the promotion should proceed. AUDIT_CLOSED means the records are mutually consistent; it does',
    'NOT mean the promotion happened, was correct, or was authorized by anyone in particular.',
    '',
    'Exit 0 = AUDIT_CLOSED, 1 = AUDIT_INVALID, 2 = usage or input error, 3 = AUDIT_OPEN, 5 = NOT_ELIGIBLE.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}

interface Discovered { readonly artifacts: Record<string, { status: ArtifactStatus; report?: unknown }>; readonly unknownFilesIgnored: number }

// Allowlisted discovery. Every candidate path is built from the FIXED filename table joined to the one
// directory the operator named; nothing here reads a name out of the data. Entries that are not on the
// allowlist are counted and otherwise ignored -- a directory legitimately holds other things.
function discover(dir: string): Discovered {
  const entries = readdirSync(dir);
  const allowed = new Set<string>();
  for (const phase of CONSOLE_PHASES) for (const name of CONSOLE_ARTIFACT_FILENAMES[phase]!) allowed.add(name);
  const artifacts: Record<string, { status: ArtifactStatus; report?: unknown }> = {};

  for (const phase of CONSOLE_PHASES) {
    const found = CONSOLE_ARTIFACT_FILENAMES[phase]!.filter((name) => {
      if (!entries.includes(name)) return false;
      try { return statSync(join(dir, name)).isFile(); } catch { return false; }
    });
    if (found.length === 0) continue;                                       // ABSENT: normal, not a defect
    if (found.length > 1) { artifacts[String(phase)] = { status: 'DUPLICATE' }; continue; }
    try {
      artifacts[String(phase)] = { status: 'PRESENT', report: JSON.parse(readFileSync(join(dir, found[0]!), 'utf8')) };
    } catch {
      // Unreadable or not JSON. That is a defect in the artifact, NOT an absence, and it is reported as one.
      artifacts[String(phase)] = { status: 'MALFORMED' };
    }
  }
  return { artifacts, unknownFilesIgnored: entries.filter((e) => !allowed.has(e)).length };
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) { console.log(usage()); return args.length === 0 ? 2 : 0; }
  const dir = valueAfter(args, '--dir');
  const bundlePath = valueAfter(args, '--bundle');
  const out = valueAfter(args, '--out');
  const asJson = args.includes('--json');
  const quiet = args.includes('--quiet');

  if (dir !== undefined && bundlePath !== undefined) {
    console.error('supply exactly one intake: --dir or --bundle, not both');
    return 2;
  }
  if (dir === undefined && bundlePath === undefined) {
    // Reached both by a genuine omission AND by `npm run ... -- --dir X` on PowerShell, where npm swallows the
    // flags and this tool is invoked bare. An operator who hits the second case sees a working command here,
    // rather than being told to supply an intake they believe they already supplied.
    console.error([
      'supply an intake: --dir <artifact-directory> or --bundle <bundle.json>.',
      `invoke it directly -- ${DIRECT_INVOCATION} --dir <artifact-directory>`,
      'passing flags via `npm run ... -- <flags>` is not portable: PowerShell eats the first `--`, so npm takes',
      'the flags as its own and this tool receives none. `--help` alone: npm run ops:promotion-operator-console:help',
    ].join('\n'));
    return 2;
  }

  let input: OperatorConsoleInput;
  try {
    if (dir !== undefined) {
      if (!statSync(dir).isDirectory()) throw new Error('not a directory');
      const found = discover(dir);
      input = { mode: 'DIRECTORY', artifacts: found.artifacts, unknownFilesIgnored: found.unknownFilesIgnored };
    } else {
      input = { mode: 'BUNDLE', bundle: JSON.parse(readFileSync(bundlePath!, 'utf8')) };
    }
  } catch {
    // The offending path is deliberately NOT echoed: it is operator input this tool never reflects back.
    console.error(dir !== undefined ? 'the artifact directory is missing or not a readable directory' : 'the bundle file is missing or not valid JSON');
    return 2;
  }

  const report = buildOperatorConsole(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  if (!quiet) console.log(asJson ? JSON.stringify(report, null, 2) : report.summary.join('\n'));
  return EXIT[report.overall] ?? 1;
}

process.exit(main());
