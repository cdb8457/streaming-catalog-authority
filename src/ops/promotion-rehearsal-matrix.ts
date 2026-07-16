import { createHash } from 'node:crypto';
import { REHEARSAL_SCENARIOS, runPromotionRehearsal, type RehearsalInput, type RehearsalScenario } from './promotion-rehearsal.js';

// Local, non-live rehearsal matrix: runs every fixture scenario and checks each produces its EXPECTED
// outcome (success -> REHEARSAL_PASS, every fault -> REHEARSAL_FAIL). It is a self-test of the rehearsal
// harness across all modes. It never runs the deploy launcher, never touches the real Movies root,
// never contacts Jellyfin, and authorizes nothing live.

export interface RehearsalMatrixInput {
  readonly workDir?: string;
  readonly runId?: string;
  readonly acceptorId?: string;
  readonly keepSandbox?: boolean;
  readonly now?: () => Date;
}

export interface RehearsalMatrixEntry {
  readonly scenario: RehearsalScenario;
  readonly expected: 'REHEARSAL_PASS' | 'REHEARSAL_FAIL';
  readonly outcome: 'REHEARSAL_PASS' | 'REHEARSAL_FAIL';
  readonly matches: boolean;
  readonly manifestDigest: string;
}

export interface RehearsalMatrixManifest {
  readonly report: 'phase-230-promotion-rehearsal-matrix';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly outcome: 'MATRIX_PASS' | 'MATRIX_FAIL';
  readonly entries: readonly RehearsalMatrixEntry[];
  readonly matrixDigest: string;
}

export function expectedOutcome(scenario: RehearsalScenario): 'REHEARSAL_PASS' | 'REHEARSAL_FAIL' {
  return scenario === 'success' ? 'REHEARSAL_PASS' : 'REHEARSAL_FAIL';
}

export async function runRehearsalMatrix(input: RehearsalMatrixInput = {}): Promise<RehearsalMatrixManifest> {
  const baseRunId = input.runId ?? 'matrix';
  const entries: RehearsalMatrixEntry[] = [];
  for (const scenario of REHEARSAL_SCENARIOS) {
    const runInput: RehearsalInput = {
      ...(input.workDir !== undefined ? { workDir: input.workDir } : {}),
      ...(input.acceptorId !== undefined ? { acceptorId: input.acceptorId } : {}),
      ...(input.keepSandbox !== undefined ? { keepSandbox: input.keepSandbox } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
      runId: `${baseRunId}-${scenario}`,
      itemId: `phase-230-matrix-${scenario}`,
      title: 'Matrix Fixture',
      year: 2026,
      scenario,
    };
    const { manifest } = await runPromotionRehearsal(runInput);
    const expected = expectedOutcome(scenario);
    entries.push({ scenario, expected, outcome: manifest.outcome, matches: manifest.outcome === expected, manifestDigest: manifest.manifestDigest });
  }

  const outcome: RehearsalMatrixManifest['outcome'] = entries.every((e) => e.matches) ? 'MATRIX_PASS' : 'MATRIX_FAIL';
  const withoutDigest: Omit<RehearsalMatrixManifest, 'matrixDigest'> = {
    report: 'phase-230-promotion-rehearsal-matrix',
    version: 1,
    redactionSafe: true,
    outcome,
    entries,
  };
  return { ...withoutDigest, matrixDigest: digest('phase-230-rehearsal-matrix', JSON.stringify(withoutDigest)) };
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
