import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATION_VERSION } from '../db/schema-version.js';
import { BACKUP_COMPONENT_IDS, type BackupComponentId } from './backup-components.js';
import { REQUIRED_COMPONENTS, inspectBackupDirectory, type BackupInspection } from './backup-inspect.js';
import {
  BACKUP_MANIFEST_NAME,
  COMPONENT_ARTIFACT_NAMES,
  describeComponent,
  readBackupManifest,
  type BackupManifest,
} from './complete-backup.js';
import { MaintenanceRefused, resolveMaintenanceRoot } from './maintenance-safety.js';

// Phase 278 — a backup that has not been verified is a belief.
//
// WHAT THIS ADDS TO PHASE 257. The offline inspector answers "what does this folder CONTAIN, and which schema
// does the dump hold". It is the right question and it is not the whole one, because it has nothing to
// compare against: a set with a component quietly truncated after it was taken looks exactly like a set that
// was always that way. This verification runs the inspector AND checks the set against its own manifest —
// every component present, none added, every digest still the one that was recorded.
//
// IT RUNS AFTER EVERY BACKUP, AUTOMATICALLY, AND STANDALONE ON DEMAND. `ops:complete-backup` calls it before
// it reports success, so "the backup succeeded" and "the backup verified" are never two different runs an
// operator has to remember to pair.
//
// IT FAILS CLOSED AND IT CHANGES NOTHING. Missing, extra, tampered, symlinked, special — every one is a
// refusal. Nothing here opens a file for writing, removes anything, or repairs anything: a verification that
// could fix what it found would be a verification whose failures nobody ever saw.
//
// IT OPENS NO SECRET. Components are digested; the secrets component is recognised and digested by file
// content but never reported by content, and no value from inside any component reaches the report.

export const BACKUP_VERIFY_REPORT = 'phase-278-backup-verification';
export const BACKUP_VERIFY_VERSION = 1;

export type VerificationFinding =
  | 'MANIFEST_MISSING'
  | 'MANIFEST_UNREADABLE'
  | 'COMPONENT_MISSING'
  | 'COMPONENT_UNEXPECTED'
  | 'COMPONENT_CHANGED'
  | 'COMPONENT_SYMLINK'
  | 'COMPONENT_SPECIAL'
  | 'SCHEMA_INCOMPATIBLE'
  | 'INSPECTOR_REFUSED';

export interface VerificationProblem {
  readonly finding: VerificationFinding;
  /** The component it is about, when it is about one. A closed id, never a path. */
  readonly component: BackupComponentId | null;
  readonly detail: string;
}

export interface BackupVerificationReport {
  readonly report: typeof BACKUP_VERIFY_REPORT;
  readonly version: typeof BACKUP_VERIFY_VERSION;
  readonly ok: boolean;
  readonly setName: string;
  /** Every required component, and whether it verified. */
  readonly verified: readonly BackupComponentId[];
  readonly problems: readonly VerificationProblem[];
  /** The Phase 257 inspector's own verdict, unmodified. */
  readonly inspectorVerdict: BackupInspection['verdict'];
  readonly manifestSchemaVersion: number;
  readonly buildSchemaVersion: number;
  readonly wrote: 'nothing';
  readonly network: 'none';
  readonly notes: readonly string[];
}

/**
 * Verify a published backup set against its own manifest and the shipped offline inspector.
 *
 * `setDir` is resolved and proved the same way every other maintenance path is: a real, contained, non-broad
 * directory reached through no symbolic link.
 */
export function verifyBackupSet(setDir: string): BackupVerificationReport {
  const resolved = resolveMaintenanceRoot(setDir, 'backup set directory');
  const setName = resolved.split(/[\\/]/).filter((s) => s !== '').pop() ?? 'backup set';
  const problems: VerificationProblem[] = [];
  const notes: string[] = [];

  // 1. THE MANIFEST. Without it there is nothing to compare against, and a set with no manifest is not one
  // this command took — which is a fact, not a fault of the operator's, so it is said plainly.
  let manifest: BackupManifest;
  try {
    manifest = readBackupManifest(resolved);
  } catch (err) {
    return failed(setName, [{
      finding: existsSync(join(resolved, BACKUP_MANIFEST_NAME)) ? 'MANIFEST_UNREADABLE' : 'MANIFEST_MISSING',
      component: null,
      detail: err instanceof MaintenanceRefused ? err.message : 'the manifest could not be read',
    }], 'INCOMPLETE', 0, [
      'A set taken by ops:complete-backup always carries a manifest. One taken by hand, following the documented '
      + 'commands, will not — inspect it with ops:backup-inspect instead, which needs no manifest.',
    ]);
  }

  // 2. EVERY COMPONENT THE MANIFEST DECLARES, still there and still the same bytes.
  const declared = new Map(manifest.components.map((component) => [component.id, component]));
  const verified: BackupComponentId[] = [];
  for (const id of BACKUP_COMPONENT_IDS) {
    const expected = declared.get(id);
    if (expected === undefined || !expected.present) {
      if (REQUIRED_COMPONENTS.includes(id)) {
        problems.push({ finding: 'COMPONENT_MISSING', component: id, detail: `the manifest declares no ${id} component` });
      }
      continue;
    }
    const artifactPath = join(resolved, expected.artifact);
    if (!existsSync(artifactPath)) {
      problems.push({ finding: 'COMPONENT_MISSING', component: id, detail: `the ${id} component is declared and is not there` });
      continue;
    }
    if (lstatSync(artifactPath).isSymbolicLink()) {
      problems.push({ finding: 'COMPONENT_SYMLINK', component: id, detail: `the ${id} component is a symbolic link` });
      continue;
    }
    let actual;
    try {
      actual = describeComponent(resolved, id);
    } catch (err) {
      problems.push({
        finding: 'COMPONENT_SPECIAL', component: id,
        detail: err instanceof MaintenanceRefused ? err.message : `the ${id} component could not be examined`,
      });
      continue;
    }
    if (actual.digest !== expected.digest) {
      problems.push({
        finding: 'COMPONENT_CHANGED', component: id,
        detail: `the ${id} component no longer matches the digest recorded when the set was taken`,
      });
      continue;
    }
    verified.push(id);
  }

  // 3. NOTHING ADDED. An artifact nobody declared is either somebody else's file in this folder or a
  // component swapped in, and neither is a set this command is willing to call verified.
  const expectedNames = new Set<string>([BACKUP_MANIFEST_NAME]);
  for (const component of manifest.components) if (component.present) expectedNames.add(component.artifact);
  for (const entry of readdirSync(resolved).slice().sort()) {
    if (expectedNames.has(entry)) continue;
    problems.push({
      finding: 'COMPONENT_UNEXPECTED', component: null,
      detail: 'this set holds an artifact its manifest does not declare',
    });
    break;
  }

  // 4. SCHEMA COMPATIBILITY, established rather than assumed. A set from a NEWER build cannot be restored
  // under this one — the same rule Phase 257 states, applied to the manifest's own recorded version.
  if (manifest.schemaVersion > MIGRATION_VERSION) {
    problems.push({
      finding: 'SCHEMA_INCOMPATIBLE', component: 'database',
      detail: `this set was taken at schema version ${manifest.schemaVersion} and this build understands `
        + `${MIGRATION_VERSION}. Restoring it here would put an older build in front of a newer schema.`,
    });
  } else if (manifest.schemaVersion < MIGRATION_VERSION) {
    notes.push(`This set was taken at schema version ${manifest.schemaVersion}, which is older than this build's `
      + `${MIGRATION_VERSION}. That makes it a rollback point for the version it came from, and it cannot be `
      + 'restored under this build.');
  }

  // 5. THE SHIPPED OFFLINE INSPECTOR, run over the same directory and reported unmodified.
  let inspection: BackupInspection;
  try {
    inspection = inspectBackupDirectory(resolved);
  } catch (err) {
    return failed(setName, [...problems, {
      finding: 'INSPECTOR_REFUSED', component: null,
      detail: err instanceof Error ? err.message : 'the offline inspector refused this set',
    }], 'INCOMPLETE', manifest.schemaVersion, notes);
  }
  if (inspection.missing.length > 0) {
    for (const id of inspection.missing) {
      problems.push({
        finding: 'COMPONENT_MISSING', component: id,
        detail: `the offline inspector does not recognise a ${id} component in this set`,
      });
    }
  }

  notes.push('Nothing was restored and nothing was changed. This proves what the set CONTAINS and that it is '
    + 'unchanged since it was taken — not that a restore of it will succeed.');

  return {
    report: BACKUP_VERIFY_REPORT,
    version: BACKUP_VERIFY_VERSION,
    ok: problems.length === 0,
    setName,
    verified,
    problems,
    inspectorVerdict: inspection.verdict,
    manifestSchemaVersion: manifest.schemaVersion,
    buildSchemaVersion: MIGRATION_VERSION,
    wrote: 'nothing',
    network: 'none',
    notes,
  };
}

function failed(
  setName: string,
  problems: readonly VerificationProblem[],
  inspectorVerdict: BackupInspection['verdict'],
  manifestSchemaVersion: number,
  notes: readonly string[],
): BackupVerificationReport {
  return {
    report: BACKUP_VERIFY_REPORT,
    version: BACKUP_VERIFY_VERSION,
    ok: false,
    setName,
    verified: [],
    problems,
    inspectorVerdict,
    manifestSchemaVersion,
    buildSchemaVersion: MIGRATION_VERSION,
    wrote: 'nothing',
    network: 'none',
    notes: [...notes],
  };
}

/** The human summary. Component ids, findings and counts. Never a path and never a component's content. */
export function renderBackupVerification(report: BackupVerificationReport): string {
  const lines: string[] = [];
  lines.push(`Backup verification — ${report.ok ? 'VERIFIED' : 'REFUSED'}`);
  lines.push(`  set                 ${report.setName}`);
  lines.push(`  verified            ${report.verified.length === 0 ? 'nothing' : report.verified.join(', ')}`);
  lines.push(`  inspector verdict   ${report.inspectorVerdict}`);
  lines.push(`  manifest schema     ${report.manifestSchemaVersion}`);
  lines.push(`  build schema        ${report.buildSchemaVersion}`);
  lines.push(`  wrote               ${report.wrote}`);
  if (report.problems.length > 0) {
    lines.push('  problems:');
    for (const problem of report.problems) {
      lines.push(`    ${problem.finding.padEnd(22)} ${problem.component ?? '-'} — ${problem.detail}`);
    }
  }
  for (const note of report.notes) lines.push(`  note: ${note}`);
  lines.push(`  RESULT: ${report.ok ? 'VERIFIED' : 'REFUSED'}`);
  return lines.join('\n');
}

/** Every artifact name a verified set may hold. Exported so a test can assert the closed set. */
export function expectedArtifactNames(): readonly string[] {
  return [BACKUP_MANIFEST_NAME, ...BACKUP_COMPONENT_IDS.map((id) => COMPONENT_ARTIFACT_NAMES[id])];
}
