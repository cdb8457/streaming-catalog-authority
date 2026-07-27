import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Phase 268 — binding an EXECUTE to the exact plan that was previewed.
//
// THE PROBLEM, AND WHY THE IMPORT'S ANSWER IS NOT ENOUGH ON ITS OWN. A plan preview says "this would create
// 28 collections and revoke 2". An execute that merely re-plans from the same selection does not queue what
// was previewed — it queues whatever the catalog and the ledger imply NOW. Between the two, a record can be
// forgotten, another operator can publish, an import can land, a tab can sit open across a restart, and a
// bookmarked request can be replayed. This is the surface that queues external writes, so "the operator read
// a preview" has to be provable rather than assumed.
//
// TWO INDEPENDENT BINDINGS, AND BOTH ARE REQUIRED.
//   1. A SIGNED CONFIRMATION, issued by the preview, naming the plan digest, the basis digest and the name.
//      It proves THIS process previewed THIS plan, once, recently.
//   2. THE OPERATOR'S OWN ECHO OF THE PLAN DIGEST, sent as `confirmDigest`. A signed blob a page carries
//      around is something a page can replay by itself; a digest that has to be sent back verbatim is the
//      part a human (or a script an operator wrote deliberately) states on purpose. The route refuses when
//      the two disagree, so neither alone is sufficient.
// On top of both, Phase 268 RECOMPUTES the plan and requires the recomputed digests to equal the confirmed
// ones — so a confirmation that is valid, unspent and echoed correctly still cannot execute a plan whose
// world has moved. That is the stale-plan refusal, and it is what makes this a confirmation rather than a
// licence.
//
// THE KEY IS PER-PROCESS, RANDOM, AND NEVER LEAVES. Not configured, not rotated, not written anywhere. A
// restart invalidates outstanding confirmations, which is the fail-closed direction: a confirmation is a
// statement about a preview THIS process performed.
//
// A CONFIRMATION IS NOT A CREDENTIAL. It authorises nothing on its own — every route still requires the
// operator token, and the write path additionally requires two deployment-level switches.

/** Long enough to read a plan of 500 records; short enough that a forgotten tab cannot execute. */
export const COLLECTION_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
/** How many spent confirmations are remembered. Past the TTL a spent nonce cannot be replayed anyway. */
export const COLLECTION_CONFIRMATION_MAX_SPENT = 4096;
/** A confirmation is small and fixed-shape; anything longer is not one. */
export const COLLECTION_CONFIRMATION_MAX_LENGTH = 1024;

export interface CollectionConfirmationClaims {
  readonly name: string;
  readonly planDigest: string;
  readonly basisDigest: string;
  /** What the plan said it would do. Carried so a refusal can say what changed without re-deriving it. */
  readonly create: number;
  readonly update: number;
  readonly revoke: number;
}

interface SignedClaims extends CollectionConfirmationClaims {
  readonly nonce: string;
  readonly issuedAt: number;
}

export type CollectionConfirmationRejection =
  | 'MALFORMED'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'ALREADY_USED'
  | 'TOO_MANY_OUTSTANDING'
  | 'DIGEST_MISMATCH';

export type CollectionConfirmationVerdict =
  | { readonly ok: true; readonly claims: CollectionConfirmationClaims }
  | { readonly ok: false; readonly rejection: CollectionConfirmationRejection; readonly message: string };

const REJECTION_MESSAGES: Record<CollectionConfirmationRejection, string> = {
  MALFORMED: 'That confirmation is not one this page issued. Preview the plan again and confirm from the fresh preview.',
  BAD_SIGNATURE: 'That confirmation was not issued by this running service. If the stack has restarted since you previewed, preview again.',
  EXPIRED: 'That plan preview is too old to execute. Preview it again and confirm from the fresh preview.',
  ALREADY_USED: 'That confirmation has already been used. Each preview may be executed once; preview again to queue more work.',
  TOO_MANY_OUTSTANDING: 'Too many confirmations are outstanding to accept another safely. Wait a few minutes and preview again.',
  DIGEST_MISMATCH: 'The plan digest you confirmed is not the plan digest that preview issued. Nothing was queued. Copy the digest from the preview you actually read.',
};

/** A digest is 64 lower-case hex characters, and is compared as one. */
export const COLLECTION_DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * The operator's own echo of a digest, compared in constant time.
 *
 * ONE IMPLEMENTATION, TWO SURFACES. Phase 272 gives the collection plane a command line, and the thing that
 * must not differ between a browser and a terminal is exactly this: whether the digest somebody stated is the
 * digest of the plan about to run. Exporting the comparison — rather than letting a CLI write `a === b` —
 * means the two surfaces cannot drift, and that the CLI inherits the constant-time property for free.
 *
 * It is constant-time over a value an attacker could grind against. Both sides are fixed-length hex by the
 * regex above, so a length mismatch is already impossible; the guard is kept because that is a property of the
 * regex rather than of this line, and `timingSafeEqual` throws on unequal lengths.
 */
export function digestEchoMatches(echoed: unknown, expected: string): boolean {
  if (typeof echoed !== 'string' || !COLLECTION_DIGEST_RE.test(echoed)) return false;
  if (!COLLECTION_DIGEST_RE.test(expected)) return false;
  const a = Buffer.from(echoed, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class CollectionConfirmations {
  private readonly key: Buffer;
  /** nonce -> the moment it stops being replayable. Pruned lazily; never consulted past the TTL. */
  private readonly spent = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now(), key: Buffer = randomBytes(32)) {
    this.key = key;
  }

  /** Issue a confirmation for a plan a preview just computed. */
  issue(claims: CollectionConfirmationClaims): string {
    const signed: SignedClaims = { ...claims, nonce: randomBytes(16).toString('hex'), issuedAt: this.now() };
    const body = base64url(Buffer.from(JSON.stringify(signed), 'utf8'));
    return `${body}.${base64url(this.mac(body))}`;
  }

  /**
   * Verify a confirmation and the operator's own echo of the digest.
   *
   * THE ORDER IS DELIBERATE AND IS THE SAME ONE THE IMPORT USES. The signature is checked before anything in
   * the payload is believed; the expiry before the nonce is spent; and the nonce is SPENT BEFORE the echoed
   * digest is compared — so a caller cannot burn attempts probing for a digest, and a confirmation that
   * reaches the comparison is already unusable a second time whatever the answer is.
   */
  verify(token: unknown, confirmDigest: unknown): CollectionConfirmationVerdict {
    if (typeof token !== 'string' || token.length === 0 || token.length > COLLECTION_CONFIRMATION_MAX_LENGTH) {
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
    // A clock that went backwards, and a token from the future, are both refused. Neither is a token this
    // process issued a moment ago, and refusing both costs an operator one re-preview.
    if (claims.issuedAt > now + 60_000) return reject('EXPIRED');
    if (now - claims.issuedAt > COLLECTION_CONFIRMATION_TTL_MS) return reject('EXPIRED');

    this.prune(now);
    if (this.spent.has(claims.nonce)) return reject('ALREADY_USED');
    // Fail CLOSED rather than forgetting an unexpired spent nonce to make room: forgetting one is what makes
    // a replay possible, and refusing is merely inconvenient.
    if (this.spent.size >= COLLECTION_CONFIRMATION_MAX_SPENT) return reject('TOO_MANY_OUTSTANDING');
    this.spent.set(claims.nonce, claims.issuedAt + COLLECTION_CONFIRMATION_TTL_MS);

    if (typeof confirmDigest !== 'string' || !COLLECTION_DIGEST_RE.test(confirmDigest)) return reject('DIGEST_MISMATCH');
    // Constant-time over a value an attacker could grind against. Both sides are fixed-length hex here, so a
    // length mismatch is already impossible — the guard is kept because that is a property of the regexes
    // above rather than of this line.
    const echoed = Buffer.from(confirmDigest, 'utf8');
    const claimed = Buffer.from(claims.planDigest, 'utf8');
    if (echoed.length !== claimed.length || !timingSafeEqual(echoed, claimed)) return reject('DIGEST_MISMATCH');

    return {
      ok: true,
      claims: {
        name: claims.name,
        planDigest: claims.planDigest,
        basisDigest: claims.basisDigest,
        create: claims.create,
        update: claims.update,
        revoke: claims.revoke,
      },
    };
  }

  private mac(body: string): Buffer {
    // The separator is a NUL written as an ESCAPE, not as a literal byte — a literal one survives no diff, no
    // patch and no editor reliably, and a signing input a copy of this file can silently change is a signing
    // input that will one day be changed. The suite pins both the escape and the resulting digest.
    return createHmac('sha256', this.key)
      .update(`catalog-authority/collection-confirmation/v1\u0000${body}`, 'utf8')
      .digest();
  }

  private prune(now: number): void {
    for (const [nonce, expiresAt] of this.spent) {
      if (expiresAt <= now) this.spent.delete(nonce);
    }
  }
}

function reject(rejection: CollectionConfirmationRejection): CollectionConfirmationVerdict {
  return { ok: false, rejection, message: REJECTION_MESSAGES[rejection] };
}

function isSignedClaims(value: unknown): value is SignedClaims {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  const count = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 100_000;
  return typeof c.name === 'string' && c.name.length > 0 && c.name.length <= 64
    && typeof c.planDigest === 'string' && COLLECTION_DIGEST_RE.test(c.planDigest)
    && typeof c.basisDigest === 'string' && COLLECTION_DIGEST_RE.test(c.basisDigest)
    && count(c.create) && count(c.update) && count(c.revoke)
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
