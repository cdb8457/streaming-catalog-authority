import {
  OPERATOR_UI_SERVICE_DEFAULT_HOST,
  OPERATOR_UI_SERVICE_DEFAULT_PORT,
  OperatorUiServiceConfigError,
  OperatorUiServiceStartupError,
  type StartedOperatorUiService,
  startOperatorUiService,
  validateOperatorUiServiceConfig,
} from './operator-ui-service.js';

interface ParsedCliArgs {
  readonly serve: boolean;
  readonly host: string;
  readonly port: number;
  readonly operatorSecretFile?: string;
}

function usage(): string {
  return [
    'Catalog Authority Operator UI Service',
    '',
    'Boundary: read-only status and redacted logs; no provider contact, scraping, downloading, playback, or runtime mutation.',
    '',
    'Usage:',
    `  npm run ops:operator-ui-server -- --serve [--host ${OPERATOR_UI_SERVICE_DEFAULT_HOST}] [--port ${OPERATOR_UI_SERVICE_DEFAULT_PORT}] [--operator-secret-file <path>]`,
    '',
    'Docker/Unraid default secret env: OPERATOR_UI_TOKEN_FILE=/run/secrets/operator_ui_token',
  ].join('\n');
}

function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  let serve = false;
  let host = OPERATOR_UI_SERVICE_DEFAULT_HOST;
  let port = OPERATOR_UI_SERVICE_DEFAULT_PORT;
  let operatorSecretFile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--serve') {
      serve = true;
      continue;
    }
    if (arg === '--host') {
      const value = args[index + 1];
      if (value === undefined) throw new OperatorUiServiceConfigError();
      host = value;
      index += 1;
      continue;
    }
    if (arg === '--port') {
      const value = args[index + 1];
      if (value === undefined || !/^\d+$/.test(value)) throw new OperatorUiServiceConfigError();
      port = Number(value);
      index += 1;
      continue;
    }
    if (arg === '--operator-secret-file') {
      const value = args[index + 1];
      if (value === undefined || value.trim() === '') throw new OperatorUiServiceConfigError();
      operatorSecretFile = value;
      index += 1;
      continue;
    }
    throw new OperatorUiServiceConfigError();
  }

  return operatorSecretFile === undefined ? { serve, host, port } : { serve, host, port, operatorSecretFile };
}

function installShutdownHandlers(runtime: StartedOperatorUiService): void {
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    runtime.close()
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
    const parsed = parseCliArgs(process.argv.slice(2));
    if (!parsed.serve) {
      process.stdout.write(`${usage()}\n`);
      return;
    }

    const config = validateOperatorUiServiceConfig(parsed);
    const runtime = await startOperatorUiService(config);
    installShutdownHandlers(runtime);
    process.stdout.write(`Catalog Authority operator UI listening at ${runtime.url}\n`);
  } catch (err) {
    process.exitCode = 1;
    if (err instanceof OperatorUiServiceConfigError || err instanceof OperatorUiServiceStartupError) {
      process.stderr.write('Catalog Authority operator UI refused unsafe startup.\n');
      process.stderr.write(`${usage()}\n`);
      return;
    }

    process.stderr.write('Catalog Authority operator UI failed safely.\n');
  }
}

void main();
