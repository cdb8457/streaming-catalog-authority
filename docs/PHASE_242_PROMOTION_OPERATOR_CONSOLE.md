# Phase 242: Promotion Record Chain Operator Console (local, non-live)

Report id: `phase-242-promotion-operator-console`

Status: `PHASE_242_PROMOTION_OPERATOR_CONSOLE_READY`

One command over the whole Phase 231–241 chain. Point it at a directory of artifacts and it tells you what
the chain proves, how far it actually reaches, what is outstanding, and exactly what a human should safely do
next — without anyone having to name ten files, remember which phase produces which artifact, or interpret a
status code.

It adds **no evidence semantics**. The Phase 241 packet reaches the verdict, unchanged; this phase only makes
that verdict, and what to do about it, legible.

## Why this phase exists

Phases 231–241 are correct and they are unusable. Reaching a verdict before this phase meant knowing which of
ten reports exist, naming each on its own flag, and reading a machine report to work out what came next. Every
one of those is a place to get it wrong — and getting it wrong *quietly* is the failure mode that matters. A
person who cannot tell **"this chain is honestly unfinished"** from **"this chain is broken"** will eventually
treat one as the other.

So the console's whole job is to make that distinction impossible to miss.

## It creates nothing and decides nothing

`approvalCreatedByThisTool`, `executionPerformedByThisTool`, `observationCapturedByThisTool`,
`custodyHeldByThisTool`, `archivedByThisTool`, `judgmentFormedByThisTool`, `humanDecisionInferredByThisTool`,
`promotionRunByThisTool` and `selfAuthorized` are all the constant `false`.

Every line of guidance it emits is a **fixed lookup** from the outcome and the phase actually outstanding. It
is never a recommendation about whether the promotion should proceed, and never an inference about what a
human meant.

## Usage

Invoke it **directly**. This form behaves identically on PowerShell, cmd and bash:

```
npx tsx src/ops/promotion-operator-console-cli.ts --dir <artifact-directory> [--out report.json] [--json] [--quiet]
npx tsx src/ops/promotion-operator-console-cli.ts --bundle <bundle.json> [--out report.json]
npm run ops:promotion-operator-console:help
```

> **Do not pass flags through `npm run … -- <flags>`.** It is not portable. PowerShell consumes the first
> `--` itself, so npm receives the tool's flags as its **own**: `-- --help` prints *npm's* help, and
> `-- --dir X` reaches this tool with **no arguments at all** — which reads as the tool ignoring you. The
> `ops:promotion-operator-console` script still works for a bare run, and
> `ops:promotion-operator-console:help` bakes `--help` into the script so there is no `--` to lose; for
> anything with flags, use the direct form above. Running with no intake prints this same guidance on stderr,
> so an operator who trips over it is handed a working command rather than a puzzle.

| `overall` | Meaning | Exit |
| --- | --- | --- |
| `AUDIT_CLOSED` | all ten artifacts present, genuine, cross-bound and each in its own terminal state | `0` |
| `AUDIT_INVALID` | fail closed — an intake defect, or the audit found the chain does not hang together | `1` |
| (usage / input error) | no intake, two intakes, or an unreadable directory or bundle | `2` |
| `AUDIT_OPEN` | consistent as far as it goes, and not yet closed | `3` |
| `NOT_ELIGIBLE` | no genuine Phase 231 anchor, so nothing can be audited against anything | `5` |

These are the Phase 241 exit codes deliberately: the same verdict exits the same way.

## Intake

**`--dir` — allowlisted discovery.** The console looks only for the **fixed filenames** below, joined to that
one directory, **non-recursively**. Two names are accepted per phase — the canonical one, derived from the
report id the Phase 241 packet requires so it can never drift, and a short form for typing by hand:

```
231  phase-231-promotion-execution-authorization.json          or  phase-231.json
...
240  phase-240-promotion-evidence-retention-inventory.json     or  phase-240.json
```

No filename, glob or path is ever taken from the data being read, so a hostile artifact cannot steer a read.
Anything else in the directory is **counted and left alone** — never read, never named, never echoed. Both
accepted names present for one phase is a `DUPLICATE` and fails closed: choosing one would be guessing which
artifact the operator meant.

**`--bundle` — an explicit JSON object** keyed `"231".."240"`. Unknown keys fail closed and are neither read
nor echoed. An array under one phase is a `DUPLICATE`.

## Four ways an artifact can fail to be there

Collapsing these into "missing" is exactly the mistake that lets a broken chain read as an unfinished one, so
each is reported separately and means something different:

| Status | Meaning | Defect? |
| --- | --- | --- |
| `ABSENT` | the phase has not happened yet | **No.** Normal, never a blocker |
| `MALFORMED` | something in that slot is not a chain report at all — unreadable, not JSON, not an object, or an unrecognised report id | Yes |
| `MISFILED` | a genuine chain report, filed under the wrong phase | Yes |
| `DUPLICATE` | two artifacts claim the same phase; the console will not guess which is authoritative | Yes |

## What is needed next

`nextRequiredPhase` is the phase whose work is actually outstanding — and a phase that is **present but not
yet terminal takes precedence over the first absent one**. This is not a detail. The real P227-A chain holds
at an *undecided* Phase 232; reporting Phase 233 as "next" would tell an operator to record an observation of
a run nobody has authorized. An unfinished phase is finished on its own terms before any later phase can
exist.

"Outstanding" is therefore **not** a synonym for "absent", and the help text, disclaimers and next steps all
say *outstanding* — describing it as "the first absent phase" would document a rule the tool does not follow.

## Rejecting what does not belong

Everything the console could not recognise as a chain artifact is screened through the **Phase 240**
location/live-surface predicate in full: URL schemes, hostnames, IP literals, UNC and drive-letter paths,
object-store buckets and live Jellyfin surfaces all fail closed (`CONSOLE_LIVE_DATA_PRESENT`).

That strict predicate is deliberately **not** applied to chain-shaped reports, because their own boundary
prose legitimately names the live surfaces they avoid ("no live Jellyfin call") — a false positive there would
make every real chain unauditable. Those are screened by the **Phase 241** raw-path scanner instead
(`CONSOLE_RAW_PATH_PRESENT`), the same split Phases 236 and 241 already make, for the same reason. Artifacts
that reach the audit are screened by the audit itself, so nothing is scanned twice and no defect is reported
under two codes.

Both predicates are the existing ones, imported. This phase restates no validation semantics of its own.

## Blockers

Every code — the console's own and the Phase 241 packet's — is paired with **fixed, value-free** text: what it
means, and what a human should do about it. The text is keyed by the code's phase-independent suffix, so one
entry serves all ten phases.

Where it matters, the action also says what *not* to do. Re-sealing an artifact to clear a blocker is always
available and never helps, because the next person re-derives the chain from the same inputs; and no blocker
is ever cleared by deleting or archiving an artifact, since no valid record in this chain can express
destruction.

## Redaction

The console **never echoes its input**. Not one string from the intake reaches the output: the report is built
from fixed text, counts, phase numbers, and the Phase 241 packet — which is itself redaction-safe. No path, no
directory, no filename, no item id, no approval id or value, no identity, no timestamp, no secret. Unreadable
input is reported as a defect without naming the path that produced it.

## Honest limits

* `AUDIT_CLOSED` means the records are mutually consistent and each is sound by its own criteria. It does
  **not** mean the promotion happened, was correct, or was authorized by anyone in particular.
* Self-digests are not signatures. A party controlling every artifact can fabricate a bundle that audits as
  `CLOSED`. The proof-limit matrix inside the embedded Phase 241 report states each phase's own honest limit,
  and it travels inside this report so the caveat cannot be separated from the verdict.
* The console proves nothing the chain did not already prove. It is a usability layer, and that is all.

## Tests

`npm run test:phase242-local` — 21 cases, including: a complete chain closing; every clean prefix reading open
with zero blockers; absent/malformed/misfiled/duplicate told apart; `NOT_ELIGIBLE` precedence; live, network
and location payloads failing closed while a genuine chain is never falsely flagged; a raw path smuggled into
an artifact the audit never sees; a forged headline explained as a forgery rather than an unfinished phase;
full blocker-text coverage; determinism; cyclic and 20 000-deep intake terminating; the whole CLI exit-code
contract; and end-to-end fixtures over the **actual P227-A chain**, which reads as honestly open, is never
reported as closed or eligible, and cannot be talked into closing by bolting on a finished-looking tail.
