# Phase 186 - Sidecar Runtime Cutover Gate

Report id: `phase-186-sidecar-runtime-cutover-gate`

Phase 186 defines the minimum gate before switching from `FileCustodian` reference custody to a local
sidecar custodian runtime. This is a cutover gate only. It does not modify
`docker-compose.unraid.runtime.yml`, start `custodian-sidecar`, switch `CUSTODIAN_MODE`, close O4, or
close O5.

## Required Inputs

- reviewed sidecar implementation commit;
- passing Phase 185 test matrix evidence from a fresh environment;
- redaction-safe Unraid evidence bundle;
- rollback plan back to the Launch v1 file-custodian runtime;
- backup plan for app DB and sidecar-owned state;
- operator approval record for the exact image, commit, and Compose change;
- independent review verdict with no P0/P1 custody blockers.

## Runtime Switch Conditions

All conditions must be true before a production cutover can be proposed:

- the sidecar image is built from the reviewed commit;
- `custodian-sidecar` exposes no published ports;
- app/ops containers receive only the Unix domain socket path;
- sidecar state remains under `/mnt/user/appdata/catalog/sidecar/state`;
- sidecar logs remain under `/mnt/user/appdata/catalog/sidecar/logs`;
- restore mismatch fails closed in live evidence;
- stale provisional reconciliation is exercised;
- destroy attestation is sidecar-owned and non-forgeable by the app;
- O4/O5 closure is explicitly reviewed after cutover evidence, not assumed before cutover.

## Rollback Requirements

The rollback plan must preserve:

- current Launch v1 runtime Compose;
- current Postgres appdata path;
- current operator UI commands;
- no provider/media behavior;
- no media-server mutation.

Rollback must not require deleting operator evidence, deleting app data, or weakening redaction rules.

## Review Status

Recommended next status: `ready-for-sidecar-cutover-gate-review`.

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.
