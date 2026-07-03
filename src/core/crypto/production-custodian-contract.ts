export type ProductionCustodianBoundary = 'external-managed' | 'external-self-hosted' | 'in-app-reference' | 'unknown';
export type ProductionCustodianRedactionReview = 'passed' | 'pending' | 'failed' | 'unknown';
export type ProductionCustodianFindingLevel = 'pass' | 'warn' | 'fail';

export interface ProductionCustodianDescriptor {
  readonly adapterName?: string;
  readonly adapterVersion?: string;
  readonly custodyBoundary?: ProductionCustodianBoundary;
  readonly implementsKeyCustodian?: boolean;
  readonly attestationFormatDocumented?: boolean;
  readonly durableTombstones?: boolean;
  readonly appCannotForgeAttestation?: boolean;
  readonly failClosedSemanticsDocumented?: boolean;
  readonly liveValidationEvidenceLabel?: string;
  readonly contractKitCommandLabel?: string;
  readonly redactionReviewStatus?: ProductionCustodianRedactionReview;
  readonly noRawSecretsInEvidence?: boolean;
  readonly backupRestoreFailClosedEvidence?: boolean;
}

export interface ProductionCustodianContractFinding {
  readonly level: ProductionCustodianFindingLevel;
  readonly code: string;
  readonly field?: keyof ProductionCustodianDescriptor | 'descriptor';
  readonly message: string;
}

export interface ProductionCustodianValidationReport {
  readonly report: 'phase-28-production-custodian-contract';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly closesO4: false;
  readonly findings: readonly ProductionCustodianContractFinding[];
}

export const PRODUCTION_CUSTODIAN_CONTRACT = {
  phase: 28,
  name: 'Production Custodian Adapter Contract',
  status: {
    o4: 'open/deferred',
    o5: 'open/deferred',
    fileCustodian: 'reference-harness-not-production-kms',
  },
  requiredKeyCustodianInvariants: [
    'provision is idempotent for identical operationId/itemId/epoch inputs and rejects operationId reuse with different inputs',
    'commitProvision is idempotent after activation and never reactivates a destroyed key',
    'destroy is idempotent on operationId and keyId and returns a stable durable receipt',
    'destroyed is terminal: status is destroyed, get fails closed, and no later path makes the key readable',
    'status returns only provisional, active, destroyed, or not_found; transport/service failures are thrown errors',
    'get fails closed for unknown, provisional, destroyed, wrong-epoch, corrupt, unauthorized, unavailable, or ambiguous keys',
    'listStaleProvisioning exposes provisional keys for reconciliation and excludes active and destroyed keys',
    'destruction receipts are durable non-secret tombstones and stable across retries',
    'attestation covers the destruction statement under a secret the app cannot forge in production',
    'lost acknowledgements are safe: retries observe idempotent results instead of duplicating or resurrecting state',
  ] as const,
  requiredCapabilities: [
    'external custody boundary outside the app process and app database',
    'KeyCustodian conformance with the shared contract kit or stricter superset',
    'operator-run live validation evidence labeled outside CI',
    'documented deterministic attestation format and verification path',
    'durable tombstones for destroyed keys',
    'redaction-reviewed evidence and failure output',
    'backup/restore fail-closed evidence when custodian prerequisites are absent',
  ] as const,
  forbiddenBehaviors: [
    'using FileCustodian or any in-process reference harness as production KMS',
    'claiming O4 closed from metadata, local tests, or reference harness coverage alone',
    'returning synthetic domain statuses for transport, auth, timeout, quorum, rate-limit, or integrity failures',
    'falling back to local key material, stale cache, another epoch, or another key after custodian failure',
    'logging or reporting raw secrets, URLs, tokens, key material, identity, provider refs, media titles, database URLs, secret paths, or artifact contents',
    'requiring live network, cloud services, Docker, production DB access, vendor SDKs, or operator credentials in deterministic CI',
  ] as const,
  evidenceRequirements: [
    'adapter name/version and non-secret deployment boundary summary',
    'contract kit command label and deterministic pass/fail summary',
    'operator-run live validation label covering provision, commit, get, destroy, retry, stale provisioning, lost acknowledgements, and fail-closed reads',
    'attestation format documentation and app-non-forgeability statement',
    'redaction review status for logs, errors, command output, and evidence bundle',
    'backup/restore evidence that main DB backups exclude custodian key material and restored systems fail closed until prerequisites exist',
  ] as const,
  redactionRequirements: [
    'emit fixed finding codes and field names rather than descriptor values',
    'never echo raw descriptor strings in validation output',
    'bucket hostile or suspicious input into generic findings',
    'omit secrets, URLs, tokens, key material, database URLs, identity, provider refs, media titles, Jellyfin ids/tokens/handles, secret paths, and artifact contents',
  ] as const,
  failClosedSemantics: [
    'unsupported modes fail closed during config parsing and adapter creation',
    'ambiguous remote state is retried with the same operation id',
    'read paths fail closed when custody state is unavailable or ambiguous',
    'destruction and tombstone checks prefer refusal over best-effort success',
  ] as const,
  trustBoundaryAssertions: [
    'the app process does not hold the completion secret in production',
    'the app database stores ciphertext, non-secret key ids, status references, and receipt metadata only',
    'the external custodian owns DEK lifecycle state, wrapping or storage, tombstones, attestation signing, and managed key material',
    'operator evidence contains only redacted statuses, labels, counts, timestamps, and approved opaque identifiers',
  ] as const,
} as const;

const EXTERNAL_BOUNDARIES: ReadonlySet<ProductionCustodianBoundary> = new Set(['external-managed', 'external-self-hosted']);

const REQUIRED_TRUE_FIELDS = [
  'implementsKeyCustodian',
  'attestationFormatDocumented',
  'durableTombstones',
  'appCannotForgeAttestation',
  'failClosedSemanticsDocumented',
  'noRawSecretsInEvidence',
  'backupRestoreFailClosedEvidence',
] as const;

export function validateProductionCustodianDescriptor(descriptor: ProductionCustodianDescriptor): ProductionCustodianValidationReport {
  const findings: ProductionCustodianContractFinding[] = [];

  if (containsReferenceHarnessClaim(descriptor)) {
    findings.push(fail(
      'REFERENCE_HARNESS_NOT_PRODUCTION_KMS',
      'descriptor',
      'Reference harnesses, including FileCustodian, cannot satisfy the production custodian boundary.',
    ));
    findings.push(warn(
      'REFERENCE_HARNESS_DESCRIPTOR_REVIEW_REQUIRED',
      'descriptor',
      'Descriptor text appears to mention a reference harness; review the adapter boundary before collecting O4 evidence.',
    ));
  }

  if (!EXTERNAL_BOUNDARIES.has(descriptor.custodyBoundary ?? 'unknown')) {
    findings.push(fail(
      'EXTERNAL_BOUNDARY_REQUIRED',
      'custodyBoundary',
      'O4 requires custody outside the app process and app database.',
    ));
  } else {
    findings.push(pass('EXTERNAL_BOUNDARY_DECLARED', 'custodyBoundary', 'Descriptor declares an external custody boundary.'));
  }

  for (const field of REQUIRED_TRUE_FIELDS) {
    if (descriptor[field] === true) findings.push(pass(`${toCode(field)}_DECLARED`, field, `${field} is declared.`));
    else findings.push(fail(`${toCode(field)}_REQUIRED`, field, `${field} must be true before O4 evidence can be reviewed.`));
  }

  if (hasNonEmptyLabel(descriptor.liveValidationEvidenceLabel)) {
    findings.push(pass('LIVE_VALIDATION_LABEL_PRESENT', 'liveValidationEvidenceLabel', 'Live validation evidence is labeled for operator review.'));
  } else {
    findings.push(fail('LIVE_VALIDATION_LABEL_REQUIRED', 'liveValidationEvidenceLabel', 'O4 requires an operator-run live validation evidence label.'));
  }

  if (hasNonEmptyLabel(descriptor.contractKitCommandLabel)) {
    findings.push(pass('CONTRACT_KIT_COMMAND_LABEL_PRESENT', 'contractKitCommandLabel', 'Contract kit command evidence is labeled.'));
  } else {
    findings.push(fail('CONTRACT_KIT_COMMAND_LABEL_REQUIRED', 'contractKitCommandLabel', 'A contract kit command label is required.'));
  }

  if (descriptor.redactionReviewStatus === 'passed') {
    findings.push(pass('REDACTION_REVIEW_PASSED', 'redactionReviewStatus', 'Redaction review is marked passed.'));
  } else if (descriptor.redactionReviewStatus === 'failed') {
    findings.push(fail('REDACTION_REVIEW_FAILED', 'redactionReviewStatus', 'Redaction review must pass before O4 evidence can be reviewed.'));
  } else {
    findings.push(fail('REDACTION_REVIEW_REQUIRED', 'redactionReviewStatus', 'A passed redaction review is required before O4 evidence can be reviewed.'));
  }

  if (!findings.some((finding) => finding.level === 'fail')) {
    findings.push(warn(
      'O4_STILL_REQUIRES_REVIEW',
      'descriptor',
      'Descriptor metadata is complete, but O4 remains open/deferred until separate reviewer and operator acceptance.',
    ));
  }

  findings.push(warn('O5_REMAINS_DEFERRED', 'descriptor', 'O5 managed KEK custody and scheduling remain open/deferred.'));

  return {
    report: 'phase-28-production-custodian-contract',
    version: 1,
    redactionSafe: true,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    closesO4: false,
    findings,
  };
}

function hasNonEmptyLabel(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function containsReferenceHarnessClaim(value: unknown): boolean {
  if (typeof value === 'string') return /(filecustodian|inmemorycustodian|reference\s+harness)/i.test(value);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some(containsReferenceHarnessClaim);
}

function toCode(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => `_${ch}`).toUpperCase();
}

function pass(code: string, field: ProductionCustodianContractFinding['field'], message: string): ProductionCustodianContractFinding {
  return { level: 'pass', code, field, message };
}

function warn(code: string, field: ProductionCustodianContractFinding['field'], message: string): ProductionCustodianContractFinding {
  return { level: 'warn', code, field, message };
}

function fail(code: string, field: ProductionCustodianContractFinding['field'], message: string): ProductionCustodianContractFinding {
  return { level: 'fail', code, field, message };
}
