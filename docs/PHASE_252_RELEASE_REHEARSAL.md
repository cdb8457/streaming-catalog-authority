# Phase 252 — final first-release rehearsal and human handoff

Everything through Phase 251 built and proved the pieces of a first release: an image, a consumer bundle, a
real-browser acceptance (Phase 248), a Compose lifecycle acceptance (Phase 249), a read-only readiness proof
(Phase 250), and an offline integrity packet (Phase 251). Phase 252 is the last thing before a human decides:
**one deterministic, offline, non-publishing rehearsal** that assembles the exact candidate in a fresh
directory, runs every offline verifier against it, and — the point of this phase — **requires references to
the Phase 248 and Phase 249 CI acceptances as explicit inputs and never fabricates them.** It then emits a
concise handoff packet a human reads before taking the one release action that remains.

```
npm run ops:release-rehearsal                       # JSON handoff report for the shipped tag
npm run ops:release-rehearsal -- --text             # a human-readable handoff
npm run ops:release-rehearsal -- --evidence ci.json # supply the Phase 248/249 CI acceptance references
```

It contacts no network, uses no credential, holds no write permission, and publishes, pushes, tags, merges or
deploys nothing. A run of it changes nothing and can be repeated.

## The four outcomes and their exit codes

| Outcome | Exit | Meaning |
| --- | --- | --- |
| `HANDOFF_READY` | `0` | The candidate assembled, every offline verifier passed, and passing CI acceptances are referenced for this commit. Evidence a human may now decide to release. |
| `BLOCKED` | `30` | A gate found a real problem: a verifier blocked, or a referenced acceptance failed or is for a different commit (stale/contradictory). |
| `INVALID` | `31` | An evidence reference could not be interpreted (malformed). |
| `NOT_RUN` | `32` | A required piece of evidence was not supplied (a CI acceptance reference is absent, or there is no Git here to tie evidence to). |

Precedence, most severe first: **INVALID > BLOCKED > NOT_RUN > HANDOFF_READY**. A usage error exits `2`; a
refused (redaction-unsafe) render exits `3`. Readiness is never manufactured from absent evidence: a skip is
`NOT_RUN`, never a pass.

## HANDOFF_READY is not approval

`HANDOFF_READY` is **evidence**, not a decision. It means the mechanical, verifiable preconditions are met; it
is **not release approval**, an authorization, or a publish. This tool holds no write permission and performs
none of the release. The report says so in its `authorityNote`, and it always carries the single human action
that remains: **create and publish the GitHub Release for the candidate tag**, which triggers the already-gated
publish workflow. Only a human takes that action.

## The gates it evaluates

Each is one statement that can be false; the adversarial suite in `test/release-rehearsal.ts` proves each
turns away from `PASS` against a minimally-weakened fixture.

* **candidate-assembled** — the bundle, archive and verification packet were assembled from scratch into an
  empty directory (not reused from a stale build);
* **offline-readiness** — the Phase 250 read-only readiness proof is `READY`;
* **offline-integrity** — the Phase 251 verifier reports `VERIFIED` for the archive that was just assembled;
* **browser-acceptance-evidence** — a passing **Phase 248** real-browser acceptance is referenced *for this
  commit*;
* **lifecycle-acceptance-evidence** — a passing **Phase 249** lifecycle acceptance is referenced *for this
  commit*;
* **install-documentation** — the bundle documents install, upgrade, rollback and how to verify the download;
* **command-paths** — copy-paste verification commands are provided for Windows, macOS and Linux.

## Evidence is required, never fabricated

This rehearsal is offline. It **cannot run** the real-browser or the Compose lifecycle acceptances — those need
a daemon and a browser. So it requires their CI-run references as inputs (a `--evidence` file, or the
`PHASE248_*` / `PHASE249_*` env vars) and validates them: a reference that is **absent** is `NOT_RUN`; one that
is **malformed** is `INVALID`; one whose conclusion is not `success`, or whose commit is not the candidate's,
is `BLOCKED` (contradictory / stale). It never invents a green checkmark. In CI the references are this run's
own facts — `github.sha` and `needs.<job>.result` — which GitHub gates, so they are honest, not fabricated.

## The handoff packet

The report *is* the handoff packet: exact candidate coordinates (tag, image ref, digest, archive name and
sha256, commit), the passed/blocked/not-run gates, the CI acceptance references a human should open, the known
limitations (it is offline; it cannot confirm the registry; a VERIFIED result is not publisher identity), the
**rollback** facts (pinned by digest, data persists in a named volume, and rolling the image back does not roll
data back), and the single remaining human action. It also carries a fixed **human checklist** and a
**decision record template** for recording the release decision, and a `selfDigest` over its verdict-bearing
fields so the exact handoff can be pinned and re-verified.

## CI wiring, without write permission

CI runs `npm run test:phase252-local` in the suites gate, and adds a read-only `rehearsal` job that assembles
the candidate, runs the rehearsal with this run's evidence, asserts `HANDOFF_READY`, and uploads the handoff
packet for inspection. The job has **no `permissions:` block**, so it inherits `contents: read` and is
structurally incapable of publishing — no registry login, no push, no tag, no release upload.

## Boundaries

Offline and read-only. No publish, push, tag, merge or deploy; no credentials; no GitHub, Jellyfin or provider
contact; no promotion, no Movies library access, no Phase 231 authorization. It requires CI acceptance
references as inputs and never fabricates a passing result. A `HANDOFF_READY` result is evidence for a human
decision and is not itself a decision, an approval, or an authorization.
