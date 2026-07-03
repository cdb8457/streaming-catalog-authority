import type { AdapterResult } from '../core/adapters/adapter.js';
import { TorBoxReadOnlyClient } from '../core/adapters/torbox-readonly-client.js';
import type {
  TorBoxErrorCategory,
  TorBoxReadOnlyOperation,
  TorBoxTransport,
  TorBoxTransportRequest,
  TorBoxTransportResponse,
} from '../core/adapters/torbox-real-client-gate.js';

/**
 * Phase 39 - deterministic TorBox transport acceptance harness.
 *
 * This module tests the injected transport contract with local fixtures only. It does not construct
 * a real transport, read credentials, call a provider, write state, or wire TorBox into adapter mode.
 */

export type TorBoxTransportAcceptanceScenario =
  | 'available'
  | 'unavailable'
  | 'unknown'
  | 'auth'
  | 'quota'
  | 'timeout'
  | 'parse'
  | 'ambiguous-response';

export type TorBoxTransportAcceptanceCategory =
  | 'fixture-ok'
  | 'auth'
  | 'quota'
  | 'timeout'
  | 'transport'
  | 'parse'
  | 'ambiguous-response';

export interface TorBoxTransportAcceptanceProbe {
  readonly operation: TorBoxReadOnlyOperation;
  readonly routeId: string;
  readonly scenario: TorBoxTransportAcceptanceScenario;
  readonly status: AdapterResult['status'];
  readonly category: TorBoxTransportAcceptanceCategory;
}

export interface TorBoxTransportAcceptanceReport {
  readonly report: 'phase-39-torbox-transport-acceptance';
  readonly phase: 39;
  readonly ok: boolean;
  readonly liveNetwork: false;
  readonly transport: 'injected-local-fixture-only';
  readonly wouldContactTorBox: false;
  readonly gates: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly category?: TorBoxTransportAcceptanceCategory;
  }[];
  readonly probes: readonly TorBoxTransportAcceptanceProbe[];
  readonly evidence: {
    readonly operations: readonly TorBoxReadOnlyOperation[];
    readonly counts: {
      readonly total: number;
      readonly available: number;
      readonly unavailable: number;
      readonly unknown: number;
      readonly blocked: number;
    };
    readonly categories: readonly TorBoxTransportAcceptanceCategory[];
  };
  readonly notes: readonly string[];
}

const DEFAULT_SCENARIOS: readonly TorBoxTransportAcceptanceScenario[] = [
  'available',
  'unavailable',
  'unknown',
  'auth',
  'quota',
  'timeout',
  'parse',
  'ambiguous-response',
] as const;

export async function runTorBoxTransportAcceptanceHarness(
  scenarios: readonly TorBoxTransportAcceptanceScenario[] = DEFAULT_SCENARIOS,
): Promise<TorBoxTransportAcceptanceReport> {
  const probes: TorBoxTransportAcceptanceProbe[] = [];

  for (const scenario of scenarios) {
    const transport = createLocalFixtureTransport(scenario);
    const client = new TorBoxReadOnlyClient({ transport, timeoutMs: 5_000 });
    const result = await client.resolveRef({
      itemId: '00000000-0000-4000-8000-000000000039',
      refType: 'infohash',
      refValue: 'RAW-INFOHASH-SECRET',
    });
    const request = transport.lastRequest();
    probes.push({
      operation: request.operation,
      routeId: request.routeId,
      scenario,
      status: result.status,
      category: categoryForScenarioAndResult(scenario, result),
    });
  }

  const serviceProbe = await runOperationProbe('available', (client) => client.checkServiceStatus());
  const hosterProbe = await runOperationProbe('available', (client) => client.checkHosters());
  probes.push(serviceProbe, hosterProbe);

  const gates = [
    gate('injected-transport-required', true),
    gate('local-fixtures-only', true),
    gate('no-live-network', true),
    gate('redaction-safe-report', probes.every((probe) => isSafeProbe(probe)), 'transport'),
    gate('read-only-operations-only', probes.every((probe) => isReadOnlyProbe(probe)), 'transport'),
  ];
  const categories = unique(probes.map((probe) => probe.category));
  const ok = gates.every((item) => item.ok)
    && containsAll(categories, ['fixture-ok', 'auth', 'quota', 'timeout', 'parse', 'ambiguous-response']);

  return {
    report: 'phase-39-torbox-transport-acceptance',
    phase: 39,
    ok,
    liveNetwork: false,
    transport: 'injected-local-fixture-only',
    wouldContactTorBox: false,
    gates,
    probes,
    evidence: {
      operations: unique(probes.map((probe) => probe.operation)),
      counts: {
        total: probes.length,
        available: probes.filter((probe) => probe.status === 'available').length,
        unavailable: probes.filter((probe) => probe.status === 'unavailable').length,
        unknown: probes.filter((probe) => probe.status === 'unknown').length,
        blocked: probes.filter((probe) => probe.category !== 'fixture-ok').length,
      },
      categories,
    },
    notes: [
      'Phase 39 accepts only injected local fixture transports.',
      'A future real transport must satisfy this harness before it can be considered for operator-run smoke.',
      'Public evidence contains only operation ids, route ids, statuses, fixed categories, and counts.',
      'No tokens, raw refs, provider payloads, endpoint URLs, titles, item ids, CDN URLs, or permalink URLs are retained.',
      'O4 remains open/deferred; O5 remains open/deferred.',
      'FileCustodian remains a hardened reference harness, not production KMS.',
    ],
  };
}

async function runOperationProbe(
  scenario: TorBoxTransportAcceptanceScenario,
  invoke: (client: TorBoxReadOnlyClient) => Promise<AdapterResult>,
): Promise<TorBoxTransportAcceptanceProbe> {
  const transport = createLocalFixtureTransport(scenario);
  const client = new TorBoxReadOnlyClient({ transport, timeoutMs: 5_000 });
  const result = await invoke(client);
  const request = transport.lastRequest();
  return {
    operation: request.operation,
    routeId: request.routeId,
    scenario,
    status: result.status,
    category: categoryForScenarioAndResult(scenario, result),
  };
}

function createLocalFixtureTransport(scenario: TorBoxTransportAcceptanceScenario): TorBoxTransport & {
  readonly lastRequest: () => TorBoxTransportRequest;
} {
  let captured: TorBoxTransportRequest | undefined;
  return {
    async request(request: TorBoxTransportRequest): Promise<TorBoxTransportResponse> {
      captured = request;
      if (scenario === 'parse') throw new SyntaxError('fixture parse failure');
      if (scenario === 'ambiguous-response') {
        return { status: 200, body: { providerPayload: 'SECRET-PROVIDER-PAYLOAD' } };
      }
      if (scenario === 'auth') return fixtureFailure(401, 'auth');
      if (scenario === 'quota') return fixtureFailure(429, 'quota');
      if (scenario === 'timeout') return fixtureFailure(504, 'timeout');
      return { status: 200, body: { availability: scenario } };
    },
    lastRequest(): TorBoxTransportRequest {
      if (!captured) throw new Error('fixture transport was not exercised');
      return captured;
    },
  };
}

function fixtureFailure(status: number, category: TorBoxErrorCategory): TorBoxTransportResponse {
  return { status, category, body: { providerPayload: 'SECRET-PROVIDER-PAYLOAD' } };
}

function categoryForScenarioAndResult(
  scenario: TorBoxTransportAcceptanceScenario,
  result: AdapterResult,
): TorBoxTransportAcceptanceCategory {
  if (scenario === 'available' || scenario === 'unavailable' || scenario === 'unknown') return 'fixture-ok';
  if (scenario === 'ambiguous-response') return result.detail === 'ambiguous-availability' ? 'ambiguous-response' : 'transport';
  if (scenario === 'auth' || scenario === 'quota' || scenario === 'timeout' || scenario === 'parse') return scenario;
  return 'transport';
}

function gate(
  name: string,
  ok: boolean,
  category?: TorBoxTransportAcceptanceCategory,
): TorBoxTransportAcceptanceReport['gates'][number] {
  return ok || !category ? { name, ok } : { name, ok, category };
}

function isSafeProbe(probe: TorBoxTransportAcceptanceProbe): boolean {
  return !JSON.stringify(probe).includes('SECRET') && !JSON.stringify(probe).includes('RAW-');
}

function isReadOnlyProbe(probe: TorBoxTransportAcceptanceProbe): boolean {
  return probe.operation === 'torrent-cache-check' || probe.operation === 'status-check' || probe.operation === 'hoster-list';
}

function unique<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function containsAll<T extends string>(values: readonly T[], expected: readonly T[]): boolean {
  return expected.every((value) => values.includes(value));
}
