import { readFileSync } from 'node:fs';

import { buildPhase14Preflight, Phase14DescriptorError } from '../core/projection/phase14.js';

const usage = 'usage: ops:projection-phase14-preflight [--descriptor <boolean-only.json>] [--json]';

function render(report: ReturnType<typeof buildPhase14Preflight>): readonly string[] {
  return [
    'Projection Phase 14 — operator preflight',
    `status: ${report.status}`,
    report.meaning,
    '',
    'missing confirmations',
    ...(report.missing.length === 0 ? ['  none'] : report.missing.map((row) =>
      `  ${row.id}: ${row.requiredShape}; ${row.confirmation}; unblocks ${row.unblocks.join(', ')}`)),
    '',
    `still-open claims: ${report.openClaims.join(', ')}`,
    'claims closed: none; contacts made: 0; values echoed: no; Phase 14 entered: no',
  ];
}

export function main(argv: readonly string[]): number {
  let descriptorPath: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--help') { console.log(usage); return 0; }
    if (arg === '--descriptor' && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) {
      descriptorPath = argv[++i]; continue;
    }
    console.error(usage); return 2;
  }

  let input: unknown = {};
  if (descriptorPath !== undefined) {
    try { input = JSON.parse(readFileSync(descriptorPath, 'utf8')); }
    catch { console.error('DESCRIPTOR_REFUSED: the boolean-only descriptor could not be read'); return 4; }
  }
  try {
    const report = buildPhase14Preflight(input);
    if (json) console.log(JSON.stringify(report, null, 2));
    else for (const line of render(report)) console.log(line);
    return report.status === 'READY' ? 0 : 3;
  } catch (error) {
    const code = error instanceof Phase14DescriptorError ? error.code : 'INVALID';
    console.error(`DESCRIPTOR_REFUSED: ${code}`);
    return 4;
  }
}

if (process.argv[1]?.endsWith('projection-phase14-preflight-cli.ts')) process.exitCode = main(process.argv.slice(2));

