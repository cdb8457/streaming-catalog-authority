import { createHash } from 'node:crypto';
import { loadJellyfinConfig } from '../core/adapters/jellyfin/config.js';
import { JellyfinHttpClient } from '../core/adapters/jellyfin/http-client.js';
import { runReadOnlySmoke } from '../core/adapters/jellyfin/smoke.js';
import type { JellyfinRef } from '../core/adapters/jellyfin/client.js';
import type { FetchLike } from '../core/adapters/jellyfin/transport.js';
import type { Env } from '../config/env.js';

export interface JellyfinLiveReadOnlySmokeReport {
  readonly report: 'phase-209-jellyfin-live-readonly-smoke';
  readonly version: 1;
  readonly ok: boolean;
  readonly redactionSafe: true;
  readonly timestamp: string;
  readonly status: 'JELLYFIN_LIVE_READONLY_SMOKE_PASS' | 'JELLYFIN_LIVE_READONLY_SMOKE_FAIL';
  readonly sourcePreflight: 'phase-208-existing-jellyfin-live-evidence-preflight';
  readonly target: {
    readonly scheme: 'http' | 'https';
    readonly port: number;
    readonly hostEchoed: false;
    readonly existingServerOnly: true;
    readonly installAttempted: false;
    readonly newPortBindingAttempted: false;
  };
  readonly credentialBoundary: {
    readonly apiKeySource: 'JELLYFIN_API_KEY_FILE';
    readonly apiKeyEchoed: false;
  };
  readonly operationBoundary: {
    readonly networkGate: 'JELLYFIN_ENABLE_NETWORK=true';
    readonly writeMode: false;
    readonly allowedMethods: readonly ['GET'];
    readonly allowedEndpointShapes: readonly ['GET /System/Info', 'GET /Items'];
    readonly forbidden: readonly string[];
  };
  readonly inputRef: {
    readonly type: string;
    readonly valueEchoed: false;
  };
  readonly steps: readonly {
    readonly name: string;
    readonly state: 'pass' | 'fail';
    readonly detail: string;
  }[];
  readonly summary: {
    readonly pass: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly evidenceDigest: string;
}

export interface RunJellyfinLiveReadOnlySmokeOptions {
  readonly env?: Env;
  readonly fetch: FetchLike;
  readonly ref: JellyfinRef;
  readonly now?: () => Date;
}

function parseTarget(baseUrl: string): { scheme: 'http' | 'https'; port: number } {
  const url = new URL(baseUrl);
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  const port = url.port.length > 0 ? Number(url.port) : scheme === 'https' ? 443 : 80;
  return { scheme, port };
}

function digestReport(report: Omit<JellyfinLiveReadOnlySmokeReport, 'evidenceDigest'>): string {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

function assertLiveReadOnlyEnv(env: Env): void {
  const problems: string[] = [];
  if (env.JELLYFIN_ENABLE_NETWORK !== 'true') problems.push('JELLYFIN_ENABLE_NETWORK must be true');
  if (!env.JELLYFIN_API_KEY_FILE) problems.push('JELLYFIN_API_KEY_FILE is required');
  if (env.JELLYFIN_API_KEY !== undefined) problems.push('JELLYFIN_API_KEY must not be set for Phase 209; use JELLYFIN_API_KEY_FILE');
  if (env.JELLYFIN_ALLOW_LIVE_PUBLISH === 'true') problems.push('JELLYFIN_ALLOW_LIVE_PUBLISH must not be true for read-only smoke');
  if (problems.length > 0) throw new Error(`invalid Phase 209 Jellyfin live read-only environment: ${problems.join('; ')}`);
}

export async function runJellyfinLiveReadOnlySmoke(opts: RunJellyfinLiveReadOnlySmokeOptions): Promise<JellyfinLiveReadOnlySmokeReport> {
  const env = opts.env ?? process.env;
  assertLiveReadOnlyEnv(env);
  const config = loadJellyfinConfig(env);
  if (config === null) throw new Error('invalid Phase 209 Jellyfin live read-only environment: Jellyfin is not configured');

  const client = new JellyfinHttpClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: opts.fetch,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  });
  const smoke = await runReadOnlySmoke(client, opts.ref);
  const target = parseTarget(config.baseUrl);
  const steps = smoke.steps.map((step) => ({
    name: step.step,
    state: step.ok ? 'pass' as const : 'fail' as const,
    detail: step.detail,
  }));
  const fail = steps.filter((step) => step.state === 'fail').length;
  const reportWithoutDigest: Omit<JellyfinLiveReadOnlySmokeReport, 'evidenceDigest'> = {
    report: 'phase-209-jellyfin-live-readonly-smoke',
    version: 1,
    ok: smoke.ok,
    redactionSafe: true,
    timestamp: (opts.now ?? (() => new Date()))().toISOString(),
    status: smoke.ok ? 'JELLYFIN_LIVE_READONLY_SMOKE_PASS' : 'JELLYFIN_LIVE_READONLY_SMOKE_FAIL',
    sourcePreflight: 'phase-208-existing-jellyfin-live-evidence-preflight',
    target: {
      scheme: target.scheme,
      port: target.port,
      hostEchoed: false,
      existingServerOnly: true,
      installAttempted: false,
      newPortBindingAttempted: false,
    },
    credentialBoundary: {
      apiKeySource: 'JELLYFIN_API_KEY_FILE',
      apiKeyEchoed: false,
    },
    operationBoundary: {
      networkGate: 'JELLYFIN_ENABLE_NETWORK=true',
      writeMode: false,
      allowedMethods: ['GET'],
      allowedEndpointShapes: ['GET /System/Info', 'GET /Items'],
      forbidden: ['POST', 'PUT', 'PATCH', 'DELETE', 'playback', 'downloads', 'providers', 'scraping', 'catalog mutation'],
    },
    inputRef: {
      type: opts.ref.type,
      valueEchoed: false,
    },
    steps,
    summary: {
      pass: steps.length - fail,
      fail,
      total: steps.length,
    },
  };
  return { ...reportWithoutDigest, evidenceDigest: digestReport(reportWithoutDigest) };
}

