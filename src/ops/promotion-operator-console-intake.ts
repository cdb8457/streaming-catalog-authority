import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSOLE_ARTIFACT_FILENAMES,
  CONSOLE_PHASES,
  type ArtifactStatus,
  type OperatorConsoleInput,
} from './promotion-operator-console.js';

// The one place the Phase 242 console chain touches a filesystem. Every caller that turns an operator's
// directory or bundle into console intake comes through here -- the Phase 242 CLI and the Phase 243 dashboard
// both do -- so discovery semantics exist once and cannot drift apart between surfaces.
//
// ALLOWLISTED, NEVER PATH-DRIVEN. Candidate paths are built from the FIXED filename table joined to the one
// directory the operator named, non-recursively. No filename, glob or path is ever taken from the data being
// read, so a hostile artifact cannot steer a read. Entries that are not on the allowlist are counted and
// otherwise untouched -- a directory legitimately holds other things.
//
// FAIL CLOSED ON ANYTHING THAT IS NOT A PLAIN, BOUNDED FILE. A symlink, directory, device or socket sitting
// under an allowlisted name is refused rather than followed: following it would let something outside the
// named directory be read as though it were an artifact. So is a file larger than the cap -- an artifact of
// this chain is a few kilobytes of digests, and nothing here needs to be able to exhaust memory. Both are
// reported as MALFORMED, never as ABSENT: an operator whose artifact was refused must be told, not left
// reading "the phase has not happened yet".

// Generous by three orders of magnitude for a real artifact, and still far too small to hurt.
export const CONSOLE_INTAKE_MAX_ARTIFACT_BYTES = 1024 * 1024;

export class ConsoleIntakeError extends Error {
  readonly code: 'CONSOLE_INTAKE_DIRECTORY_UNREADABLE' | 'CONSOLE_INTAKE_BUNDLE_UNREADABLE';

  // The offending path is deliberately never carried on the error: it is operator input, and nothing in this
  // chain reflects operator input back into a message, a log or a page.
  constructor(code: ConsoleIntakeError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'ConsoleIntakeError';
  }
}

export interface DiscoveredConsoleIntake {
  readonly artifacts: Record<string, { readonly status: ArtifactStatus; readonly report?: unknown }>;
  readonly unknownFilesIgnored: number;
}

export function consoleIntakeAllowedFilenames(): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const phase of CONSOLE_PHASES) for (const name of CONSOLE_ARTIFACT_FILENAMES[phase]!) allowed.add(name);
  return allowed;
}

export function discoverConsoleIntake(dir: string): DiscoveredConsoleIntake {
  let entries: readonly string[];
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    entries = readdirSync(dir);
  } catch {
    throw new ConsoleIntakeError('CONSOLE_INTAKE_DIRECTORY_UNREADABLE', 'the artifact directory is missing or not a readable directory');
  }

  const allowed = consoleIntakeAllowedFilenames();
  const artifacts: Record<string, { status: ArtifactStatus; report?: unknown }> = {};

  for (const phase of CONSOLE_PHASES) {
    const names = CONSOLE_ARTIFACT_FILENAMES[phase]!.filter((name) => entries.includes(name));
    if (names.length === 0) continue;                                  // ABSENT: normal, never a defect
    if (names.length > 1) { artifacts[String(phase)] = { status: 'DUPLICATE' }; continue; }
    artifacts[String(phase)] = readArtifact(join(dir, names[0]!));
  }
  return { artifacts, unknownFilesIgnored: entries.filter((e) => !allowed.has(e)).length };
}

function readArtifact(path: string): { status: ArtifactStatus; report?: unknown } {
  try {
    // lstat, NOT stat: a symlink must be refused, not resolved. The size is taken from the same lstat that
    // established the file is regular, so the check cannot be defeated by swapping the entry afterwards --
    // the read below either sees the same file or fails, and either way nothing outside the cap is parsed.
    const stat = lstatSync(path);
    if (!stat.isFile()) return { status: 'MALFORMED' };
    if (stat.size > CONSOLE_INTAKE_MAX_ARTIFACT_BYTES) return { status: 'MALFORMED' };
    const body = readFileSync(path, 'utf8');
    if (Buffer.byteLength(body, 'utf8') > CONSOLE_INTAKE_MAX_ARTIFACT_BYTES) return { status: 'MALFORMED' };
    return { status: 'PRESENT', report: JSON.parse(body) };
  } catch {
    // Unreadable, not JSON, or replaced mid-read. A defect in the artifact, NOT an absence.
    return { status: 'MALFORMED' };
  }
}

export function readConsoleBundle(path: string): unknown {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > CONSOLE_INTAKE_MAX_ARTIFACT_BYTES) throw new Error('not a bounded regular file');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConsoleIntakeError('CONSOLE_INTAKE_BUNDLE_UNREADABLE', 'the bundle file is missing, oversized, or not valid JSON');
  }
}

// One intake, either way in, so both surfaces build the console from identical input.
export function buildConsoleIntake(source: { readonly dir: string } | { readonly bundle: string }): OperatorConsoleInput {
  if ('dir' in source) {
    const found = discoverConsoleIntake(source.dir);
    return { mode: 'DIRECTORY', artifacts: found.artifacts, unknownFilesIgnored: found.unknownFilesIgnored };
  }
  return { mode: 'BUNDLE', bundle: readConsoleBundle(source.bundle) };
}
