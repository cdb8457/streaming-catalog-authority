import { reviewO4O5EvidencePackets } from './o4-o5-evidence-packet-review.js';

interface ParsedArgs {
  readonly files: readonly string[];
  readonly json: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run ops:o4-o5-evidence-packet-review -- [--json] <packet.json>...',
    '',
    'Reviews saved Phase 166 O4/O5 evidence packet JSON files for schema, open gates, boundary, and redaction safety.',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const files: string[] = [];
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      files.push(arg);
    }
  }
  return { files, json };
}

function renderText(report: ReturnType<typeof reviewO4O5EvidencePackets>): string {
  const lines = [
    `report=${report.report}`,
    `ok=${report.ok}`,
    `reviewed=${report.reviewed} passed=${report.passed} failed=${report.failed}`,
  ];
  for (const file of report.files) {
    lines.push(`${file.state.toUpperCase()} ${file.file}`);
    for (const check of file.checks) lines.push(`  ${check.state.toUpperCase()} ${check.name}: ${check.detail}`);
  }
  return lines.join('\n');
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = reviewO4O5EvidencePackets({ files: args.files });
  console.log(args.json ? JSON.stringify(report) : renderText(report));
  if (!report.ok) process.exitCode = 1;
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 2;
}

