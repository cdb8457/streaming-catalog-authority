# Phase 230: Operator Approval Request Packet (local, non-live)

Report id: `phase-230-promotion-approval-request-packet`

Status: `PHASE_230_PROMOTION_APPROVAL_REQUEST_PACKET_READY`

A redaction-safe packet that **asks** a human to approve — it never accepts, grants, or records approval.
Given the authoritative review-authorization scaffold, it emits `APPROVAL_REQUEST_READY` listing the exact
reviewed commit (hex sha), the required test labels, the pending human gates, and **PENDING placeholders** for
the item / source / destination binding a human must fill. `status` is the constant `PENDING` and
`authorization` is the constant `NONE`.

## What it checks (fail closed)

- **No approval claim** — if the supplied review-authorization already claims an `authorization` other than
  `NONE`/`PENDING`, the packet refuses to build (`APPROVAL_CLAIM_PRESENT`).
- **Authoritative review** — the review-authorization is present (`REVIEW_AUTHORIZATION_MISSING`), has the
  right report id (`REVIEW_AUTHORIZATION_INVALID`), recomputes its self-digest, is `LOCAL_REVIEW_AUTHORIZED`
  with `evidenceValid`/`matrixValid`/`contextBound`, and carries sha40 placeholders with a non-empty test set
  (`REVIEW_AUTHORIZATION_NOT_AUTHORITATIVE`). The reviewed commit is the terminal placeholder sha; the required
  tests are the placeholder test labels.

It reads parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts
Jellyfin, and echoes only a hex commit sha, path-free test labels, fixed-language gates, and the literal
`PENDING`. **A READY packet is a REQUEST for human review — it does NOT approve anything and does not authorize
Phase 231.**

## Files

- `src/ops/promotion-approval-request-packet.ts` — `buildApprovalRequestPacket(input)`.
- `src/ops/promotion-approval-request-packet-cli.ts` — CLI wrapper.
- `test/promotion-approval-request-packet.ts` — 3 tests: ready packet with reviewed commit/tests/PENDING
  bindings that grants nothing; blocked on approval claim / non-authoritative / missing; and a spawned CLI run.

## Usage

```
npm run ops:promotion-approval-request-packet -- --reviewauthorization ra.json [--out packet.json]
```

Exit `0` = `APPROVAL_REQUEST_READY`, `1` = `APPROVAL_REQUEST_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and
no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
