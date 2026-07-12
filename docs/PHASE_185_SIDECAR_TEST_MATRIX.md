# Phase 185 - Sidecar Test Matrix

Report id: `phase-185-sidecar-test-matrix`

Phase 185 defines the tests and evidence expected from the local sidecar custodian implementation.
This is a matrix only. It does not start a sidecar, install a service, change Compose, switch
`CUSTODIAN_MODE`, close O4, or close O5.

## Required Test Areas

| Area | Required proof |
|---|---|
| Contract kit | The sidecar client passes the shared `KeyCustodian` behavior contract. |
| Socket unavailable | App calls fail closed when the Unix domain socket is absent or unreadable. |
| Socket permissions | Socket and run directory are owner-only and not exposed through TCP or HTTP. |
| Restart persistence | Active keys and destroyed tombstones survive sidecar restart. |
| Restore mismatch | Restored app DB without matching sidecar state fails closed. |
| Lost acknowledgement | Retried `commitProvision` is idempotent and creates no duplicate active key. |
| Stale provisional reconcile | Stale provisional keys are visible through `listStaleProvisioning` only. |
| Corrupt state | Corrupt or ambiguous state fails closed without returning key material. |
| Destroy attestation | Destruction receipts are sidecar-owned and non-secret. |
| Redaction | Evidence contains no KEKs, DEKs, database URLs, secret file contents, raw logs, provider refs, or media titles. |

## Evidence Requirements

Every implementation evidence packet must include fixed booleans for:

- `contractKitPassed`;
- `socketUnavailableFailClosed`;
- `restartPersistenceExercised`;
- `restoreMismatchFailClosed`;
- `lostAckIdempotent`;
- `staleProvisionalsListedWithoutSecrets`;
- `corruptStateFailClosed`;
- `attestationOwnedBySidecar`;
- `redactionSafe`;
- `providerContactAllowed: false`;
- `playbackAllowed: false`;
- `mediaServerMutationAllowed: false`.

## Gates

The sidecar cannot be proposed for runtime cutover until all required test areas pass in a fresh
environment from documented commands. Any missing, stale, or redaction-unsafe evidence is a hold.

## Review Status

Recommended next status: `ready-for-sidecar-test-matrix-review`.

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.
