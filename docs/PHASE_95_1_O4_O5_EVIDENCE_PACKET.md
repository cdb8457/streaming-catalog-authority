# Phase 95.1 - O4/O5 Evidence Packet

Phase 95.1 defines a docs-only O4/O5 readiness packet shape. The packet is an index of
redaction-safe evidence labels and descriptor preflight reports. It does not add a CLI, fixture,
adapter, cloud SDK, vendor SDK, HTTP service, daemon, scheduler, provider integration, media-server
workflow, UI, network call, Docker requirement, or runtime behavior.

This packet does not close O4 or O5. It only tells a reviewer where the existing O4 and O5 descriptor
preflight evidence should be found, and what labels must be present before a later gate review can
begin.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Source Preflights

The packet references existing preflight semantics rather than creating a new validator:

- O4 production custodian descriptor preflight:
  - `docs/PHASE_28_PRODUCTION_CUSTODIAN_CONTRACT.md`
  - `docs/PHASE_29_CUSTODIAN_EVIDENCE_PREFLIGHT.md`
  - `npm run ops:custodian-evidence-preflight -- -- <descriptor.json> --json`
- O5 managed KEK custody descriptor preflight:
  - `docs/PHASE_17_KEK_ROTATION_READINESS.md`
  - `docs/PHASE_30_KEK_EVIDENCE_PREFLIGHT.md`
  - `npm run ops:kek-evidence-preflight -- -- <descriptor.json> --json`
- Non-mutating KEK rewrap preflight:
  - `npm run ops:rewrap-kek -- --plan --json`

The packet itself is not a command input. If a future phase adds a packet CLI, it must stay static,
offline, redaction-safe, and descriptor-only.

## Evidence Label Checklist

The packet should include labels only, not contents.

Required shared labels:

- `packetLabel`: a non-secret operator label for this packet.
- `scopeLabel`: a label confirming this is O4/O5 security hardening only.
- `catalogDeploymentEvidenceLabel`: a label for catalog deployment readiness evidence.
- `doctorEvidenceLabel`: a label for a recent passing `ops:doctor` report.
- `backupEvidenceLabel`: a label for encrypted backup and verify evidence.
- `restoreOrRehearsalEvidenceLabel`: a label for restore rehearsal or an explicit manual deferral.
- `redactionReviewLabel`: a label for a reviewer/operator redaction check.
- `residualRiskLabel`: a label for accepted or unresolved residual risk.

Required O4 labels:

- `custodianDescriptorLabel`: the reviewed O4 descriptor label.
- `custodianPreflightReportLabel`: the Phase 29 preflight report label.
- `contractKitEvidenceLabel`: the contract-kit or stricter adapter-specific validation label.
- `liveCustodianEvidenceLabel`: the operator-run live validation label, or an explicit deferred label.
- `attestationFormatLabel`: the non-secret attestation/tombstone format label.
- `backupRestoreFailClosedLabel`: the evidence label showing restored systems fail closed until
  external custodian prerequisites are supplied.

Required O5 labels:

- `kekDescriptorLabel`: the reviewed O5 descriptor label.
- `kekPreflightReportLabel`: the Phase 30 preflight report label.
- `rewrapPlanEvidenceLabel`: the non-mutating `ops:rewrap-kek -- --plan --json` label.
- `rotationRecordLabel`: the manual or managed rotation record label.
- `custodyRunbookLabel`: the KEK custody and backup-passphrase custody runbook label.
- `scheduleAndAlertLabel`: the rotation schedule and alert-triage label.

## Redaction Rules

The packet must not include:

- KEKs, DEKs, wrapping keys, private keys, age identities, passphrases, API keys, bearer tokens, or
  credentials;
- secret file contents, secret paths, environment dumps, database URLs, connection strings, raw logs,
  command output blobs, backup contents, ciphertext, tombstone contents, receipt values, or artifact
  contents;
- provider refs, media titles, raw identity values, Jellyfin/Plex identifiers, provider/debrid
  service identifiers, or live service URLs.

The packet should use labels like `custodian-preflight-20260707-redacted` rather than paths or raw
values. A label can point the operator to evidence stored outside the committed repo, but the packet
must not embed that evidence.

## Redaction-Safe O4 Example

```json
{
  "packetLabel": "o4-o5-readiness-20260707-redacted",
  "scopeLabel": "security-hardening-only",
  "catalogDeploymentEvidenceLabel": "unraid-catalog-foundation-20260707-redacted",
  "doctorEvidenceLabel": "doctor-20260707-095336-redacted",
  "backupEvidenceLabel": "backup-encrypt-verify-20260707-095338-redacted",
  "restoreOrRehearsalEvidenceLabel": "restore-rehearsal-20260707-redacted",
  "redactionReviewLabel": "redaction-review-pending",
  "residualRiskLabel": "o4-o5-deferred-risk-accepted-20260707-redacted",
  "o4": {
    "status": "open/deferred",
    "closesO4": false,
    "custodianDescriptorLabel": "custodian-descriptor-redacted",
    "custodianPreflightReportLabel": "phase-29-custodian-preflight-redacted",
    "contractKitEvidenceLabel": "contract-kit-review-pending",
    "liveCustodianEvidenceLabel": "live-custodian-validation-deferred",
    "attestationFormatLabel": "attestation-format-design-pending",
    "backupRestoreFailClosedLabel": "restore-fail-closed-evidence-pending"
  }
}
```

This O4 example is ready to index evidence labels only. It is not proof of a real managed custodian
and cannot close O4.

## Redaction-Safe O5 Example

```json
{
  "packetLabel": "o4-o5-readiness-20260707-redacted",
  "scopeLabel": "security-hardening-only",
  "catalogDeploymentEvidenceLabel": "unraid-catalog-foundation-20260707-redacted",
  "doctorEvidenceLabel": "doctor-20260707-095336-redacted",
  "backupEvidenceLabel": "backup-encrypt-verify-20260707-095338-redacted",
  "restoreOrRehearsalEvidenceLabel": "restore-rehearsal-20260707-redacted",
  "redactionReviewLabel": "redaction-review-pending",
  "residualRiskLabel": "o4-o5-deferred-risk-accepted-20260707-redacted",
  "o5": {
    "status": "open/deferred",
    "closesO5": false,
    "kekDescriptorLabel": "kek-custody-descriptor-redacted",
    "kekPreflightReportLabel": "phase-30-kek-preflight-redacted",
    "rewrapPlanEvidenceLabel": "kek-rewrap-plan-20260707-095349-redacted",
    "rotationRecordLabel": "rotation-record-pending",
    "custodyRunbookLabel": "custody-runbook-pending",
    "scheduleAndAlertLabel": "schedule-alert-triage-pending"
  }
}
```

This O5 example is ready to index evidence labels only. It does not prove managed KEK custody, does
not install or verify scheduling, does not rotate keys, and cannot close O5.

## Review Semantics

Reviewer readiness means:

- required labels are present;
- descriptor preflight reports were generated by the Phase 29 and Phase 30 commands;
- output and evidence labels are redaction-safe;
- missing live custodian, managed KEK custody, rotation automation, or restore fail-closed evidence is
  explicitly labeled as pending/deferred.

Reviewer readiness does not mean:

- production readiness;
- managed custodian readiness;
- managed KEK custody readiness;
- launch approval;
- O4 closure;
- O5 closure.

## Authorization Boundary

Before any implementation follows this packet, require a separate operator decision for:

- chosen O4 custodian direction;
- chosen O5 custody direction;
- target Unraid deployment mode;
- whether operator-run commands may contact a live custodian service;
- which evidence labels are required before a gate can close.

Until that decision exists, this phase remains documentation and static guard work only.
