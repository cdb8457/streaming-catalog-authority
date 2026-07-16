import { createHash } from 'node:crypto';

// Local, non-live final coordinator evidence packet. It summarizes a fixture evidence bundle and its
// (required) replay result into a compact redaction-safe packet: the key digests, the local test
// commands to reproduce, the remaining human gates, and explicit no-live / no-Phase-231 language. It is
// deterministic (a pure function of its inputs). It reads parsed JSON only; it performs no promotion,
// never touches the real Movies root, never contacts Jellyfin, and authorizes nothing live.

export interface EvidencePacketInput {
  readonly bundle?: unknown;
  readonly replay?: unknown;
}

// Fixed language — constants, never derived from input, and deliberately free of raw paths.
export const EVIDENCE_TEST_COMMANDS: readonly string[] = [
  'npm run test:phase230-local',
  'npm run test:promotion-fixture-bundle',
  'npm run test:promotion-bundle-replay',
  'npx tsc -p tsconfig.json --noEmit',
];

export const EVIDENCE_HUMAN_GATES: readonly string[] = [
  'A human operator authors and independently attests the approval file; this tooling validates it but does not issue it.',
  'The live real-library promotion (the Phase 229 operator-approved launcher writing to the real Movies library) is a human-authorized step, out of scope and not performed by this tooling.',
  'The coordinator records an explicit ACCEPT decision in the acceptance seal.',
  'Phase 231 authorization is a separate human decision, granted by nothing in this evidence.',
];

export const EVIDENCE_DISCLAIMERS: readonly string[] = [
  'This evidence packet does NOT authorize Phase 231.',
  'This evidence packet does NOT authorize live promotion.',
  'No live Jellyfin call or real Movies write is implied or performed by this packet.',
  'All artifacts summarized here are offline fixtures; the packet is redaction-safe and deterministic.',
];

export interface CoordinatorEvidencePacket {
  readonly report: 'phase-230-promotion-coordinator-evidence-packet';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'EVIDENCE_COMPLETE' | 'EVIDENCE_INCOMPLETE';
  readonly digests: Record<string, string>;
  readonly testCommands: readonly string[];
  readonly humanGates: readonly string[];
  readonly disclaimers: readonly string[];
  readonly blockers: readonly string[];
  readonly packetDigest: string;
}

export function buildCoordinatorEvidencePacket(input: EvidencePacketInput): CoordinatorEvidencePacket {
  const blockers: string[] = [];
  const bundle = input.bundle === undefined ? undefined : asObject(input.bundle);
  const replay = input.replay === undefined ? undefined : asObject(input.replay);

  const bundleValid = bundle !== undefined && bundle.report === 'phase-230-promotion-fixture-evidence-bundle';
  if (!bundleValid) blockers.push('BUNDLE_INVALID');
  else if (bundle!.outcome !== 'BUNDLE_READY') blockers.push('BUNDLE_NOT_READY');

  // A replay is REQUIRED: a complete coordinator packet must include a passing bundle-replay result.
  if (replay === undefined) {
    blockers.push('REPLAY_MISSING');
  } else {
    const replayValid = replay.report === 'phase-230-promotion-bundle-replay';
    if (!replayValid) blockers.push('REPLAY_INVALID');
    else if (replay.ok !== true) blockers.push('REPLAY_NOT_OK');
  }

  const digests: Record<string, string> = {};
  if (bundleValid) {
    const b = bundle!;
    const reports = asObject(b.reports);
    add(digests, 'bundle', b.bundleDigest);
    add(digests, 'manifest', asObject(b.rehearsalManifest).manifestDigest);
    add(digests, 'matrix', asObject(reports.matrix).matrixDigest);
    add(digests, 'integrity', asObject(reports.integrity).integrityDigest);
    add(digests, 'schema', asObject(reports.schema).schemaDigest);
    add(digests, 'handoff', asObject(reports.handoff).handoffDigest);
    add(digests, 'dashboard', asObject(reports.dashboard).dashboardDigest);
  }
  if (replay !== undefined) add(digests, 'replay', replay.replayDigest);

  const body: Omit<CoordinatorEvidencePacket, 'packetDigest'> = {
    report: 'phase-230-promotion-coordinator-evidence-packet',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall: blockers.length === 0 ? 'EVIDENCE_COMPLETE' : 'EVIDENCE_INCOMPLETE',
    digests,
    testCommands: EVIDENCE_TEST_COMMANDS,
    humanGates: EVIDENCE_HUMAN_GATES,
    disclaimers: EVIDENCE_DISCLAIMERS,
    blockers,
  };

  if (hasRawPathLeak(body)) {
    const leaked = { ...body, overall: 'EVIDENCE_INCOMPLETE' as const, blockers: [...blockers, 'RAW_PATH_IN_PACKET'] };
    return { ...leaked, packetDigest: digest('phase-230-evidence-packet', JSON.stringify(leaked)) };
  }
  return { ...body, packetDigest: digest('phase-230-evidence-packet', JSON.stringify(body)) };
}

function add(map: Record<string, string>, key: string, value: unknown): void {
  if (isSha256(value)) map[key] = value;
}

function hasRawPathLeak(value: unknown): boolean {
  let leak = false;
  const walk = (v: unknown, key: string | undefined): void => {
    if (leak) return;
    if (typeof v === 'string') {
      if (key === 'disclaimers' || key === 'humanGates' || key === 'testCommands') return; // fixed language
      if (looksLikePath(v)) leak = true;
      return;
    }
    if (Array.isArray(v)) { for (const e of v) walk(e, key); return; }
    if (v && typeof v === 'object') { for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, k); }
  };
  walk(value, undefined);
  return leak;
}

function looksLikePath(s: string): boolean {
  return s.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(s)
    || s.includes('/mnt/')
    || s.includes('\\mnt\\')
    || s.includes('catalog-authority-test-library')
    || /\.(mkv|mp4|m4v|avi|mov|webm)$/i.test(s);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
