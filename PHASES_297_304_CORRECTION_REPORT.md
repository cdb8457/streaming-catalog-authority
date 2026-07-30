# Phases 297–304 — correction tranche report

Commit `1b2e510`, from `9063ecf`. Worktree clean. Nothing pushed, no PR, no live system touched.

## Every review item, and what it became

| # | Finding | Correction |
| --- | --- | --- |
| 1 | Confirmation bound only part of the operation; rendering leaked host paths | `canonicalOperation()` binds project root, destination, set name + resolved path + verified `setDigest` + schema, custody, **every component target path**, components present, target-state, safety-set name, safety/data-loss choice, and exact ordered argv. Rendering shows `<project>` / `<staged>` only |
| 2 | `EMPTY` inferred from host directories | `EMPTY` **removed**. `OCCUPIED` \| `UNKNOWN`; both require a verified safety set or the digest-bound `--accept-data-loss`. Non-mutating `compose ps` probe can only *add* occupancy; unanswerable fails closed |
| 3 | Journal trusted; abandon used CLI paths | Full schema + semantic validation (suffix shape, usable names, custody/sidecar agreement, safety-set consistency, known/unique/ordered-prefix steps, legal running step, swap shape, `.replaced-` name provenance). Journal carries the operation's own request and swaps. `--abandon` and `--resume` take **only `--project`**. Abandon refuses to clear the journal while any swap is unresolved |
| 4 | Set could change after verification | New `stage-components` step **before the teardown**: descriptor-safe copy of every component, re-verified against the manifest's digest / entry count / byte count. All placements and the replay read the staged object |
| 5 | Vacuous decryption proof | New `ops:custody-proof` — decrypts through the shipped `CatalogAuthority.readIdentity` and this installation's custodian. Read-only, bounded documented sample, counts/categories only. `NO_ENCRYPTED_RECORDS` reported honestly with `proven: false`. Restore consumes the body through `readCustodyProof` |
| 6 | Post-destructive failure exited 3; irrelevant flags accepted | `CompleteRestoreFailed` → exit **1**. `MODE_VALUE_FLAGS` allowlist per mode; usage rewritten to match |
| 7 | Report/rendering claims | `replaced` built from the journal, so a resumed run names every kept directory. No absolute path in any rendered surface. Docs rewritten |

## The seven behaviours, executed against `9063ecf`

Not argued — run. Baseline extracted with `git archive 9063ecf` into a scratch tree and driven directly:

```
DEFECT CONFIRMED  target-path digest binding       — a DIFFERENT secrets target produced the SAME digest
DEFECT CONFIRMED  sidecar cross-project replay     — IDENTICAL digests for two different projects
DEFECT CONFIRMED  empty host dirs called EMPTY     — classified EMPTY, so `down -v` runs with no safety set
DEFECT CONFIRMED  abandon with altered CLI paths   — reported ok, CLEARED the journal, orphaned .secrets.replaced-*
DEFECT CONFIRMED  unverified bytes restored        — bytes written into the set AFTER it verified were restored
DEFECT CONFIRMED  vacuous decryption proof         — ran `ops:collections -- status`, which opens no key
DEFECT CONFIRMED  host paths in rendered plan      — the plan printed the absolute project path
DEFECT CONFIRMED  irrelevant flags accepted        — --accept-data-loss accepted with --resume, then ignored
```

Cross-project replay in **inline** custody did *not* reproduce: the baseline digest was protected only
incidentally, because `place-inline-keystore`'s argv happens to carry the set path. Sidecar custody places its
keystore by rename and issues no such command, so it collided outright. The regression now covers **both**
topologies, and the commit message says why.

## Test results

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | **PASS**, 0 errors |
| `npm run test:complete-restore` | **63 passed, 0 failed** (was 42) |
| `npm run test:complete-backup` | **49 passed, 0 failed** |
| `npm run test:custody-proof` | **9 passed, 0 failed** — real embedded PostgreSQL, real key material |
| `npm run test:inventory` | **ok: true**, 322 suites, 6 helpers |
| `test/test-runner.ts` | 60 passed, 0 failed |
| `test/backup-inspect.ts` | 60 passed, 0 failed, 1 skipped (pre-existing: no `pg_dump` binary) |
| `test/doctor-monitor.ts` / `test/upgrade-rehearsal.ts` | 19 / 49 passed, 0 failed |
| `npm test -- --group db` | **33/33 PASS** |
| `npm test -- --group offline` | 287 selected, **284 pass, 3 fail — all pre-existing at baseline** |
| `npm test -- --group docker` | **NOT_RUN** |

### Pre-existing offline failures (unchanged, verified at baseline in the prior dispatch)

`custody-transition.ts` (1), `kek-correction-gates.ts` (1), `custody-cutover.ts` (2) — all in the
custody/compose-wiring family, all failing identically on `b704935`. Left untouched: fixing them would
broaden this tranche into unrelated phases.

### NOT_RUN, with reasons

- **Docker acceptance group** — no daemon: `failed to connect to the docker API at
  npipe:////./pipe/dockerDesktopLinuxEngine … The system cannot find the file specified.`
- **A live `ops:complete-restore --confirm`** — needs a real daemon, real images, a real installation.
- **A live `ops:custody-proof` inside a container** — same reason. Its logic is fully exercised against a real
  database and real custodians by `test/custody-proof.ts`; what is unexercised is only the `compose exec`
  transport, which the restore suite covers against the modelled stack.
- **Real `pg_dump`/`psql` binaries** — the embedded PostgreSQL package ships neither (pre-existing skip).

## Also fixed: a pre-existing defect on this command's path

`--secrets` was refused by the shared credential-word scan, because `"secrets"` contains `"secret"` — so
`ops:complete-backup -- --secrets <rel>`, a flag its own usage text documents, could not be used at all.
Confirmed against baseline. The blunt scan is unchanged; a one-entry exact-name allowlist exempts the flag
that names a *folder of* credentials rather than a credential. `--secret`, `--secrets-value` and everything
else are still refused.

## What a reviewer should look at next

1. **The `UNKNOWN` path costs the DR case an acknowledgement.** Restoring onto a fresh machine now requires
   `--accept-data-loss <digest>`. That is correct — the volumes genuinely are not provably empty — but it is
   a real ergonomic change and worth confirming as the intended trade.
2. **The occupancy probe is `compose ps -a --quiet`.** It is only consulted when host directories are empty.
   Whether a stronger non-mutating volume probe exists on the supported topologies is an open question; the
   current answer is deliberately conservative rather than clever.
3. **The custody proof's bound is 25 by default.** `PROVEN` over a sample is a proof about that sample, stated
   in the report and the docs. Whether the default should be higher for a post-restore proof is a policy call.
4. **`complete-restore.ts` still imports `readSchemaVersions` from `upgrade-rehearsal.ts`** for one parser —
   carried over, no cycle, still the wrong home.
5. **Inline custody on a bind-mounted keystore** (rather than a volume) remains the open topology question
   from the first review; `down -v` would not empty it.
6. **The staging directory holds a copy of every secret** for the duration of a run. It is removed on success
   by digest-checked ownership and deliberately left for a resume on failure, with a note saying so.
