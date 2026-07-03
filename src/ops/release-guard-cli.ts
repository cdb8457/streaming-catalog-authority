import {
  createChildProcessGitRunner,
  formatReleaseGuardJson,
  formatReleaseGuardText,
  hasFailedGuardChecks,
  runReleaseGuard,
  type ReleaseGuardMode,
  type ReleaseGuardOptions,
} from './release-guard.js';

const USAGE = `usage: ops:release-guard --base <ref> [--head <ref>] [--tag <tag>] [--phase <n>] [--mode pre-pr|pre-merge|post-merge] [--json]

Advisory only. Performs read-only local Git inspection and never approves, merges, tags, pushes,
deletes branches, opens PRs, reads secrets, calls live services, runs Docker, or closes O4/O5.
`;

function parseArgs(argv: readonly string[]): ReleaseGuardOptions & { readonly json: boolean } {
  let base = '';
  let head = 'HEAD';
  let tag: string | undefined;
  let phase: string | undefined;
  let mode: ReleaseGuardMode = 'pre-pr';
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--base' || arg === '--head' || arg === '--tag' || arg === '--phase' || arg === '--mode') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
      if (arg === '--base') base = value;
      else if (arg === '--head') head = value;
      else if (arg === '--tag') tag = value;
      else if (arg === '--phase') phase = value;
      else {
        if (!isReleaseGuardMode(value)) throw new Error(`unsupported mode: ${value}`);
        mode = value;
      }
      continue;
    }
    throw new Error(`unsupported argument: ${arg}`);
  }

  if (!base) throw new Error('--base is required');
  return { base, head, tag, phase, mode, json };
}

function isReleaseGuardMode(value: string): value is ReleaseGuardMode {
  return value === 'pre-pr' || value === 'pre-merge' || value === 'post-merge';
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    const { json, ...options } = parseArgs(args);
    const runner = createChildProcessGitRunner();
    const report = runReleaseGuard(options, runner);
    process.stdout.write(json ? formatReleaseGuardJson(report) : formatReleaseGuardText(report));
    return hasFailedGuardChecks(report) ? 1 : 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
}

process.exit(main());
