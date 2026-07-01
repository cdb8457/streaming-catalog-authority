import type { RevocationAdapter, RevokeResult } from './revoke.js';

/**
 * Phase 9 — deterministic, LOCAL fake revoker (no network, no real media server, no credentials).
 *
 * Revokes any opaque handle by default; handles listed in the constructor's `failHandles` report
 * `failed` (to exercise the retry/visibility path). It records the handles it received in `seen` so
 * privacy tests can prove revocation only ever sees OPAQUE handles — never identity.
 */
export class FakeRevoker implements RevocationAdapter {
  readonly seen: string[] = [];
  private readonly fail: ReadonlySet<string>;

  constructor(failHandles: Iterable<string> = []) { this.fail = new Set(failHandles); }

  describe(): { name: string; kind: 'revoker' } {
    return { name: 'fake', kind: 'revoker' };
  }

  async revoke(externalHandle: string): Promise<RevokeResult> {
    this.seen.push(externalHandle);
    if (this.fail.has(externalHandle)) return { status: 'failed', detail: 'fake: revoke failed' };
    return { status: 'revoked' };
  }
}
