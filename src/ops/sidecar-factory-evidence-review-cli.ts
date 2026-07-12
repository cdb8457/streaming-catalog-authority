import {
  formatSidecarFactoryEvidenceReviewText,
  reviewSidecarFactoryEvidence,
} from './sidecar-factory-evidence-review.js';

interface ParsedArgs {
  readonly files: readonly string[];
  readonly json: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run ops:sidecar-factory-evidence-review -- [--json] <phase-189-evidence.json>...',
    '',
    'Reviews saved Phase 189 sidecar factory evidence JSON files for schema, passing checks, safety boundary, and redaction.',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const files: string[] = [];
  let json = false;
  for (const arg of argv) {
    if (arg === '--') {
      continue;
    } else if (arg === '--json') {
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

try {
  const args = parseArgs(process.argv.slice(2));
  const report = reviewSidecarFactoryEvidence({ files: args.files });
  console.log(args.json ? JSON.stringify(report) : formatSidecarFactoryEvidenceReviewText(report));
  if (!report.ok) process.exitCode = 1;
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 2;
}
