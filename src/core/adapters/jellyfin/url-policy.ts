// Phase 266 — what a Jellyfin base URL is allowed to be, decided once, offline, before anything is sent.
//
// WHY A POLICY AND NOT A PARSE. `new URL(x)` accepts `http://user:pass@169.254.169.254/latest/meta-data`,
// `http://evil.example.com`, and `http://[::ffff:169.254.169.254]/`. A configuration value that reaches a
// transport becomes a request this process makes on somebody else's behalf, and the set of hosts an
// operator's own media server can live on is small and local. Everything outside that set is refused by NAME
// of the rule it broke, so a misconfiguration is a sentence rather than a mysterious timeout.
//
// THE RULES, AND WHAT EACH ONE IS FOR.
//   scheme        http or https only. `file:`, `gopher:`, `data:` are not media servers.
//   userinfo      REFUSED outright. A URL carrying credentials is a secret in a variable that is printed,
//                 logged, and shown in diagnostics; the api key belongs in a secret FILE and a header.
//   query/hash    REFUSED. A base URL is an origin plus an optional path prefix; a query string on it would
//                 be silently dropped or silently merged by every request builder, and neither is honest.
//   path          bounded, no `..`, no `//`, no control characters, and normalised to have no trailing `/`.
//   host          must be PRIVATE. A literal IP must be loopback / RFC1918 / link-local / CGNAT / ULA; a
//                 name must be a single label (a Compose service, a NetBIOS name) or end in one of the
//                 local-network suffixes below. A public FQDN is refused.
//   port          optional, 1..65535.
//
// WHY NAMES ARE JUDGED BY SUFFIX AND NOT BY RESOLUTION. Resolving at configuration time proves nothing: DNS
// can answer differently at request time (a rebind), and a check that has to be re-run per request is a check
// that will one day not be. A closed set of names is decidable, deterministic, offline, identical on every
// platform, and cannot be moved by an attacker who controls a DNS zone. It is deliberately conservative: an
// operator whose media server is at a public name is refused, and told to use its address on their own
// network — which is the configuration this product is for.
//
// IT PRODUCES NO STRING THAT ECHOES INPUT. Every rejection is a CODE from the closed set below. The base URL
// may embed a host name an operator considers private; a rejection message is not the place to publish it.

/** How long a base URL may be in total, before anything else is looked at. */
export const JELLYFIN_URL_MAX_LENGTH = 512;
/** How long the optional path prefix may be. */
export const JELLYFIN_URL_MAX_PATH_LENGTH = 128;

export type JellyfinUrlRejection =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'NOT_A_URL'
  | 'SCHEME'
  | 'CREDENTIALS_IN_URL'
  | 'QUERY_OR_FRAGMENT'
  | 'PATH'
  | 'PORT'
  | 'HOST_MISSING'
  | 'HOST_NOT_PRIVATE';

export interface JellyfinUrlVerdict {
  readonly ok: boolean;
  /** Present only when ok. Scheme + host + port + normalised path prefix, with no trailing slash. */
  readonly baseUrl?: string;
  /** Present only when ok. `scheme://host[:port]` — what every request is re-checked against. */
  readonly origin?: string;
  /** Present only when ok. How the host was judged private, for a diagnostics line that names no host. */
  readonly hostClass?: 'loopback' | 'private-ipv4' | 'link-local' | 'cgnat' | 'unique-local-ipv6' | 'local-name';
  readonly rejection?: JellyfinUrlRejection;
}

/**
 * The cloud instance-metadata endpoints, refused by name.
 *
 * Each one sits inside a range this policy otherwise admits, so an allowlist alone would let them through.
 * They are listed as the exact literals a URL can carry — the IPv4-mapped IPv6 spellings are caught by the
 * unwrapping in {@link classifyHost} before they are compared, and every non-literal spelling (decimal,
 * octal, hex) is already refused as "not a dotted quad".
 */
export const JELLYFIN_METADATA_HOSTS: readonly string[] = [
  '169.254.169.254',      // AWS / GCP / Azure / OpenStack / DigitalOcean instance metadata
  '169.254.170.2',        // AWS ECS task metadata and credentials
  '169.254.169.253',      // AWS VPC DNS
  '169.254.169.123',      // AWS time sync
  'fd00:ec2::254',        // AWS IMDSv2 over IPv6
  'metadata.google.internal',
];
const METADATA_HOSTS = new Set(JELLYFIN_METADATA_HOSTS);

/** Names that only exist on somebody's own network. A single label (no dot) counts as one of these too. */
export const JELLYFIN_LOCAL_NAME_SUFFIXES: readonly string[] = ['.local', '.lan', '.internal', '.home.arpa', '.home', '.localdomain'];

// Written as ESCAPES, never as literal bytes: a literal control character in a source file survives no
// diff, no patch and no editor reliably, and this expression decides whether a value reaches a socket.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
/** A single DNS label, or a dotted name of them. Deliberately no underscore, no trailing dot. */
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Judge a base URL. Pure, offline, and total: every input produces a verdict, and no input produces a throw.
 */
export function checkJellyfinBaseUrl(raw: unknown): JellyfinUrlVerdict {
  if (typeof raw !== 'string' || raw.trim() === '') return reject('EMPTY');
  const value = raw.trim();
  if (value.length > JELLYFIN_URL_MAX_LENGTH) return reject('TOO_LONG');
  if (CONTROL_CHARS.test(value)) return reject('NOT_A_URL');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject('NOT_A_URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject('SCHEME');
  // Checked on the PARSED url rather than by looking for an `@` in the string: `http://a@b/` and
  // `http://a:b@c/` differ, and the parser is the thing that decides which part is the host.
  if (url.username !== '' || url.password !== '') return reject('CREDENTIALS_IN_URL');
  if (url.search !== '' || url.hash !== '') return reject('QUERY_OR_FRAGMENT');
  if (url.hostname === '') return reject('HOST_MISSING');

  if (url.port !== '') {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return reject('PORT');
  }

  const path = normalizePath(url.pathname);
  if (path === null) return reject('PATH');

  const hostClass = classifyHost(url.hostname);
  if (hostClass === null) return reject('HOST_NOT_PRIVATE');

  const origin = `${url.protocol}//${url.host}`;
  return { ok: true, baseUrl: `${origin}${path}`, origin, hostClass };
}

/**
 * A path prefix, or null when it is not usable.
 *
 * `/` becomes the empty string so the base URL never ends in a slash — every request builder in this codebase
 * concatenates a path that starts with one, and `//System/Info` is a different request from `/System/Info`.
 */
function normalizePath(pathname: string): string | null {
  const decoded = safeDecode(pathname);
  if (decoded === null) return null;
  if (decoded === '' || decoded === '/') return '';
  if (decoded.length > JELLYFIN_URL_MAX_PATH_LENGTH) return null;
  if (!decoded.startsWith('/')) return null;
  if (decoded.includes('..') || decoded.includes('//') || decoded.includes('\\')) return null;
  if (CONTROL_CHARS.test(decoded)) return null;
  // The trailing slash is dropped BEFORE the grammar is applied, not after. An operator who pastes
  // `http://host:8096/jellyfin/` out of a browser address bar has typed a legitimate address, and refusing it
  // over a slash would be a rejection about nothing. A bare `/` was already handled above.
  const trimmed = decoded.replace(/\/+$/, '');
  if (trimmed === '') return null;
  if (!/^(?:\/[A-Za-z0-9._~-]+)+$/.test(trimmed)) return null;
  return trimmed;
}

/** Percent-decoding that refuses rather than throwing, so `%2e%2e` cannot pass as a literal. */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Which private class this host belongs to, or null if it is not private.
 *
 * IPv6 is handled before the name check because `URL` hands back a bracketed literal, and a bracketed value
 * is never a name. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is unwrapped and judged as the IPv4 address it is —
 * otherwise `http://[::ffff:169.254.169.254]/` would be judged as "an IPv6 address we do not recognise".
 */
export function classifyHost(hostname: string): JellyfinUrlVerdict['hostClass'] | null {
  const host = hostname.toLowerCase();

  // THE ONE DENYLIST, AND IT IS SMALL AND EXACT. Everything else here is an allowlist, because an allowlist
  // is the shape that fails closed. These addresses are the exception: they are inside the link-local and ULA
  // ranges an operator's own LAN legitimately uses, and they are the cloud instance-metadata endpoints whose
  // whole reason for appearing in a configuration value is that somebody is trying to make this process read
  // credentials on their behalf. Nobody runs a media server on one. Refusing them costs an operator nothing
  // and closes the single most-used SSRF target by name.
  if (METADATA_HOSTS.has(host) || METADATA_HOSTS.has(host.replace(/^\[|\]$/g, ''))) return null;

  if (host.startsWith('[') && host.endsWith(']')) return classifyIpv6(host.slice(1, -1));
  // `URL.hostname` strips the brackets for us in every runtime we support; handle both shapes anyway.
  if (host.includes(':')) return classifyIpv6(host);

  const ipv4 = parseIpv4(host);
  if (ipv4 !== null) return classifyIpv4(ipv4);

  // Anything that LOOKS like a dotted-quad but did not parse (`10.0.0.256`, `1.2.3`, `0x7f.0.0.1`) is not a
  // name either. Falling through to the name rules would let `010.0.0.1` be read as a local name.
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) return null;

  if (!NAME_RE.test(host) || host.length > 253) return null;
  if (!host.includes('.')) return 'local-name'; // a single label: a Compose service, a LAN name
  for (const suffix of JELLYFIN_LOCAL_NAME_SUFFIXES) {
    if (host.endsWith(suffix)) return 'local-name';
  }
  return null;
}

/** Strict dotted-quad only. No octal, no hex, no shorthand — those are how a filter gets walked past. */
function parseIpv4(host: string): readonly number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function classifyIpv4(octets: readonly number[]): JellyfinUrlVerdict['hostClass'] | null {
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return 'loopback';
  if (a === 10) return 'private-ipv4';
  if (a === 172 && b >= 16 && b <= 31) return 'private-ipv4';
  if (a === 192 && b === 168) return 'private-ipv4';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  return null;
}

function classifyIpv6(raw: string): JellyfinUrlVerdict['hostClass'] | null {
  const address = raw.split('%')[0]!.toLowerCase(); // drop a zone id; it names an interface, not a host
  if (address === '::1') return 'loopback';
  // IPv4-mapped and IPv4-compatible forms carry an IPv4 address; judge THAT address, not the wrapper.
  // `URL` re-serialises `::ffff:169.254.169.254` as `::ffff:a9fe:a9fe`, so the HEX form is the one that
  // actually arrives here. It is converted back to the address it denotes and judged as that; without this
  // the hex form would be refused only as "an IPv6 shape we do not recognise", which is the right answer for
  // the wrong reason — and would also refuse `::ffff:c0a8:0101`, a legitimate way to write 192.168.1.1.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hexMapped !== null) {
    const high = parseInt(hexMapped[1]!, 16);
    const low = parseInt(hexMapped[2]!, 16);
    const dotted = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
    if (METADATA_HOSTS.has(dotted)) return null;
    const octets = parseIpv4(dotted);
    return octets === null ? null : classifyIpv4(octets);
  }
  const mapped = /^(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/.exec(address);
  if (mapped !== null) {
    // The denylist is re-applied to the UNWRAPPED address. Checking only the outer spelling would let
    // `::ffff:169.254.169.254` reach a metadata endpoint the plain form is refused for.
    if (METADATA_HOSTS.has(mapped[1]!)) return null;
    const octets = parseIpv4(mapped[1]!);
    return octets === null ? null : classifyIpv4(octets);
  }
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return 'unique-local-ipv6';
  if (/^fe[89ab][0-9a-f]:/.test(address)) return 'link-local';
  return null;
}

function reject(rejection: JellyfinUrlRejection): JellyfinUrlVerdict {
  return { ok: false, rejection };
}

/** What each rejection means, in a sentence that names the RULE and never the value that broke it. */
export const JELLYFIN_URL_REJECTION_MESSAGES: Record<JellyfinUrlRejection, string> = {
  EMPTY: 'No Jellyfin address is configured.',
  TOO_LONG: 'The configured Jellyfin address is longer than an address needs to be.',
  NOT_A_URL: 'The configured Jellyfin address is not a URL.',
  SCHEME: 'The configured Jellyfin address must start with http:// or https://.',
  CREDENTIALS_IN_URL:
    'The configured Jellyfin address carries a username or password. Credentials belong in the API key secret '
    + 'file, never in an address that is printed, logged and shown in diagnostics.',
  QUERY_OR_FRAGMENT: 'The configured Jellyfin address must not carry a query string or a fragment.',
  PATH: 'The configured Jellyfin address has a path this product will not use as a prefix.',
  PORT: 'The configured Jellyfin address has a port outside 1-65535.',
  HOST_MISSING: 'The configured Jellyfin address names no host.',
  HOST_NOT_PRIVATE:
    'The configured Jellyfin address is not on a private network. This product talks to a media server on your '
    + 'own network: use its LAN address (10.x, 172.16-31.x, 192.168.x, 127.0.0.1), its Compose service name, or '
    + 'a .local / .lan / .internal name.',
};
