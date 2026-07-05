import {
  OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST,
  OPERATOR_UI_STATIC_RUNTIME_DEFAULT_PORT,
  OPERATOR_UI_STATIC_RUNTIME_MAX_PORT,
  OPERATOR_UI_STATIC_RUNTIME_MIN_CLI_PORT,
  OperatorUiStaticRuntimeConfigError,
  OperatorUiStaticRuntimeSelfCheckError,
  type StartedOperatorUiStaticRuntime,
  startOperatorUiStaticRuntime,
  validateOperatorUiStaticRuntimeConfig,
} from './operator-ui-static-runtime.js';

interface ParsedCliArgs {
  readonly serve: boolean;
  readonly host: string;
  readonly port: number;
}

function usage(): string {
  return [
    'Operator UI Static Runtime Shell',
    '',
    'Boundary: local fixture-only static preview; no API, packet source, DB read, provider, playback, download, scraping, or media-server behavior.',
    '',
    'Usage:',
    `  npm run ops:operator-ui-static-runtime -- --serve [--host ${OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST}] [--port ${OPERATOR_UI_STATIC_RUNTIME_DEFAULT_PORT}]`,
    '',
    `Allowed host: ${OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST}`,
    `Allowed CLI port range: ${OPERATOR_UI_STATIC_RUNTIME_MIN_CLI_PORT}-${OPERATOR_UI_STATIC_RUNTIME_MAX_PORT}`,
  ].join('\n');
}

function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  let serve = false;
  let host = OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST;
  let port = OPERATOR_UI_STATIC_RUNTIME_DEFAULT_PORT;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--serve') {
      serve = true;
      continue;
    }

    if (arg === '--host') {
      const value = args[index + 1];
      if (value === undefined) throw new OperatorUiStaticRuntimeConfigError();
      host = value;
      index += 1;
      continue;
    }

    if (arg === '--port') {
      const value = args[index + 1];
      if (value === undefined || !/^\d+$/.test(value)) throw new OperatorUiStaticRuntimeConfigError();
      port = Number(value);
      index += 1;
      continue;
    }

    throw new OperatorUiStaticRuntimeConfigError();
  }

  return { serve, host, port };
}

function installShutdownHandlers(runtime: StartedOperatorUiStaticRuntime): void {
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

    const config = validateOperatorUiStaticRuntimeConfig(parsed, { allowEphemeralPort: false });
    const runtime = await startOperatorUiStaticRuntime(config);
    installShutdownHandlers(runtime);
    process.stdout.write(`Operator UI static runtime listening at ${runtime.url}\n`);
  } catch (err) {
    process.exitCode = 1;
    if (err instanceof OperatorUiStaticRuntimeConfigError) {
      process.stderr.write('Operator UI static runtime refused unsafe config.\n');
      process.stderr.write(`${usage()}\n`);
      return;
    }

    if (err instanceof OperatorUiStaticRuntimeSelfCheckError) {
      process.stderr.write('Operator UI static runtime failed self-check safely.\n');
      return;
    }

    process.stderr.write('Operator UI static runtime failed safely.\n');
  }
}

void main();
