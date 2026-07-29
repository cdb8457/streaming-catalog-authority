import { probeSidecarHealth } from '../core/crypto/local-sidecar-runtime.js';
import { isDirectRun } from './direct-run.js';

// Phase 281/284 — `npm run ops:sidecar-health`.
//
// -----------------------------------------------------------------------------------------------------
// WHAT THIS REPLACES, AND WHY IT MATTERS MORE THAN IT LOOKS.
// -----------------------------------------------------------------------------------------------------
//
// The shipped stack's sidecar healthcheck was `test -S /run/catalog-sidecar/catalog-sidecar.sock`, and the
// app started when that passed. A socket file is not evidence of anything a custodian does:
//
//   * IT EXISTS THE INSTANT `listen` IS CALLED, which is before the process has opened its state directory,
//     read its root wrapping key, or established that its ring is intact.
//   * IT SURVIVES THE PROCESS. A crashed daemon leaves the socket behind; `test -S` keeps passing while
//     nothing is serving.
//   * IT SAYS NOTHING ABOUT THE KEYSTORE. A daemon whose state directory has become unreadable — a bad
//     restore, a permissions change, a corrupt ring — serves the socket and fails every request.
//
// The last of those is the dangerous one. The app in front of it comes up, reports itself healthy, and
// answers every catalog read with a fail-closed unreadable item — which is INDISTINGUISHABLE from a correctly
// erased one. An operator sees a working installation with an empty catalog and no error anywhere.
//
// So the gate is a HANDSHAKE. This connects, sends `health`, and the daemon answers only after exercising its
// custodian against its real state. A non-zero exit here means the app must not start, and that is what the
// Compose healthcheck and the app's `depends_on` are wired to.

export const SIDECAR_HEALTH_EXIT_OK = 0;
export const SIDECAR_HEALTH_EXIT_NOT_READY = 1;
export const SIDECAR_HEALTH_EXIT_USAGE = 2;

function usage(): string {
  return [
    'usage: npm run ops:sidecar-health -- --socket <path> [--json]',
    '',
    'Asks the custodian sidecar whether it is READY: connected, protocol agreed, and its custodian exercised',
    'against its real state directory. This is not "does the socket file exist" — that passes for a crashed',
    'daemon and for one that cannot read its own keystore.',
    '',
    'exit codes: 0 ready | 1 not ready | 2 bad usage',
  ].join('\n');
}

export function parseSidecarHealthArgs(argv: readonly string[]): { readonly socket: string; readonly json: boolean } {
  let socket: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--json') { json = true; continue; }
    if (argument === '--socket') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--socket needs a value');
      socket = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  if (socket === undefined) throw new Error('--socket is required');
  return { socket, json };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage()); return SIDECAR_HEALTH_EXIT_OK; }
  let args: ReturnType<typeof parseSidecarHealthArgs>;
  try {
    args = parseSidecarHealthArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    console.error('');
    console.error(usage());
    return SIDECAR_HEALTH_EXIT_USAGE;
  }
  const health = await probeSidecarHealth(args.socket);
  if (health === null) {
    // ONE SENTENCE, NO PATH. This runs as a container healthcheck, whose output lands in `docker inspect` and
    // in whatever an operator pastes into an issue.
    console.error('the custodian sidecar did not answer a health handshake, so it is NOT ready');
    return SIDECAR_HEALTH_EXIT_NOT_READY;
  }
  console.log(args.json ? JSON.stringify(health) : renderHealth(health));
  return SIDECAR_HEALTH_EXIT_OK;
}

function renderHealth(health: NonNullable<Awaited<ReturnType<typeof probeSidecarHealth>>>): string {
  return [
    'The custodian sidecar is READY.',
    `  protocol           ${health.protocol}`,
    `  custody mechanism  ${health.custodian}`,
    `  active generation  ${health.ringGeneration ?? 'no ring on this installation'}`,
  ].join('\n');
}

if (isDirectRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    process.exitCode = SIDECAR_HEALTH_EXIT_NOT_READY;
  });
}
