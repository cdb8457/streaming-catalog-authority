# Phases 263–265 — implementation report

Branch `cdb8457/phases-263-265-operator-workspace`, from `bb209bc`. Repository-local only: nothing pushed,
no PR, no tag, no release, no deploy, no contact with Unraid, Jellyfin, a provider or a media system.

## What was built

### Phase 263 — safe repair of an installation that already exists

Phase 262 fixed the shipped image so a **fresh** keystore volume is `node`-owned. It could not fix a volume
that already existed, and that was the stated remaining limitation.

* `src/ops/keystore-repair.ts` — inspect and repair, with an **injected filesystem** so every ownership state
  is provable on every platform. Two operations only: create the root if missing, and change owners (plus
  tighten the root's mode). It reads, writes, moves and deletes **no** key material, generates no secret, and
  needs no database and no network.
* Nine named refusals — symlink, non-directory root, device/socket/FIFO, **two or more** foreign owners,
  world-writable key file, non-keystore entry, too deep, too wide, unreadable — each with nothing changed.
  A **single** foreign owner is the legacy case and is repaired; a partially re-owned tree finishes.
* `ops:keystore-check` / `ops:keystore-repair` — one program, one flag, redaction-safe reports (counts, uids,
  a mode; never a file name, a path or any content).
* A `keystore-prepare` one-shot in `docker-compose.runtime.yml` and `docker-compose.arcane.yml`, gating both
  `migrate` and `app`. The **only** root container in either stack: `network_mode: none`, `read_only: true`,
  `cap_drop: ALL` + exactly `CHOWN`/`FOWNER`/`DAC_OVERRIDE`, `no-new-privileges`, **no secrets**, one mount.
  The long-running app is byte-for-byte as hardened as before.
* `docker-compose.unraid.yml` and `docker-compose.deploy.yml` deliberately **do not** get it — they run as
  root, so root ownership is correct there. The suite pins both facts.
* `ops:doctor` gains `keystore-ownership`, which answers the question that actually predicts `EACCES`.

### Phase 264 — authenticated catalog import workflow

* Four routes behind the existing token: `/api/import/{inbox,preview,apply,history}`. `preview` and `apply`
  are the only non-GET routes in the service, named explicitly rather than matched by prefix.
* A snapshot can come only from the read-only mounted inbox. Four independent checks: a closed name grammar
  in which a separator, `..`, a dot-file and a control character **cannot be spelled**; the inbox resolving;
  containment re-checked after `realpath` on both sides **and** direct-child only; and an `lstat`
  regular-file/size check before the read, re-checked against the bytes actually read.
* **Preview writes nothing, structurally**: it is handed a read-only lookup and no authority and no history
  store, so nothing in its scope can write.
* **Apply is bound to the previewed bytes** by a signed, single-use, 15-minute confirmation. Substitution,
  wrong file, replay, expiry, forgery and a different process are each refused with nothing written; the
  nonce is spent *before* the content is compared so a failing apply cannot be used to probe.
* CSRF is structural — no ambient credential — plus a custom-header requirement, a JSON content-type
  requirement, and an Origin/Sec-Fetch-Site check that compares **host and port, not scheme** so a documented
  TLS-terminating proxy keeps working.
* Schema **v6**: identity-free `import_history` + one SECURITY DEFINER appender. The runtime role has SELECT
  and EXECUTE and **no UPDATE or DELETE path**. A path in `file_name` is impossible by CHECK, not by habit.
* `src/ops/catalog-import-service.ts` is the **one** preview and the **one** apply. The CLI is unchanged
  except that it now records to the same history.

### Phase 265 — a catalog workspace

* Source filter and page-size control on top of the existing search/sort/filter/page/detail; import history
  rendered back; a sanitized export.
* The export is a real snapshot the import accepts (round trip tested), **never** carries a provider
  reference value (or its type, or the structure) and counts what it omitted, is deterministic **to the
  byte**, is bounded and **refuses rather than truncating**, and is sanitized against the import's own bounds.
* `Content-Disposition` is built from a closed grammar, re-validated where the header is set, and falls back
  to a constant rather than to an escaper.
* CSP, `textContent`-only rendering, labels, live regions and layout are unchanged. The import panel is
  marked as the only panel that writes — in words, in styling **and** by a disabled button.

## Evidence

| What | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run test:inventory` | `ok: true` — every file under `test/` is inventoried |
| `npm run test:runner` | 60 passed |
| `npm test` (aggregate) | **297 suites selected, 297 passed, 0 failed** (2045s) |
| `npm run test:phase263-local` | 40 passed |
| `npm run test:phase264-local` | 44 passed |
| `npm run test:phase265-local` | 22 passed |
| Compose config, all five shipped stacks | resolve |
| Release bundle assembly + `test:release-delivery` | 26 passed |
| Real Docker + real Chromium acceptance | ran locally, found two real defects (below); the full multi-leg run did not complete — see *Honest limits of the local run* |

## What the real gate found — two defects in my own work

Running `deploy/ci/catalog-acceptance.sh` against a real Docker daemon and a real headless Chromium found two
defects that no unit suite could have:

1. **The legacy-keystore leg was passing vacuously.** An *empty* Docker named volume is re-initialised from
   the image's directory — ownership and mode included — on **every container start**, not only at creation.
   The manufactured root-owned state was silently undone before `keystore-prepare` ever saw it, so the
   one-shot had nothing to repair, exited 0, and the leg reported success having proved nothing. The old
   assertion looked only for the words "wrongly owned", which are printed whatever the count.

   Fixed: the gate now puts real content in the keystore first and requires a **non-zero count** of
   wrongly-owned entries. The underlying fact is documented, because it decides the product's behaviour and
   not just the test's — **on an empty keystore the image fix alone is sufficient; the defect persists
   exactly when the keystore holds key material, which is every real installation.**

2. **`ops:keystore-check` cried wolf, forever.** Because Docker re-opens an empty volume's directory to 0755
   on every start, treating a too-open root as `REPAIRABLE` made the check exit non-zero on a healthy
   installation every single time. Ownership and mode are now separated: a foreign owner is `REPAIRABLE` /
   exit 1 / doctor FAIL; a loose mode is `ALREADY_CORRECT` with a new `TIGHTEN` action / exit 0 / doctor PASS,
   with the fact reported either way.

A third, smaller one: the gate failed with its diagnosis discarded to `/dev/null`. It now prints the check's
report, the one-shot's own report and the directory as the container sees it — which is what made both
defects findable in one run rather than guessable over several.

## Honest limits of the local run

`deploy/ci/catalog-acceptance.sh` was executed locally, for real, three times against a real Docker daemon
with the pinned Chromium harness installed. It assembled the release bundle, extracted it standalone, built
the production image, started the shipped Compose stack, ran the migration one-shot, proved the read-only
import mount, and drove the Phase 263 legacy-keystore leg — which is where it found both defects above.

**It did not complete a full seven-leg pass locally.** After the second run the machine's Docker daemon
stopped being able to pull the `moby/buildkit` builder image, so `docker build` — the acceptance's third step
— hung indefinitely. That is an environment failure on this machine, not a result about the code: the same
Dockerfile built successfully on the same daemon earlier in the session. The browser legs themselves
(`@empty`, `@preview`, `@apply`, `@imported`, `@workspace`, `@reapply`, `@survived`) have therefore **not**
been observed passing end to end locally, and nothing here claims they have.

The gate is CI-required and carries `REQUIRE_ACCEPTANCE=1` there, so a runner that cannot execute it fails
rather than skips. **CI is the evidence for those legs, and it is still outstanding.**

Everything that does not need a Docker daemon was run to completion locally and is reported above.

## Limitations, stated

* **The confirmation does not survive a restart**, by design. A page open across an upgrade must preview
  again.
* **Whole-run import atomicity is not claimed.** Per-record atomicity is the database's; a partial run is
  resumable because identities are derived, and the report says which records landed.
* **The export is lossy and says so.** Provider references cannot be exported; it is not a substitute for
  `ops:backup`, and the refusal message points there.
* **The repair fixes ownership, not corruption.** A damaged keystore is a restore-from-backup problem and
  this tool will not pretend otherwise.
* **`UNSAFE_MIXED_OWNERSHIP` is deliberately not automatable** — two foreign owners means a human decides.
* **The source filter is best-effort for pre-history records**, merging the durable history with the current
  page.
* **Search and sort over encrypted identity are bounded** and say when they did not see everything. That is
  the cost of crypto-shredding being a real erasure, not a defect.
