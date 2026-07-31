# Phases 329-336 — Custody runtime closure

**The three red suites in the release baseline are green, and the baseline has no inherited exceptions left.**

Design document: [`docs/PHASES_329_336_CUSTODY_RUNTIME_CLOSURE.md`](docs/PHASES_329_336_CUSTODY_RUNTIME_CLOSURE.md).

## The task, and what the evidence said

Three suites had been failing at every release baseline since Phases 297-304 — four assertions in total —
and four consecutive tranche reports recorded them as pre-existing, another feature family, left alone.

**Verdict: all four were stale structural assertions. The product was correct in every case.** Each cut a
region out of a shipped shell script by searching for a literal containing a bare LF (`'\n}\n'`,
`'\n  root-only)\n'`, `'…custodian_root_key\n'`, `/custodian_kek:\n\s+file:/`). Git's default on Windows is
`core.autocrlf=true`, so no such literal exists in the bytes of an ordinary Windows checkout.

The miss was **silent**, which is the part that mattered: `indexOf` answered `-1`, and `slice(0, -1)` returned
*the rest of the file* while `slice(-1, -1)` returned *the empty string*. One gate searched a region three
functions too long and found a legitimate `chmod` belonging to `write_secret_if_absent`; another searched
nothing at all. Reversed, the identical bug produces a **green tick over an unread file**.

**And tracing them surfaced two real product defects**, neither of which any existing gate could see. Both are
fixed here.

## What changed

### Production

| File | Change |
| --- | --- |
| `deploy/local-runtime-setup.ps1` | **Defect fix.** Stops creating `custodian_root_key` through the generic secret writer + best-effort ACL. New `Deny-CustodySecret` refuses that one secret in the POSIX helper's own words, keeps the rest of the Windows setup working, and reports a pre-existing key as `UNVERIFIED` rather than deleting or blessing it. |
| `deploy/unraid-custody-mode.sh` | **Defect fix.** `cleanup()` now `return 0`s. It ended in a test that is false on the success path, so the `EXIT` trap returned 1 and a **successful `bootstrap` exited 1**. |

### Tests

| File | Change |
| --- | --- |
| `test/helpers/shell-source.ts` | **New.** Structural reader for the shipped shell scripts: brace-matched function bodies, `case` blocks and arms, word-split call sites across `\` continuations and into `$( … )`, quote-aware comment stripping. Every extractor **refuses rather than returning a region it is unsure of**. |
| `test/custody-runtime-closure.ts` | **New**, 22 checks. The phase329 suite. |
| `test/kek-correction-gates.ts` | The custody-helper gate is brace-matched, plus a contrast assertion that `write_secret_if_absent` *does* chmod — so an empty region cannot pass. |
| `test/custody-transition.ts` | The command-line gate counts **arguments** instead of asserting an LF terminator, and now also counts the helper's real argv and rejects value-producing substitutions in it. |
| `test/custody-cutover.ts` | The overlay gate **parses the YAML**; the marker gate uses `caseArm(caseBlock(src, 'ACTION'), …)` plus a contrast assertion on the `bootstrap` arm. |
| `test/promotion-chain-operator-ui.ts` | `RUNTIME_SECRETS` splits into what the stack *declares* and what a host can *establish*; the PowerShell arm asserts the refusal, on the first run and on the re-run. |

### Registration

| File | Change |
| --- | --- |
| `package.json` | `test:custody-runtime-closure`, `test:phase329-local` |
| `test/suite-inventory.json` | `custody-runtime-closure.ts`, group `offline` |
| `src/ops/release-readiness.ts` | `test:phase329-local` added to `REQUIRED_SUITE_SCRIPTS` |
| `.github/workflows/runtime-image.yml` | New required `suites` step running `test:phase329-local` |

### Documentation

| File | Change |
| --- | --- |
| `docs/PHASES_329_336_CUSTODY_RUNTIME_CLOSURE.md` | **New.** The design record. |
| `PHASES_329_336_REPORT.md` | **New.** This report. |
| `README.md` | **Operator-visible behaviour change.** New section: the Windows setup refuses `custodian_root_key` and prints why; the Windows local runtime stack is static-KEK custody only; complete backups still work and why; managed custody needs a POSIX host; an older Windows key is reported `UNVERIFIED`. |
| `docs/PHASES_281_284_SIDECAR_CUSTODY.md` | Amendment beside the required-secret model, stating that the requirement follows the evidence in the set, and what the PowerShell refusal does and does not cost. |

### This IS a documented compatibility change

An earlier draft of this report said no operator-doc change was needed. **That was wrong**, and an independent
review caught it. `deploy/local-runtime-setup.ps1` now deliberately omits a file that
`src/ops/backup-components.ts` lists in `REQUIRED_SECRET_FILES` and that `docker-compose.runtime.yml` declares.
That is an operator-visible change to what a Windows install produces, and it is now documented in both places
above. Its consequences were verified against the real setup, Compose and backup paths rather than inferred
from comments:

| Question | Verified how | Answer |
| --- | --- | --- |
| Does the Windows stack still start without the file? | `docker compose -f docker-compose.runtime.yml config` against a secrets directory with the root key absent, on a real daemon | **Yes.** Exit 0, and the resolved config does not mention `custodian_root_key` at all — Compose materialises only secrets a service consumes, and no service in that file consumes it. Asserted from the parsed stack in `custody-runtime-closure.ts`. |
| Can such an installation take a complete backup? | The real `runVerifiedCompleteBackup` driven against a project holding exactly the files the PowerShell setup leaves | **Yes**, `ok: true`, verifier agrees, and the set does **not** invent a placeholder at that name. |
| Why is the required-secret model satisfied? | `requiredSecretFilesFor(ringPresent)` in `src/ops/backup-components.ts` | The requirement follows **the evidence in the set**, not the stack's declaration: no KEK ring in the keystore → no root key required. A Windows install has no sidecar, so never a ring. A set that *does* hold a ring still requires it — the refusal weakens nothing for a migrated installation. |
| What is genuinely lost? | — | **Managed-ring custody on that host.** `ops:custody-cutover`, ring migration and root rotation need a POSIX host. This is not new capability loss so much as newly *honest*: the key the old script wrote could never have been trusted for those operations anyway. |

No other documented command, flag, output shape or exit code changed, other than
`unraid-custody-mode.sh bootstrap` now exiting 0 on success — which is the defect being fixed, and which no
document had described as anything else.

## The two defects, stated plainly

### 1. The PowerShell setup wrote a root wrapping key it could not protect

`deploy/local-runtime-setup.ps1` created `custodian_root_key` with `Write-SecretIfAbsent` — a real 32-byte
key — and then applied `Set-OwnerOnlyAcl`, whose every failure is swallowed by an empty `catch {}`.

Its Bash twin refuses. `deploy/write-custody-secret.mjs` opens the name once with
`O_CREAT|O_EXCL|O_NOFOLLOW`, sets mode and owner on the **descriptor**, reads the bytes back from that same
descriptor, and creates **nothing** on a host that cannot establish all of it — naming Windows explicitly:
*"this platform has no file ownership model … NOTHING WAS CREATED."*

The same installation step was a refusal on one platform and a silent success on the other, and the silent one
produced the more dangerous artefact: a root wrapping key with an ACL nobody verified, which the backup
component model, the legacy-versus-migrated classifier and an operator reading a `secrets/` listing would all
take as custody established.

The refusal is scoped to that one secret. `docker-compose.runtime.yml` — the stack this script installs — runs
static KEK custody and contains **no custodian sidecar**, so nothing there reads a root wrapping key. Failing
the whole Windows setup would have removed a supported configuration to fix a file that should not exist.

### 2. A successful custody-mode switch exited 1

```sh
cleanup() { [ -n "${TEMP}" ] && rm -f "${TEMP}"; }   # ends in a TEST
trap cleanup EXIT INT TERM
… mv -f "${TEMP}" "${MARKER}"; TEMP=""              # success clears TEMP, so the test is false
```

The trap's last command returned 1, so the shell exited 1. Observed directly: marker written, correct
contents, correct mode, full success output, **exit status 1**.

A caller that unwinds on non-zero is told the switch did not happen *after it has been committed*, and rolls
back against state that is already correct. The failure signal and the state disagree, and the signal is the
wrong one — a direct breach of the fail-closed rule.

Found by **running** the script. No source-text gate could have caught it; nothing about that function is
wrong to read.

## Non-negotiables, re-verified

| Invariant | Evidence |
| --- | --- |
| Root key never in argv, env, Compose secret material, logs, reports, predictable temp paths or world-readable files | `custody-runtime-closure.ts` spawns the real helper and inspects real argv and both streams; argument counts asserted at every call site; `--pull never`/no-value argv gates; marker temp is `mktemp … XXXXXXXXXX` under `umask 077` |
| The sidecar alone receives it, via an owner-only host file / bind mount with verified UID/GID and mode | `kek-correction-gates.ts` (parsed compose + descriptor-based helper); `o4-o5-runtime-acceptance.ts`; reader still refuses any group/other bit |
| Ordinary app/runtime cannot read it | `custody-cutover.ts` parsed-YAML gate: no other service has a mount or secret entry |
| No maintenance/cutover compose run may pull an image | `custody-cutover.ts` command ledger (argv of every leg); `custody-transition.ts` launcher executed against a fake `docker` |
| Mode/cutover marker created atomically at an unpredictable private path, never deleted through an attacker-chosen name | Marker script **executed**: one file appears, no temporary survives, `0600`-private, atomic `mv`, `trap cleanup EXIT` |
| Failure and rollback fail-closed and redaction-safe | Partial-failure injection leaves **no file**; rollback to root-only removes the marker and writes nothing; **and the exit-status defect above is fixed**, which is the one place this was actually broken |

## Verification

All commands run in this worktree at `ddc1f8b0` + this tranche.

### The three formerly-red suites

| Suite | Baseline | Now |
| --- | --- | --- |
| `test/kek-correction-gates.ts` | 37 passed, **1 failed** | **38 passed, 0 failed** |
| `test/custody-cutover.ts` | 22 passed, **2 failed** | **24 passed, 0 failed** |
| `test/custody-transition.ts` | 14 passed, **1 failed** | **15 passed, 0 failed** |

Baseline figures are those recorded in `PHASES_321_328_REPORT.md` and reproduced independently at the start of
this tranche.

### Aggregate gates

| Command | Result |
| --- | --- |
| `npm run typecheck` | **exit 0** |
| `npm run test:inventory` | **exit 0** — no drift; `custody-runtime-closure.ts` registered |
| `npm test -- --group offline` | **291 selected, 291 passed, 0 failed, 0 required-but-skipped** (513s) |
| `npm test -- --group db` | **33 selected, 33 passed, 0 failed** (190s) |
| `npm run test:docker-suites` | **2 selected, 2 passed, 0 failed** (`--require-capabilities`) |

**The offline group has no inherited exceptions.** The previous baseline was 287 selected / 284 passed /
3 failed, with the three failures carried forward through four tranches. It is now clean.

**One intermittent, reported rather than hidden.** The group was run five times. Four runs were
291/291. One run failed a single check in `external-snapshot-produce.ts` —
"two no-overwrite publishers cannot both succeed, and the winner is complete", at the *deliberate overwrite*
leg (`publishTemporary(third, destination, true)`), with "the snapshot could not be moved into place". That
is a `rename()` over an existing destination on Windows, which fails transiently with `EPERM` when another
process (an indexer or scanner) holds the destination for a moment.

It is recorded as a flake on this evidence, not assumed to be one:

- the suite passed **43/43 on five consecutive individual runs** afterwards;
- it passed in **both** full sweeps before the change that preceded the failing run, and in the sweep after;
- it imports nothing this tranche touched — `catalog-snapshot-produce`, `catalog-import-inbox` and
  `catalog-import`, none of which reach custody, the shell reader or the backup components;
- the failing operation is a filesystem race with no input from this tranche.

### The new suite and the affected ones

| Suite | Result |
| --- | --- |
| `test/custody-runtime-closure.ts` (new) | **22 passed, 0 failed** |
| `test/promotion-chain-operator-ui.ts` | **19 passed, 0 failed** — includes the PowerShell setup **executed** on this host |
| `test/release-readiness.ts` | **44 passed, 0 failed** — the mutation test removes each required suite command in turn and requires a BLOCK; it now covers `test:phase329-local` |
| `test/deploy.ts`, `test/o4-o5-runtime-acceptance.ts`, `test/consumer-release-image.ts`, `test/arcane-install.ts`, `test/managed-custody-lifecycle.ts`, `test/custodian-contract.ts`, `test/backup-inspect.ts`, `test/complete-backup.ts` | all **exit 0** within the offline group |

### Environment-only skips, with reasons

- **The image-building Docker acceptance** (`PHASE244_DOCKER_SMOKE=1`, `REQUIRE_ACCEPTANCE=1`) was not run. A
  daemon **was** available this run — unlike the previous four tranches — and the `docker` group was executed
  for real. What was not run is the opt-in leg that builds and pulls images, because it reaches a network;
  the two suites in the group are its deterministic contract and both pass. The suites themselves assert that
  a skip can never be read as a pass and that an unreachable daemon under `REQUIRE_ACCEPTANCE=1` is a failure.
- **POSIX file-ownership behaviour** (symlink refusal, mode verification, `fchown` partial-failure cleanup) is
  asserted on POSIX and announced as skipped on this Windows host. The **platform gate itself** is asserted on
  every host for both arms, so the Windows refusal is proved here rather than assumed.
- **One pre-existing skip inside `shared-destination-lock.ts`** — "a holder note that is a symbolic link stops
  the release" — this host permits no file symbolic link without privilege. Unchanged by this tranche.
- **A real `pg_dump`/`psql` binary** — the embedded PostgreSQL package ships neither. Pre-existing, already
  recorded in `test/backup-inspect.ts`.

## Residual risks

- **A Windows installation cannot move to managed-ring custody on that host.** It never really could — the
  key the old setup wrote had an ACL nobody had verified — but the limitation is now explicit rather than
  disguised by the presence of a file. Static-KEK custody, which is what that stack runs, is unaffected, and
  so are complete backups. An operator who needs managed-ring custody runs the setup on the POSIX host that
  will run the sidecar.
- **`custodian_root_key` files created by an older PowerShell setup remain on disk** wherever one was run.
  The next run reports them `UNVERIFIED` and advises treating them as compromised; nothing removes or rotates
  them automatically, because a setup script deleting what may be the only copy of a key sealing a ring
  elsewhere is not a decision it may take. An operator who used the Windows setup and later moved that
  installation to a POSIX host should rotate the root wrapping key.
- **`deploy/unraid-jellyfin-live-mapping-capture.sh`** runs `docker compose up -d postgres sidecar` without
  `--pull never` and builds an evidence temporary as `"${OUT_FILE}.tmp-$$"` — a predictable name written
  through a redirection. It is a deliberately network-enabled live-capture script, outside this tranche's
  custody/cutover scope; left alone rather than changed under a custody mandate. Recorded because it was
  seen, not because it is closed.
- **POSIX-only checks are announced skips on Windows.** Symlink, mode and ownership behaviour is asserted on
  POSIX and skipped-with-a-reason elsewhere. The platform *gate itself* is asserted on every host, both arms.
- **The shell reader is not a POSIX shell parser.** It handles the constructs these scripts are written in and
  refuses on anything it cannot account for. A script written in a style it does not model would produce a
  named error, not a wrong answer — which is the property that matters, but it does mean a future script may
  need the reader extended.
