import { parseCutoverDoctorCheckpointFile } from './cutover-doctor-check.js';

function usage(): string {
  return [
    'usage: ops:cutover-doctor-check -- <doctor-output-file> [--exit-code <n>] [--json]',
    '',
    'Validates a captured ops:doctor --json checkpoint output. The input may include npm banner',
    'lines before the JSON payload. Parse errors are retryable checkpoint errors; unhealthy doctor',
    'reports are non-retryable health failures.',
  ].join('\n');
}

function readArg(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value) throw new Error(`missing value for ${args[index]}`);
  return value;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help') || args.length === 0) {
    console.log(usage());
    return args.length === 0 ? 2 : 0;
  }

  let file: string | undefined;
  let exitCode = 0;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--json') { json = true; continue; }
    if (arg === '--exit-code') { exitCode = Number(readArg(args, i)); i++; continue; }
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    if (file !== undefined) throw new Error(`unexpected extra argument: ${arg}`);
    file = arg;
  }
  if (!file) throw new Error('doctor output file is required');
  if (!Number.isInteger(exitCode) || exitCode < 0) throw new Error('--exit-code must be a non-negative integer');

  const result = parseCutoverDoctorCheckpointFile(file, exitCode);
  if (json) console.log(JSON.stringify(result));
  else console.log(`${result.status}: ${result.reason ?? `pass=${result.pass} warn=${result.warn} fail=${result.fail}`}`);
  return result.status === 'healthy' ? 0 : result.status === 'unhealthy' ? 1 : 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error((err as Error).message); process.exit(2); });
