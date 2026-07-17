import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LOCAL_OPS_REGISTRY } from './promotion-acceptance-meta.js';

// Local, non-live CLI ergonomics guard. Every registered op's CLI must define a usage() text and handle
// --help (print usage, exit 0) so an operator can always discover the contract without side effects. This
// guard verifies both statically over every registry CLI; its test additionally drives a sample of CLIs
// live (--help exits 0 with a usage line; malformed input exits non-zero with a clean one-line message and
// no stack trace). It reads files + the shared registry only; it performs no promotion, never touches the
// real Movies root, never contacts Jellyfin, and authorizes nothing live.

export interface CliErgonomicsResult {
  readonly cli: string;
  readonly usageDefined: boolean;
  readonly helpHandled: boolean;
  readonly ok: boolean;
}

export interface CliErgonomicsReport {
  readonly report: 'phase-230-promotion-cli-ergonomics';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'CLI_ERGONOMICS_OK' | 'CLI_ERGONOMICS_GAP';
  readonly cliCount: number;
  readonly results: readonly CliErgonomicsResult[];
  readonly gaps: readonly string[];
  readonly ergonomicsDigest: string;
}

export function buildCliErgonomics(projectRoot: string): CliErgonomicsReport {
  const read = (rel: string): string => { try { return readFileSync(`${projectRoot}/${rel}`, 'utf8'); } catch { return ''; } };
  const gaps: string[] = [];

  const results: CliErgonomicsResult[] = LOCAL_OPS_REGISTRY.map(({ base }) => {
    const src = read(`src/ops/${base}-cli.ts`);
    const usageDefined = src.includes('function usage(');
    const helpHandled = src.includes(`'--help'`);
    if (!usageDefined) gaps.push('USAGE_MISSING');
    if (!helpHandled) gaps.push('HELP_MISSING');
    return { cli: base, usageDefined, helpHandled, ok: usageDefined && helpHandled };
  });

  const uniqueGaps = [...new Set(gaps)];
  const overall: CliErgonomicsReport['overall'] = uniqueGaps.length === 0 ? 'CLI_ERGONOMICS_OK' : 'CLI_ERGONOMICS_GAP';
  const withoutDigest: Omit<CliErgonomicsReport, 'ergonomicsDigest'> = {
    report: 'phase-230-promotion-cli-ergonomics',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    cliCount: results.length,
    results,
    gaps: uniqueGaps,
  };
  return { ...withoutDigest, ergonomicsDigest: digest('phase-230-cli-ergonomics', JSON.stringify(withoutDigest)) };
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
