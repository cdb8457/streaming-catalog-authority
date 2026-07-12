import {
  runSidecarDaemonSelfTest,
  SidecarDaemonConfigError,
  startSidecarDaemon,
  validateSidecarDaemonConfig,
} from './sidecar-daemon.js';

interface ParsedArgs {
  readonly serve: boolean;
  readonly selfTest: boolean;
  readonly json: boolean;
  readonly socketPath?: string;
  readonly stateDir?: string;
  readonly completionSecretFile?: string;
  readonly kekFile?: string;
}

function usage(): string {
  return [
    'Catalog Authority Sidecar Daemon',
    '',
    'Boundary: local Unix socket or Windows named pipe only; no TCP, HTTP, provider contact, playback, or media-server mutation.',
    '',
    'Usage:',
    '  npm run ops:sidecar-daemon -- -- --self-test [--json]',
    '  npm run ops:sidecar-daemon -- -- --serve --socket <path> --state-dir <path> --completion-secret-file <path> --kek-file <path>',
    '',
    'Environment fallback:',
    '  SIDECAR_SOCKET_PATH, SIDECAR_STATE_DIR, SIDECAR_COMPLETION_SECRET_FILE, SIDECAR_KEK_FILE',
  ].join('\n');
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let serve = false;
  let selfTest = false;
  let json = false;
  let socketPath: string | undefined;
  let stateDir: string | undefined;
  let completionSecretFile: string | undefined;
  let kekFile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--serve') {
      serve = true;
      continue;
    }
    if (arg === '--self-test') {
      selfTest = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--socket') {
      socketPath = readValue(args, index);
      index += 1;
      continue;
    }
    if (arg === '--state-dir') {
      stateDir = readValue(args, index);
      index += 1;
      continue;
    }
    if (arg === '--completion-secret-file') {
      completionSecretFile = readValue(args, index);
      index += 1;
      continue;
    }
    if (arg === '--kek-file') {
      kekFile = readValue(args, index);
      index += 1;
      continue;
    }
    throw new SidecarDaemonConfigError();
  }

  if (serve === selfTest) throw new SidecarDaemonConfigError();
  return { serve, selfTest, json, socketPath, stateDir, completionSecretFile, kekFile };
}

function readValue(args: readonly string[], index: number): string {
  const value = args[index + 1];
  if (value === undefined || value.trim() === '') throw new SidecarDaemonConfigError();
  return value;
}

function installShutdownHandlers(close: () => Promise<void>): void {
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.selfTest) {
      const report = await runSidecarDaemonSelfTest();
      if (parsed.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else {
        process.stdout.write(`Phase 187 sidecar daemon self-test: ${report.ok ? 'PASS' : 'FAIL'}\n`);
        for (const check of report.checks) process.stdout.write(`${check.state.toUpperCase()} ${check.id}: ${check.detail}\n`);
      }
      process.exitCode = report.ok ? 0 : 1;
      return;
    }

    const daemon = await startSidecarDaemon(validateSidecarDaemonConfig(parsed));
    installShutdownHandlers(() => daemon.close());
    process.stdout.write(`Catalog Authority sidecar daemon listening on local socket ${daemon.socketPath}\n`);
    process.stdout.write('FileCustodian remains a reference harness; this process does not close O4 or O5.\n');
  } catch (err) {
    process.exitCode = 1;
    if (err instanceof SidecarDaemonConfigError) {
      process.stderr.write('Catalog Authority sidecar daemon refused unsafe startup.\n');
      process.stderr.write(`${usage()}\n`);
      return;
    }
    process.stderr.write('Catalog Authority sidecar daemon failed safely.\n');
  }
}

void main();
