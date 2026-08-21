# Projection Phase 15 — release candidate, rollback proof, operator smoke, soak and review

## 1. Status and entry

**CONTROL PLANE ONLY. PHASE 15 IS NOT RUN AND NOT CLOSED.** Phase 15 may be prepared after either a Phase 14
GO or the Phase 14 operator preflight, provided every claim the preflight could not close is recorded open
with its required window. Every earlier real run record must name its frozen candidate.

This tranche composes existing proven mechanisms. It does not create a second installer, rollback path,
Usenet client or release pipeline:

- packaging uses the existing consumer release bundle and release-candidate acceptance harness;
- install, upgrade and rollback use `deploy/projection-alpha.sh` literally;
- the soak decision is `phase9RequiresSoakRerun` over the actual changed-path set;
- the operator smoke is the shipped runbook with no hand-run commands;
- an independent reader records findings whether the disposition is ACCEPT or REJECT.

## 2. Entry record

The executable entry record accepts `phase14Disposition` as `go`, `preflight-issued`, or `missing`, plus
booleans stating whether Phase 14's open claims/windows were recorded and whether every earlier run record
names its frozen candidate. `preflight-issued` is a valid preparation entry only when the open-claim record
exists. It is not Phase 14 GO and is never rendered as one.

## 3. Closure evidence

| group | required evidence |
|---|---|
| Packaging | one frozen commit, immutable image digest and reproducible bundle/image result |
| Cleanup and rollback | install, upgrade and rollback each completed; container/network/volume membership preserved; namespace readable after rollback; bytes identical to before upgrade |
| Operator smoke | shipped runbook followed literally; zero commands outside it; zero interventions |
| Soak and sequences | soak ran iff the deterministic changed-path predicate required it; tier one and tier two each completed three consecutive fresh runs with zero skips |
| Independent review | reviewer did not build the tranche; findings were recorded; disposition is `accept` or `reject` |

Every decision-bearing count is a finite non-negative integer. Missing, fractional, negative, `NaN` and
infinite evidence is refused before comparison. A rejected independent review cannot close Phase 15.

## 4. Planner output and non-claims

The planner reports entry refusals, whether the soak is required, the fixed commands/control surfaces for
each evidence group, and every still-open closure condition. It runs no command and mutates nothing.

No second host, high availability, uptime/load figure, automatic source failover, indexer search, download
selection policy, instant Usenet streaming or Real-Debrid support is introduced. Live-provider entry and an
operator maintenance window remain separately authorised actions.

