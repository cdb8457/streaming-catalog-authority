import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runJellyfinLiveReadOnlySmoke, type JellyfinLiveReadOnlySmokeReport } from './jellyfin-live-readonly-smoke.js';
import type { JellyfinRef } from '../core/adapters/jellyfin/client.js';
import type { FetchLike } from '../core/adapters/jellyfin/transport.js';
import type { Env } from '../config/env.js';

export interface CaptureJellyfinLiveEvidenceOptions {
  readonly env?: Env;
  readonly fetch: FetchLike;
  readonly ref: JellyfinRef;
  readonly outFile: string;
  readonly now?: () => Date;
}

export interface JellyfinLiveEvidenceCaptureResult {
  readonly report: 'phase-211-jellyfin-live-evidence-capture';
  readonly ok: boolean;
  readonly redactionSafe: true;
  readonly outputFile: string;
  readonly outputPathEchoed: true;
  readonly smokeReport: 'phase-209-jellyfin-live-readonly-smoke';
  readonly smokeStatus: 'JELLYFIN_LIVE_READONLY_SMOKE_PASS' | 'JELLYFIN_LIVE_READONLY_SMOKE_FAIL';
  readonly evidenceDigest: string;
  readonly bytesWritten: number;
}

export async function captureJellyfinLiveEvidence(opts: CaptureJellyfinLiveEvidenceOptions): Promise<JellyfinLiveEvidenceCaptureResult> {
  const smoke = await runJellyfinLiveReadOnlySmoke({
    env: opts.env,
    fetch: opts.fetch,
    ref: opts.ref,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const body = `${JSON.stringify(smoke, null, 2)}\n`;
  mkdirSync(dirname(opts.outFile), { recursive: true });
  writeFileSync(opts.outFile, body, { encoding: 'utf8', mode: 0o600 });
  return summarizeCapture(opts.outFile, smoke, body);
}

export function summarizeCapture(outFile: string, smoke: JellyfinLiveReadOnlySmokeReport, body: string): JellyfinLiveEvidenceCaptureResult {
  return {
    report: 'phase-211-jellyfin-live-evidence-capture',
    ok: smoke.ok,
    redactionSafe: true,
    outputFile: outFile,
    outputPathEchoed: true,
    smokeReport: smoke.report,
    smokeStatus: smoke.status,
    evidenceDigest: smoke.evidenceDigest,
    bytesWritten: Buffer.byteLength(body, 'utf8'),
  };
}

