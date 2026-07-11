import { OPERATOR_UI_TOKEN_DEFAULT_PATH, resolveOperatorUiTokenPath } from './operator-ui-token.js';
import {
  OPERATOR_UI_LIVE_CHECK_DEFAULT_BASE_URL,
  OPERATOR_UI_LIVE_CHECK_DEFAULT_TIMEOUT_MS,
  runOperatorUiLiveCheck,
} from './operator-ui-live-check.js';

interface ParsedArgs {
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly timeoutMs: number;
  readonly json: boolean;
}

function usage(): string {
  return [
    'Usage:',
    `  npm run ops:operator-ui-live-check -- [--url ${OPERATOR_UI_LIVE_CHECK_DEFAULT_BASE_URL}] [--token-file ${OPERATOR_UI_TOKEN_DEFAULT_PATH}] [--timeout-ms ${OPERATOR_UI_LIVE_CHECK_DEFAULT_TIMEOUT_MS}] [--json]`,
    '',
    'Runs a redaction-safe live check of /healthz, auth rejection, authenticated status, and logs.',
    'Never prints the operator token, secret values, database URLs, provider identifiers, or raw log payloads.',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let baseUrl = process.env.OPERATOR_UI_BASE_URL ?? OPERATOR_UI_LIVE_CHECK_DEFAULT_BASE_URL;
  let tokenFile = resolveOperatorUiTokenPath(undefined, process.env);
  let timeoutMs = OPERATOR_UI_LIVE_CHECK_DEFAULT_TIMEOUT_MS;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--url') {
      const value = argv[++i];
      if (value === undefined) throw new Error('Missing value for --url.');
      baseUrl = value;
    } else if (arg === '--token-file') {
      const value = argv[++i];
      if (value === undefined) throw new Error('Missing value for --token-file.');
      tokenFile = resolveOperatorUiTokenPath(value, process.env);
    } else if (arg === '--timeout-ms') {
      const value = argv[++i];
      if (value === undefined) throw new Error('Missing value for --timeout-ms.');
      timeoutMs = Number(value);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30000) throw new Error('Invalid --timeout-ms.');
    } else if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { baseUrl, tokenFile, timeoutMs, json };
}

function renderText(report: Awaited<ReturnType<typeof runOperatorUiLiveCheck>>): string {
  const lines = [
    `report=${report.report}`,
    `baseUrl=${report.baseUrl}`,
    `ok=${report.ok}`,
  ];
  for (const check of report.checks) lines.push(`${check.state.toUpperCase()} ${check.name} status=${check.statusCode} ${check.detail}`);
  if (report.statusSummary !== undefined) {
    lines.push(`doctor pass=${report.statusSummary.pass} warn=${report.statusSummary.warn} fail=${report.statusSummary.fail} total=${report.statusSummary.total}`);
    lines.push(`needsAttention=${report.statusSummary.needsAttentionCount}`);
  }
  if (report.logSummary !== undefined) lines.push(`logs entries=${report.logSummary.entries}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runOperatorUiLiveCheck({ baseUrl: args.baseUrl, tokenFile: args.tokenFile, timeoutMs: args.timeoutMs });
    console.log(args.json ? JSON.stringify(report) : renderText(report));
    if (!report.ok) process.exitCode = 1;
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 2;
  }
}

await main();
