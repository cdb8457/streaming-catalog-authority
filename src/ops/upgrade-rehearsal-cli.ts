import { CommandLedger } from './maintenance-safety.js';
import {
  MaintenanceUsageError,
  parseMaintenanceFlags,
  realCommandRunner,
  reportRefusal,
} from './maintenance-cli-shared.js';
import {
  assertDisposableRootIsEmptyish,
  planRehearsal,
  renderRehearsal,
  resolveRehearsal,
  runRehearsal,
  type RehearsalRequestWithConfirmation,
} from './upgrade-rehearsal.js';
import { isDirectRun } from './direct-run.js';

// Phases 279/280 — `npm run ops:upgrade-rehearsal`.
//
// TWO STEPS, BECAUSE THE FIRST ONE IS THE POINT. `--plan` prints what would happen and the digest of it;
// running it requires that digest back. A rehearsal creates and destroys a Compose project, and the one thing
// that must never be a typo is WHICH project.

export const REHEARSAL_EXIT_OK = 0;
export const REHEARSAL_EXIT_FAILED = 1;
export const REHEARSAL_EXIT_USAGE = 2;
export const REHEARSAL_EXIT_REFUSED = 3;

function usage(): string {
  return [
    'usage: npm run ops:upgrade-rehearsal -- --production <dir> --production-project <name> \\',
    '         --disposable <dir> --label <name> --backup-set <dir> \\',
    '         --current-image <ref> --candidate-image <ref> (--plan | --confirm-digest <hex>)',
    '',
    'Rehearses an upgrade AND the rollback that makes it reversible, in a disposable Compose project, from a',
    'backup set that verifies. Merely putting the old image back is not a rollback once a migration has run;',
    'this proves the restore path that actually is one.',
    '',
    'required:',
    '  --production <dir>          your real project directory. Read ONLY to prove the disposable one is not it.',
    '  --production-project <name> your real Compose project name, for the same reason',
    '  --disposable <dir>          a scratch directory beside production, never inside it',
    '  --label <name>              names the disposable project: catalog-rehearsal-<label>',
    '  --backup-set <dir>          a complete backup set that verifies',
    '  --current-image <ref>       the image you run now. An exact tag or a sha256 digest; never "latest".',
    '  --candidate-image <ref>     the image you are considering. Same rule.',
    '',
    'then one of:',
    '  --plan                      print what would happen, and the digest to confirm it with',
    '  --confirm-digest <hex>      the digest --plan printed',
    '',
    'options:',
    '  --cleanup                   remove the disposable project afterwards, if every step held',
    '  --json                      print the machine-readable evidence report',
    '',
    'It never addresses production, never pulls (no pull, login or push is available to it at all), and issues',
    'no media, media-server or acquisition command of any kind. A step that does not hold leaves the disposable',
    'project in place for diagnosis and removes nothing.',
    '',
    'exit codes: 0 both legs held | 1 a step did not hold | 2 bad usage | 3 refused before anything ran',
  ].join('\n');
}

export function parseRehearsalArgs(argv: readonly string[]): {
  readonly request: RehearsalRequestWithConfirmation;
  readonly plan: boolean;
  readonly json: boolean;
} {
  const parsed = parseMaintenanceFlags(argv, {
    values: ['production', 'production-project', 'disposable', 'label', 'backup-set', 'current-image',
      'candidate-image', 'confirm-digest'],
    switches: ['plan', 'cleanup', 'json'],
  });
  const required = ['production', 'production-project', 'disposable', 'label', 'backup-set', 'current-image',
    'candidate-image'];
  for (const name of required) {
    if (parsed.values[name] === undefined) throw new MaintenanceUsageError(`--${name} is required`);
  }
  const plan = parsed.switches.has('plan');
  const confirm = parsed.values['confirm-digest'] ?? null;
  if (plan && confirm !== null) {
    throw new MaintenanceUsageError('--plan prints what would happen and runs nothing, so it takes no --confirm-digest');
  }
  if (!plan && confirm === null) {
    throw new MaintenanceUsageError('--confirm-digest is required (or use --plan, which runs nothing)');
  }
  if (confirm !== null && !/^[0-9a-f]{64}$/.test(confirm)) {
    throw new MaintenanceUsageError('--confirm-digest must be the 64-character digest --plan printed');
  }
  return {
    request: {
      productionRoot: parsed.values.production!,
      productionProject: parsed.values['production-project']!,
      disposableRoot: parsed.values.disposable!,
      label: parsed.values.label!,
      backupSet: parsed.values['backup-set']!,
      currentImage: parsed.values['current-image']!,
      candidateImage: parsed.values['candidate-image']!,
      confirmDigest: confirm,
      cleanup: parsed.switches.has('cleanup'),
    },
    plan,
    json: parsed.switches.has('json'),
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage()); return REHEARSAL_EXIT_OK; }
  let args: ReturnType<typeof parseRehearsalArgs>;
  try {
    args = parseRehearsalArgs(argv);
  } catch (err) {
    console.error(reportRefusal(err));
    console.error('');
    console.error(usage());
    return REHEARSAL_EXIT_USAGE;
  }

  try {
    const resolved = resolveRehearsal(args.request);
    assertDisposableRootIsEmptyish(resolved.disposableRoot);
    if (args.plan) {
      console.log(`This rehearsal would run in the disposable project "${resolved.projectName}", from the backup`);
      console.log('set you named, between these two exact images:');
      console.log(`  current    ${resolved.currentImage}`);
      console.log(`  candidate  ${resolved.candidateImage}`);
      console.log('');
      for (const command of planRehearsal(resolved)) {
        console.log(`  ${command.program} ${command.args.join(' ')}`);
        console.log(`      ${command.purpose}`);
      }
      console.log('');
      console.log('Production is never addressed. Nothing is pulled. No media, media-server or acquisition');
      console.log('command exists in this plan or in what this command is permitted to run.');
      console.log('');
      console.log(`plan digest: ${resolved.planDigest}`);
      console.log('Re-run with --confirm-digest <that digest> to carry it out.');
      return REHEARSAL_EXIT_OK;
    }

    const report = runRehearsal(args.request, { runner: realCommandRunner(), ledger: new CommandLedger() });
    console.log(args.json ? JSON.stringify(report, null, 2) : renderRehearsal(report));
    return report.ok ? REHEARSAL_EXIT_OK : REHEARSAL_EXIT_FAILED;
  } catch (err) {
    console.error(reportRefusal(err));
    return REHEARSAL_EXIT_REFUSED;
  }
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = main();
}
