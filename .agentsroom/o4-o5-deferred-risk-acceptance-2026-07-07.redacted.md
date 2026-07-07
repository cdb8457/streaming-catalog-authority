# O4/O5 Deferred Risk Acceptance - Redacted

## Scope

- Evidence label: o4-o5-deferred-risk-acceptance-2026-07-07
- Repository commit: 057405ac5e96bbbe123361626ab8f77a4a195e6a
- Deployment host label: Tower
- Deployment mode: Unraid, catalog/privacy core
- Redaction status: no secret values, database URLs, key material, backup contents, raw identity, provider refs, or raw logs are retained here

## Current Evidence Basis

| Area | Status |
|---|---:|
| Local Docker Desktop validation | PASS |
| Unraid Compose validation | PASS |
| Explicit Unraid bind-mount validation | PASS |
| `ops:doctor` | PASS |
| Backup dump and offline verify | PASS |
| Isolated restore rehearsal | PASS |
| KEK rewrap plan tooling | PASS |
| User Scripts installed and manually proven | PASS |
| Hourly doctor schedule observed | PASS |

## O4 - Managed/External Custodian

- Status: DEFERRED / OPEN
- Current implementation: FileCustodian reference harness
- Accepted for this stage: yes, for catalog/privacy validation and self-hosted foundation only
- Closed by this evidence: no
- Production note: a managed/external custodian adapter remains a future deployment deliverable before claiming managed-KMS-grade production custody.

## O5 - Managed KEK Custody / Rotation Automation

- Status: DEFERRED / OPEN
- Current implementation: KEK rewrap tooling and non-mutating plan preflight
- Validated evidence: `ops:rewrap-kek -- --plan --json` returned `mutates:false`, `status:ready`, `needsRewrap:0`, `alreadyCurrent:0`, `total:0`
- Accepted for this stage: yes, for catalog/privacy validation and self-hosted foundation only
- Closed by this evidence: no
- Production note: managed KEK custody, scheduling, and rotation automation remain future operational/security deliverables.

## Backup Encryption At Rest

- Status: PENDING OPERATOR STORAGE POLICY
- Current backup tooling: dump and verify pass; artifacts are ciphertext/key-control DB backups without key material
- File-level `age` encryption on Unraid: not installed at evidence time
- Accepted for this stage: pending operator decision
- Closed by this evidence: no

## Decision

- Proceeding past validation gate with O4 and O5 explicitly deferred: yes
- O4 described as closed: no
- O5 described as closed: no
- Launch approved by this note: no
- Production readiness approved by this note: no
- Release candidate approved by this note: no
- Production release approved by this note: no

## Required Future Work

- Decide and document backup encryption-at-rest policy.
- Implement or integrate managed/external custodian if production custody requirements demand it.
- Define managed KEK custody and rotation automation if production operations require it.
- Add alert receipt proof if notification delivery must be evidence-backed.

