import {
  OPERATOR_UI_EVIDENCE_REVIEW_DEFAULT_MAX_AGE_HOURS,
  reviewOperatorUiEvidence,
} from './operator-ui-evidence-review.js';

interface ParsedArgs {
  readonly files: readonly string[];
  readonly maxAgeHours: number;
  readonly json: boolean;
}

function usage(): string {
  return [
    'Usage:',
    `  npm run ops:operator-ui-evidence-review -- [--max-age-hours ${OPERATOR_UI_EVIDENCE_REVIEW_DEFAULT_MAX_AGE_HOURS}] [--json] <evidence.json>...`,
    '',
    'Reviews saved ui-live-check evidence JSON files for validity, schema completeness, recency, and pass state.',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const files: string[] = [];
  let maxAgeHours = OPERATOR_UI_EVIDENCE_REVIEW_DEFAULT_MAX_AGE_HOURS;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) throw new Error('Unexpected empty argument.');
    if (arg === '--json') {
      json = true;
    } else if (arg === '--max-age-hours') {
      const value = argv[++i];
      if (value === undefined) throw new Error('Missing value for --max-age-hours.');
      maxAgeHours = Number(value);
      if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('Invalid --max-age-hours.');
    } else if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      files.push(arg);
    }
  }
  return { files, maxAgeHours, json };
}

function renderText(report: ReturnType<typeof reviewOperatorUiEvidence>): string {
  const lines = [
    `report=${report.report}`,
    `ok=${report.ok}`,
    `reviewed=${report.reviewed} passed=${report.passed} failed=${report.failed} maxAgeHours=${report.maxAgeHours}`,
  ];
  for (const file of report.files) {
    const age = file.ageHours === undefined ? 'unknown' : `${file.ageHours.toFixed(2)}h`;
    lines.push(`${file.state.toUpperCase()} ${file.file} age=${age}`);
    for (const check of file.checks) lines.push(`  ${check.state.toUpperCase()} ${check.name}: ${check.detail}`);
  }
  return lines.join('\n');
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = reviewOperatorUiEvidence({ files: args.files, maxAgeHours: args.maxAgeHours });
  console.log(args.json ? JSON.stringify(report) : renderText(report));
  if (!report.ok) process.exitCode = 1;
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 2;
}
