# Phase 256: the backup that was missing a third of itself

The `back-up` step on the operator page said this:

> **Your secrets and your database are the two things an upgrade cannot regenerate.** Copy `./secrets/`
> somewhere safe and dump the database.

That is not a complete backup, and the way it is wrong is worse than being incomplete: it is a **closed
list**. "The two things" tells a reader they are done. Nobody goes looking for a third.

The third thing is the **custodian keystore** — the wrapped data-encryption keys. It lives on its own volume
precisely so that a database dump is never also a key backup. That is a good decision, and it is exactly why
the keystore has to be backed up on purpose.

An operator who followed that instruction to the letter, and then needed it, would restore the database and
the secrets and get an installation that **starts, reports itself healthy, passes every check in
`ops:doctor`, and cannot decrypt a single item.** An unreadable item is indistinguishable from a correctly
fail-closed one, so nothing anywhere reports a problem.

## It was already known, in a different file

`docs/LIFECYCLE_MIGRATION_BACKUP_UPGRADE_ROLLBACK.md` said, in its Backup section:

> Back the keystore up separately, and treat it with the care you would treat a key.

and then, four paragraphs later, in its own **Upgrade** checklist:

> 2. **Back up.** Database dump and `./secrets/`.

Two surfaces, three answers, and the one on the screen in front of the operator was the wrong one. This is
what prose spread across files does, so the fix is not better prose.

---

## 1. One model

`src/ops/backup-components.ts` is the list. Four components, each with what it is, what is lost without it,
the backup and restore command for both platforms, and a caveat.

| Component | What is lost without it |
| --- | --- |
| **The database** | Everything this installation has ever recorded. |
| **The custodian keystore** | The database restores and *nothing in it can be decrypted*. The service starts and reports itself healthy. |
| **The secret files** | The KEK unwraps nothing, shred completion can never verify, and PostgreSQL refuses the password its volume was initialised with. |
| **The promotion record artifacts** | The evidence you loaded. This product never produced those files and cannot recreate them. |

Every one is `regenerable: false`. That is the finding stated as a field: **there is nothing in a complete
backup of this product that can be downloaded again.** The flag exists so a component added later has to
answer the question rather than inherit an assumption.

The first-run checklist step, the new **Backup & restore** panel and the troubleshooting table all render
from this module — the checklist step's backup command and the troubleshooting entry's restore command are
read out of it, so no two surfaces can show different commands.

`docs/LIFECYCLE_MIGRATION_BACKUP_UPGRADE_ROLLBACK.md` is prose and does not render from anything, so it is
held to the model by a test instead: the document must say four things, must no longer carry the old
two-item claim, and its Upgrade checklist must no longer contradict its own Backup section.

### And in sidecar mode the keystore is somewhere else

The Unraid launcher stack runs the custodian as a sidecar whose `SIDECAR_STATE_DIR` is a `FileCustodian`
keystore under a different path. Same material, same consequence, second place to forget. It maps to the same
component deliberately — an operator has one thing to remember — and the component text names both places.

## 2. Coverage, enforced against the shipped stacks

The defect was not that somebody wrote the wrong sentence. It was that **a volume existed that nobody's
backup instructions mentioned, and nothing could notice.**

`assertBackupCoverage` walks every mount in a Compose stack and refuses any container path that is neither
claimed by a backup component nor explained by a stated exclusion. All four shipped stacks are checked:
`docker-compose.runtime.yml`, `docker-compose.arcane.yml`, `docker-compose.unraid.yml` and
`docker-compose.unraid.runtime.yml`. **A stack that gains persistent state and does not say what a backup does
about it fails a test.**

* Coverage is decided by the **container** path. The host side is `${VAR:-default}` in three of the four
  stacks and is a different string on every machine; the container side is fixed by this project.
* Two Unraid mounts write a directory at its own host path inside the container, so a command running there
  can be handed a host-shaped path. One leading `${…}` expansion is stripped so the two spellings of the same
  place answer identically — and only one, and only at the start, so a variable in the middle of a path
  stays undecided rather than being guessed at.
* Long-syntax mounts are read too, so changing notation cannot silence the check. A mount with no string
  target is a refusal, not a skip.
* Declared Compose secrets are covered even though they appear in no mount list.
* Every uncovered path is reported in one run, not just the first.

Exclusions are arguments, not silence. There are two, both used by a shipped stack, both stating why:

| Exclusion | Why |
| --- | --- |
| `runtime-socket` | A socket directory, recreated on start. Copying it restores nothing, and restoring a stale socket is worse than having none. |
| `backup-destination` | Where backups are written to. An output of a backup, not state a backup must capture. |

## 3. What the operator sees

A **Backup & restore** panel, server-rendered and readable **without a token** — the same decision as the
first-run checklist, for the same reason: the moment you need a backup instruction is not reliably a moment
when you can log in.

It leads with the four-item sentence, then gives each component's backup command, restore command and caveat,
per platform. Every command is one a person with only Docker can run: no `npm`, no `npx`, no `node`, asserted
by a test, because the audience installed a release bundle and has no toolchain. No command names a home
directory, an Unraid share, a Windows drive path, an IP address or a URL — the same host-identity rule the
checklist has always been held to.

A new **restore** lifecycle step and a new troubleshooting entry —
*"a restore finished, the stack starts, and nothing can be read"* — name the keystore as the cause and say
plainly that if the copy does not exist, the keys are gone and nothing here can regenerate them.

The `docker compose cp` form is used for the keystore because it is identical on every platform and needs no
knowledge of the generated volume name. Its restore is `stop` → `cp` → `start`, **not** `down` → `cp`:
`docker compose down` removes the container that `cp` needs, so the first version of that command could not
work. A test now refuses any command that pairs a `compose down` with a `compose cp`.

---

## What this phase does not do

It adds no route, no write and no mutation. `backup-components.ts` performs no filesystem write, opens no
socket, spawns no process and reads no file of its own choosing — it is handed Compose text and returns a
verdict; tests assert each of those. Nothing is published, tagged, released, deployed or pushed. No promotion,
approval, execution, archival or deletion is run; no provider, media server or library is contacted; no part
of Phase 231 is authorized or executed.

It does not take a backup for you, and it does not add a button that would. Taking a backup means writing
somewhere outside the container, and the operator UI is read-only.

## Limitations

* The commands are asserted to be well-formed, platform-correct and toolchain-free. They are **not executed**
  here — that would need a Docker daemon, and there is none in this environment. `docker compose cp` against
  a real stack remains unexercised by automated tests; the container smoke is where that rung would go.
* Coverage is over the four shipped Compose stacks. `docker-compose.yml` (the CI harness) and
  `docker-compose.deploy.yml` are not deployments and are not checked.
* Whether the backup you took is *usable* is a different question, and it is Phase 257's.

## Tests

`test/backup-components.ts` — 37 checks, run in CI as `test:phase256-local`: the keystore present with its
consequence stated as a consequence,
the checklist no longer claiming a closed list of two, coverage over all four shipped stacks, the sidecar
state routed to the keystore component, a synthetic stack with new persistent state failing and naming the
path, every uncovered path reported at once, long-syntax and variable-prefixed targets, secrets covered
without appearing in a mount list, the host-identity rule over every command, no command requiring a
toolchain, the lifecycle document's internal contradiction gone, and the model performing no write, no
network call and no process spawn.
