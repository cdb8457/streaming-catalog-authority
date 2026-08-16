import { seal, type SealedValue } from './sealed.js';
import type { UsenetRefusalReason } from './sab-contract.js';

// Projection Phase 9 — reading the SABnzbd API key, and refusing every way of holding one badly.
//
// §2: "Its API credential is read from a restrictive file and is never placed in argv, a manifest, a log, an
// error, a metric label or an inline environment value."
//
// WHAT THAT MEANS FOR THIS MODULE, CONCRETELY.
//
//   THE PATH IS AN INPUT; THE VALUE NEVER IS. There is no function here that accepts a key. An operator who
//   wants to hand this project a key has exactly one way to do it: put it in a file, make the file theirs
//   alone, and name the file. That closes the two routes a key most often leaks by — a shell history entry
//   and a `docker inspect` — because neither ever holds one.
//
//   THE MODE CHECK IS A REFUSAL, NOT A WARNING, AND IT IS THE DAEMON'S OWN RULE. `source.SecretFile` in
//   `projectiond` refuses a file whose mode has any group or other bit set. `real-provider.ts` restates the
//   same bound as `CREDENTIAL_MAX_MODE`. This module refuses on the same test, so an operator cannot have one
//   credential accepted here and refused three components later.
//
//   NOTHING THIS MODULE RETURNS OR THROWS CARRIES THE PATH. Not the failure messages, not the codes, not the
//   success value. A path under an operator's appdata share names their host layout, and a report that says
//   "/mnt/user/appdata/sabnzbd/admin/api.key is world-readable" has published the location of a live
//   credential to whoever reads the report. The caller knows which path it asked about; the report does not
//   have to say it again.
//
// IT READS ONE FILE THROUGH AN INJECTED INTERFACE. That is not test decoration: the same interface is what
// lets the boundary suite drive every refusal — a mode, a size, a symlink, a device — on a platform whose
// filesystem cannot produce some of them.

/** The bound the daemon's own `source.SecretFile` holds, restated so a refusal happens before a read. */
export const SAB_API_KEY_MAX_MODE = 0o600;
export const SAB_API_KEY_MAX_BYTES = 4096;
export const SAB_API_KEY_MIN_BYTES = 8;

/**
 * The shape a SABnzbd API key has.
 *
 * SABnzbd generates a 32-character lower-case hex key. This accepts a wider alphabet and a wider length,
 * because an operator may be running a fork, a proxy or a version that generates differently — but it does
 * NOT accept whitespace, punctuation, control characters or anything URL-shaped. A "key" containing a slash
 * or a colon is far more likely to be a path or a URL somebody pasted into the wrong file, and treating that
 * as a credential would send it to the worker in a query string.
 */
export const SAB_API_KEY_SHAPE = /^[A-Za-z0-9_-]{8,128}$/;

export type ApiKeyFileKind = 'file' | 'symlink' | 'directory' | 'device' | 'fifo' | 'socket' | 'other' | 'missing';

/**
 * What the caller must be able to tell this module about the file, WITHOUT following a link.
 *
 * `kind` comes from an `lstat`, never a `stat`. A `stat` on a symlink describes its target, so a `stat`-based
 * check on a credential file is a check on whatever the link currently points at — which an attacker who can
 * write the directory chooses.
 */
export interface ApiKeyFileStat {
  readonly kind: ApiKeyFileKind;
  /** POSIX permission bits, or `undefined` on a platform that has no such concept. */
  readonly mode?: number;
  readonly sizeBytes: number;
}

export interface ApiKeyFileSystem {
  /** `lstat`, not `stat`. A symlink reports itself. */
  lstatFile(path: string): Promise<ApiKeyFileStat>;
  /** Reads at most `SAB_API_KEY_MAX_BYTES`. Must open with O_NOFOLLOW where the platform provides it. */
  readFileNoFollow(path: string): Promise<Buffer>;
}

export interface ApiKeyReadOk {
  readonly ok: true;
  readonly key: SealedValue;
  /** Twelve hex characters. The ONLY way this key is ever named in a report, a log or an evidence file. */
  readonly fingerprint: string;
}

export interface ApiKeyReadRefused {
  readonly ok: false;
  readonly reason: UsenetRefusalReason;
  /** A constant sentence. It never carries the path, the mode digits or any part of the value. */
  readonly detail: string;
}

export type ApiKeyRead = ApiKeyReadOk | ApiKeyReadRefused;

const refuse = (reason: UsenetRefusalReason, detail: string): ApiKeyReadRefused => ({ ok: false, reason, detail });

/**
 * Whether a POSIX mode is restrictive enough to hold a credential.
 *
 * Exported because the operator preflight asks the same question about the same file before a run starts, and
 * two implementations of "restrictive enough" is how one of them ends up looser.
 */
export function isRestrictiveMode(mode: number | undefined): boolean {
  if (mode === undefined) return true; // a platform without modes cannot fail this test; see requireMode below
  return (mode & 0o077) === 0;
}

export interface ReadApiKeyOptions {
  /**
   * Whether a platform that reports no mode is acceptable.
   *
   * TRUE ON A REAL DEPLOYMENT, and the default is true for exactly one reason: the appliance runs on Unraid,
   * where every credential file has a mode, so a missing mode there means the stat call is lying rather than
   * that the concept is absent. A developer host that genuinely has no POSIX modes sets this false and is
   * told so, rather than being silently held to a check that cannot run.
   */
  readonly requireMode?: boolean;
}

/**
 * Read the key, or say exactly what is wrong with the file — in that order, and with the cheap structural
 * checks first, so a world-readable file is refused before its contents are ever read into this process.
 */
export async function readSabApiKeyFile(
  fs: ApiKeyFileSystem,
  path: string,
  options: ReadApiKeyOptions = {},
): Promise<ApiKeyRead> {
  const requireMode = options.requireMode ?? true;

  let stat: ApiKeyFileStat;
  try {
    stat = await fs.lstatFile(path);
  } catch {
    return refuse('credential-file-unreadable', 'the API key file could not be examined');
  }

  if (stat.kind === 'missing') {
    return refuse('credential-file-unreadable', 'no API key file exists at the configured location');
  }
  // A SYMLINK IS REFUSED RATHER THAN RESOLVED. §4 forbids following a symlink for media, and a credential is
  // strictly more sensitive than media: a link means the bytes this process reads are chosen by whoever can
  // write the link, and no mode on the link itself constrains the target.
  if (stat.kind === 'symlink') {
    return refuse('credential-file-permissive', 'the API key path is a symbolic link, which is refused rather than followed');
  }
  if (stat.kind !== 'file') {
    return refuse('credential-file-unreadable', 'the API key path is not a regular file');
  }
  if (stat.mode === undefined) {
    if (requireMode) {
      return refuse('credential-file-permissive',
        'the API key file reports no permission bits, so the restrictive-mode check could not be applied');
    }
  } else if (!isRestrictiveMode(stat.mode)) {
    return refuse('credential-file-permissive',
      'the API key file grants access to group or other; it must grant nothing beyond its owner');
  }
  if (stat.sizeBytes > SAB_API_KEY_MAX_BYTES) {
    return refuse('credential-file-malformed', 'the API key file is larger than a key could be');
  }
  if (stat.sizeBytes < SAB_API_KEY_MIN_BYTES) {
    return refuse('credential-file-malformed', 'the API key file is shorter than a key could be');
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFileNoFollow(path);
  } catch {
    return refuse('credential-file-unreadable', 'the API key file could not be read');
  }
  if (bytes.byteLength > SAB_API_KEY_MAX_BYTES) {
    return refuse('credential-file-malformed', 'the API key file is larger than a key could be');
  }

  // TRAILING WHITESPACE IS TRIMMED; INTERNAL WHITESPACE IS A REFUSAL. Every editor and every `echo` adds a
  // trailing newline, so refusing one would refuse the file an operator will actually create. A space in the
  // MIDDLE of a key means the file holds something other than a key, and sending that to the worker in a query
  // string is how half a credential ends up in somebody's access log.
  const text = bytes.toString('utf8').replace(/[\r\n\t ]+$/u, '').replace(/^﻿/u, '');
  if (text.length === 0) {
    return refuse('credential-file-malformed', 'the API key file holds only whitespace');
  }
  if (!SAB_API_KEY_SHAPE.test(text)) {
    return refuse('credential-file-malformed',
      'the API key file does not hold a single opaque key; a key is 8 to 128 characters of letters, digits, '
      + 'underscore and hyphen with nothing else on the line');
  }

  const key = seal('sab-api-key', text);
  return { ok: true, key, fingerprint: key.fingerprint() };
}
