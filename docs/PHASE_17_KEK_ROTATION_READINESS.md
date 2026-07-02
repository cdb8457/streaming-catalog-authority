# Phase 17 - KEK Rotation Automation Readiness

Phase 17 narrows O5 by adding a deterministic, non-mutating KEK rewrap preflight. It is meant for
operator runbooks, User Scripts, and schedulers to rehearse the explicit rewrap before changing any
key files.

This does **not** add in-process age support, cloud KMS integration, background scheduling, or
zero-touch custody. O5 remains open for managed rotation and age-key custody. Live rotation is still
an operator-run activity and must not be required by CI.

## Operator flow

Set the same variables used by the mutating rewrap:

- `CUSTODIAN_KEYSTORE_DIR`
- `CUSTODIAN_KEK` or `CUSTODIAN_KEK_FILE` for the new/current KEK
- `CUSTODIAN_KEK_PREVIOUS` or `CUSTODIAN_KEK_PREVIOUS_FILE` for the previous KEK

Run the plan first:

```bash
npm run ops:rewrap-kek -- --plan
npm run ops:rewrap-kek -- --plan --json
```

The plan validates config, scans live key files, and reports aggregate counts:

- `needsRewrap`: live wrapped DEKs still readable under the previous KEK
- `alreadyCurrent`: live wrapped DEKs already readable under the new/current KEK
- `total`: live key files scanned
- `mutates: false` in JSON mode

The plan never rewrites key files and never touches identity ciphertext. It also ignores tombstones
because destroyed keys have no live wrapped-DEK file.

If the plan succeeds and the operator has quiesced the app, run the explicit mutation:

```bash
npm run ops:rewrap-kek
```

After a successful rewrap, remove `CUSTODIAN_KEK_PREVIOUS` from normal runtime config.

## Fail-closed behavior

Plan mode uses the same AES-GCM unwrap classification as the mutating rewrap:

- a file readable under the new/current KEK is counted as already current;
- otherwise, a file readable under the previous KEK is counted as needing rewrap;
- a file readable under neither KEK fails the plan before mutation.

Unreadable or corrupt key files also fail the plan. Error messages and plan output are
redaction-safe: they do not include KEKs, DEKs, key ids, raw identity, provider refs, or secret file
paths.

## Scope boundary

The mutating rewrap remains explicitly operator-triggered. There is no background scheduler, no
implicit rotation during normal reads/writes, no new runtime dependency, and no change to encryption
semantics: identity ciphertext is untouched, DEKs remain wrapped by KEK, and FileCustodian remains a
hardened reference harness rather than the production KMS.
