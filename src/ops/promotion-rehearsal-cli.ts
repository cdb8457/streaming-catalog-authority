import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REHEARSAL_SCENARIOS, runPromotionRehearsal, type RehearsalInput, type RehearsalScenario } from './promotion-rehearsal.js';

// Offline rehearsal CLI. Runs the fixture-only Phase 230 pipeline end-to-end in an ephemeral sandbox
// and writes a redaction-safe manifest. Never runs the deploy launcher, never touches the real Movies
// root, never contacts Jellyfin, and authorizes nothing live.

function usage(): string {
  return [
    'usage: ops:promotion-rehearsal [--scenario <name>] [--work-dir <dir>] [--title <t>] [--year <y>] \\',
    '    [--item-id <id>] [--acceptor-id <id>] [--run-id <id>] [--keep-sandbox] [--out <manifest.json>] [--artifacts-dir <dir>]',
    '',
    `  --scenario one of: ${REHEARSAL_SCENARIOS.join(', ')} (default: success)`,
    '',
    'Local, non-live: builds an ephemeral fixture sandbox and runs approval -> promotion (promote+withdraw) ->',
    'evidence review -> readiness -> acceptance seal with a local file-state observer (no Jellyfin), then emits a',
    'redaction-safe manifest. Non-success scenarios inject a deterministic fixture fault. Exit 0 = REHEARSAL_PASS,',
    '1 = REHEARSAL_FAIL. Does not authorize Phase 231.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const artifactsDir = valueAfter(args, '--artifacts-dir');
  const yearRaw = valueAfter(args, '--year');
  const year = yearRaw === undefined ? undefined : Number(yearRaw);
  if (yearRaw !== undefined && (!Number.isInteger(year) || year! < 0)) {
    console.error('invalid --year: expected a non-negative integer');
    return 2;
  }
  const scenarioRaw = valueAfter(args, '--scenario');
  if (scenarioRaw !== undefined && !REHEARSAL_SCENARIOS.includes(scenarioRaw as RehearsalScenario)) {
    console.error(`invalid --scenario: expected one of ${REHEARSAL_SCENARIOS.join(', ')}`);
    return 2;
  }

  const input: RehearsalInput = {
    ...(scenarioRaw !== undefined ? { scenario: scenarioRaw as RehearsalScenario } : {}),
    ...(valueAfter(args, '--work-dir') !== undefined ? { workDir: valueAfter(args, '--work-dir') } : {}),
    ...(valueAfter(args, '--title') !== undefined ? { title: valueAfter(args, '--title') } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(valueAfter(args, '--item-id') !== undefined ? { itemId: valueAfter(args, '--item-id') } : {}),
    ...(valueAfter(args, '--acceptor-id') !== undefined ? { acceptorId: valueAfter(args, '--acceptor-id') } : {}),
    ...(valueAfter(args, '--run-id') !== undefined ? { runId: valueAfter(args, '--run-id') } : {}),
    ...(args.includes('--keep-sandbox') ? { keepSandbox: true } : {}),
  };

  let result;
  try {
    result = await runPromotionRehearsal(input);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const { manifest, artifacts } = result;

  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  if (artifactsDir) {
    mkdirSync(artifactsDir, { recursive: true });
    for (const [name, value] of Object.entries(artifacts)) {
      if (value === undefined) continue;
      writeFileSync(join(artifactsDir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  }

  console.log(JSON.stringify({
    report: 'phase-230-promotion-rehearsal-capture',
    scenario: manifest.scenario,
    outcome: manifest.outcome,
    redactionSafe: true,
    stages: manifest.stages.map((s) => ({ stage: s.stage, ok: s.ok, status: s.status })),
    notes: manifest.notes,
    manifestDigest: manifest.manifestDigest,
    // Never echo the raw --out / --artifacts-dir paths; report only that files were written.
    ...(out ? { manifestWritten: true } : {}),
    ...(artifactsDir ? { artifactsWritten: true } : {}),
  }, null, 2));
  return manifest.outcome === 'REHEARSAL_PASS' ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
