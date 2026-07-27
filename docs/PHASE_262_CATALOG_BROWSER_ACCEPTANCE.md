# Phase 262 — the shipped product, imported and browsed in a real browser

## User-visible outcome

Before a release can be published, CI now proves the thing the product is *for*, end to end, on the artifact
an operator actually downloads:

> extract the release → start it → drop a snapshot file in the folder the README names → preview it (and
> nothing is written) → apply it → browse your own catalog in a real Chromium.

Phase 248 proved the release **loads** in a browser. Phase 259 proved the import CLI is correct against an
embedded database, from source. Phase 260 proved the catalog panel is correct against a fake DOM and a server
started from source. None of them crossed the image, the read-only import mount, the migration one-shot, the
operator token and the browser *at once* — which is the only place several kinds of breakage can appear.

## The command

```
REQUIRE_ACCEPTANCE=1 bash deploy/ci/catalog-acceptance.sh
```

Prerequisites: a running **Docker** daemon, `node`, and the pinned browser harness:

```
npm --prefix deploy/ci/acceptance ci
npx --prefix deploy/ci/acceptance playwright install --with-deps chromium
```

The contract suite — everything below that does not need a daemon — is:

```
npm run test:phase262-local
```

## What it does, in order

| # | step | what it proves |
| --- | --- | --- |
| 1 | assemble the consumer bundle, extract it | the release is standalone: no `package.json`, `src`, `node_modules` or toolchain, and it ships `example-catalog-snapshot.json` |
| 2 | build the production image with a local-only tag | never pulled, never pushed, never `latest` |
| 3 | point the extracted `.env` at that image, on port **8098** | its own loopback port, so it cannot collide with the Phase 248 stack |
| 4 | run the bundle's `setup.sh` | the operator token is read from disk and never printed |
| 5 | copy the snapshot into `./import/` | through the **shipped** read-only mount path, exactly as the README instructs |
| 6 | `docker compose up -d` | the one-shot `migrate` service bootstraps the schema **before** the app exists; the run asserts it exited 0 |
| 7 | inspect the import mount, and try to write into it from the container | read-only in metadata **and** in fact |
| 8 | browser leg **@empty** | `EMPTY`, a guidance line that points at importing, and the import instructions on the same page |
| 9 | `ops:catalog-import -- --file …` (no `--apply`) | the preview announces itself, plans 28 creates, **and the item and event counts do not move** |
| 10 | the same command with `--apply` | 28 records exist, and the catalog API agrees |
| 11 | browser leg **@imported** | the whole browsing surface (below) |
| 12 | re-read the item and event counts | **an entire browsing session wrote nothing** |
| 13 | read the container logs | no token, no title, no reference value |
| 14 | apply the same snapshot again | `create 0`, `already present 28`, no new events — idempotent |
| 15 | `docker compose stop` then `up -d` | records, token and event log all survive; the migration is idempotent |
| 16 | teardown, on every exit path | containers, volumes, image and temporary directories removed |

Counts in steps 9, 12, 14 and 15 are read with `psql` **inside** the stack, because the database is
deliberately not published to the host. They are exact row counts, not inferences from the UI.

## What the browser leg asserts

Against the real shipped assets, under the real CSP:

- **empty state** — `EMPTY`, a guidance line naming import, `No records yet.`, and the import panel readable
  without a token;
- **counts and paging** — 28 records, 25 on page one and 3 on page two, no record on both pages, all 28 seen
  exactly once, and `Previous` returning to page one;
- **search** — a substring match narrowing to one; a no-match search reported `NO_MATCH` with the total
  intact rather than as an empty catalog; `Clear` restoring everything;
- **filter** — provider-reference **type** `imdb` narrowing to the one record that has one; an inclusive year
  range narrowing to three;
- **sort** — title Z-to-A putting the fixture's only Z-titled record first;
- **detail** — the operator's own external id and metadata shown back to them, and the provider reference
  shown as a type plus a fingerprint with the words *the value is never shown*;
- **hostile title** — `A Hostile <img src=x onerror=…><script>…</script> Title` arrives **verbatim as text**,
  creates no `img` and no `script` element, does not execute, and needs no CSP violation to be safe (it was
  never markup);
- **token authentication** — 401 with no token, 401 for a same-length wrong token, 405 with `Allow: GET` for
  POST/PUT/PATCH/DELETE, 200 with the token;
- **no disclosure** — the sentinel reference value appears in no rendered text, no API response body, no
  serialized DOM and no log line;
- **no browser persistence** — no cookies, empty `localStorage`, `sessionStorage` and IndexedDB, the token in
  no URL, request body or serialized DOM, no catalog record persisted anywhere, and a reload leaving an empty
  token field and an unloaded catalog;
- **cleanliness** — no console error, no page error, no CSP violation, no cross-origin request, no mixed
  content.

## The fixture

`deploy/ci/acceptance/fixtures/catalog-acceptance-snapshot.json` — 28 records, checked in, deterministic, and
**validated by the product's own `parseCatalogSnapshot` in `npm run test:phase262-local`**. A fixture the
product would reject proves nothing about the product, and finding that out inside a Docker job most
contributors cannot run is the wrong place to find it out.

It contains no URL, no host, no live-service name: one imdb reference whose value is the disclosure sentinel,
one hostile title, one undated record, and 25 ordinary ones — one full default page, so the 26th forces a
second.

## Skip and failure semantics — the part that must never lie

| where | Docker present | Docker absent |
| --- | --- | --- |
| a developer machine | runs, passes or fails on behaviour | **exit 3**, prints `SKIP:`, says it is CI-required and was **NOT executed** |
| CI (`REQUIRE_ACCEPTANCE=1`) | runs, passes or fails on behaviour | **exit 1**, and says why it refused to skip |

There is no path by which "we could not run it" is reported as "it passed". Both directions are executed for
real in `npm run test:phase262-local`, with the daemon **made** unreachable for the child process — so the
contract is exercised on a laptop with no daemon and on a CI runner with a healthy one alike, rather than
inferred from a probe that might disagree with what the orchestrator went on to see.

The CI job `catalog-acceptance` is required: `publish` now needs all **seven** gates
(`bundle`, `catalog-acceptance`, `image`, `lifecycle`, `rehearsal`, `release-candidate`, `suites`), and the
job carries no `if:`, so it runs on every event that can reach `publish` and can never be skipped into
looking green.

## What it found on its first run

The gate was built to catch the class of defect that only appears in the shipped container. It caught one
immediately, in CI, on the first run that reached the browser:

```
FAIL: GET /api/catalog answered 503, not 200
      the service said: {"code":"OPERATOR_UI_CATALOG_UNAVAILABLE", ...}
--- ops:doctor, run inside the app container ---
doctor failed: EACCES: permission denied, mkdir '/var/lib/catalog/keystore/keys'
```

The custodian keystore is a named volume. Docker initialises a fresh named volume from whatever the **image**
has at that path, ownership included — and creates it **root-owned** when the image has nothing there. The
container runs as `node`. So on every fresh install the first thing that constructs a `FileCustodian` died
with `EACCES`, which is `ops:doctor`, `/api/status` **and the entire catalog panel**.

Nothing caught it before because every gate up to Phase 261 probed only `/healthz`, which needs no custodian.
Worse, the Phase 248 spec had written the symptom down as *"on a freshly-started stack the database has not
been migrated, so /api/status answers 503"* — a mis-attribution that made the real defect look expected. The
schema was current the whole time; the keystore was unwritable.

**Fixed in `Dockerfile.runtime`**: the image now creates `/var/lib/catalog/keystore` owned by `node` before
dropping to that user, so Docker gives the fresh volume the same ownership. `test/consumer-release-image.ts`
pins it, and the Phase 248 comment is corrected.

**If you already have an installation**, its volume was created root-owned and the image change cannot
retro-fit it. One command fixes it, with the stack stopped:

```
docker compose run --rm --user root --entrypoint sh app -c 'chown -R node:node /var/lib/catalog/keystore'
```

## What it covers as of Phases 263-265

The gate grew with the product rather than being duplicated: one orchestrator, one spec, one CI job, more
legs. In order, against one real extracted Compose stack:

1. **The legacy keystore, repaired.** One authenticated catalog read first, to put real content in the
   keystore — **this is load-bearing, not setup**. An *empty* Docker volume is re-initialised from the image's
   directory, ownership and mode included, on every container start, so a manufactured legacy state on an
   empty keystore is wiped before anything can see it and the whole leg passes vacuously. (It did, until this
   gate's own evidence showed it.) With content present the state persists, which is exactly the real-world
   case. The stack is then stopped, the volume made root-owned at 0755, and `ops:keystore-check` must report a
   **non-zero count** of wrongly-owned entries and exit non-zero. The stack is brought back up; the shipped
   `keystore-prepare` one-shot must have exited 0; the app must be running as a **non-root** uid; `ops:doctor`
   must report `keystore-ownership: pass`; and a repeat check must exit 0. A failure here prints the
   one-shot's own report and the directory as the container sees it, because a gate that fails without a
   diagnosis only tells you to guess.
2. **The empty installation** — guidance, and an Import panel that has discovered the snapshot and offers no
   path, URL or upload control.
3. **Preview, twice** — from the command line and from the browser. Rows, events **and** import history
   entries are counted either side and must all be unchanged.
4. **Apply, from the browser**, bound to the exact previewed bytes, writing exactly one history entry.
5. **Browsing** the imported catalog: counts, search, filters, sort, paging, record detail, a hostile title
   rendered as text, and token authentication.
6. **The workspace**: a real download whose `Content-Disposition` name matches the closed grammar and whose
   body carries every record and **no provider reference value**; the import history, identity-free; page-size
   and out-of-range bounds; and the write boundary — 401 without a token, 405 on GET, 400 on a form post, 403
   cross-origin, 400 on four spellings of a path, and 409 on a forged confirmation.
7. **Browsing and exporting wrote nothing** — items, events and import history all unchanged across the whole
   session, and the export API asked directly discloses no reference value and no token.
8. **Idempotency, through both surfaces.** A browser re-apply and a command-line re-apply each create nothing
   and append no events — and each still write a history row, because "I ran an import and it changed nothing"
   is a fact worth keeping.
9. **A full stop/start.** Records, token, event log and import history all survive, and the browser is driven
   again afterwards to prove the page still shows them.
10. **The import mount is still read-only** after an entire import workflow — in Docker's metadata and by a
    `touch` from inside the container.

Every leg goes through one `run_leg` helper, so a new leg cannot be wired differently by accident, and each
one still fails if it ran zero tests.

## Boundaries

- Nothing here contacts a provider, Jellyfin, a media library, Unraid or any endpoint beyond `127.0.0.1`.
  The contract suite asserts that, including that every URL in the orchestrator is loopback.
- It **accepts**; it never publishes. No registry login, no push, no tag, no release asset, no floating image
  tag. The job has no `permissions:` block, so it inherits the workflow's read-only default and is
  structurally incapable of publishing.
- Its Compose project, host port, image tag and artifact directories are all its own, so it can never tear
  down or interfere with the Phase 248 stack — and the CI teardown step is scoped to its own project label.
- Artifacts are failure-only, pass through the same redaction gate, and reach the upload directory only by
  being **promoted** out of staging after the gate passes. A gate failure, or a kill before the gate ran,
  leaves the upload directory empty rather than merely scrubbed.

## Limitations

- **It was not executed locally.** The development machine for this phase has the Docker CLI and Compose but
  no daemon (`failed to connect to the docker API at npipe:...`), so the orchestrator's own SKIP path is what
  ran here, by design. Everything that does not need a daemon — the fixture parsed by the product's parser,
  the workflow wiring, the orchestrator and spec contracts, and both skip/fail semantics with the daemon made
  unreachable — was executed. **The real Docker + browser evidence is the CI job**, and this document does
  not claim otherwise.
- **One snapshot, one shape.** 28 records exercise paging, search, one filter type and one sort. They do not
  exercise the 1000-record scan bound, a truncated result, or a catalog large enough to make decryption cost
  visible.
- **The Phase 252 handoff packet does not carry this gate's result.** `rehearsal` needs `suites`,
  `release-candidate` and `lifecycle`, and reports those three from this run's job results. `publish` needs
  `catalog-acceptance` directly, and the readiness verifier now blocks a graph in which it is missing — so a
  release still cannot go out over a red catalog gate. What the handoff packet says about the acceptances is
  simply one gate short of what the graph enforces, and extending it is a change to the rehearsal's own
  evidence contract rather than to this one.
- **The empty and imported legs are separate browser runs.** They share a spec file and are selected by tag.
  The orchestrator reads each leg's report and refuses a leg that ran zero tests, so a mistyped tag fails
  rather than passing quietly — but it does not pin *which* tests ran, only that some did.
- **`forget` is not exercised here.** Phase 260's suite proves a forgotten record leaves the count and 404s
  its detail; this acceptance does not repeat it, because an erasure inside a release-acceptance run is a
  destructive act on a stack that is about to be discarded anyway.
- **This stack plants no promotion records, so `/api/promotion-chain` answers 503 and the browser logs a
  console error for it.** That is the shipped behaviour of a panel this gate is not about. The browser
  assertions are therefore scoped: strict "no console errors" on the unauthenticated shell, and on the
  authenticated page, no uncaught error, no CSP violation, and **every catalog response a 200**. Asserting
  "no console errors" after authenticating would have meant planting a record to keep an unrelated panel
  quiet — arranging the world to fit the assertion.
- **No screenshot is kept on success.** Diagnostics exist only for failures, which is the right default for a
  gate but means a passing run leaves no visual record.
- **It proves the amd64 Linux runner.** Like every Docker gate in this repository, the architecture it can
  actually verify is the one CI runs on.
- **It builds the production image a second time.** The job runs in parallel with the release-candidate one,
  so wall-clock is unchanged, but a pull request now pays for two image builds and two Chromium
  installations. Sharing a built image between the jobs would mean an artifact hand-off between them, and a
  gate that depends on another gate's output is a gate that can be fed the wrong bytes.

## Next usable-product step

The catalog can now be filled and read. The obvious next thing an operator needs is to get it back out: a
**catalog export** in the same snapshot format would complete the round trip, make a catalog portable between
installations, and give this acceptance its natural closing assertion — export what was imported and compare
the two documents.
