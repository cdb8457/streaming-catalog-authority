import { resolveVar, type Env } from '../config/env.js';
import {
  JELLYFIN_URL_REJECTION_MESSAGES,
  checkJellyfinBaseUrl,
  type JellyfinUrlRejection,
  type JellyfinUrlVerdict,
} from '../core/adapters/jellyfin/url-policy.js';

// Phase 266 — the configuration the Jellyfin CONTROL PLANE runs on, and the four switches in front of it.
//
// WHAT IS DIFFERENT FROM `core/adapters/jellyfin/config.ts`. That module is the Phase 10 loader: it accepts
// `JELLYFIN_API_KEY` inline, accepts any http(s) URL, and is what the existing smoke and mapping tools use.
// This module is what the OPERATOR UI uses, and it is deliberately stricter in three ways that matter once a
// browser is involved:
//
//   1. THE API KEY MUST COME FROM A FILE. `JELLYFIN_API_KEY_FILE` and nothing else. An inline
//      `JELLYFIN_API_KEY` is REFUSED rather than accepted — it is not merely discouraged. An environment
//      variable is visible in `docker inspect`, in `/proc/<pid>/environ`, in a Compose file somebody pastes
//      into an issue, and in the process listing of anything that shells out. A file is a mount with an
//      owner and a mode. This is the same shape the operator token, the KEK and the database URL already use.
//   2. THE ADDRESS MUST PASS THE PRIVATE-NETWORK POLICY (url-policy.ts). A media server on somebody's own
//      network is what this product talks to; a URL pointing anywhere else is a request this process would
//      make on an attacker's behalf.
//   3. NETWORKING IS OFF UNLESS TURNED ON, AND WRITING IS OFF UNLESS SEPARATELY TURNED ON. Two independent
//      switches, neither implied by the other, both fail-closed, both exactly-`true`-or-nothing.
//
// NOTHING HERE OPENS A SOCKET. This module reads variables and files and returns a value object. It holds no
// client, constructs no transport, and imports nothing that can perform I/O beyond reading a secret file.
//
// EVERY DIAGNOSTIC IT PRODUCES IS REDACTED BY CONSTRUCTION. `describeJellyfinControlConfig` returns booleans,
// closed-set labels and integers. There is no code path in this file that puts the api key, the base URL, the
// host, or a file path into a returned string — the rejection messages are fixed sentences chosen from a
// closed set, and the summary carries a `hostClass` ('loopback', 'private-ipv4', …) rather than a host.

/** Turn on real networking at all. Exactly `"true"`; anything else, including absent, is OFF. */
export const JELLYFIN_ENABLE_NETWORK_ENV = 'JELLYFIN_ENABLE_NETWORK';
/** Turn on the collection WRITE path (Phase 268). Independent of the above; also exactly `"true"`. */
export const JELLYFIN_ALLOW_COLLECTION_WRITES_ENV = 'JELLYFIN_ALLOW_COLLECTION_WRITES';
export const JELLYFIN_BASE_URL_ENV = 'JELLYFIN_BASE_URL';
export const JELLYFIN_API_KEY_ENV = 'JELLYFIN_API_KEY';
export const JELLYFIN_API_KEY_FILE_ENV = 'JELLYFIN_API_KEY_FILE';
export const JELLYFIN_TIMEOUT_MS_ENV = 'JELLYFIN_TIMEOUT_MS';

/** Per-request timeout bounds. A request this service makes must always be able to end. */
export const JELLYFIN_TIMEOUT_MIN_MS = 250;
export const JELLYFIN_TIMEOUT_MAX_MS = 30_000;
export const JELLYFIN_TIMEOUT_DEFAULT_MS = 5_000;

/** An api key is an opaque token. Bounded, printable, and never logged whatever it is. */
export const JELLYFIN_API_KEY_MAX_LENGTH = 512;

export type JellyfinConfigProblem =
  | 'NETWORK_DISABLED'
  | 'UNCONFIGURED'
  | 'API_KEY_MUST_BE_A_FILE'
  | 'API_KEY_UNREADABLE'
  | 'API_KEY_SHAPE'
  | 'TIMEOUT'
  | `URL_${JellyfinUrlRejection}`;

export interface JellyfinControlConfig {
  readonly baseUrl: string;
  readonly origin: string;
  readonly hostClass: NonNullable<JellyfinUrlVerdict['hostClass']>;
  /** SECRET. Read from a file, held in memory, sent only as the `X-Emby-Token` request header. */
  readonly apiKey: string;
  readonly timeoutMs: number;
  /** Whether the separate collection-write switch is on. Never implied by anything else. */
  readonly writesEnabled: boolean;
}

export type JellyfinControlConfigResult =
  | { readonly ok: true; readonly config: JellyfinControlConfig }
  | { readonly ok: false; readonly problem: JellyfinConfigProblem; readonly message: string };

const PROBLEM_MESSAGES: Record<Exclude<JellyfinConfigProblem, `URL_${JellyfinUrlRejection}`>, string> = {
  NETWORK_DISABLED:
    'Jellyfin networking is switched off, which is the default. Nothing on this page has contacted a media '
    + `server. Set ${JELLYFIN_ENABLE_NETWORK_ENV}=true and restart to turn on read-only discovery.`,
  UNCONFIGURED:
    'No Jellyfin server is configured. Set ' + JELLYFIN_BASE_URL_ENV + ' and point '
    + JELLYFIN_API_KEY_FILE_ENV + ' at a file holding the API key, then restart.',
  API_KEY_MUST_BE_A_FILE:
    'The Jellyfin API key must come from a file. Point ' + JELLYFIN_API_KEY_FILE_ENV + ' at it and remove '
    + JELLYFIN_API_KEY_ENV + ': an environment variable is visible in `docker inspect`, in the process '
    + 'environment and in any Compose file that gets shared, and a key is not that kind of value.',
  API_KEY_UNREADABLE:
    'The file named by ' + JELLYFIN_API_KEY_FILE_ENV + ' could not be read, or is empty.',
  API_KEY_SHAPE:
    'The Jellyfin API key file does not hold a usable key: it must be one line of printable characters and '
    + 'no longer than ' + JELLYFIN_API_KEY_MAX_LENGTH + ' characters.',
  TIMEOUT:
    JELLYFIN_TIMEOUT_MS_ENV + ' must be a whole number of milliseconds between ' + JELLYFIN_TIMEOUT_MIN_MS
    + ' and ' + JELLYFIN_TIMEOUT_MAX_MS + '.',
};

/** True ONLY for the exact string `"true"`. Fail-closed in every other case, including `"TRUE"` and `"1"`. */
export function isJellyfinControlNetworkEnabled(env: Env = process.env): boolean {
  return env[JELLYFIN_ENABLE_NETWORK_ENV] === 'true';
}

/**
 * True ONLY for the exact string `"true"`.
 *
 * DELIBERATELY NOT IMPLIED BY THE NETWORK SWITCH. Read-only discovery and writing collections are different
 * decisions with different consequences, and an operator who turned on the first must make the second
 * separately. Phase 268 requires this AND the network switch AND `PUBLISH_EXTERNAL_IDENTITY=allow` AND a
 * digest-bound confirmation before anything is queued.
 */
export function isJellyfinCollectionWriteEnabled(env: Env = process.env): boolean {
  return env[JELLYFIN_ALLOW_COLLECTION_WRITES_ENV] === 'true';
}

/**
 * Load the control-plane configuration, or say exactly which rule was not met.
 *
 * TOTAL AND THROW-FREE. Every outcome is a result value, because the caller is an HTTP route that has to
 * render a state rather than a stack trace. The ORDER is the order an operator fixes things in: the switch,
 * then whether anything is configured at all, then the address, then the key, then the bounds.
 */
export function loadJellyfinControlConfig(env: Env = process.env): JellyfinControlConfigResult {
  if (!isJellyfinControlNetworkEnabled(env)) return problem('NETWORK_DISABLED');

  const rawBaseUrl = env[JELLYFIN_BASE_URL_ENV];
  const hasKeyFile = env[JELLYFIN_API_KEY_FILE_ENV] !== undefined && env[JELLYFIN_API_KEY_FILE_ENV] !== '';
  const hasInlineKey = env[JELLYFIN_API_KEY_ENV] !== undefined && env[JELLYFIN_API_KEY_ENV] !== '';
  if ((rawBaseUrl === undefined || rawBaseUrl === '') && !hasKeyFile && !hasInlineKey) {
    return problem('UNCONFIGURED');
  }
  // Checked BEFORE the URL so the loudest misconfiguration is the one reported first, and checked even when
  // a key file is also present: setting both is how a key ends up in an environment nobody meant it to be in.
  if (hasInlineKey) return problem('API_KEY_MUST_BE_A_FILE');
  if (!hasKeyFile) return problem('UNCONFIGURED');

  const url = checkJellyfinBaseUrl(rawBaseUrl);
  if (!url.ok) {
    const rejection = url.rejection!;
    return {
      ok: false,
      problem: `URL_${rejection}` as JellyfinConfigProblem,
      message: JELLYFIN_URL_REJECTION_MESSAGES[rejection],
    };
  }

  // `resolveVar` performs the *_FILE read, strips one trailing newline, and reports by variable NAME only.
  // Its problem string is discarded here in favour of this module's own closed set: it is redaction-safe
  // either way, and a fixed sentence keeps the response's shape independent of another module's wording.
  const resolved = resolveVar(env, JELLYFIN_API_KEY_ENV);
  if (resolved.problem !== undefined || resolved.value === undefined) return problem('API_KEY_UNREADABLE');
  const apiKey = resolved.value;
  if (!isUsableApiKey(apiKey)) return problem('API_KEY_SHAPE');

  const rawTimeout = env[JELLYFIN_TIMEOUT_MS_ENV];
  let timeoutMs = JELLYFIN_TIMEOUT_DEFAULT_MS;
  if (rawTimeout !== undefined && rawTimeout !== '') {
    if (!/^\d{1,7}$/.test(rawTimeout)) return problem('TIMEOUT');
    timeoutMs = Number(rawTimeout);
    if (timeoutMs < JELLYFIN_TIMEOUT_MIN_MS || timeoutMs > JELLYFIN_TIMEOUT_MAX_MS) return problem('TIMEOUT');
  }

  return {
    ok: true,
    config: {
      baseUrl: url.baseUrl!,
      origin: url.origin!,
      hostClass: url.hostClass!,
      apiKey,
      timeoutMs,
      writesEnabled: isJellyfinCollectionWriteEnabled(env),
    },
  };
}

/**
 * Is this a key we are willing to put in a header?
 *
 * A header value containing CR or LF is header injection, and a key is an opaque token with no legitimate
 * reason to contain either — or any other control character, or leading and trailing space that an operator
 * cannot see and a server will not match.
 */
export function isUsableApiKey(value: string): boolean {
  if (value.length === 0 || value.length > JELLYFIN_API_KEY_MAX_LENGTH) return false;
  if (value.trim().length !== value.length) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

export interface JellyfinControlConfigSummary {
  readonly networkEnabled: boolean;
  readonly writesEnabled: boolean;
  readonly configured: boolean;
  /** How the address was judged private. A CLASS, never the host. */
  readonly hostClass: JellyfinControlConfig['hostClass'] | null;
  readonly apiKeySource: 'file' | 'none';
  readonly timeoutMs: number | null;
  readonly problem: JellyfinConfigProblem | null;
  readonly message: string;
}

/**
 * The redaction-safe summary a diagnostics panel renders.
 *
 * WHAT IS DELIBERATELY ABSENT: the base URL, the host, the port, the api key, the key file path, and the
 * value of any variable. Everything present is a boolean, a small integer, or a label from a closed set
 * declared in this file. That is what makes this response safe to show in a browser, quote in a support
 * report and paste into an issue.
 */
export function describeJellyfinControlConfig(env: Env = process.env): JellyfinControlConfigSummary {
  const result = loadJellyfinControlConfig(env);
  const networkEnabled = isJellyfinControlNetworkEnabled(env);
  const writesEnabled = isJellyfinCollectionWriteEnabled(env);
  if (result.ok) {
    return {
      networkEnabled,
      writesEnabled,
      configured: true,
      hostClass: result.config.hostClass,
      apiKeySource: 'file',
      timeoutMs: result.config.timeoutMs,
      problem: null,
      message: writesEnabled
        ? 'Configured, with collection writes switched ON. Discovery reads; nothing is written until a plan '
          + 'is confirmed by its exact digest.'
        : 'Configured for READ-ONLY discovery. Collection writes are switched off, so nothing on this page '
          + 'can change a Jellyfin library.',
    };
  }
  return {
    networkEnabled,
    writesEnabled,
    configured: false,
    hostClass: null,
    apiKeySource: env[JELLYFIN_API_KEY_FILE_ENV] !== undefined && env[JELLYFIN_API_KEY_FILE_ENV] !== '' ? 'file' : 'none',
    timeoutMs: null,
    problem: result.problem,
    message: result.message,
  };
}

function problem(kind: Exclude<JellyfinConfigProblem, `URL_${JellyfinUrlRejection}`>): JellyfinControlConfigResult {
  return { ok: false, problem: kind, message: PROBLEM_MESSAGES[kind] };
}
