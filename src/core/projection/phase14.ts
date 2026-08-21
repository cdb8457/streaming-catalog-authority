// Projection Phase 14 — the required operator preflight when the live tranche cannot enter.
// Pure, boolean-only and value-silent: this module cannot contact or identify an operator resource.

export const PHASE14_CLAIMS = Object.freeze([
  'P9-2', 'P9-3', 'P9-5', 'P9-11', 'P11-R1', 'P11-R2', 'P11-R4', 'P11-R3',
] as const);

export type Phase14Claim = typeof PHASE14_CLAIMS[number];

export const PHASE14_WINDOWS = Object.freeze([
  'operator window: worker, both approved source shapes, and all three attached media servers available',
  'retention window: the entitled content remains available from the configured NNTP provider',
  'natural-outage window: required only for P11-R3 and never induced by this product',
] as const);

export const PHASE14_CONFIRMATION_IDS = Object.freeze([
  'phase13Go',
  'phase13ZeroSkips',
  'sabnzbdRunning',
  'nntpConfiguredInWorker',
  'dedicatedCategory',
  'incompleteDirectory',
  'completeDirectory',
  'entitledSource',
  'expectedFailureSource',
  'completeDirectoryUnderMediaRoot',
  'plexAttached',
  'jellyfinAttached',
  'embyAttached',
] as const);

export type Phase14ConfirmationId = typeof PHASE14_CONFIRMATION_IDS[number];
export type Phase14Descriptor = Partial<Readonly<Record<Phase14ConfirmationId, boolean>>>;

export interface Phase14Requirement {
  readonly id: Phase14ConfirmationId;
  readonly requiredShape: string;
  readonly purpose: string;
  readonly unblocks: readonly Phase14Claim[];
  readonly confirmation: string;
}

const ALL = PHASE14_CLAIMS;
export const PHASE14_REQUIREMENTS: readonly Phase14Requirement[] = Object.freeze([
  { id: 'phase13Go', requiredShape: 'a Phase 13 GO record from one frozen candidate', purpose: 'the inherited prerequisite', unblocks: ALL, confirmation: 'confirm the GO record exists; provide no record contents here' },
  { id: 'phase13ZeroSkips', requiredShape: 'the Phase 13 GO record reports zero skips', purpose: 'a skipped provider run is not a prerequisite', unblocks: ALL, confirmation: 'confirm its skip count is zero' },
  { id: 'sabnzbdRunning', requiredShape: 'an operator-controlled SABnzbd worker is already running', purpose: 'the real worker boundary', unblocks: ['P9-2', 'P9-3', 'P9-5', 'P11-R2'], confirmation: 'confirm readiness in the worker UI without copying its address' },
  { id: 'nntpConfiguredInWorker', requiredShape: 'a real NNTP provider is already configured inside the worker', purpose: 'provider contact remains operator-owned', unblocks: ['P9-2', 'P9-3', 'P9-5'], confirmation: 'confirm the worker connection test succeeds; disclose no provider or credential' },
  { id: 'dedicatedCategory', requiredShape: 'one dedicated category', purpose: 'isolated admission and cleanup', unblocks: ['P9-2', 'P11-R2'], confirmation: 'confirm a dedicated category exists without copying its name' },
  { id: 'incompleteDirectory', requiredShape: 'a category-specific incomplete directory', purpose: 'prove in-flight files do not publish', unblocks: ['P9-2', 'P11-R2'], confirmation: 'confirm the worker assigns one; disclose no path' },
  { id: 'completeDirectory', requiredShape: 'a category-specific complete directory', purpose: 'the admission boundary', unblocks: ['P9-3', 'P11-R1'], confirmation: 'confirm the worker assigns one; disclose no path' },
  { id: 'entitledSource', requiredShape: 'one operator-approved NZB or indexer reference', purpose: 'the successful real sequence', unblocks: ['P9-3', 'P9-5', 'P11-R1'], confirmation: 'confirm entitlement and availability; disclose no reference' },
  { id: 'expectedFailureSource', requiredShape: 'one entitled source expected to fail or remain incomplete', purpose: 'refusal and lifecycle evidence', unblocks: ['P9-2', 'P11-R2'], confirmation: 'confirm the expected disposition; disclose no reference' },
  { id: 'completeDirectoryUnderMediaRoot', requiredShape: 'completed output already beneath the served media root', purpose: 'one mixed published generation', unblocks: ['P11-R1'], confirmation: 'confirm containment locally; disclose no path' },
  { id: 'plexAttached', requiredShape: 'real Plex bind attached before the appliance mount', purpose: 'first real reader', unblocks: ['P11-R1', 'P11-R4'], confirmation: 'confirm the existing bind; change no media-server configuration' },
  { id: 'jellyfinAttached', requiredShape: 'real Jellyfin bind attached before the appliance mount', purpose: 'second real reader', unblocks: ['P11-R1', 'P11-R4'], confirmation: 'confirm the existing bind; change no media-server configuration' },
  { id: 'embyAttached', requiredShape: 'real Emby bind attached before the appliance mount', purpose: 'third real reader', unblocks: ['P11-R1', 'P11-R4'], confirmation: 'confirm the existing bind; change no media-server configuration' },
]);

export class Phase14DescriptorError extends Error {
  constructor(readonly code: 'NOT_AN_OBJECT' | 'UNKNOWN_FIELD' | 'NON_BOOLEAN') {
    super(`Phase 14 descriptor refused: ${code}`);
  }
}

export function parsePhase14Descriptor(input: unknown): Phase14Descriptor {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Phase14DescriptorError('NOT_AN_OBJECT');
  }
  const allowed = new Set<string>(PHASE14_CONFIRMATION_IDS);
  const parsed: Partial<Record<Phase14ConfirmationId, boolean>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) throw new Phase14DescriptorError('UNKNOWN_FIELD');
    if (typeof value !== 'boolean') throw new Phase14DescriptorError('NON_BOOLEAN');
    parsed[key as Phase14ConfirmationId] = value;
  }
  return Object.freeze(parsed);
}

export interface Phase14PreflightReport {
  readonly report: 'projection-phase14-operator-preflight';
  readonly status: 'READY' | 'BLOCKED';
  readonly phase14Entered: false;
  readonly contactsMade: 0;
  readonly valuesEchoed: false;
  readonly claimsClosed: readonly [];
  readonly openClaims: readonly Phase14Claim[];
  readonly missing: readonly Phase14Requirement[];
  readonly windows: readonly string[];
  readonly meaning: string;
}

export function buildPhase14Preflight(input: unknown = {}): Phase14PreflightReport {
  const descriptor = parsePhase14Descriptor(input);
  const missing = PHASE14_REQUIREMENTS.filter((requirement) => descriptor[requirement.id] !== true);
  const ready = missing.length === 0;
  return Object.freeze({
    report: 'projection-phase14-operator-preflight',
    status: ready ? 'READY' : 'BLOCKED',
    phase14Entered: false,
    contactsMade: 0,
    valuesEchoed: false,
    claimsClosed: Object.freeze([]) as readonly [],
    openClaims: PHASE14_CLAIMS,
    missing: Object.freeze(missing),
    windows: PHASE14_WINDOWS,
    meaning: ready
      ? 'all required shapes are confirmed; separate live-run authorization is still required'
      : 'Phase 14 does not run or partially run while any required shape is missing',
  });
}
