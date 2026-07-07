# Phase 95 - O4/O5 Hardening Plan

Phase 95 is a planning-only phase for the two remaining production security gates:

- **O4**: managed/external custodian readiness.
- **O5**: managed KEK custody and rotation automation.

This phase does not add a real custodian adapter, cloud SDK, vendor SDK, HTTP service, daemon,
scheduler, provider/debrid adapter, Plex/Jellyfin integration, scraping, downloading, playback, UI,
or network requirement. It does not close O4 or O5. It converts the existing readiness and preflight
work into an implementation sequence for a later explicitly-authorized phase.

## Current Baseline

The catalog-only Unraid foundation has operator evidence for deployment and operations:

- explicit Unraid bind-mounted deployment validation;
- `ops:doctor` passing with no FAIL checks;
- backup dump, offline verify, encrypted artifact wrapping, and isolated restore rehearsal;
- scheduled User Scripts for doctor, backup/verify/encrypt, and KEK rewrap plan;
- KEK rewrap plan returning redaction-safe aggregate counts;
- O4/O5 deferred-risk acceptance recorded outside the committed repo.

The repo already has deterministic O4/O5 scaffolding:

- `docs/PHASE_16_EXTERNAL_CUSTODIAN_READINESS.md`;
- `docs/PHASE_21_EXTERNAL_CUSTODIAN_ACCEPTANCE.md`;
- `docs/PHASE_28_PRODUCTION_CUSTODIAN_CONTRACT.md`;
- `docs/PHASE_29_CUSTODIAN_EVIDENCE_PREFLIGHT.md`;
- `docs/PHASE_17_KEK_ROTATION_READINESS.md`;
- `docs/PHASE_30_KEK_EVIDENCE_PREFLIGHT.md`;
- `test:custodian-acceptance`;
- `test:production-custodian-contract`;
- `ops:custodian-evidence-preflight`;
- `ops:kek-evidence-preflight`;
- `ops:rewrap-kek -- --plan --json`.

## Hard Scope Boundary

Phase 95 must not introduce:

- provider adapters, Real-Debrid, TorBox, metadata providers, scraping, downloading, or playback;
- Plex, Jellyfin, media-server orchestration, or library writes;
- web UI, mobile UI, HTTP framework, or externally bound service behavior;
- cloud/KMS SDKs, vendor SDKs, real network clients, or live service calls;
- CI dependencies on Docker, Unraid, cloud accounts, live custodians, age tooling, or operator secrets;
- runtime mutation beyond future phases explicitly authorized by the operator.

## O4 Target State

O4 can be reviewed only after a real managed/external custodian implementation has evidence that it:

- runs outside the app process and app database trust boundary;
- implements the existing `KeyCustodian` contract without weakening fail-closed semantics;
- stores or wraps key material outside the catalog DB and outside catalog backups;
- makes destruction terminal, durable, idempotent, and retry-safe;
- returns stable destruction receipts or tombstones that can be verified without exposing secrets;
- keeps the app unable to forge completion attestations;
- fails closed on transport, auth, timeout, service, quorum, integrity, and ambiguous-state failures;
- passes the deterministic contract kit or a stricter adapter-specific superset;
- has operator-run live validation evidence explicitly kept out of CI;
- has redaction review for logs, errors, command output, and evidence bundles;
- preserves backup/restore behavior: DB backups exclude custodian key material, and restored systems
  fail closed until external custodian prerequisites are provided.

## O5 Target State

O5 can be reviewed only after managed KEK custody and rotation automation evidence proves:

- current KEK custody is documented and independent of DB backups and catalog evidence;
- previous/current KEK handling supports explicit rewrap without exposing key material;
- `ops:rewrap-kek -- --plan --json` remains the non-mutating preflight and reports aggregate counts;
- mutating rewrap remains explicit, resumable, and operator-controlled;
- rotation cadence, ownership, alerting, and failure triage are documented;
- independent secret media or managed custody protects KEKs and backup encryption passphrases;
- no KEKs, DEKs, wrapping keys, private keys, secret paths, env dumps, raw logs, or artifact contents
  appear in evidence;
- residual risk is accepted or resolved by a reviewer/operator.

## Recommended Implementation Sequence

### Stage 95.1 - Evidence Descriptor Consolidation

Add a single O4/O5 readiness packet shape that references existing descriptor preflights rather than
inventing new evidence semantics.

Expected output:

- a docs-only checklist for O4/O5 evidence labels in
  `docs/PHASE_95_1_O4_O5_EVIDENCE_PACKET.md`;
- examples of redaction-safe descriptor JSON for O4 and O5 in the Phase 95.1 packet doc;
- explicit statement that descriptor readiness does not close O4/O5.

Tests:

- static docs/source guard if a CLI or fixture is added;
- no live services, no network, no Docker.

### Stage 95.2 - External Custodian Adapter Design

Design, but do not implement, the first external-custodian adapter boundary.

Open design choices:

- local sidecar process versus managed KMS service;
- RPC/IPC boundary and authentication model;
- namespace/tenant isolation for contract tests;
- receipt and attestation encoding;
- retry/idempotency storage location;
- operator-run live validation workflow;
- Unraid deployment topology.

Expected output:

- adapter boundary document in `docs/PHASE_95_2_EXTERNAL_CUSTODIAN_ADAPTER_DESIGN.md`;
- failure-mode matrix;
- redaction-safe evidence plan;
- test harness plan using `runCustodianContract`.

### Stage 95.3 - O5 Managed Custody Design

Design managed KEK custody and rotation scheduling without changing runtime defaults.

Open design choices:

- file-level age versus managed secret store versus external custodian-owned KEK;
- where previous/current KEKs are staged during rotation;
- how scheduled preflight reports are retained;
- how mutating rewrap is authorized and quiesced;
- how backup encryption passphrase custody is tracked separately from KEK custody.

Expected output:

- KEK custody runbook in `docs/PHASE_95_3_O5_MANAGED_KEK_CUSTODY_RUNBOOK.md`;
- rotation schedule and alert-triage plan;
- descriptor fixture for `ops:kek-evidence-preflight`;
- explicit manual approval boundary for mutating rewrap.

### Stage 95.4 - Minimal Implementation Authorization Gate

Before any real adapter or automation code is written, require a new explicit operator decision:

- chosen O4 custodian direction;
- chosen O5 custody direction;
- target deployment mode for Unraid;
- whether a live custodian service may be contacted by operator-run commands;
- evidence labels required before the gate can close.

Expected output:

- implementation authorization gate in `docs/PHASE_95_4_IMPLEMENTATION_AUTHORIZATION_GATE.md`;
- redaction-safe decision record shape;
- hold conditions that keep implementation unauthorized;
- explicit closure boundary separating implementation authorization from O4/O5 closure.

## Failure Modes To Preserve

Any later implementation must keep these fail-closed behaviors:

- unsupported custodian modes fail config parsing;
- in-process memory custodian remains refused in production unless explicitly overridden;
- missing previous KEK fails the rewrap plan rather than guessing;
- corrupt or unreadable key files fail preflight before mutation;
- custodian read failures never return stale or fallback key material;
- restored DB without external custodian prerequisites cannot decrypt identity;
- evidence commands never print secrets, raw logs, DB URLs, secret paths, key material, provider refs,
  media titles, backup contents, or artifact contents.

## Review Checklist

Before moving from planning to implementation, confirm:

- O4/O5 scope is still security hardening only;
- no provider/media/UI work has entered the branch;
- CI remains deterministic and offline;
- FileCustodian remains a reference harness;
- O4 and O5 are still described as open/deferred until live/operator evidence is reviewed;
- Unraid runbooks remain one-shot/ops-oriented rather than long-running web services.

## Non-Goals

- Closing O4 or O5 in this phase.
- Adding a real managed KMS, cloud account, vendor SDK, or external service dependency.
- Installing or mutating Unraid schedules from repo code.
- Changing catalog encryption semantics.
- Introducing provider adapters or media-server workflows.
- Building any UI or HTTP API.
