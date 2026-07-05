export const OPERATOR_UI_SCREEN_IDS = [
  'overview',
  'catalog-authority',
  'privacy-crypto-shredding',
  'key-custodian-o4-status',
  'reconciler',
  'backup-restore',
  'provider-availability-packets',
  'audit-queue',
  'settings-operator-configuration',
] as const;

export type OperatorUiScreenId = (typeof OPERATOR_UI_SCREEN_IDS)[number];

export const OPERATOR_UI_DISPLAY_FIELD_LABELS = [
  'Item A',
  'Item B',
  'Provider Count',
  'Shred State',
  'Backup Integrity',
  'Reconcile Status',
  'Event Sequence',
  'Packet Count',
  'Review Required',
  'Key State',
  'Custodian Status',
  'Backup Verified',
] as const;

export type OperatorUiDisplayFieldLabel = (typeof OPERATOR_UI_DISPLAY_FIELD_LABELS)[number];

export const OPERATOR_UI_STATUS_LABELS = [
  'Open',
  'Deferred',
  'Verified',
  'Warning',
  'Failed',
  'Blocked',
  'Synced',
  'Static',
  'Count Only',
  'Advisory',
  'Reference Harness',
  'Not Production KMS',
] as const;

export type OperatorUiStatusLabel = (typeof OPERATOR_UI_STATUS_LABELS)[number];

export const OPERATOR_UI_CATEGORY_LABELS = [
  'System Health',
  'Catalog Authority',
  'Privacy Gate',
  'Backup Gate',
  'Reconcile Gate',
  'Provider Availability',
  'Audit Review',
  'Operator Configuration',
  'Redaction Policy',
] as const;

export type OperatorUiCategoryLabel = (typeof OPERATOR_UI_CATEGORY_LABELS)[number];

export const OPERATOR_UI_FORBIDDEN_FIELD_CATEGORIES = [
  'title',
  'externalId',
  'external_id',
  'providerRef',
  'provider_ref',
  'infohash',
  'magnet',
  'credential',
  'token',
  'secret',
  'path',
  'url',
  'poster',
  'artwork',
  'providerName',
  'provider_name',
  'providerLogo',
  'provider_logo',
  'rawPayload',
  'raw_payload',
  'rawLog',
  'raw_log',
  'databaseUrl',
  'database_url',
  'playback',
  'download',
  'stream',
  'library',
  'media',
] as const;

export type OperatorUiForbiddenFieldCategory = (typeof OPERATOR_UI_FORBIDDEN_FIELD_CATEGORIES)[number];

export interface OperatorUiPacketFieldDescriptor {
  readonly label: OperatorUiDisplayFieldLabel;
  readonly statusLabel?: OperatorUiStatusLabel;
  readonly categoryLabel?: OperatorUiCategoryLabel;
}

export interface OperatorUiPacketDescriptor {
  readonly screenId: OperatorUiScreenId;
  readonly fields: readonly OperatorUiPacketFieldDescriptor[];
}

export type OperatorUiPacketValidationIssueCode =
  | 'OPERATOR_UI_PACKET_INVALID_SHAPE'
  | 'OPERATOR_UI_PACKET_INVALID_SCREEN'
  | 'OPERATOR_UI_PACKET_INVALID_FIELD_LIST'
  | 'OPERATOR_UI_PACKET_INVALID_FIELD_SHAPE'
  | 'OPERATOR_UI_PACKET_FORBIDDEN_DESCRIPTOR_KEY'
  | 'OPERATOR_UI_PACKET_FORBIDDEN_FIELD_KEY'
  | 'OPERATOR_UI_PACKET_FORBIDDEN_FIELD_LABEL'
  | 'OPERATOR_UI_PACKET_INVALID_FIELD_LABEL'
  | 'OPERATOR_UI_PACKET_INVALID_STATUS_LABEL'
  | 'OPERATOR_UI_PACKET_INVALID_CATEGORY_LABEL';

export interface OperatorUiPacketValidationIssue {
  readonly code: OperatorUiPacketValidationIssueCode;
  readonly message:
    | 'Descriptor must use the static operator UI packet shape.'
    | 'Screen id is not in the Phase 60 operator UI allowlist.'
    | 'Fields must be a non-empty static list.'
    | 'Field descriptor must use the static operator UI field shape.'
    | 'Descriptor contains a forbidden data category.'
    | 'Field descriptor contains a forbidden data category.'
    | 'Field label matches a forbidden data category.'
    | 'Field label is not in the operator UI allowlist.'
    | 'Status label is not in the operator UI allowlist.'
    | 'Category label is not in the operator UI allowlist.';
}

export type OperatorUiPacketValidationResult =
  | {
      readonly ok: true;
      readonly code: 'OPERATOR_UI_PACKET_ACCEPTED';
      readonly message: 'Operator UI packet descriptor is redaction-safe.';
      readonly issues: readonly [];
    }
  | {
      readonly ok: false;
      readonly code: 'OPERATOR_UI_PACKET_REJECTED';
      readonly message: 'Operator UI packet descriptor is not redaction-safe.';
      readonly issues: readonly OperatorUiPacketValidationIssue[];
    };

const SCREEN_IDS = new Set<string>(OPERATOR_UI_SCREEN_IDS);
const FIELD_LABELS = new Set<string>(OPERATOR_UI_DISPLAY_FIELD_LABELS);
const STATUS_LABELS = new Set<string>(OPERATOR_UI_STATUS_LABELS);
const CATEGORY_LABELS = new Set<string>(OPERATOR_UI_CATEGORY_LABELS);
const DESCRIPTOR_KEYS = new Set(['screenId', 'fields']);
const FIELD_KEYS = new Set(['label', 'statusLabel', 'categoryLabel']);

const ISSUE_MESSAGES: Record<OperatorUiPacketValidationIssueCode, OperatorUiPacketValidationIssue['message']> = {
  OPERATOR_UI_PACKET_INVALID_SHAPE: 'Descriptor must use the static operator UI packet shape.',
  OPERATOR_UI_PACKET_INVALID_SCREEN: 'Screen id is not in the Phase 60 operator UI allowlist.',
  OPERATOR_UI_PACKET_INVALID_FIELD_LIST: 'Fields must be a non-empty static list.',
  OPERATOR_UI_PACKET_INVALID_FIELD_SHAPE: 'Field descriptor must use the static operator UI field shape.',
  OPERATOR_UI_PACKET_FORBIDDEN_DESCRIPTOR_KEY: 'Descriptor contains a forbidden data category.',
  OPERATOR_UI_PACKET_FORBIDDEN_FIELD_KEY: 'Field descriptor contains a forbidden data category.',
  OPERATOR_UI_PACKET_FORBIDDEN_FIELD_LABEL: 'Field label matches a forbidden data category.',
  OPERATOR_UI_PACKET_INVALID_FIELD_LABEL: 'Field label is not in the operator UI allowlist.',
  OPERATOR_UI_PACKET_INVALID_STATUS_LABEL: 'Status label is not in the operator UI allowlist.',
  OPERATOR_UI_PACKET_INVALID_CATEGORY_LABEL: 'Category label is not in the operator UI allowlist.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isForbiddenCategory(value: string): boolean {
  const normalized = normalize(value);
  return OPERATOR_UI_FORBIDDEN_FIELD_CATEGORIES.some((category) => normalized.includes(normalize(category)));
}

function issue(code: OperatorUiPacketValidationIssueCode): OperatorUiPacketValidationIssue {
  return { code, message: ISSUE_MESSAGES[code] };
}

export function validateOperatorUiPacketDescriptor(input: unknown): OperatorUiPacketValidationResult {
  const issues: OperatorUiPacketValidationIssue[] = [];

  if (!isRecord(input)) {
    issues.push(issue('OPERATOR_UI_PACKET_INVALID_SHAPE'));
    return reject(issues);
  }

  for (const key of Object.keys(input).sort()) {
    if (isForbiddenCategory(key)) issues.push(issue('OPERATOR_UI_PACKET_FORBIDDEN_DESCRIPTOR_KEY'));
    else if (!DESCRIPTOR_KEYS.has(key)) issues.push(issue('OPERATOR_UI_PACKET_INVALID_SHAPE'));
  }

  if (typeof input.screenId !== 'string' || !SCREEN_IDS.has(input.screenId)) {
    issues.push(issue('OPERATOR_UI_PACKET_INVALID_SCREEN'));
  }

  if (!Array.isArray(input.fields) || input.fields.length === 0) {
    issues.push(issue('OPERATOR_UI_PACKET_INVALID_FIELD_LIST'));
  } else {
    for (const field of input.fields) {
      if (!isRecord(field)) {
        issues.push(issue('OPERATOR_UI_PACKET_INVALID_FIELD_SHAPE'));
        continue;
      }

      for (const key of Object.keys(field).sort()) {
        if (isForbiddenCategory(key)) issues.push(issue('OPERATOR_UI_PACKET_FORBIDDEN_FIELD_KEY'));
        else if (!FIELD_KEYS.has(key)) issues.push(issue('OPERATOR_UI_PACKET_INVALID_FIELD_SHAPE'));
      }

      if (typeof field.label !== 'string') {
        issues.push(issue('OPERATOR_UI_PACKET_INVALID_FIELD_LABEL'));
      } else if (isForbiddenCategory(field.label)) {
        issues.push(issue('OPERATOR_UI_PACKET_FORBIDDEN_FIELD_LABEL'));
      } else if (!FIELD_LABELS.has(field.label)) {
        issues.push(issue('OPERATOR_UI_PACKET_INVALID_FIELD_LABEL'));
      }

      if (field.statusLabel !== undefined && (typeof field.statusLabel !== 'string' || !STATUS_LABELS.has(field.statusLabel))) {
        issues.push(issue('OPERATOR_UI_PACKET_INVALID_STATUS_LABEL'));
      }

      if (field.categoryLabel !== undefined && (typeof field.categoryLabel !== 'string' || !CATEGORY_LABELS.has(field.categoryLabel))) {
        issues.push(issue('OPERATOR_UI_PACKET_INVALID_CATEGORY_LABEL'));
      }
    }
  }

  if (issues.length > 0) return reject(issues);
  return {
    ok: true,
    code: 'OPERATOR_UI_PACKET_ACCEPTED',
    message: 'Operator UI packet descriptor is redaction-safe.',
    issues: [],
  };
}

function reject(issues: readonly OperatorUiPacketValidationIssue[]): OperatorUiPacketValidationResult {
  return {
    ok: false,
    code: 'OPERATOR_UI_PACKET_REJECTED',
    message: 'Operator UI packet descriptor is not redaction-safe.',
    issues,
  };
}

export const OPERATOR_UI_EXAMPLE_PACKET_DESCRIPTORS: readonly OperatorUiPacketDescriptor[] = [
  {
    screenId: 'overview',
    fields: [
      { label: 'Reconcile Status', statusLabel: 'Synced', categoryLabel: 'System Health' },
      { label: 'Backup Integrity', statusLabel: 'Verified', categoryLabel: 'Backup Gate' },
      { label: 'Provider Count', statusLabel: 'Count Only', categoryLabel: 'Provider Availability' },
      { label: 'Review Required', statusLabel: 'Warning', categoryLabel: 'Audit Review' },
    ],
  },
  {
    screenId: 'catalog-authority',
    fields: [
      { label: 'Item A', categoryLabel: 'Catalog Authority' },
      { label: 'Item B', categoryLabel: 'Catalog Authority' },
      { label: 'Provider Count', statusLabel: 'Advisory', categoryLabel: 'Provider Availability' },
      { label: 'Shred State', categoryLabel: 'Privacy Gate' },
      { label: 'Reconcile Status', statusLabel: 'Synced', categoryLabel: 'Reconcile Gate' },
    ],
  },
  {
    screenId: 'privacy-crypto-shredding',
    fields: [
      { label: 'Key State', statusLabel: 'Open', categoryLabel: 'Privacy Gate' },
      { label: 'Custodian Status', statusLabel: 'Reference Harness', categoryLabel: 'Privacy Gate' },
      { label: 'Shred State', statusLabel: 'Deferred', categoryLabel: 'Privacy Gate' },
    ],
  },
  {
    screenId: 'key-custodian-o4-status',
    fields: [
      { label: 'Custodian Status', statusLabel: 'Not Production KMS', categoryLabel: 'Privacy Gate' },
      { label: 'Key State', statusLabel: 'Deferred', categoryLabel: 'Privacy Gate' },
      { label: 'Review Required', statusLabel: 'Open', categoryLabel: 'Audit Review' },
    ],
  },
  {
    screenId: 'reconciler',
    fields: [
      { label: 'Reconcile Status', statusLabel: 'Synced', categoryLabel: 'Reconcile Gate' },
      { label: 'Event Sequence', categoryLabel: 'Reconcile Gate' },
      { label: 'Review Required', statusLabel: 'Blocked', categoryLabel: 'Audit Review' },
    ],
  },
  {
    screenId: 'backup-restore',
    fields: [
      { label: 'Backup Integrity', statusLabel: 'Verified', categoryLabel: 'Backup Gate' },
      { label: 'Backup Verified', statusLabel: 'Verified', categoryLabel: 'Backup Gate' },
      { label: 'Review Required', statusLabel: 'Open', categoryLabel: 'Audit Review' },
    ],
  },
  {
    screenId: 'provider-availability-packets',
    fields: [
      { label: 'Provider Count', statusLabel: 'Count Only', categoryLabel: 'Provider Availability' },
      { label: 'Packet Count', statusLabel: 'Count Only', categoryLabel: 'Provider Availability' },
      { label: 'Review Required', statusLabel: 'Advisory', categoryLabel: 'Audit Review' },
    ],
  },
  {
    screenId: 'audit-queue',
    fields: [
      { label: 'Event Sequence', categoryLabel: 'Audit Review' },
      { label: 'Review Required', statusLabel: 'Warning', categoryLabel: 'Audit Review' },
      { label: 'Packet Count', statusLabel: 'Static', categoryLabel: 'Audit Review' },
    ],
  },
  {
    screenId: 'settings-operator-configuration',
    fields: [
      { label: 'Key State', statusLabel: 'Deferred', categoryLabel: 'Operator Configuration' },
      { label: 'Custodian Status', statusLabel: 'Reference Harness', categoryLabel: 'Operator Configuration' },
      { label: 'Review Required', statusLabel: 'Open', categoryLabel: 'Redaction Policy' },
    ],
  },
] as const;
