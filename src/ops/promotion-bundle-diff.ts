import { createHash } from 'node:crypto';

// Local, non-live bundle diff/audit. It compares two fixture evidence bundles by their per-artifact and
// per-report digests only, producing a redaction-safe diff (component names, booleans, and digests —
// never raw paths or titles). It reads parsed JSON only; it performs no promotion, never touches the
// real Movies root, never contacts Jellyfin, and authorizes nothing live.

export interface BundleDiffReport {
  readonly report: 'phase-230-promotion-bundle-diff';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly aValid: boolean;
  readonly bValid: boolean;
  readonly identical: boolean;
  readonly components: readonly { readonly component: string; readonly aDigest?: string; readonly bDigest?: string; readonly equal: boolean }[];
  readonly differingComponents: readonly string[];
  readonly diffDigest: string;
}

// component -> accessor returning its self-digest within a bundle.
const COMPONENTS: Array<{ name: string; get: (b: Record<string, unknown>) => unknown }> = [
  { name: 'bundle', get: (b) => b.bundleDigest },
  { name: 'manifest', get: (b) => asObject(b.rehearsalManifest).manifestDigest },
  { name: 'approvalEvidence', get: (b) => art(b, 'approvalEvidence').evidenceDigest },
  { name: 'promotionEvidence', get: (b) => art(b, 'promotionEvidence').evidenceDigest },
  { name: 'evidenceReview', get: (b) => art(b, 'evidenceReview').reviewDigest },
  { name: 'readiness', get: (b) => art(b, 'readiness').checklistDigest },
  { name: 'acceptancePacket', get: (b) => art(b, 'acceptancePacket').sealDigest },
  { name: 'integrity', get: (b) => rep(b, 'integrity').integrityDigest },
  { name: 'schema', get: (b) => rep(b, 'schema').schemaDigest },
  { name: 'matrix', get: (b) => rep(b, 'matrix').matrixDigest },
  { name: 'handoff', get: (b) => rep(b, 'handoff').handoffDigest },
  { name: 'dashboard', get: (b) => rep(b, 'dashboard').dashboardDigest },
];

export function diffFixtureBundles(aCandidate: unknown, bCandidate: unknown): BundleDiffReport {
  const a = asObject(aCandidate);
  const b = asObject(bCandidate);
  const aValid = a.report === 'phase-230-promotion-fixture-evidence-bundle';
  const bValid = b.report === 'phase-230-promotion-fixture-evidence-bundle';

  const components: BundleDiffReport['components'] = COMPONENTS.map(({ name, get }) => {
    const aDigest = aValid ? asSha256(get(a)) : undefined;
    const bDigest = bValid ? asSha256(get(b)) : undefined;
    const equal = aDigest !== undefined && bDigest !== undefined && aDigest === bDigest;
    return { component: name, ...(aDigest ? { aDigest } : {}), ...(bDigest ? { bDigest } : {}), equal };
  });
  const differingComponents = components.filter((c) => !c.equal).map((c) => c.component);
  const identical = aValid && bValid && differingComponents.length === 0;

  const withoutDigest: Omit<BundleDiffReport, 'diffDigest'> = {
    report: 'phase-230-promotion-bundle-diff',
    version: 1,
    redactionSafe: true,
    aValid,
    bValid,
    identical,
    components,
    differingComponents,
  };
  return { ...withoutDigest, diffDigest: digest('phase-230-bundle-diff', JSON.stringify(withoutDigest)) };
}

function art(b: Record<string, unknown>, key: string): Record<string, unknown> {
  return asObject(asObject(b.artifacts)[key]);
}
function rep(b: Record<string, unknown>, key: string): Record<string, unknown> {
  return asObject(asObject(b.reports)[key]);
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asSha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
