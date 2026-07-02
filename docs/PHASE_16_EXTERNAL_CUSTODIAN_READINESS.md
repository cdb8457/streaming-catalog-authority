# Phase 16 - External Custodian Production Readiness

Phase 16 narrows production gate O4 without adding a cloud SDK, HTTP service, provider adapter, or
live external dependency. This document defines what a future external/managed custodian adapter
must prove before O4 can close.

`FileCustodian` remains a hardened reference harness. It is useful for local durability,
crash-recovery, contract tests, backup/restore policy, and operator rehearsal, but it is not the
production custodian/KMS. A production adapter must run outside the app trust boundary and implement
the existing `KeyCustodian` interface in `src/core/crypto/custodian.ts`.

## Boundary

The catalog app owns ciphertext, item key-control rows, forget orchestration, and reconciler logic.
The production custodian owns DEK lifecycle state, wrapping or storage of key material, destruction
receipts, and the completion secret used to attest destruction. The app must not be able to read or
forge custodian-local secrets.

The deployment trust boundary for O4 is:

- App database: ciphertext, non-secret key ids, key status references, tombstone/receipt metadata.
- App process: transient plaintext DEKs only during encrypt/decrypt operations; no durable KEK,
  completion secret, custodian master key, provider ref, or raw identity in logs or evidence.
- External custodian: DEK generation/retrieval/destruction, durable tombstones, attestation signing,
  and any KEK or managed-service key material.
- Operator evidence: redacted config and test output proving behavior, with no key material or raw
  identity disclosed.

## Required `KeyCustodian` Invariants

A production adapter must satisfy the same interface-level behavior as the reference harnesses:

- `provision(operationId, itemId, epoch)` is idempotent for identical inputs and returns the same
  `keyId` and 32-byte DEK on retry. Reusing the same `operationId` with different inputs fails.
- `commitProvision(operationId)` is idempotent after successful activation, but a delayed commit must
  never reactivate a destroyed key.
- `destroy(operationId, keyId)` is idempotent on both `operationId` and `keyId`. Retrying the same
  destroy, or destroying an already-destroyed key under a new operation id, returns the same stable
  destruction receipt.
- Destroyed is terminal. After destruction, `status(keyId)` reports `destroyed`, `get(keyId, epoch)`
  fails closed, and no later provision/commit path can make that key readable again.
- `status(keyId)` returns only definite domain states: `provisional`, `active`, `destroyed`, or
  `not_found`. Transport, auth, timeout, service, rate-limit, quorum, or integrity failures are
  thrown errors, never synthetic status values.
- `get(keyId, epoch)` fails closed for unknown, provisional, destroyed, wrong-epoch, corrupt,
  unauthorized, unavailable, or ambiguous keys. It must never return stale or best-effort material
  after an error condition.
- `listStaleProvisioning()` exposes provisional keys that may need reconciler attention and excludes
  active and destroyed keys. The result must be safe to log after ordinary redaction because it
  contains operation ids, item ids, key ids, and ages only.
- Destruction receipts are durable non-secret tombstones. Receipt fields must be stable across
  retries and re-verifiable by the database completion check.
- Attestation covers the destruction statement (`keyId`, `receiptId`, `destroyedAt`) under a secret
  the app process cannot forge in production. The exact encoding must be deterministic and documented.
- Lost acknowledgements are safe: if the custodian mutates state and the response is lost, a retry
  observes the idempotent result instead of duplicating, resurrecting, or fabricating state.

## Deterministic Contract Tests

Future adapters should import and run the shared conformance kit:

```ts
import { runCustodianContract } from './test/custodian-contract.js';
import type { KeyCustodian } from './src/core/crypto/custodian.js';

await runCustodianContract('ExternalCustodian', () => makeFreshIsolatedCustodian());
```

The `makeFreshIsolatedCustodian()` factory must return a fresh, isolated custodian instance for each
contract scenario. For an external service, that means a dedicated namespace, tenant, prefix, test
project, or local emulator fixture that can be safely discarded. The contract suite must remain
deterministic: no live network, cloud account, real KMS, or operator credential may be required by CI.

External-service validation is an operator-run gate, not an automated CI dependency. CI may run
against a local fake/emulator only if the fake has no network or cloud dependency and does not weaken
the `KeyCustodian` contract.

## Failure Semantics

Production adapters must fail closed:

- Unsupported `CUSTODIAN_MODE` values continue to fail closed during config parsing/creation.
- `CUSTODIAN_MODE=memory` remains refused in production unless the explicit insecure override is set.
- Custodian transport/auth/service failures throw and must not be translated into `not_found`,
  `destroyed`, or empty results.
- Ambiguous remote state after a timeout is reconciled by retrying with the same operation id.
- Reads never fall back to another key, another epoch, stale local cache, or locally stored key
  material when the external custodian is unavailable.
- Reconciler behavior must be compatible with stale provisioning, lost commit acknowledgements,
  lost destroy acknowledgements, and old-backup self-heal.

## Redaction-Safe O4 Evidence

To close O4, reviewers need evidence that proves the adapter satisfies the boundary without exposing
secrets. Evidence may include command transcripts, CI output, screenshots, exported reports, and
configuration summaries, but it must redact or omit:

- KEKs, DEKs, wrapping keys, master-key material, HMAC/completion secrets, access tokens, API keys,
  credentials, seed phrases, private keys, or raw custodian secret values.
- Raw identity fields, provider refs, catalog identity ciphertext plaintext, media titles supplied as
  private identity, and any user-specific provider/account identifiers.
- Full destruction attestations if they are treated as sensitive by the deployment; otherwise include
  only receipt ids, key ids, timestamps, and verification pass/fail summaries.
- Full environment dumps. Show variable names, mode names, redacted file paths, and digest/fingerprint
  identifiers only when needed.

Minimum evidence before O4 can close:

- Adapter name, version/commit, deployment topology, and exact `CUSTODIAN_MODE`.
- Proof the adapter implements `KeyCustodian` and runs outside the app trust boundary.
- Deterministic contract-test output using `runCustodianContract` or a stricter superset.
- Operator-run live validation output, explicitly marked out of CI, covering provision, commit, get,
  destroy, idempotent retry, stale provisioning, lost-ack retry, and fail-closed read behavior.
- Attestation format documentation and verification evidence showing the app cannot forge completion.
- Redaction review showing logs/errors/evidence do not contain KEKs, DEKs, completion secrets, raw
  identity, provider refs, or key material.
- Backup/restore evidence showing main-DB backups still exclude custodian key material and that a
  restored DB without custodian prerequisites fails closed.

Until that evidence exists, O4 remains open.

`ops:doctor` reflects this production gate: in production with `CUSTODIAN_MODE=file`, it emits the
redaction-safe WARN check `production-gate-o4-external-custodian` rather than describing the
reference harness as complete managed-KMS readiness.
