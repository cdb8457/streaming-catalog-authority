import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { createTorBoxLiveTransport, type TorBoxFetchLike } from './torbox-live-transport.js';
import {
  formatTorBoxLiveSmokeJson,
  formatTorBoxLiveSmokeText,
  runTorBoxLiveSmoke,
} from './torbox-live-smoke-runner.js';
import {
  buildTorBoxSmokeShellReport,
  formatTorBoxSmokeShellJson,
  formatTorBoxSmokeShellText,
  parseTorBoxSmokeShellArgs,
  torBoxSmokeShellUsage,
} from './torbox-smoke-shell.js';

/**
 * Phase 37/43 - TorBox smoke CLI shell and operator live smoke entrypoint.
 *
 * Live mode is refused by default and remains operator-run only. It reads one explicit credential
 * file and attaches global fetch only after all redaction and read-only gates pass.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(torBoxSmokeShellUsage());
    return 0;
  }

  const parsed = parseTorBoxSmokeShellArgs(argv);
  if ('error' in parsed) {
    console.error(torBoxSmokeShellUsage());
    console.error(`refusing: ${parsed.error}`);
    return 2;
  }

  const report = buildTorBoxSmokeShellReport(parsed);
  if (parsed.liveTransport && parsed.fixture === undefined) {
    if (!report.ok) {
      process.stdout.write(parsed.json ? formatTorBoxSmokeShellJson(report) : formatTorBoxSmokeShellText(report));
      return 2;
    }
    const credentialFile = getFlagValue(argv, '--credential-file');
    if (!credentialFile) {
      process.stdout.write(parsed.json ? formatTorBoxSmokeShellJson(report) : formatTorBoxSmokeShellText(report));
      return 2;
    }
    const bearerToken = readCredentialFileBounded(credentialFile);
    const fetchImpl = globalThis.fetch as unknown as TorBoxFetchLike;
    const liveReport = await runTorBoxLiveSmoke({
      options: parsed,
      transport: createTorBoxLiveTransport({ fetchImpl, bearerToken }),
    });
    process.stdout.write(parsed.json ? formatTorBoxLiveSmokeJson(liveReport) : formatTorBoxLiveSmokeText(liveReport));
    return liveReport.ok ? 0 : 2;
  }

  process.stdout.write(parsed.json ? formatTorBoxSmokeShellJson(report) : formatTorBoxSmokeShellText(report));
  return report.ok ? 0 : 2;
}

function getFlagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('-') ? value : undefined;
}

function readCredentialFileBounded(path: string): string {
  const maxBytes = 4096;
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error('credential-file-read-failed');
    const buffer = Buffer.alloc(stat.size);
    const bytes = readSync(fd, buffer, 0, stat.size, 0);
    const value = buffer.subarray(0, bytes).toString('utf8').trim();
    if (value.length === 0 || /[\r\n]/.test(value)) throw new Error('credential-file-read-failed');
    return value;
  } catch {
    throw new Error('credential-file-read-failed');
  } finally {
    closeSync(fd);
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  const message = err instanceof Error && err.message === 'credential-file-read-failed'
    ? 'refusing: credential-file-read-failed'
    : 'refusing: live-smoke-failed';
  console.error(message);
  process.exit(2);
});
