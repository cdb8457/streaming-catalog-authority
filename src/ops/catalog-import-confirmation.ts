import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Phase 264 — binding an APPLY to the exact bytes that were PREVIEWED.
//
// THE PROBLEM. A preview says "this would create 28 records". An apply that merely re-reads the same file
// NAME does not import what was previewed — it imports whatever is at that name NOW. Between the two, the
// file can be replaced (the folder is read-only to the container, not to the person at the host), the
// operator can preview one file and confirm another by clicking the wrong row, an old browser tab can be
// re-submitted hours later, and a page left open across a restart can confirm against a different
// installation. "Preview is mandatory" is worth nothing unless the apply can prove which preview it is.
//
// THE BINDING. A preview issues a CONFIRMATION: a small, signed statement of exactly what was previewed —
// which file name, how many bytes, the sha256 of those bytes, the digest of the normalised snapshot, and a
// single-use nonce with an issue time. The apply verifies the signature, re-reads the file, recomputes the
// content digest, and requires every one of those to match. A substituted file changes the content digest. A
// different row changes the name. An old tab fails the expiry. A replay fails the nonce. A restarted
// container fails the signature, because the key lives only in the process that issued it — which is exactly
// right: a confirmation is a statement about a preview this process performed.
//
// THE KEY IS PER-PROCESS, RANDOM, AND NEVER LEAVES. It is not a secret an operator holds, configures,
// rotates or can lose; it is not written to disk, an environment variable, a log line or a response. Losing
// it (a restart) invalidates outstanding previews, which is the fail-closed direction.
//
// A CONFIRMATION IS NOT A CREDENTIAL. It authorises nothing on its own: every route still requires the
// operator token. It only says "this apply is the apply that preview described".

/** How long a confirmation is good for. Long enough to read a preview; short enough that a stale tab fails. */
export const IMPORT_CONFIRMATION_TTL_MS = 15 * 60 * 1000;
/** How many spent confirmations are remembered. Past the TTL a spent nonce cannot be replayed anyway. */
export const IMPORT_CONFIRMATION_MAX_SPENT = 4096;
/** A confirmation is small and fixed-shape; anything longer is not one. */
export const IMPORT_CONFIRMATION_MAX_LENGTH = 1024;

export interface ImportConfirmationClaims {
  readonly name: string;
  readonly bytes: number;
  readonly contentDigest: string;
  readonly snapshotDigest: string;
  readonly source: string;
  readonly updateExisting: boolean;
}

interface SignedClaims extends ImportConfirmationClaims {
  readonly nonce: string;
  readonly issuedAt: number;
}

export type ConfirmationRejection =
  | 'MALFORMED'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'ALREADY_USED'
  | 'TOO_MANY_OUTSTANDING'
  | 'FILE_CHANGED';

export type ConfirmationVerdict =
  | { readonly ok: true; readonly claims: ImportConfirmationClaims }
  | { readonly ok: false; readonly rejection: ConfirmationRejection; readonly message: string };

const REJECTION_MESSAGES: Record<ConfirmationRejection, string> = {
  MALFORMED: 'That confirmation is not one this page issued. Preview the snapshot again and confirm from the fresh preview.',
  BAD_SIGNATURE: 'That confirmation was not issued by this running service. If the stack has restarted since you previewed, preview again.',
  EXPIRED: 'That preview is too old to apply. Preview the snapshot again and confirm from the fresh preview.',
  ALREADY_USED: 'That confirmation has already been used. Each preview may be applied once; preview again to import again.',
  TOO_MANY_OUTSTANDING: 'Too many confirmations are outstanding to accept another safely. Wait a few minutes and preview again.',
  FILE_CHANGED: 'The snapshot file is not the one you previewed — its contents changed since the preview. Nothing was written. Preview it again and read the new preview before confirming.',
};

/**
 * The issuer and verifier for one running process.
 *
 * A CLASS, not module state, so a test can hold two independent issuers and prove that a confirmation from
 * one is refused by the other — which is the same property a container restart has.
 */
export class ImportConfirmations {
  private readonly key: Buffer;
  /** nonce -> the moment it stops being replayable. Pruned lazily; never consulted past the TTL. */
  private readonly spent = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now(), key: Buffer = randomBytes(32)) {
    this.key = key;
  }

  /** Issue a confirmation for what a preview just read. */
  issue(claims: ImportConfirmationClaims): string {
    const signed: SignedClaims = {
      ...claims,
      nonce: randomBytes(16).toString('hex'),
      issuedAt: this.now(),
    };
    const body = base64url(Buffer.from(JSON.stringify(signed), 'utf8'));
    return `${body}.${base64url(this.mac(body))}`;
  }

  /**
   * Verify a confirmation against the bytes that are on disk NOW.
   *
   * ORDER MATTERS AND IS DELIBERATE. The signature is checked before anything in the payload is believed,
   * the expiry before the nonce is spent, and the nonce is SPENT BEFORE the content is compared — so a
   * caller cannot burn attempts probing whether a file changed, and a confirmation that reaches the content
   * check is already unusable a second time whatever the answer is.
   */
  verify(token: unknown, actualContentDigest: string, actualBytes: number): ConfirmationVerdict {
    if (typeof token !== 'string' || token.length === 0 || token.length > IMPORT_CONFIRMATION_MAX_LENGTH) {
      return reject('MALFORMED');
    }
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) return reject('MALFORMED');
    const body = token.slice(0, dot);
    const signature = fromBase64url(token.slice(dot + 1));
    if (signature === null) return reject('MALFORMED');

    const expected = this.mac(body);
    // Constant-time, and length-checked first because timingSafeEqual throws on a length mismatch.
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return reject('BAD_SIGNATURE');

    const raw = fromBase64url(body);
    if (raw === null) return reject('MALFORMED');
    let claims: SignedClaims;
    try {
      claims = JSON.parse(raw.toString('utf8')) as SignedClaims;
    } catch {
      return reject('MALFORMED');
    }
    if (!isSignedClaims(claims)) return reject('MALFORMED');

    const now = this.now();
    // A clock that went backwards, or a token from the future, is not a token this process issued a moment
    // ago. Refusing both directions costs an operator one re-preview and closes a whole family of games.
    if (claims.issuedAt > now + 60_000) return reject('EXPIRED');
    if (now - claims.issuedAt > IMPORT_CONFIRMATION_TTL_MS) return reject('EXPIRED');

    this.prune(now);
    if (this.spent.has(claims.nonce)) return reject('ALREADY_USED');
    // Fail CLOSED rather than forgetting an unexpired spent nonce to make room: forgetting one is what makes
    // a replay possible, and refusing is merely inconvenient.
    if (this.spent.size >= IMPORT_CONFIRMATION_MAX_SPENT) return reject('TOO_MANY_OUTSTANDING');
    this.spent.set(claims.nonce, claims.issuedAt + IMPORT_CONFIRMATION_TTL_MS);

    if (claims.contentDigest !== actualContentDigest || claims.bytes !== actualBytes) return reject('FILE_CHANGED');

    return {
      ok: true,
      claims: {
        name: claims.name,
        bytes: claims.bytes,
        contentDigest: claims.contentDigest,
        snapshotDigest: claims.snapshotDigest,
        source: claims.source,
        updateExisting: claims.updateExisting,
      },
    };
  }

  private mac(body: string): Buffer {
    // The separator is a NUL, written as an ESCAPE and not as a literal byte. `\u0000` and a raw 0x00
    // are the same character to the template literal, so the MAC input is byte-for-byte what it always was —
    // but a literal NUL in a source file survives no diff, no patch, no editor and no terminal reliably, and
    // a signing input that a copy of this file can silently change is a signing input that will one day be
    // changed. `test/operator-ui-import-endpoint.ts` pins both the escape and the resulting digest.
    return createHmac('sha256', this.key).update(`catalog-authority/import-confirmation/v1\u0000${body}`, 'utf8').digest();
  }

  private prune(now: number): void {
    for (const [nonce, expiresAt] of this.spent) {
      if (expiresAt <= now) this.spent.delete(nonce);
    }
  }
}

function reject(rejection: ConfirmationRejection): ConfirmationVerdict {
  return { ok: false, rejection, message: REJECTION_MESSAGES[rejection] };
}

function isSignedClaims(value: unknown): value is SignedClaims {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return typeof c.name === 'string'
    && typeof c.bytes === 'number' && Number.isInteger(c.bytes) && c.bytes >= 0
    && typeof c.contentDigest === 'string' && /^[0-9a-f]{64}$/.test(c.contentDigest)
    && typeof c.snapshotDigest === 'string' && /^[0-9a-f]{64}$/.test(c.snapshotDigest)
    && typeof c.source === 'string'
    && typeof c.updateExisting === 'boolean'
    && typeof c.nonce === 'string' && /^[0-9a-f]{32}$/.test(c.nonce)
    && typeof c.issuedAt === 'number' && Number.isFinite(c.issuedAt);
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return null;
  }
}
