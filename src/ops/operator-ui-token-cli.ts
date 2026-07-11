import {
  OperatorUiTokenError,
  buildOperatorUiTokenStatus,
  readTokenValue,
  resolveOperatorUiTokenPath,
  rotateOperatorUiToken,
} from './operator-ui-token.js';

interface ParsedArgs {
  readonly path?: string;
  readonly showPath: boolean;
  readonly status: boolean;
  readonly rotate: boolean;
  readonly confirm: boolean;
  readonly print: boolean;
  readonly confirmPrint: boolean;
  readonly json: boolean;
}

function usage(): string {
  return [
    'Catalog Authority Operator UI Token',
    '',
    'Usage:',
    '  npm run ops:operator-ui-token -- --show-path [--path <file>]',
    '  npm run ops:operator-ui-token -- --status [--json] [--path <file>]',
    '  npm run ops:operator-ui-token -- --rotate --confirm [--json] [--path <file>]',
    '  npm run ops:operator-ui-token -- --print --confirm-print [--path <file>]',
    '',
    'Default path: OPERATOR_UI_TOKEN_FILE or /mnt/user/appdata/catalog/secrets/operator_ui_token',
    'Safety: token value is printed only with --print --confirm-print.',
  ].join('\n');
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let path: string | undefined;
  let showPath = false;
  let status = false;
  let rotate = false;
  let confirm = false;
  let print = false;
  let confirmPrint = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--path') {
      const value = args[index + 1];
      if (value === undefined || value.trim() === '') throw new OperatorUiTokenError();
      path = value;
      index += 1;
      continue;
    }
    if (arg === '--show-path') { showPath = true; continue; }
    if (arg === '--status') { status = true; continue; }
    if (arg === '--rotate') { rotate = true; continue; }
    if (arg === '--confirm') { confirm = true; continue; }
    if (arg === '--print') { print = true; continue; }
    if (arg === '--confirm-print') { confirmPrint = true; continue; }
    if (arg === '--json') { json = true; continue; }
    throw new OperatorUiTokenError();
  }

  return { path, showPath, status, rotate, confirm, print, confirmPrint, json };
}

function exactlyOneAction(parsed: ParsedArgs): boolean {
  return [parsed.showPath, parsed.status, parsed.rotate, parsed.print].filter(Boolean).length === 1;
}

function printStatus(status: ReturnType<typeof buildOperatorUiTokenStatus>, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  process.stdout.write([
    `path: ${status.path}`,
    `exists: ${status.exists}`,
    `readable: ${status.readable}`,
    `bytes: ${status.bytes}`,
    `acceptable: ${status.acceptable}`,
  ].join('\n'));
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (!exactlyOneAction(parsed)) throw new OperatorUiTokenError();
    const path = resolveOperatorUiTokenPath(parsed.path);

    if (parsed.showPath) {
      process.stdout.write(`${path}\n`);
      return;
    }

    if (parsed.status) {
      printStatus(buildOperatorUiTokenStatus(path), parsed.json);
      return;
    }

    if (parsed.rotate) {
      if (!parsed.confirm) throw new OperatorUiTokenError();
      printStatus(rotateOperatorUiToken(path), parsed.json);
      return;
    }

    if (parsed.print) {
      if (!parsed.confirmPrint) throw new OperatorUiTokenError();
      process.stdout.write(`${readTokenValue(path)}\n`);
      return;
    }
  } catch {
    process.exitCode = 1;
    process.stderr.write('Operator UI token command refused unsafe input.\n');
    process.stderr.write(`${usage()}\n`);
  }
}

void main();
