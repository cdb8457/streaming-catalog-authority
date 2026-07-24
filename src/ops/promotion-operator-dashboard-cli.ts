import { buildOperatorConsole } from './promotion-operator-console.js';
import { buildConsoleIntake, ConsoleIntakeError } from './promotion-operator-console-intake.js';
import {
  DASHBOARD_HOST,
  DashboardConfigError,
  DashboardRenderError,
  startDashboard,
  type StartedDashboard,
} from './promotion-operator-dashboard-server.js';

// Phase 243 operator dashboard launcher. One command: read the artifacts once, audit them through the Phase
// 242 console, render the answer, and serve it on loopback until you stop it.
//
// It CREATES nothing, DECIDES nothing and CHANGES nothing. No promotion run, no approval, no execution, no
// observation, no custody, no archival, no deletion, no upload, no mutation, no Phase 231 authorization, no
// Movies library access, no Jellyfin call, no database read, no outbound network, no merge, tag or push.
//
// The artifacts are read ONCE, before the socket opens. After that this process never touches the filesystem
// for a request, so nothing a browser sends can name a path or race a file. Restart it to re-read.
//
// Exit 0 = served and shut down cleanly, 2 = usage or startup failure (nothing was ever listening).

const DIRECT_INVOCATION = 'npx tsx src/ops/promotion-operator-dashboard-cli.ts';

function usage(): string {
  return [
    `usage: ${DIRECT_INVOCATION} (--dir <artifact-directory> | --bundle <bundle.json>) [--port <1024-65535>]`,
    '',
    'Serves a local, read-only page showing what the promotion record chain (Phases 231-241) proves: the',
    'outcome, how far the chain reaches, what is outstanding, every artifact state, every blocker with what it',
    'means and what to do, the exact safe next human steps, and the proof limits -- all on one page, so the',
    'caveats cannot be separated from the verdict.',
    '',
    'Invoke it directly, as above -- that form works on every shell. Passing flags through',
    '`npm run <script> -- <flags>` is not portable: PowerShell eats the first `--`, so npm takes the flags as',
    'its own and this tool receives none. For the help text alone, `npm run ops:promotion-operator-dashboard:help`',
    'is safe on any shell.',
    '',
    '--dir     an artifact directory, discovered by allowlisted filename exactly as the Phase 242 console does.',
    '--bundle  an explicit JSON bundle keyed by phase number ("231".."240").',
    '--port    an explicit loopback port. Omitted, the operating system picks a free one and the URL is',
    '          printed -- so the dashboard never squats a port and never collides with anything.',
    '',
    'It binds to 127.0.0.1 and nowhere else: there is no flag or environment variable that changes the host,',
    'so the page is unreachable from another machine. There is no form, no input, no upload and no route that',
    'takes a parameter; every request is a GET of a fixed path, and query-bearing targets are refused.',
    '',
    'The artifacts are read ONCE, before the server starts listening. The page does not change while it runs,',
    'so what was audited is what you read. Restart to re-read. Stop it with Ctrl+C.',
    '',
    'It adds no audit semantics: every verdict shown is the Phase 242 console\'s, unchanged. AUDIT_OPEN with no',
    'blockers is normal and is presented as normal. AUDIT_CLOSED means the records are mutually consistent; it',
    'does NOT mean the promotion happened, was correct, or was authorized by anyone in particular.',
    '',
    'Exit 0 = served and shut down cleanly, 2 = usage or startup failure.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) { console.log(usage()); return args.length === 0 ? 2 : 0; }

  const dir = valueAfter(args, '--dir');
  const bundlePath = valueAfter(args, '--bundle');
  const portRaw = valueAfter(args, '--port');
  if (dir !== undefined && bundlePath !== undefined) {
    console.error('supply exactly one intake: --dir or --bundle, not both');
    return 2;
  }
  if (dir === undefined && bundlePath === undefined) {
    console.error([
      'supply an intake: --dir <artifact-directory> or --bundle <bundle.json>.',
      `invoke it directly -- ${DIRECT_INVOCATION} --dir <artifact-directory>`,
      'passing flags via `npm run ... -- <flags>` is not portable: PowerShell eats the first `--`, so npm takes',
      'the flags as its own and this tool receives none. `--help` alone: npm run ops:promotion-operator-dashboard:help',
    ].join('\n'));
    return 2;
  }
  let port: number | undefined;
  if (portRaw !== undefined) {
    port = Number(portRaw);
    if (!Number.isInteger(port)) { console.error('--port takes an integer between 1024 and 65535'); return 2; }
  }

  // Read and audit BEFORE binding anything. A chain that cannot be read never reaches a socket.
  let started: StartedDashboard;
  try {
    const report = buildOperatorConsole(buildConsoleIntake(dir !== undefined ? { dir } : { bundle: bundlePath! }));
    started = await startDashboard(report, port === undefined ? {} : { port });
  } catch (err) {
    // The offending path is never echoed: it is operator input, and nothing in this chain reflects it back.
    if (err instanceof ConsoleIntakeError) console.error(err.message);
    else if (err instanceof DashboardConfigError) console.error('the dashboard binds to 127.0.0.1 on a port between 1024 and 65535, or an operating-system-chosen one');
    else if (err instanceof DashboardRenderError) console.error('the page failed its own markup self-check and was not served');
    else console.error('the dashboard could not start; nothing is listening');
    return 2;
  }

  console.log([
    `promotion record chain dashboard: ${started.url}`,
    `bound to ${DASHBOARD_HOST} only -- unreachable from another machine`,
    'read-only snapshot taken at launch; restart to re-read the artifacts',
    'stop with Ctrl+C',
  ].join('\n'));

  // Clean shutdown on either signal, once. Closing is idempotent and never rejects, so Ctrl+C always ends in
  // a closed socket and exit 0 rather than a stack trace.
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void started.close().then(() => { console.log('dashboard stopped'); resolve(); });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    started.server.once('close', () => { if (!stopping) resolve(); });
  });
  return 0;
}

main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 2; });
