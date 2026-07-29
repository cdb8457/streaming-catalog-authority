import { createHash } from 'node:crypto';
import { CommandLedger, MaintenanceRefused, resolveMaintenanceRoot } from './maintenance-safety.js';
import {
  MaintenanceUsageError,
  parseMaintenanceFlags,
  realCommandRunner,
  reportRefusal,
} from './maintenance-cli-shared.js';
import {
  adoptStaticKekAsRing,
  initializeKekRing,
  kekRingExists,
  loadKekRing,
  readRootWrappingKey,
  rotateRootWrappingKey,
  summarizeKekRing,
} from '../core/crypto/kek-ring.js';
import { readKeyFileNoFollow } from './kek-ring-secret-io.js';
import {
  classifyKekRotationAge,
  countKeystoreEntries,
  kekRotationPlanDigest,
  planKekRotation,
  readRotationJournal,
  retireKekGeneration,
  runKekRotation,
} from './kek-rotation.js';
import { verifyBackupSet } from './backup-set-verification.js';
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
  if ((verb === 'migrate' || verb === 'rotate') && !plan && confirm === null) {
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

/**
 * The digest an operator confirms before a migration.
 *
 * Over the state directory, the root that will seal the ring and the static key being adopted — all three as
 * non-reversible labels. A migration confirmed for one static key cannot be spent on another, which matters
 * because adopting the WRONG static key produces a ring that opens nothing and looks perfectly well-formed.
 */
export function kekMigrationPlanDigest(parts: {
  readonly stateDir: string; readonly rootKeyId: string; readonly staticKeyId: string;
}): string {
  return createHash('sha256').update(JSON.stringify([
    'phase-282-kek-ring-migration',
    createHash('sha256').update(parts.stateDir, 'utf8').digest('hex'),
    parts.rootKeyId,
    parts.staticKeyId,
  ]), 'utf8').digest('hex');
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
        if (kekRingExists(stateDir)) throw new MaintenanceRefused('a KEK ring is already there; migration has happened');
        const staticKek = readKeyFileNoFollow(args.staticFile!, 'static KEK');
        const digest = kekMigrationPlanDigest({
          stateDir,
          rootKeyId: labelOf(root),
          staticKeyId: labelOf(staticKek),
        });
        if (args.plan) {
          console.log('This would ADOPT the static KEK this installation already uses as generation 1 of a new');
          console.log('ring, sealed under the root wrapping key file you named. It rewrites no key file and');
          console.log('changes no key material: every wrapped DEK stays exactly as it is. What changes is that');
          console.log('the sidecar stops reading a static file and starts reading a ring it can rotate.');
          console.log('');
          console.log('AFTER THIS, ROTATE. Until you do, the key protecting this installation is still the one');
          console.log('that was in a file — the migration alone does not change that, and this command will not');
          console.log('let a report say otherwise.');
          console.log('');
          console.log(`plan digest: ${digest}`);
          return KEK_RING_EXIT_OK;
        }
        if (args.confirmDigest !== digest) {
          throw new MaintenanceRefused('the digest you confirmed is not this migration\'s. Nothing was changed.');
        }
        if (args.backupSet === null) throw new MaintenanceRefused('--backup-set is required for a migration');
        const verification = verifyBackupSet(resolveMaintenanceRoot(args.backupSet, 'backup set directory'));
        if (!verification.ok) {
          throw new MaintenanceRefused(
            'the complete backup you named does not verify. A migration writes a new ring beside a keystore '
            + 'that cannot be regenerated; without a set that verifies NOW there is nothing to go back to.');
        }
        const ring = adoptStaticKekAsRing(stateDir, root, staticKek);
        console.log(render('The static KEK is now generation 1 of a sidecar-managed ring.', summarizeKekRing(ring, root), args.json));
        console.log('Nothing was re-wrapped and no key material changed. Run `rotate` to move this installation');
        console.log('onto a key this sidecar generated, then unmount the static KEK file from the stack.');
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
          const next = readRootWrappingKey(args.newRootFile!);
          const moved = rotateRootWrappingKey(stateDir, root, next);
          console.log('The ring is now sealed under the new root wrapping key.');
          console.log(`  from root ${moved.from}`);
          console.log(`  to root   ${moved.to}`);
          console.log('No key file was touched and nothing was re-wrapped: what changed is which 32 bytes open');
          console.log('the ring. Remove the previous root key file deliberately once you have verified a backup.');
          return KEK_RING_EXIT_OK;
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
        const outcome = retireKekGeneration({
          stateDir: args.stateDir,
          rootKeyFile: args.rootFile,
          backupSet: args.backupSet,
          generation: args.generation!,
        });
        console.log(render(`Generation ${args.generation} was retired.`, outcome.ring, args.json));
        for (const note of outcome.notes) console.log(`note: ${note}`);
        return KEK_RING_EXIT_OK;
      }
    }
  } catch (err) {
    console.error(reportRefusal(err));
    return KEK_RING_EXIT_REFUSED;
  }
}

/** A non-reversible label for a key, used only to bind a plan digest. Never printed beside its key. */
function labelOf(key: Buffer): string {
  return createHash('sha256').update('phase-282-key-label').update(key).digest('hex').slice(0, 32);
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
