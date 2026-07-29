import { CommandLedger } from './maintenance-safety.js';
import {
  MaintenanceUsageError,
  parseMaintenanceFlags,
  realCommandRunner,
  reportRefusal,
} from './maintenance-cli-shared.js';
import {
  planRehearsal,
  planRehearsalCommands,
  rehearsalCleanupCommand,
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
    '         --disposable <dir> --label <name> --compose-file <rel> --backup-set <dir> \\',
    '         --import-snapshot <file> --current-image <ref> --candidate-image <ref> \\',
    '         --expect-current-version <x.y.z> --expect-candidate-version <x.y.z> \\',
    '         --expect-current-schema <n> --expect-candidate-schema <n> (--plan | --confirm-digest <hex>)',
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
    '  --compose-file <rel>        YOUR Compose definition for the disposable stack, inside that directory.',
    '                              This command writes an override beside it; it never writes the definition.',
    '  --backup-set <dir>          a complete backup set that verifies. All four components are restored.',
    '  --import-snapshot <file>    a representative catalog snapshot, previewed, applied and replayed',
    '  --current-image <ref>       the image you run now. An exact tag or a sha256 digest; never "latest".',
    '  --candidate-image <ref>     the image you are considering. Same rule.',
    '  --expect-current-version    the exact product version INSIDE the current image (never read off its tag)',
    '  --expect-candidate-version  the exact product version inside the candidate image',
    '  --expect-current-schema     the schema version the current build expects — and the set\'s own version',
    '  --expect-candidate-schema   the schema version the candidate build expects once its migration has run',
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
    values: ['production', 'production-project', 'disposable', 'label', 'compose-file', 'backup-set',
      'import-snapshot', 'current-image', 'candidate-image', 'expect-current-version', 'expect-candidate-version',
      'expect-current-schema', 'expect-candidate-schema', 'confirm-digest'],
    switches: ['plan', 'cleanup', 'json'],
  });
  const required = ['production', 'production-project', 'disposable', 'label', 'compose-file', 'backup-set',
    'import-snapshot', 'current-image', 'candidate-image', 'expect-current-version', 'expect-candidate-version',
    'expect-current-schema', 'expect-candidate-schema'];
  for (const name of required) {
    if (parsed.values[name] === undefined) throw new MaintenanceUsageError(`--${name} is required`);
  }
  // A SCHEMA VERSION IS A NUMBER, and one that is not is a usage error rather than a NaN carried into a
  // comparison that would then never hold.
  const schema = (name: string): number => {
    const raw = parsed.values[name]!;
    if (!/^[0-9]{1,9}$/.test(raw)) throw new MaintenanceUsageError(`--${name} must be a whole schema version number`);
    return Number(raw);
  };
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
      composeFile: parsed.values['compose-file']!,
      backupSet: parsed.values['backup-set']!,
      importSnapshot: parsed.values['import-snapshot']!,
      currentImage: parsed.values['current-image']!,
      candidateImage: parsed.values['candidate-image']!,
      expect: {
        currentVersion: parsed.values['expect-current-version']!,
        candidateVersion: parsed.values['expect-candidate-version']!,
        currentSchema: schema('expect-current-schema'),
        candidateSchema: schema('expect-candidate-schema'),
      },
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
    if (args.plan) {
      // THE PLAN MAY NAME THE REFERENCES IN FULL. They are the operator's own words, printed back to them on
      // their own terminal, and choosing between two images is impossible without seeing which two. The
      // durable report carries digests instead; that asymmetry is the whole redaction boundary.
      console.log(`This rehearsal would run in the disposable project "${resolved.projectName}", from the backup`);
      console.log('set you named, between these two exact images:');
      console.log(`  current    ${resolved.currentImage}  (expected version ${resolved.expect.currentVersion}, `
        + `schema ${resolved.expect.currentSchema})`);
      console.log(`  candidate  ${resolved.candidateImage}  (expected version ${resolved.expect.candidateVersion}, `
        + `schema ${resolved.expect.candidateSchema})`);
      console.log('');
      console.log('Steps, in this order:');
      for (const step of planRehearsal(resolved)) {
        console.log(`  ${step.leg.padEnd(8)} ${step.id.padEnd(22)} ${step.proves}`);
        for (const action of step.actions) {
          if (action.kind === 'prepare-workspace') {
            console.log('      prepare a private restore workspace holding all four components and your import');
          } else if (action.kind === 'write-override') {
            console.log(`      write the ${action.role} Compose override, pinning that image and mounting them`);
          } else {
            console.log(`      ${action.command.program} ${action.command.args.join(' ')}`);
          }
        }
      }
      console.log('');
      console.log('Then, only if you pass --cleanup and every step held, and only while this rehearsal\'s own');
      console.log('marker is still on that root:');
      const cleanup = rehearsalCleanupCommand(resolved);
      console.log(`  ${cleanup.program} ${cleanup.args.join(' ')}`);
      console.log('');
      console.log(`That is ${planRehearsalCommands(resolved).length} commands, every one of them in the disposable`);
      console.log('root under this rehearsal\'s own project name. Production is never addressed. Nothing is pulled.');
      console.log('No media, media-server or acquisition command exists in this plan or in what this command is');
      console.log('permitted to run at all.');
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
