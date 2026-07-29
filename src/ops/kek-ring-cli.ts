import {
  CommandLedger,
  MaintenanceRefused,
  resolveMaintenanceRoot,
} from './maintenance-safety.js';
import {
  MaintenanceUsageError,
  parseMaintenanceFlags,
  realCommandRunner,
  reportRefusal,
} from './maintenance-cli-shared.js';
import {
  initializeKekRing,
  loadKekRing,
  readRootWrappingKey,
  summarizeKekRing,
} from '../core/crypto/kek-ring.js';
import {
  classifyKekRotationAge,
  countKeystoreEntries,
  planKekMigration,
  planKekRetirement,
  planKekRotation,
  planRootKeyRotation,
  readRotationJournal,
  retireKekGeneration,
  runKekMigration,
  runKekRotation,
  runRootKeyRotation,
} from './kek-rotation.js';
import { isDirectRun } from './direct-run.js';

// Phases 282/283 — `npm run ops:kek-ring`.
//
// FIVE VERBS, EACH ONE A DELIBERATE ACT.
//
//   init      create the ring for a NEW installation, with a KEK generated inside the sidecar
//   migrate   adopt an existing installation's STATIC KEK as generation 1, so the ring can open what is
//             already on disk. Gated on a complete backup that verifies and on a plan digest.
//   status    what the ring is, as numbers and closed words. Reads nothing out of it.
//   rotate    the Phase 283 rotation, or a resume of one
//   retire    remove a retained generation, after a POST-rotation backup that verifies
//
// NO KEY REACHES A COMMAND LINE, IN EITHER DIRECTION. Every key material input is a FILE PATH — a command
// line is visible in `ps`, in a scheduler's log and in shell history — and no output of any verb carries a
// key, a wrapped value or a path. The shared flag parser refuses a flag whose NAME suggests a credential, so
// `--root-key <hex>` cannot be added later without that refusal firing.

export const KEK_RING_EXIT_OK = 0;
export const KEK_RING_EXIT_FAILED = 1;
export const KEK_RING_EXIT_USAGE = 2;
export const KEK_RING_EXIT_REFUSED = 3;

function usage(): string {
  return [
    'usage: npm run ops:kek-ring -- <init|migrate|status|rotate|retire> [options]',
    '',
    'The sidecar-managed KEK ring. "Managed" means the key-encryption keys are generated, held, rotated and',
    'used INSIDE the custodian sidecar and the application never receives one. It is not a cloud KMS and not',
    'a hardware boundary; nothing here contacts a network.',
    '',
    'common:',
    '  --state <dir>             the sidecar state directory (holds the ring and the keystore)',
    '  --root-file <file>        the ROOT WRAPPING KEY file. Owner-only, read without following a link.',
    '                            Never an environment variable and never a command-line value.',
    '',
    'init      create a ring for a NEW installation. Refuses if one is already there.',
    'migrate   --static-file <file> --backup-set <dir> (--plan | --confirm-digest <hex>)',
    '          adopt the existing static KEK as generation 1. The keys on disk are already under it, so this',
    '          is a change of CUSTODY MECHANISM, not of key material — the rotation that follows is what',
    '          moves them onto a key this sidecar generated.',
    'status    what the ring is: generations, which is active, how old it is, and whether a rotation is due.',
    'rotate    --backup-set <dir> --project <dir> --project-name <name> (--plan | --confirm-digest <hex>)',
    '          generate a pending KEK inside the ring, rewrap every key onto it, verify all of them, and only',
    '          then activate. Resumable: a re-run after a crash finishes what did not complete.',
    '          --root-rotate --new-root-file <file>  re-seal the ring under a NEW root wrapping key. This',
    '          changes nothing about what any key is wrapped under; it changes which bytes open the ring.',
    'retire    --generation <n> --backup-set <dir>',
    '          remove a retained generation. IRREVERSIBLE: every backup taken while it was active stops being',
    '          restorable. Refused unless the named backup verifies AND was taken after the rotation.',
    '',
    'exit codes: 0 done | 1 did not complete | 2 bad usage | 3 refused before anything changed',
  ].join('\n');
}

export interface ParsedKekRingArgs {
  readonly verb: 'init' | 'migrate' | 'status' | 'rotate' | 'retire';
  readonly stateDir: string;
  readonly rootFile: string;
  readonly staticFile: string | null;
  readonly newRootFile: string | null;
  readonly backupSet: string | null;
  readonly projectRoot: string | null;
  readonly projectName: string | null;
  readonly generation: number | null;
  readonly plan: boolean;
  readonly rootRotate: boolean;
  readonly confirmDigest: string | null;
  readonly json: boolean;
}

const VERBS = ['init', 'migrate', 'status', 'rotate', 'retire'] as const;

export function parseKekRingArgs(argv: readonly string[]): ParsedKekRingArgs {
  const verb = argv[0];
  if (verb === undefined || !(VERBS as readonly string[]).includes(verb)) {
    throw new MaintenanceUsageError(`the first argument must be one of: ${VERBS.join(', ')}`);
  }
  const parsed = parseMaintenanceFlags(argv.slice(1), {
    values: ['state', 'root-file', 'static-file', 'new-root-file', 'backup-set', 'project', 'project-name',
      'generation', 'confirm-digest'],
    switches: ['plan', 'json', 'root-rotate'],
  });
  for (const name of ['state', 'root-file']) {
    if (parsed.values[name] === undefined) throw new MaintenanceUsageError(`--${name} is required`);
  }
  const confirm = parsed.values['confirm-digest'] ?? null;
  const plan = parsed.switches.has('plan');
  if (plan && confirm !== null) {
    throw new MaintenanceUsageError('--plan prints what would happen and changes nothing, so it takes no --confirm-digest');
  }
  if (confirm !== null && !/^[0-9a-f]{64}$/.test(confirm)) {
    throw new MaintenanceUsageError('--confirm-digest must be the 64-character digest --plan printed');
  }
  const generationRaw = parsed.values.generation;
  if (generationRaw !== undefined && !/^[0-9]{1,9}$/.test(generationRaw)) {
    throw new MaintenanceUsageError('--generation must be a whole generation number');
  }
  if ((verb === 'migrate' || verb === 'rotate' || verb === 'retire') && !plan && confirm === null) {
    throw new MaintenanceUsageError('--confirm-digest is required (or use --plan, which changes nothing)');
  }
  if (verb === 'migrate' && parsed.values['static-file'] === undefined) {
    throw new MaintenanceUsageError('--static-file is required for migrate');
  }
  if (verb === 'retire' && generationRaw === undefined) {
    throw new MaintenanceUsageError('--generation is required for retire');
  }
  if (parsed.switches.has('root-rotate') && parsed.values['new-root-file'] === undefined) {
    throw new MaintenanceUsageError('--root-rotate needs --new-root-file');
  }
  return {
    verb: verb as ParsedKekRingArgs['verb'],
    stateDir: parsed.values.state!,
    rootFile: parsed.values['root-file']!,
    staticFile: parsed.values['static-file'] ?? null,
    newRootFile: parsed.values['new-root-file'] ?? null,
    backupSet: parsed.values['backup-set'] ?? null,
    projectRoot: parsed.values.project ?? null,
    projectName: parsed.values['project-name'] ?? null,
    generation: generationRaw === undefined ? null : Number(generationRaw),
    plan,
    rootRotate: parsed.switches.has('root-rotate'),
    confirmDigest: confirm,
    json: parsed.switches.has('json'),
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) { console.log(usage()); return KEK_RING_EXIT_OK; }
  let args: ParsedKekRingArgs;
  try {
    args = parseKekRingArgs(argv);
  } catch (err) {
    console.error(reportRefusal(err));
    console.error('');
    console.error(usage());
    return KEK_RING_EXIT_USAGE;
  }

  try {
    const stateDir = resolveMaintenanceRoot(args.stateDir, 'sidecar state directory');
    const root = readRootWrappingKey(args.rootFile);

    switch (args.verb) {
      case 'init': {
        const ring = initializeKekRing(stateDir, root);
        console.log(render('A KEK ring was created for this installation.', summarizeKekRing(ring, root), args.json));
        console.log('The key it holds was generated inside this process. Back the sidecar state up NOW: a ring');
        console.log('that is lost is every item in the catalog lost, and nothing else holds a copy of it.');
        return KEK_RING_EXIT_OK;
      }
      case 'migrate': {
        // THE WHOLE MIGRATION IS A PLAN AND A CONFIRMATION, and both live in `kek-rotation.ts` beside the
        // other two irreversible custody operations. It used to be assembled here: the digest covered three
        // labels, the backup was verified only on the confirmed path, and the static key was proved against a
        // keystore nothing bound. A plan is now a pure function of what is on disk, it carries the backup's
        // own digest and a digest of the exact key set the static key was proved against, and the confirmed
        // run recomputes all of it under the lock.
        if (args.backupSet === null) {
          throw new MaintenanceRefused(
            '--backup-set is required for a migration, including for --plan: a migration writes a ring beside '
            + 'a keystore that cannot be regenerated, and the plan is what proves there is a way back.');
        }
        const migration = {
          stateDir: args.stateDir,
          rootKeyFile: args.rootFile,
          staticKeyFile: args.staticFile!,
          backupSet: args.backupSet,
        };
        const planned = planKekMigration(migration);
        if (args.plan) {
          console.log('This would ADOPT the static KEK this installation already uses as generation 1 of a new');
          console.log('ring, sealed under the root wrapping key file you named. It rewrites no key file and');
          console.log('changes no key material: every wrapped DEK stays exactly as it is. What changes is that');
          console.log('the sidecar stops reading a static file and starts reading a ring it can rotate.');
          console.log('');
          console.log(`  root wrapping key  ${planned.rootKeyId} (reference label, not the key)`);
          console.log(`  static KEK         ${planned.staticKeyId} (reference label, not the key)`);
          console.log(`  wrapped keys proved to open under it  ${planned.keysProved}`);
          console.log('');
          console.log('NOTHING HAS BEEN CHANGED BY PRINTING THIS.');
          console.log('');
          console.log('AFTER THIS, ROTATE. Until you do, the key protecting this installation is still the one');
          console.log('that was in a file — the migration alone does not change that, and this command will not');
          console.log('let a report say otherwise.');
          console.log('');
          console.log(`plan digest: ${planned.planDigest}`);
          return KEK_RING_EXIT_OK;
        }
        const outcome = runKekMigration({ ...migration, confirmDigest: args.confirmDigest });
        console.log(render('The static KEK is now generation 1 of a sidecar-managed ring.', outcome.ring, args.json));
        for (const note of outcome.notes) console.log(`note: ${note}`);
        console.log('Run `rotate` to move this installation onto a key this sidecar generated, then unmount the');
        console.log('static KEK file from the stack.');
        return KEK_RING_EXIT_OK;
      }
      case 'status': {
        const ring = loadKekRing(stateDir, root);
        const summary = summarizeKekRing(ring, root);
        const age = classifyKekRotationAge(summary.activeCreatedAt, Date.now());
        const journal = readRotationJournal(stateDir);
        if (args.json) {
          console.log(JSON.stringify({
            report: 'phase-282-kek-ring-status',
            ring: summary,
            rotation: age,
            keys: countKeystoreEntries(stateDir),
            unfinishedRotation: journal === null ? null : journal.stage,
          }, null, 2));
          return KEK_RING_EXIT_OK;
        }
        console.log(render('KEK ring', summary, false));
        console.log(`  wrapped keys       ${countKeystoreEntries(stateDir)}`);
        console.log(`  rotation           ${age}`);
        if (journal !== null) console.log(`  UNFINISHED ROTATION at stage: ${journal.stage} — re-run rotate to resume`);
        return KEK_RING_EXIT_OK;
      }
      case 'rotate': {
        if (args.rootRotate) {
          // THE DEFECT THIS CLOSES. `--root-rotate --plan` used to call the re-seal directly: the flag whose
          // entire purpose is "tell me what would happen" had already done it, and the only warning was that
          // the output described the change in the past tense. Planning now touches nothing.
          if (args.backupSet === null) {
            throw new MaintenanceRefused('--backup-set is required: after a re-seal the OLD root opens nothing');
          }
          const rootRequest = {
            stateDir: args.stateDir,
            rootKeyFile: args.rootFile,
            newRootKeyFile: args.newRootFile!,
            backupSet: args.backupSet,
          };
          const planned = planRootKeyRotation(rootRequest);
          if (args.plan) {
            console.log('This would RE-SEAL the KEK ring under a new root wrapping key. It rewrites no key');
            console.log('file and re-wraps nothing: every wrapped key stays under exactly the generation it is');
            console.log('under now. What changes is which 32 bytes open the ring.');
            console.log('');
            console.log(`  from root         ${planned.fromRootKeyId}`);
            console.log(`  to root           ${planned.toRootKeyId}`);
            console.log(`  active generation ${planned.activeGeneration} (unchanged by this operation)`);
            console.log('');
            console.log('NOTHING HAS BEEN CHANGED BY PRINTING THIS. After it runs, the previous root key opens');
            console.log('nothing — keep it until you have taken a complete backup under the new one.');
            console.log('');
            console.log(`plan digest: ${planned.planDigest}`);
            return KEK_RING_EXIT_OK;
          }
          const report = runRootKeyRotation({ ...rootRequest, confirmDigest: args.confirmDigest });
          console.log(args.json ? JSON.stringify(report, null, 2) : [
            'The ring is now sealed under the new root wrapping key.',
            `  from root          ${report.fromRootKeyId}`,
            `  to root            ${report.toRootKeyId}`,
            `  active generation  ${report.activeGeneration}`,
            `  ring unchanged     ${report.ringUnchanged}`,
            ...report.notes.map((note) => `  note: ${note}`),
          ].join('\n'));
          return report.ok ? KEK_RING_EXIT_OK : KEK_RING_EXIT_FAILED;
        }
        if (args.backupSet === null || args.projectRoot === null || args.projectName === null) {
          throw new MaintenanceRefused('--backup-set, --project and --project-name are required for a rotation');
        }
        const request = {
          stateDir: args.stateDir,
          rootKeyFile: args.rootFile,
          backupSet: args.backupSet,
          projectRoot: args.projectRoot,
          projectName: args.projectName,
        };
        const resolved = planKekRotation(request);
        if (args.plan) {
          console.log('This would rotate the KEK for this installation, in this order:');
          console.log('  1. verify the complete backup you named, and refuse if it does not verify NOW');
          console.log('  2. take the rotation lock over this state directory');
          console.log('  3. stop the app and the sidecar, so nothing writes while every key is rewritten');
          console.log('  4. generate a PENDING key inside the ring — nothing is under it yet');
          console.log('  5. write a journal, then rewrap every wrapped key onto it, one atomic file at a time');
          console.log('  6. prove EVERY live key reads under the new generation, while the old one is still active');
          console.log('  7. only then activate it, RETAINING the outgoing generation');
          console.log('  8. start the app and the sidecar again');
          console.log('');
          console.log(`  from generation ${resolved.fromGeneration}, under root ${resolved.rootKeyId}`);
          console.log(`  ${countKeystoreEntries(resolved.stateDir)} wrapped keys would be rewritten`);
          console.log('');
          console.log('A crash at any point leaves a ring whose active generation is still what the keys on disk');
          console.log('are under. Re-running resumes; every step is idempotent.');
          console.log('');
          console.log(`plan digest: ${resolved.planDigest}`);
          return KEK_RING_EXIT_OK;
        }
        const report = runKekRotation({ ...request, confirmDigest: args.confirmDigest }, {
          runner: realCommandRunner(),
          ledger: new CommandLedger(),
        });
        console.log(args.json ? JSON.stringify(report, null, 2) : renderRotation(report));
        return report.ok ? KEK_RING_EXIT_OK : KEK_RING_EXIT_FAILED;
      }
      case 'retire': {
        if (args.backupSet === null) throw new MaintenanceRefused('--backup-set is required to retire a generation');
        const retirement = {
          stateDir: args.stateDir,
          rootKeyFile: args.rootFile,
          backupSet: args.backupSet,
          generation: args.generation!,
        };
        // PLANNED AND CONFIRMED LIKE EVERY OTHER IRREVERSIBLE OPERATION HERE. Retirement is the one that
        // cannot be undone by re-running anything: the moment it lands, every backup taken while that
        // generation was active stops being restorable by this installation.
        const planned = planKekRetirement(retirement);
        if (args.plan) {
          console.log(`This would REMOVE generation ${planned.generation} from the ring, permanently.`);
          console.log('');
          console.log(`  active generation  ${planned.activeGeneration} (unaffected)`);
          console.log(`  root wrapping key  ${planned.rootKeyId} (reference label, not the key)`);
          console.log('');
          console.log('The backup you named has been proved to be one taken AFTER the rotation: its own root');
          console.log('key opens its own ring, that ring is on the generation this installation is on, and');
          console.log('every wrapped key inside it opens under that generation. NOTHING HAS BEEN CHANGED BY');
          console.log('PRINTING THIS.');
          console.log('');
          console.log('After it runs, any backup taken while that generation was active can no longer be');
          console.log('restored by this installation. That is what retirement means.');
          console.log('');
          console.log(`plan digest: ${planned.planDigest}`);
          return KEK_RING_EXIT_OK;
        }
        if (args.confirmDigest === null) {
          throw new MaintenanceUsageError('--confirm-digest is required to retire (or use --plan, which changes nothing)');
        }
        const outcome = retireKekGeneration({ ...retirement, confirmDigest: args.confirmDigest });
        console.log(render(`Generation ${outcome.retired} was retired.`, outcome.ring, args.json));
        for (const note of outcome.notes) console.log(`note: ${note}`);
        return KEK_RING_EXIT_OK;
      }
    }
  } catch (err) {
    console.error(reportRefusal(err));
    return KEK_RING_EXIT_REFUSED;
  }
}

function render(heading: string, summary: ReturnType<typeof summarizeKekRing>, json: boolean): string {
  if (json) return JSON.stringify({ report: 'phase-282-kek-ring', heading, ring: summary }, null, 2);
  return [
    heading,
    `  active generation  ${summary.active}`,
    `  pending            ${summary.pending ?? 'none'}`,
    `  retained           ${summary.retained.length === 0 ? 'none' : summary.retained.join(', ')}`,
    `  root wrapping key  ${summary.rootKeyId} (reference label, not the key)`,
    `  active origin      ${summary.origin}`,
  ].join('\n');
}

function renderRotation(report: ReturnType<typeof runKekRotation>): string {
  const lines: string[] = [];
  lines.push(`KEK rotation — ${report.ok ? 'COMPLETE' : 'DID NOT COMPLETE'}`);
  lines.push(`  reached stage      ${report.stage}`);
  lines.push(`  from generation    ${report.fromGeneration}`);
  lines.push(`  to generation      ${report.toGeneration ?? 'none'}`);
  lines.push(`  keys rewrapped     ${report.keys.rewrapped} (skipped ${report.keys.skipped} of ${report.keys.total})`);
  lines.push(`  every key verified ${report.verifiedAll}`);
  lines.push(`  quiesced           ${report.quiesced.join(', ')}`);
  lines.push(`  restarted          ${report.restarted}`);
  if (report.stillStopped.length > 0) {
    lines.push(`  STILL STOPPED      ${report.stillStopped.join(', ')} — start these before anything else`);
  }
  for (const note of report.notes) lines.push(`  note: ${note}`);
  lines.push(`  RESULT: ${report.ok ? 'OK' : 'INCOMPLETE'}`);
  return lines.join('\n');
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = main();
}
