import {
  JellyfinDiscoveryClient,
  JellyfinDiscoveryError,
  type JellyfinDiscoveryReport,
} from '../core/adapters/jellyfin/discovery.js';
import { guardedJellyfinFetch } from '../core/adapters/jellyfin/guarded-fetch.js';
import type { FetchLike } from '../core/adapters/jellyfin/transport.js';
import {
  describeJellyfinControlConfig,
  isJellyfinControlNetworkEnabled,
  loadJellyfinControlConfig,
} from './jellyfin-control-config.js';

// Phase 266 — the two READ routes of the Jellyfin control plane.
//
// `/api/jellyfin/status`     what is configured, and what is switched on. Contacts nothing, ever.
// `/api/jellyfin/discovery`  one bounded read-only conversation with the configured server.
//
// BOTH ARE GETs AND BOTH REQUIRE THE OPERATOR TOKEN, like every other operational route in this service.
// Neither can write anything anywhere: there is no authority, no outbox, no history store and no write client
// in the scope of either function. Discovery's client issues GET and only GET.
//
// DISABLED IS AN ANSWER, NOT AN ERROR. With `JELLYFIN_ENABLE_NETWORK` unset — the default, and what a fresh
// install has — `/api/jellyfin/discovery` answers 200 with `state: "DISABLED"` and makes no call at all. That
// is deliberately a success: a stack that has not been pointed at a media server is not broken, and answering
// 503 would make a correct installation look faulty. The proof that nothing was contacted is structural: the
// transport is not even constructed on that path.
//
// EVERY RESPONSE IS REDACTION-SAFE BY CONSTRUCTION, AND THAT IS THE HARD PART OF THIS SURFACE. The address,
// the api key, the key file's path, the host, the port, the server's NAME and every Jellyfin id are absent
// from every shape below. What is present: booleans, small integers, a host CLASS from a closed set, a
// product version matched against a strict pattern, non-reversible digests, and the names of collections THIS
// product created — which are names an operator typed into this UI's own form. A collection this product did
// not create is COUNTED and never named: it is somebody's private library organisation on a server this
// product does not own.

export const JELLYFIN_STATUS_ROUTE = '/api/jellyfin/status';
export const JELLYFIN_DISCOVERY_ROUTE = '/api/jellyfin/discovery';

export const JELLYFIN_ROUTES: readonly string[] = [JELLYFIN_STATUS_ROUTE, JELLYFIN_DISCOVERY_ROUTE];

export const JELLYFIN_ENDPOINT_REPORT = 'phase-266-jellyfin-control-plane';

export interface JellyfinEndpointResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export type JellyfinDiscoveryState = 'DISABLED' | 'NOT_CONFIGURED' | 'CONNECTED' | 'UNREACHABLE';

/**
 * GET the configuration state. No network, no database, no filesystem beyond the api key file that
 * `resolveVar` already reads at load time.
 *
 * IT ANSWERS 200 IN EVERY STATE, INCLUDING THE BROKEN ONES. "Your address is not on a private network" is a
 * correct answer to a correct question, and a 503 would make a browser treat a misconfiguration as a dead
 * server — sending an operator to look at the wrong thing.
 */
export function jellyfinStatusResponse(env: NodeJS.ProcessEnv = process.env): JellyfinEndpointResponse {
  const summary = describeJellyfinControlConfig(env);
  return {
    status: 200,
    body: {
      ok: true,
      code: 'OPERATOR_UI_JELLYFIN_STATUS',
      report: JELLYFIN_ENDPOINT_REPORT,
      // Said explicitly as well as guaranteed structurally, because this is the sentence an operator acts on.
      contacted: 'nothing',
      connection: summary,
    },
  };
}

export interface JellyfinDiscoveryDeps {
  /**
   * INJECTED, and OPTIONAL ON PURPOSE. When it is absent this endpoint cannot make a request at all, whatever
   * the configuration says — which is what lets a test assert "no call was made" rather than "no call was
   * observed". The service supplies one only through {@link resolveJellyfinTransport}, which itself refuses
   * unless the gate is on.
   */
  readonly fetch?: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: swap the client the endpoint drives. Never set in the running service. */
  readonly discover?: () => Promise<JellyfinDiscoveryReport>;
}

/**
 * GET the read-only discovery surface.
 *
 * FOUR OUTCOMES, ALL OF THEM 200 EXCEPT AN UNREACHABLE SERVER:
 *   DISABLED        the switch is off. Nothing was constructed and nothing was sent.
 *   NOT_CONFIGURED  the switch is on but the configuration does not pass. Nothing was sent.
 *   CONNECTED       one bounded conversation happened and here is what it found.
 *   UNREACHABLE     the conversation failed. 503, with a REASON from a closed set and nothing else — never
 *                   the transport's own message, which carries the host on a DNS failure and the
 *                   certificate's subject on a TLS one.
 */
export async function jellyfinDiscoveryResponse(deps: JellyfinDiscoveryDeps = {}): Promise<JellyfinEndpointResponse> {
  const env = deps.env ?? process.env;

  if (!isJellyfinControlNetworkEnabled(env)) {
    return {
      status: 200,
      body: {
        ok: true,
        code: 'OPERATOR_UI_JELLYFIN_DISCOVERY',
        report: JELLYFIN_ENDPOINT_REPORT,
        state: 'DISABLED' satisfies JellyfinDiscoveryState,
        contacted: 'nothing',
        connection: describeJellyfinControlConfig(env),
        discovery: null,
        guidance: 'Jellyfin networking is switched off, which is the default. Nothing on this page has '
          + 'contacted a media server. Turn it on with JELLYFIN_ENABLE_NETWORK=true once you have configured '
          + 'an address and an API key file, then restart.',
      },
    };
  }

  const loaded = loadJellyfinControlConfig(env);
  if (!loaded.ok) {
    return {
      status: 200,
      body: {
        ok: true,
        code: 'OPERATOR_UI_JELLYFIN_DISCOVERY',
        report: JELLYFIN_ENDPOINT_REPORT,
        state: 'NOT_CONFIGURED' satisfies JellyfinDiscoveryState,
        contacted: 'nothing',
        connection: describeJellyfinControlConfig(env),
        discovery: null,
        guidance: loaded.message,
      },
    };
  }

  // The transport is constructed HERE and nowhere earlier, so every refusal above is provably a refusal that
  // built no client. A missing transport is treated as a disabled one rather than as a crash.
  const discover = deps.discover ?? (deps.fetch === undefined
    ? null
    : () => new JellyfinDiscoveryClient({
      baseUrl: loaded.config.baseUrl,
      origin: loaded.config.origin,
      apiKey: loaded.config.apiKey,
      fetch: guardedJellyfinFetch(loaded.config.origin, deps.fetch!),
      timeoutMs: loaded.config.timeoutMs,
    }).discover());

  if (discover === null) {
    return {
      status: 200,
      body: {
        ok: true,
        code: 'OPERATOR_UI_JELLYFIN_DISCOVERY',
        report: JELLYFIN_ENDPOINT_REPORT,
        state: 'DISABLED' satisfies JellyfinDiscoveryState,
        contacted: 'nothing',
        connection: describeJellyfinControlConfig(env),
        discovery: null,
        guidance: 'This build has no network transport available to it, so no media server can be contacted '
          + 'from here whatever the configuration says.',
      },
    };
  }

  let report: JellyfinDiscoveryReport;
  try {
    report = await discover();
  } catch (err) {
    const reason = err instanceof JellyfinDiscoveryError ? err.reason : 'unreachable';
    const operation = err instanceof JellyfinDiscoveryError ? err.operation : 'discover';
    return {
      status: 503,
      body: {
        ok: false,
        code: 'OPERATOR_UI_JELLYFIN_UNREACHABLE',
        report: JELLYFIN_ENDPOINT_REPORT,
        state: 'UNREACHABLE' satisfies JellyfinDiscoveryState,
        contacted: 'attempted',
        connection: describeJellyfinControlConfig(env),
        discovery: null,
        // A CLASS and the OPERATION, never a message. Both are values this repository produced.
        reason,
        operation,
        guidance: discoveryGuidance(reason),
      },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      code: 'OPERATOR_UI_JELLYFIN_DISCOVERY',
      report: JELLYFIN_ENDPOINT_REPORT,
      state: 'CONNECTED' satisfies JellyfinDiscoveryState,
      contacted: 'read-only',
      connection: describeJellyfinControlConfig(env),
      discovery: report,
      guidance: `Connected. This server reports ${report.libraries} librar${report.libraries === 1 ? 'y' : 'ies'} `
        + `and ${report.collections} collection(s), of which ${report.managed.length} carry this product's own `
        + 'marker. No media item was listed and nothing was changed.'
        + (report.truncated ? ' The listing hit its bound, so these counts are a floor rather than a total.' : ''),
    },
  };
}

function discoveryGuidance(reason: string): string {
  switch (reason) {
    case 'unauthorized':
      return 'The server refused the API key. Check that the key file holds a key this server issued, and that '
        + 'it has not been revoked. Nothing was read and nothing was changed.';
    case 'timed-out':
      return 'The server did not answer inside the configured timeout. It may be starting, busy, or not at the '
        + 'configured address. Nothing was read and nothing was changed.';
    case 'redirected':
      return 'The server answered with a redirect. This product refuses to follow one, because a redirect can '
        + 'move a request to an address the private-network policy never approved. Point the configuration at '
        + 'the address the server actually serves on.';
    case 'too-large':
      return 'The server sent more than this product will read in one response. Nothing was read.';
    case 'unreadable':
      return 'The server answered with something that is not the JSON this product expects. Check that the '
        + 'address points at Jellyfin itself and not at a proxy, a login page or another service.';
    default:
      return 'The server could not be reached. Check that it is running and that the address is right for this '
        + 'network. Nothing was read and nothing was changed.';
  }
}

/**
 * The ONE place in this service a real transport can come from.
 *
 * IT RETURNS `undefined` UNLESS THE GATE IS ON. That is what makes "networking is off by default" a property
 * of the code rather than of a branch somebody has to remember to write: with the switch unset, no transport
 * exists to be handed to anything, so no route can make a request even if a future edit forgets to check.
 *
 * IT ALSO RETURNS `undefined` WHEN THE RUNTIME HAS NO `fetch`. Reading `globalThis.fetch` rather than calling
 * a bare `fetch` is deliberate: it keeps this the only expression in `src/` that can produce a real
 * transport, so a search for one finds this function and nothing else.
 */
export function resolveJellyfinTransport(env: NodeJS.ProcessEnv = process.env): FetchLike | undefined {
  if (!isJellyfinControlNetworkEnabled(env)) return undefined;
  const platform = (globalThis as { fetch?: unknown }).fetch;
  if (typeof platform !== 'function') return undefined;
  return platform as unknown as FetchLike;
}
