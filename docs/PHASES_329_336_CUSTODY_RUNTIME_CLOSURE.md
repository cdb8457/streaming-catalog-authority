# Phases 329-336 — Custody runtime closure

Closing the three red offline suites in the release baseline, and closing the way custody is proved.

## What this tranche was asked to decide

Four assertions across three suites had been failing at every release baseline since Phases 297-304:

| Suite | Failing check |
| --- | --- |
| `test/kek-correction-gates.ts` | "the root key is delivered by a bind mount" — `local-runtime-setup.sh` performs no path-based mode, owner or stat operation |
| `test/custody-cutover.ts` | "the steady-state stack has no static KEK anywhere" — the overlay declares the secret the runtime file does not |
| `test/custody-cutover.ts` | "no compose run can fetch an image, and the mode marker is never written by a predictable temp" — root-only removes the marker |
| `test/custody-transition.ts` | "the custody secret helper never takes key material on a command line" — `local-runtime-setup.sh` passes no value for the root key |

Four tranche reports in a row recorded them as pre-existing, belonging to another feature family, and left
them alone. The question this tranche had to answer was whether each was a stale structural assertion or a
real product defect — and to fix whichever it turned out to be, without weakening a test to bless unsafe
behaviour.

## The verdict: four stale assertions, and two real defects found underneath them

**All four assertions were wrong about the product.** Every property they were trying to establish holds, and
held at the time they were written. What broke was how they established it.

**And tracing them turned up two genuine defects** that no existing gate could see, both fixed here.

## Part 1 — Why the four gates failed

Each of the four cut a region out of a shipped shell script by searching for a **literal containing a bare
LF**:

```ts
const body = text.slice(text.indexOf('write_custody_secret() {'));
const helperBody = body.slice(0, body.indexOf('\n}\n'));      // ← the closing brace, typed as LF

const caseLabel = `${'\n'}  root-only)${'\n'}`;                // ← a case arm, typed as LF
const rootOnlyBlock = script.slice(script.indexOf(caseLabel), script.indexOf(defaultLabel));

assert(source.includes('write_custody_secret custodian_root_key\n'));   // ← "and nothing after it", as LF
assert(/custodian_kek:\n\s+file:/.test(bootstrap));                     // ← adjacency, as LF
```

Git's default on Windows is `core.autocrlf=true`. The repository stores LF; an ordinary Windows checkout gets
CRLF in the working tree. None of those literals is present in the bytes of such a checkout.

**The miss was silent, and that — not the line endings — is the defect worth a suite.** `indexOf` answers
`-1`; `String.slice(0, -1)` is a perfectly good string. What came back was not "no match":

- `slice(0, -1)` returned **the rest of the file**. The region searched for `chmod` ran past
  `write_custody_secret` into `write_secret_if_absent` — which chmods ordinary app secrets, by design — and
  the gate reported a custody violation that did not exist.
- `slice(-1, -1)` returned **the empty string**. That gate searched nothing, and failed.

These four failed closed. The identical mechanism fails **open** just as easily: an empty region satisfies
every `!includes` gate ever written, and that version is a green tick over an unread file that nobody
investigates. The four visible failures were the lucky half.

### Why the fix is not line-ending normalisation

Adding `.gitattributes`, or normalising the text before matching, would make all four pass and leave all four
still asserting that *a region of text* contains *a word*. That is the property that broke: the word `chmod`
in a comment, in a string, or in a neighbouring function reads identically to `String.includes`.

The repository had already made this move for its compose gates, and says so in
`test/promotion-chain-operator-ui.ts`:

> These assert what the stack IS, not how its file is typed: the compose files are parsed, so indentation
> width, key order, quoting and line endings cannot decide the verdict.

The shell scripts had been left on raw text. This tranche applies the same principle to them. It also
confirms the design intent that a CRLF checkout is supported: `src/ops/consumer-release-bundle.ts` normalises
every bundled file to LF at packaging time, so what ships to an operator is LF regardless of the checkout the
bundle was cut from. No repository-wide line-ending change was made, and none is needed.

### What replaced them: `test/helpers/shell-source.ts`

A structural reader for the POSIX-shell constructs these scripts are written in. Its governing rule:

> **Every extractor refuses rather than returning a region it is not sure of.**

| Function | Answers | Refuses when |
| --- | --- | --- |
| `parseShellSource` | lines, splitting on CRLF, LF **or** CR | — |
| `functionBody(src, name)` | the brace-matched body of `name() { … }` | the function is absent, opens no block, or is never closed |
| `caseBlock(src, subject)` | the `case "<subject>" in … esac` block | there is not exactly one such `case` |
| `caseArm(block, label)` | one arm, pattern to `;;` | the arm is absent, duplicated, or unterminated |
| `callSites(src, command)` | every call site as a **word list**, across `\` continuations and into `$( … )` | — (a count, never a region) |
| `withoutComment` / `code` | the same source with `#` comments removed, quote-aware | — |

Brace and paren matching skip comments, quoted text and `${…}` parameter expansions. `commandSubstitutions`
returns top-level spans only, and `callSites` descends into them, so a program run inside `$( … )` is a call
site with the arguments it really receives — which is what makes an **argument count** meaningful, and an
argument count is the whole proof that no key travels on a command line.

The four gates now read:

| Was | Is |
| --- | --- |
| `body.slice(0, body.indexOf('\n}\n'))` searched for `chmod` | `functionBody(src, 'write_custody_secret')`, brace-matched — **plus** the contrast that `write_secret_if_absent` *does* chmod, so an empty region cannot pass |
| `source.includes('… custodian_root_key\n')` | `callSite(src, 'write_custody_secret')` and `assertEq(call.length, 2)` — the argument count, which is what the gate always meant |
| `/custodian_kek:\n\s+file:/` on the overlay's text | `parseYaml(…).secrets.custodian_kek.file` — a structure, not an adjacency |
| `script.slice(indexOf('\n  root-only)\n'), …)` | `caseArm(caseBlock(src, 'ACTION'), 'root-only')` — **plus** the contrast that the `bootstrap` arm of the same `case` is the one that writes |

Two of those carry a **contrast assertion** deliberately. A region with no `chmod` in it and a region that is
empty read identically to `assert(!includes(…))`. Asserting that the *neighbouring* region does contain what
it should is what tells a real answer from a vacuous one — and it is the assertion the old mechanism would
have failed.

## Part 2 — The real defects found underneath

### Defect 1 — the PowerShell setup wrote a root wrapping key it could not protect

`deploy/local-runtime-setup.ps1` created `custodian_root_key` through its ordinary secret writer:

```powershell
Write-SecretIfAbsent -Name 'custodian_root_key' -Value (New-RandomSecret)
```

followed by `Set-OwnerOnlyAcl`, whose every failure is swallowed by an empty `catch {}`.

Its Bash twin does the opposite, deliberately. There, custody goes through `deploy/write-custody-secret.mjs`,
which opens the name **once** with `O_CREAT|O_EXCL|O_NOFOLLOW`, sets mode and owner **on the descriptor**,
reads the bytes back from that same descriptor, and creates **nothing** on a host that cannot establish all of
it — naming Windows as such a host in as many words:

> this platform has no file ownership model, so a root wrapping key cannot be created here owned by the
> sidecar runtime user and readable by nobody else. NOTHING WAS CREATED.

So the same installation step was a refusal on one platform and a silent success on the other, and **the
silent one produced the more dangerous artefact**: a real root wrapping key, with an ACL nobody verified,
which every custody check in this project — the backup component model, the legacy-versus-migrated
classifier, an operator reading a `secrets/` listing — would then read as custody established. It had a file.

`test/promotion-chain-operator-ui.ts` already asserted the refusal for the Bash script on Windows, in the same
test, four lines away. One shared list of "runtime secrets" for both scripts is what made the inconsistency
look correct.

**The fix.** `Deny-CustodySecret` replaces the write. It states the same refusal in the same words, and:

- **it refuses that one secret, not the whole setup.** The stack this script installs is
  `docker-compose.runtime.yml`, which runs static KEK custody and has **no custodian sidecar in it at all**;
  nothing there consumes a root wrapping key. Failing the entire Windows setup would remove a supported
  configuration to fix a file that should not have been written.
- **an existing key from an older run is named, not blessed and not deleted.** It is reported `UNVERIFIED`,
  with the advice to treat it as compromised. Removing it is not a setup script's decision — it may be the
  only copy of a key sealing a ring elsewhere.

**What the refusal costs, verified against the real paths rather than reasoned from comments.**
`custodian_root_key` is in `REQUIRED_SECRET_FILES` and is declared by `docker-compose.runtime.yml`, so
omitting it could plausibly have broken both starting the stack and backing it up. It breaks neither:

| Question | How it was checked | Answer |
| --- | --- | --- |
| Does the stack start? | `docker compose config` on a real daemon with the file absent | **Yes.** The resolved config does not mention the secret at all — Compose materialises only what a service consumes, and no service in that file consumes it. |
| Complete backup? | The real `runVerifiedCompleteBackup` against a project shaped as the PowerShell setup leaves one | **Yes**, and it does not invent a placeholder at that name. |
| Why? | `requiredSecretFilesFor(ringPresent)` | The requirement follows **the evidence in the set**: no KEK ring → no root key required. That rule predates this tranche; it was written for released v1.1.4 installations, which have exactly this shape. A set that *does* hold a ring still requires it. |
| What is lost? | — | **Managed-ring custody on that host** — `ops:custody-cutover`, migration and rotation. Newly honest rather than newly lost: the key the old script wrote could never have been trusted for them. |

Both rows are asserted in `test/custody-runtime-closure.ts`, and the operator-facing consequences are
documented in `README.md` and beside the required-secret model in `docs/PHASES_281_284_SIDECAR_CUSTODY.md`.

`RUNTIME_SECRETS` in `test/promotion-chain-operator-ui.ts` splits accordingly: what the *stack declares*
(unchanged, still including `custodian_root_key`) and what a *given host can establish*.

### Defect 2 — a successful custody-mode switch exited 1

Found by running the shipped script rather than reading it.

```sh
TEMP=""
cleanup() { [ -n "${TEMP}" ] && rm -f "${TEMP}"; }
trap cleanup EXIT INT TERM
…
mv -f "${TEMP}" "${MARKER}"
TEMP=""                       # the marker is published; there is nothing left to clean up
```

`cleanup` ends in a **test**. On the successful path `TEMP` is empty, so `[ -n "" ]` is false, the `&&`
short-circuits, and the function returns **1**. It is the last command an `EXIT` trap runs, so the shell
exits 1 — having done everything correctly.

Observed directly on `deploy/unraid-custody-mode.sh <project> bootstrap`: marker written, correct contents,
correct mode, full success output on stdout, **exit status 1**. `status` and `root-only` exit 0.

This is the worst shape a status bug can take. A caller that reads the exit code — an Unraid User Script, a
runbook step, anything that unwinds on non-zero — is told the switch did not happen **after it has been
committed**, and any rollback it takes acts against state that is already correct. It is a direct breach of
the fail-closed rule: the failure signal and the state disagree, and the signal is the wrong one.

**The fix** is `return 0` in `cleanup`. The trap is a cleanup; the verdict belongs to the arm.

No source-text gate in this repository could have caught it. Nothing about that function is wrong to read.

## Part 3 — The new suite

`test/custody-runtime-closure.ts`, registered as `test:phase329-local` and as a required CI gate. 22 checks.

**The extractors, held to their contract** — the same region from the same script under LF, CRLF and CR;
refusal (not a wrong region) when a function, arm or `case` is missing, duplicated or unclosed; an arm chosen
by the `case` it belongs to, on the real script that has *three* `root-only)` arms; argument counting across
continuations and into command substitutions. Plus the old mechanism reproduced as an assertion — including
`slice(-1, -1) === ''`, the direction that would have passed — so nobody restores it.

**The shipped scripts, structurally** — no custody function in any `deploy/*.sh` performs a path-based
`chmod`, `chown`, `stat`, `install`, `touch` or `setfacl`; every custody call site passes a name and no value;
the helper's real argv is a path, a source word and two ids, with no value-producing substitution among them.

**The custody writer against a hostile path** — a symlink planted at the custody path is refused **and what it
points at keeps both its bytes and its mode** (the point of `O_NOFOLLOW`, stated as an outcome rather than as
a flag); a directory at that path is refused and nothing is written inside it; an existing key at 0644 is
refused, and left at 0644 with its value intact — verified, never repaired.

**Partial failure** — a writer that stalls after the first chunk, and a writer that writes the right *number*
of bytes and the wrong *ones*; both refuse, and **neither leaves a file at that name** for the next run to
adopt. The same path then succeeds with an honest writer, so every refusal was the injected failure and not
the fixture.

**The command line as a process really receives it** — the helper spawned for real: no argument is
key-shaped, neither stream carries anything key-shaped, the value it generates appears in no output at all,
a re-run verifies rather than regenerates, and the *old* value-carrying argv form is refused without echoing
what it was handed.

**Windows refusal against POSIX ownership** — the platform gate asked directly for both platforms on every
host, so the rule is exercised where it permits *and* where it refuses. A rule only ever tested on the
platform it permits is not tested.

**The PowerShell refusal** — structurally (the root key reaches `Deny-CustodySecret`, never
`Write-SecretIfAbsent`) and behaviourally (the script executed: every other secret created, no root key, the
refusal printed in the helper's own words, and a re-run that does not relent).

**The marker, executed** — a relative project directory refused before anything is touched; bootstrap
succeeds *and says so*; exactly one file appears and no temporary survives; the marker is private from the
instant it exists; rollback to root-only removes it and writes nothing on the way; every action idempotent in
both status and effect.

## What was deliberately not done

- **No `.gitattributes` and no line-ending normalisation.** It would have made four brittle gates pass while
  leaving them brittle, and CRLF checkouts are a supported configuration the bundler already accounts for.
- **No weakened assertion.** Every property the four gates asserted is still asserted, and two of them are now
  asserted more strongly than before via contrast checks.
- **No source-text copy of a gate that already exists behaviourally.** A draft of the new suite re-asserted
  "no compose run can fetch an image" by reading the deploy scripts. That property is already proved where the
  commands are *built* — `custody-cutover.ts` asserts the argv of every leg from the command ledger, and
  `custody-transition.ts` runs the shipped launcher against a fake `docker` and reads back what it handed
  over. A text version would have been a weaker second copy. It was replaced with a property those two do not
  cover: that `unraid-custody-mode.sh` executes no docker command at all, only prints them.
- **No public CLI or JSON change.** No command, flag, output shape or exit code changed, other than
  `unraid-custody-mode.sh bootstrap` now exiting 0 on success — which is the defect fix. The Windows setup's
  *output* does change (it prints a refusal where it used to print `created`), and that is documented as an
  operator-visible compatibility change in `README.md` rather than filed under "nothing changed".

## Residual risks

- **`custodian_root_key` files created by an older PowerShell setup remain on disk** wherever one was run.
  They are reported `UNVERIFIED` on the next run with advice to treat them as compromised, but nothing
  removes or rotates them automatically. An operator who used the Windows setup and later migrated that
  installation to a POSIX host should rotate the root wrapping key.
- **`deploy/unraid-jellyfin-live-mapping-capture.sh` runs `docker compose up -d postgres sidecar` without
  `--pull never`**, and builds an evidence temporary as `"${OUT_FILE}.tmp-$$"` — a predictable name written
  through a redirection. It is a deliberately network-enabled live-capture script and is outside this
  tranche's custody/cutover scope, so it was left alone rather than changed under a custody mandate. Recorded
  here because it was seen, not because it is closed.
- **The Windows arms of the POSIX-only checks are skips, not passes.** Symlink, mode and ownership behaviour
  is asserted on POSIX and announced as skipped elsewhere; the platform *gate* is asserted on every host.
