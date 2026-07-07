# Phase 95.3 - O5 Managed KEK Custody Runbook

Phase 95.3 designs managed KEK custody and rotation operations without changing runtime defaults. It
does not add a scheduler, daemon, cloud SDK, vendor SDK, managed secret-store client, HTTP service,
network client, mutating rewrap automation, Unraid service installation, provider integration,
media-server workflow, UI, or runtime behavior.

This phase does not close O5. It defines the operator runbook and evidence labels required before a
later implementation can choose managed custody or automation.

O5 remains open/deferred. O4 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Runbook Goal

The O5 runbook must prove that KEK custody and rotation can be operated without exposing key material
or coupling secrets to catalog DB backups. It must preserve the current explicit, operator-controlled
rewrap flow:

- run `ops:rewrap-kek -- --plan --json` first;
- inspect only redaction-safe aggregate counts;
- quiesce catalog writes before mutation;
- run mutating rewrap only after explicit approval;
- remove previous KEK material from normal runtime after successful mutation;
- retain only labels and redacted reports as evidence.

## Custody Direction Options

No option is selected in this phase.

### Option A - Operator-Held Secret Media

The operator keeps current and previous KEKs on independent secret media or a password manager outside
the catalog host, catalog DB backups, and committed evidence.

Required controls:

- current KEK is available to runtime only through explicit secret-file staging;
- previous KEK is staged only for rotation windows;
- backup encryption passphrase custody is tracked separately from KEK custody;
- local evidence records labels only, not media names, file paths, passphrases, or key contents;
- recovery requires operator-held material, not catalog DB backups alone.

### Option B - Managed Secret Store

A managed secret store owns KEK custody while the catalog host receives only explicit runtime access.
This option is future-gated because it may require SDKs, service credentials, account boundaries, and
operator-run live validation.

Required controls:

- no managed secret-store dependency in CI;
- credentials never appear in repo, `.env`, command output, logs, evidence, or DB backups;
- service/account identifiers are evidence labels only;
- unavailable, unauthorized, throttled, or ambiguous access fails closed;
- restore rehearsal proves the catalog DB cannot decrypt until managed custody prerequisites are
  supplied.

### Option C - External Custodian-Owned KEK

A future external custodian owns KEK wrapping or release, aligning O4 and O5 custody. This option is
blocked until the O4 external-custodian direction is explicitly selected.

Required controls:

- O4 and O5 evidence labels remain distinct;
- custodian receipt/tombstone evidence does not expose raw receipt values;
- KEK rotation cannot bypass custodian fail-closed semantics;
- backup passphrase custody remains separately documented.

## Rotation Procedure

This phase keeps rotation manual and explicit.

1. Prepare current KEK and previous KEK custody labels outside committed repo evidence.
2. Stage only the secret files required for the rotation window.
3. Run:

   ```bash
   npm run ops:rewrap-kek -- --plan --json
   ```

4. Record only the redacted plan evidence label and aggregate counts.
5. If the plan fails, do not mutate. Triage corrupt, unreadable, or missing key material outside
   committed evidence.
6. If the plan is ready, quiesce catalog writes.
7. Require explicit operator approval for mutating rewrap.
8. Run the mutating rewrap command only during the approved window.
9. Run `ops:doctor -- --json` after mutation and retain a redacted evidence label.
10. Remove previous KEK material from normal runtime configuration.
11. Record the rotation record label, residual-risk label, and redaction-review label.

## Manual Approval Boundary

Mutating rewrap must never be implied by:

- a scheduled preflight;
- a readiness packet;
- an evidence descriptor;
- `ops:doctor`;
- backup verification;
- restore rehearsal;
- a future UI or operator packet;
- an agent action without explicit operator authorization.

The approval record must identify:

- rotation window label;
- operator approval label;
- preflight evidence label;
- expected aggregate count label;
- post-rotation doctor evidence label;
- rollback or hold decision label.

It must not include keys, passphrases, file paths, raw logs, command output blobs, or backup contents.

## Schedule and Alert Triage

Recommended planning cadence:

- monthly non-mutating rewrap plan;
- quarterly custody review;
- rotation after suspected exposure, custodian change, host migration, or operator decision;
- immediate hold if preflight cannot classify all live key files.

Alert triage labels:

- `kek-plan-missing-previous-kek`;
- `kek-plan-corrupt-key-file`;
- `kek-plan-unreadable-key-file`;
- `kek-plan-unclassified-key-material`;
- `kek-plan-redaction-review-failed`;
- `kek-rotation-approved`;
- `kek-rotation-held`;
- `kek-rotation-complete`.

No scheduler is installed by this phase. Existing Unraid User Scripts may run the non-mutating plan,
but mutating rewrap remains manual and explicitly approved.

## Descriptor Fixture Shape

A future `ops:kek-evidence-preflight` descriptor can use labels like:

```json
{
  "rewrapPlanEvidenceLabel": "kek-rewrap-plan-20260707-095349-redacted",
  "rotationRecordLabel": "rotation-record-pending",
  "managedKekCustodyDocumented": false,
  "rotationScheduleDocumented": true,
  "operatorRunbookDocumented": true,
  "alertTriageDocumented": true,
  "independentSecretMediaDocumented": true,
  "noRawSecretsInEvidence": true,
  "residualRiskAccepted": true,
  "redactionReviewStatus": "pending"
}
```

This fixture is an example only. It does not prove managed custody, does not rotate keys, does not
install scheduling, and does not close O5.

## Evidence Labels

Required O5 labels for a later gate review:

- `kekDescriptorLabel`;
- `kekPreflightReportLabel`;
- `rewrapPlanEvidenceLabel`;
- `rotationRecordLabel`;
- `custodyRunbookLabel`;
- `scheduleAndAlertLabel`;
- `backupPassphraseCustodyLabel`;
- `postRotationDoctorEvidenceLabel`;
- `redactionReviewLabel`;
- `residualRiskLabel`.

## Redaction Rules

Evidence must not include:

- KEKs, DEKs, wrapping keys, age identities, private keys, backup passphrases, API keys, bearer tokens,
  credentials, or raw secret values;
- secret file contents, secret file paths, environment dumps, database URLs, connection strings, raw
  logs, command output blobs, backup contents, ciphertext, artifact contents, provider refs, media
  titles, live service identifiers, account identifiers, or tenant identifiers.

## Review Semantics

Runbook readiness means the operator has a documented, redaction-safe manual path for plan, approval,
mutation, verification, and evidence labeling.

Runbook readiness does not mean:

- managed KEK custody is implemented;
- rotation automation is implemented;
- scheduling is installed;
- keys were rotated;
- production readiness is proven;
- O5 is closed.

## Authorization Gate

Before implementation begins, require an explicit operator decision that names:

- chosen KEK custody direction;
- whether O5 is independent from or coupled to the O4 custodian direction;
- target Unraid staging path and retention policy for secret files, without committing actual paths to
  evidence;
- whether a managed secret store or custodian may be contacted by operator-run commands;
- required evidence labels before O5 can be considered for closure.

Until that decision exists, this document remains design/runbook guidance only.
