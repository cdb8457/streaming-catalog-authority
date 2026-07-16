# Phase 230: Final Coordinator Evidence Packet (local, non-live)

Report id: `phase-230-promotion-coordinator-evidence-packet`

Status: `PHASE_230_PROMOTION_EVIDENCE_PACKET_READY`

Summarizes a fixture evidence bundle and its (**required**) replay result into a compact,
**redaction-safe, deterministic** coordinator packet: the key digests, the local test commands to
reproduce, the remaining human gates, and explicit no-live / no-Phase-231 language. It reads parsed
JSON only; it performs no promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin,
and **never authorizes Phase 231 or live promotion** (`authorization` is the constant `NONE`).

## Contents

- `overall`: `EVIDENCE_COMPLETE` iff the bundle is `BUNDLE_READY` **and** a replay is supplied and `ok`;
  otherwise `EVIDENCE_INCOMPLETE` with generic `blockers` (`BUNDLE_INVALID`, `BUNDLE_NOT_READY`,
  `REPLAY_MISSING`, `REPLAY_INVALID`, `REPLAY_NOT_OK`, `RAW_PATH_IN_PACKET`). A replay is **required** —
  a complete packet must carry a passing bundle-replay result.
- `digests`: `bundle`, `manifest`, `matrix`, `integrity`, `schema`, `handoff`, `dashboard`, and (when a
  replay is supplied) `replay` — SHA-256 digests lifted from the bundle/replay.
- `testCommands`: the exact local commands to reproduce (`test:phase230-local`, the fixture-bundle and
  bundle-replay suites, and `tsc --noEmit`).
- `humanGates`: the remaining non-automatable human gates (approval authoring; the live Phase 229
  promotion, out of scope; the coordinator ACCEPT decision; the separate Phase 231 authorization).
- `disclaimers`: fixed no-live / no-Phase-231 language, present in **every** packet.
- `packetDigest`: `sha256("phase-230-evidence-packet:" + body)`; deterministic for identical inputs.

The packet carries only digests, enums, and the fixed constant strings — no raw title, path, or
destination.

## Files

- `src/ops/promotion-evidence-packet.ts` — `buildCoordinatorEvidencePacket(input)` + the fixed constants.
- `src/ops/promotion-evidence-packet-cli.ts` — CLI wrapper.
- `test/promotion-evidence-packet.ts` — 7 tests: complete packet with digests/commands/gates/disclaimers,
  incomplete on not-ready bundle / missing replay / not-ok replay / invalid bundle, redaction-safety +
  deterministic digest, and a spawned CLI run.

## Usage

```
npm run ops:promotion-evidence-packet -- --bundle bundle.json [--replay replay.json] [--out packet.json]
```

Exit `0` = `EVIDENCE_COMPLETE`, `1` = `EVIDENCE_INCOMPLETE`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization — stated explicitly in the packet itself.
