# Phase 230: Strict Artifact Schema/Status Validator (local, non-live)

Report id: `phase-230-promotion-artifact-schema`

Status: `PHASE_230_PROMOTION_ARTIFACT_SCHEMA_READY`

Validates the **structural shape and status/verdict enums** of the Phase 230 offline artifacts —
independent of digests. It complements the artifact-integrity verifier: integrity proves the digests
recompute and chain, while this proves each artifact is actually *well-formed*. A malformed artifact
that has been re-sealed so its self-digest still recomputes (e.g. a bogus status on the terminal
acceptance packet) passes integrity but is **rejected** here.

It reads parsed JSON only; it performs no promotion, never touches `/mnt/user/media/Movies`, never
contacts Jellyfin, and authorizes nothing live (no Phase 231).

## What it checks (per artifact)

For each of `approvalEvidence`, `promotionEvidence`, `evidenceReview`, `readiness`, `acceptancePacket`:

- `report` matches the expected report id and `version === 1`;
- `redactionSafe === true`;
- the status/verdict field is one of the allowed enum values;
- the self-digest field is a well-formed SHA-256 string (shape only — recomputation is the integrity
  verifier's job);
- the required structural fields are present.

Problems are generic codes (e.g. `ACCEPTANCE_PACKET_STATUS_INVALID`, `PROMOTION_EVIDENCE_VERSION_INVALID`,
`EVIDENCE_REVIEW_NOT_REDACTION_SAFE`, `APPROVAL_EVIDENCE_MISSING_FIELD`, `READINESS_MISSING`). `ok` is true
only when every supplied artifact is well-formed and none is missing. The report carries a `schemaDigest`.

## Files

- `src/ops/promotion-artifact-schema.ts` — `validateArtifactSchema(kind, obj)`, `validateArtifactSchemas(bundle)`.
- `src/ops/promotion-artifact-schema-cli.ts` — CLI wrapper.
- `test/promotion-artifact-schema.ts` — 7 tests, including a malformed-but-self-digested artifact that
  integrity accepts and schema rejects.

## Usage

```
npm run ops:promotion-artifact-schema -- \
  [--approval-evidence f] [--promotion-evidence f] [--evidence-review f] [--readiness f] [--acceptance-packet f] [--out report.json]
```

Exit `0` = ok, `1` = schema problem(s).

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization.
