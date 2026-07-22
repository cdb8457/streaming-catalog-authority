import { isAbsolute } from 'node:path';
import { buildOperatorConsole } from './promotion-operator-console.js';
import { buildConsoleIntake, ConsoleIntakeError } from './promotion-operator-console-intake.js';
import {
  buildDashboardStatus,
  buildDashboardViewModel,
  type DashboardViewModel,
} from './promotion-operator-dashboard.js';

// Phase 244: the promotion record chain, inside the operator UI people actually run.
//
// WHY THIS EXISTS RATHER THAN ANOTHER SERVER. Phase 243 built a local dashboard and started its own process to
// serve it. That was the wrong shape for a product: an operator who deploys this stack gets ONE web UI, the
// authenticated Phase 147 service on 8099 that Compose already runs, and a second competing server is a second
// thing to launch, secure, port-map, upgrade and forget about. So the chain moves INTO that service, behind
// the token boundary that already protects every other operational route.
//
// IT ADDS NO AUDIT SEMANTICS. The intake is Phase 242's, the audit is Phase 241's through Phase 242, the view
// -- headlines, caveats, artifact meanings, tones, proof limits -- is the Phase 243 view model, unchanged. All
// this file does is decide WHICH directory to read and turn a refusal into an honest payload.
//
// THE DIRECTORY IS NOT NEGOTIABLE AT RUNTIME. It comes from container configuration and nowhere else: there is
// no query parameter, no form, no upload, no header and no request body that can influence which path is read.
// The default is a fixed container path that Compose mounts READ-ONLY from a host folder the operator chose
// when they installed the stack. An operator who wants to audit a different folder changes the mount and
// restarts -- which is a deliberate act on the host, not something a browser can do.
//
// IT IS READ AT REQUEST TIME, not frozen at boot. That is the opposite of the standalone Phase 243 page, on
// purpose: this is a long-running service an operator leaves running for weeks, and a chain frozen at
// container start would quietly go stale the moment they dropped a new artifact into the folder. The read is
// safe to repeat because Phase 242's intake is anchored to an opened descriptor -- it validates and reads the
// same object or refuses -- and because every path through it is bounded and fails closed.

export const PROMOTION_RECORDS_DIR_ENV = 'PROMOTION_RECORDS_DIR';
export const PROMOTION_RECORDS_DEFAULT_DIR = '/var/lib/catalog/promotion-records';
export const PROMOTION_RECORDS_MAX_DIR_LENGTH = 512;

export class PromotionRecordsConfigError extends Error {
  readonly code = 'PROMOTION_RECORDS_DIR_REJECTED';

  // The rejected value is deliberately absent from the message: a bad configuration value is still operator
  // input, and this stack does not reflect operator input into a message, a log or a page.
  constructor(message = 'The promotion records directory must be an absolute, traversal-free container path.') {
    super(message);
    this.name = 'PromotionRecordsConfigError';
  }
}

// NARROW ON PURPOSE. This is the one value that decides what gets read off disk, so it is checked structurally
// rather than trusted: absolute, bounded, no traversal segment, no NUL, no whitespace padding hiding a second
// path. It is NOT resolved against the working directory and it is never combined with anything from a
// request -- the only names ever joined to it are Phase 242's fixed artifact filenames.
export function resolvePromotionRecordsDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[PROMOTION_RECORDS_DIR_ENV];
  if (raw === undefined) return PROMOTION_RECORDS_DEFAULT_DIR;
  if (typeof raw !== 'string') throw new PromotionRecordsConfigError();
  if (raw !== raw.trim() || raw === '') throw new PromotionRecordsConfigError();
  if (raw.length > PROMOTION_RECORDS_MAX_DIR_LENGTH) throw new PromotionRecordsConfigError();
  if (raw.includes('\0')) throw new PromotionRecordsConfigError();
  if (!isAbsolute(raw)) throw new PromotionRecordsConfigError();

  // One trailing separator is a harmless way to write a directory, so it is stripped rather than refused.
  const path = raw.replace(/[\\/]+$/, '');
  if (path === '' || !isAbsolute(path)) throw new PromotionRecordsConfigError();

  // Segment checks, NOT `path.normalize`. This value is a CONTAINER path -- always POSIX -- while the code
  // validating it runs on whatever the operator's machine is, and `normalize` answers in the host's
  // separators: on Windows it rewrites `/var/lib/catalog` to a backslash path, so comparing against it would
  // refuse the very default this ships with. Splitting on both separators is host-independent and says what
  // is actually meant: no traversal, no current-directory hop, no empty segment hiding a doubled slash.
  const segments = path.split(/[\\/]/);
  for (const [index, segment] of segments.entries()) {
    if (segment === '.' || segment === '..') throw new PromotionRecordsConfigError();
    if (segment === '' && index !== 0) throw new PromotionRecordsConfigError();
  }
  return path;
}

export type PromotionChainAvailability = 'READABLE' | 'ARTIFACT_DIRECTORY_UNAVAILABLE';

export interface PromotionChainSnapshot {
  readonly ok: boolean;
  readonly code: 'PROMOTION_CHAIN_SNAPSHOT' | 'PROMOTION_CHAIN_ARTIFACT_DIRECTORY_UNAVAILABLE';
  readonly report: 'phase-244-operator-ui-promotion-chain';
  readonly availability: PromotionChainAvailability;
  readonly surface: 'authenticated-operator-ui-promotion-chain';
  readonly dataMode: 'container-mounted-read-only-artifact-directory';
  readonly readAt: 'request-time';
  readonly mutationsOffered: 'none';
  readonly artifactSourceIsBrowserSupplied: false;
  readonly view: DashboardViewModel | null;
  readonly unavailableGuidance: readonly string[];
}

// The Phase 243 STATUS contract is deliberately not embedded here, even though building it would be one call.
// Two of its fields would be false on this surface -- it declares `snapshotTakenAtLaunch: true` and names
// itself the local-only dashboard -- and a payload that carries a field which is wrong is worse than one that
// omits it. What IS reused is the part that matters: the rule deciding whether a chain counts as healthy, so
// this service and the standalone page can never disagree about whether an unfinished chain is a fault.
function chainIsHealthy(report: Parameters<typeof buildDashboardStatus>[0]): boolean {
  return buildDashboardStatus(report).ok;
}

// What an operator is told when the folder is not there. Fixed text, and never the path: naming it would put
// a host filesystem layout on an authenticated web page for no benefit -- the operator knows what they mounted,
// and anyone who does not should not learn it here.
const UNAVAILABLE_GUIDANCE: readonly string[] = [
  'No promotion record artifacts are readable at the configured container directory.',
  'On a fresh install this is expected: the folder is empty until someone puts chain artifacts in it.',
  'Place the Phase 231-240 artifact files in the host folder mounted read-only into this container, then reload. The container never writes to that folder.',
  'The directory is fixed by container configuration. It cannot be chosen, typed or uploaded from this page.',
];

export function buildPromotionChainSnapshot(dir: string): PromotionChainSnapshot {
  let report;
  try {
    report = buildOperatorConsole(buildConsoleIntake({ dir }));
  } catch (err) {
    // An unreadable directory is a configuration state, not a crash, and certainly not a chain verdict.
    if (!(err instanceof ConsoleIntakeError)) throw err;
    return {
      ok: false,
      code: 'PROMOTION_CHAIN_ARTIFACT_DIRECTORY_UNAVAILABLE',
      report: 'phase-244-operator-ui-promotion-chain',
      availability: 'ARTIFACT_DIRECTORY_UNAVAILABLE',
      surface: 'authenticated-operator-ui-promotion-chain',
      dataMode: 'container-mounted-read-only-artifact-directory',
      readAt: 'request-time',
      mutationsOffered: 'none',
      artifactSourceIsBrowserSupplied: false,
      view: null,
      unavailableGuidance: UNAVAILABLE_GUIDANCE,
    };
  }

  return {
    // `ok` follows the Phase 243 health rule exactly: an honestly unfinished chain is healthy. Only a chain
    // that does not hang together, or has no anchor to hang from, is not.
    ok: chainIsHealthy(report),
    code: 'PROMOTION_CHAIN_SNAPSHOT',
    report: 'phase-244-operator-ui-promotion-chain',
    availability: 'READABLE',
    surface: 'authenticated-operator-ui-promotion-chain',
    dataMode: 'container-mounted-read-only-artifact-directory',
    readAt: 'request-time',
    mutationsOffered: 'none',
    artifactSourceIsBrowserSupplied: false,
    view: buildDashboardViewModel(report),
    unavailableGuidance: [],
  };
}
