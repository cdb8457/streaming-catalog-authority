# Phases 277–280 — the maintenance an operator was doing by hand

Phase 256 established what a complete backup **is**: four components, none of them obtainable again from
anywhere. Phase 257 built an offline inspector for one. Between them there was still only prose — an operator
read four commands off a page and ran them in an order that matters, with a quiescence step that is easy to
skip and invisible when you do. Nothing verified the result, nothing watched the installation between
backups, and nobody had ever rehearsed the rollback that the no-down-migration rule makes the *only* rollback.

| Phase | What it adds | What it changes |
| --- | --- | --- |
| **277** | `ops:complete-backup` — the four components, taken from one quiesced moment, published atomically | Backups stop being a checklist |
| **278** | Verification after every backup, and `ops:doctor-monitor` for a schedule | A backup is verified in the same run that took it |
| **279** | `ops:upgrade-rehearsal` — the upgrade, in a disposable project, from a verified set | An upgrade can be tried before it is done |
| **280** | The rollback leg and marker-scoped cleanup | Rollback is proved to be a *restore*, not an image change |

## What these commands are, and what they are not

`ops:backup` already exists and is a **different thing**: the Phase 3 ciphertext-only database artifact, which
is one component of four. Nothing here replaces it and nothing here re-defines a backup. The component list
is `backup-components.ts`'s, the secret file names are its `REQUIRED_SECRET_FILES`, the verification runs
Phase 257's `inspectBackupDirectory`, and the health check is Phase 5/6's `ops:doctor --json`. **A component
added to the model appears in the backup without being retyped anywhere.**

They run on the **host**, beside the Compose project — not inside it. Stopping the app is the one thing a
container inside the stack cannot do to itself.

## Every command is a value before it is an execution

Nothing in this tranche builds a shell string. A command is a program and an argument array handed to an
injected runner, and three things follow:

* **There is no shell, so there is nothing to inject into.** An operator-supplied name containing a semicolon
  is an argument containing a semicolon. There is exactly one `spawnSync` in the whole tranche, it runs with
  `shell: false`, and a suite asserts both.
* **A suite can assert the exact arguments.** The acceptance harness drives the real planners against a
  recording fake toolchain and a temporary project root — no daemon, no images, no network — and checks the
  argv arrays and the files on disk.
* **Every command passes one guard.** `assertPermittedCommand` allows two programs (`docker`, `node`), a
  closed set of `docker` and `compose` subcommands that contains no `pull`, `login`, `push` or `build`, and
  refuses any argument carrying a URL, a registry, a media path, a media extension or an acquisition word.
  The absolute invariant is enforced where every command has to pass, rather than by reading four files.

Paths are treated as hostile: resolved once through `realpath`, every component `lstat`ed, symbolic links and
special files refused, traversal refused, and a short list of broad roots (`/`, `/mnt`, `/mnt/user`, …) plus a
minimum depth refused by shape before anything is read. **No path ever reaches an output** — reports carry
base names, counts, digests and closed-set words.

## Phase 277 — the complete backup

**The database and the keystore must come from the same moment.** This is the property the whole command is
built around. A dump taken while the app was writing and a keystore copied a few seconds later produce a
backup that restores into an installation which cannot read some of its own rows — and which reports itself
healthy, because a fail-closed unreadable item looks exactly like a correctly erased one. So every writer is
stopped, both components are taken, and the writers are started again **through a `finally` that runs on every
path out**: a refusal, a thrown error, a failed step, a success. A backup that leaves the stack down is a
backup that causes the outage it was insurance against. PostgreSQL itself stays up — it is the thing being
dumped.

**Topology is declared, never guessed.** `--custodian inline` copies the keystore out of the app container;
`--custodian sidecar --sidecar-state <relative path>` copies a directory the operator names. There is no
default and no probe: an unstated topology is a refusal, and a sidecar path given with inline custody is a
refusal too. Guessing is how a backup ends up with an empty keystore and a green result.

**The set is built in a staging directory and published by a rename**, so a killed run leaves a dot-prefixed
staging directory and no set, rather than half a set under a name an operator would trust. An existing set
name is **refused** — replacing a set is how the only copy of something irrecoverable gets overwritten by a
failed run. One maintenance command runs at a time per project, enforced by `mkdir` as a lock; a stale lock is
reported, never broken automatically, because breaking it means guessing whether another process is alive.

**All four components are taken inside the quiesced window** — the database, the keystore, the secret files and
the promotion records. Copying the secrets after the writers came back is how a set ends up holding a database
from before a restart and a keystore state from after one, and every component of that set is individually
intact, so it verifies green.

**The dump goes straight into a file.** The child's stdout is bound to a descriptor this command created
`O_EXCL`; the bytes never enter this process. That is what makes a dump larger than any in-memory bound
possible at all, and it is what keeps a dump holding bytes that are not valid UTF-8 byte-faithful — a captured
string would have replaced each of them with U+FFFD and digested the corruption.

**Every component file is read through one descriptor, opened without following a symbolic link**, and every
question — is it a file, how big is it, what is its digest — is asked of that open file description rather than
of the name. A leaf swapped for a link between an `lstat` and a read is refused at the open. Where a platform
cannot promise that atomically (Windows has no `O_NOFOLLOW`), the fallback refuses a link by `lstat` and then
compares the opened object's identity to the one inspected, which detects the race rather than preventing it.

**Taking the set and verifying it are one contract, and there is no unverified success to be had.**
`runVerifiedCompleteBackup` returns the backup, the verification and the failures together, and success means
all three: the set was published, the writers came back, and the set verified. A stack that never restarted is
a failed cycle however good the files on disk are — and the report says both facts rather than one.

That used to be enforced by *discipline*: the taking function returned its own `ok`, and only the CLI happened
to verify afterwards, so any other caller — a scheduler, a route, a later phase — could hold an unverified
success indistinguishable from a verified one. It is now enforced by *subtraction*. The taking report has **no
`ok` field at all**, its rendering prints no verdict line, and the function is named
`takeCompleteBackupWithoutVerifying`. There is no value in existence for a caller to misread, the only `ok`
this module produces cannot exist without a verification report beside it, and a suite asserts that nothing
under `src/` calls the unverified taker.

**A dual failure carries both facts.** When a step inside the quiesced window fails *and* the restart
afterwards fails too, an operator has two problems and the urgent one is the outage. The `finally` still
refuses to throw of its own — replacing the failure that sent it there would lose the reason — but the outage
used to be recorded only as a *note*, and notes travel on a report that a thrown failure never returns. So it
was dropped: an operator was told "the database dump did not run. Nothing was written." and was never told
their installation was down. A failure that leaves services stopped is now a `CompleteBackupFailed`, carrying
the primary refusal **word for word** plus the outage and the names of what did not come back; where the stack
did restart, the original error is rethrown untouched, because there is no second fact to add and a paragraph
about an outage that did not happen is only noise between an operator and a sentence they can act on. The
report gained a `stillStopped` list for the same reason.

**Directories are 0700 and files are 0600.** The manifest carries structural metadata and digests — component
ids, sizes, entry counts, sha256 — and no content, no host path and no secret.

## Phase 278 — verification, and a monitor for a schedule

**Verification runs in the same run that took the backup.** "The backup succeeded" and "the backup verified"
are never two commands somebody has to remember to pair. It checks the set against its own manifest (every
declared component present, unchanged by digest, nothing added), establishes schema compatibility, and runs
the shipped offline inspector, reporting its verdict unmodified. Missing, extra, tampered, symlinked, special,
schema-ahead — every one is a refusal, and **it changes nothing**: a verification that could repair what it
found is one whose failures nobody ever sees.

**An intact older set is a rollback point, not a failure.** Verification answers two different questions and
keeps them apart: is this set intact, and could *this* build restore it. A set from an older schema is intact
and is **not** restorable here — which is exactly what a rollback point is, and reporting it as a failure would
teach an operator to ignore the one check that catches a real problem. A set whose manifest and whose dump
disagree about the schema is a `SCHEMA_DISAGREEMENT` finding; a verdict this build cannot interpret is
`SCHEMA_INDETERMINATE`. Neither is rounded to the nearest familiar answer.

**The doctor monitor adds a schedule's two missing pieces and nothing else** — a durable record between runs
and a consecutive-failure count. It runs the existing read-only `ops:doctor --json`, validates the stable
contract, and writes one small redacted state file atomically.

* **It sends no alert.** No outbound call by any mechanism. That is not an omission: a monitor that alerts is
  silent when the alerting is what broke. It exits with a distinct code per state — `0` healthy, `3` WARN,
  `1` FAIL, `4` the doctor could not be read, `2` bad usage — and the scheduler that already runs it alerts.
* **It never softens the doctor.** A WARN exits WARN on the first run and on the fiftieth. A report that says
  `ok: true` while carrying a `fail` is `INVALID`, not healthy.
* **The process and its output must agree.** The doctor exits non-zero when it found something. A body that
  parses as healthy behind a non-zero status is `INVALID` — there is no honest way to pick one of two answers
  about an installation, and a monitor that read only stdout would report health from a command that failed.
  The status and the *presence* of error output are reported as facts; the error text is never carried, because
  it is written by whatever was on the other end of that pipe.
* **A check name is an identifier or the report is INVALID.** Names are the only field that reaches a durable
  file and a terminal, so they are checked against a vocabulary — lowercase words joined by single hyphens,
  bounded, unique — rather than merely typed. A path, a URL, an escape sequence or a duplicate makes the whole
  report `INVALID`, and nothing from it is persisted. The report's size, its check count and each detail are
  bounded before anything is parsed.
* **A corrupt state file cannot reset the consecutive-failure count.** "No file yet" is a first run; "a file
  that will not parse" is the monitor's own memory having been lost, and collapsing the two would make the
  number an alerting threshold is set against resettable by one bad byte. A lost history is `INVALID`, counts
  as one rather than as none, and says so.
* **One monitor at a time**, around the whole read-modify-write, by a lock of its own in the state directory.
  Two runs that both read 4 and both write 5 mean the run that should have crossed a threshold of 6 never
  happens. The lock is separate from the project lock so a five-minute schedule does not refuse every time a
  backup is running.
* **The state file carries check names and states**, a timestamp, a count and a digest. No `detail` string,
  because a detail is written for a person reading a terminal and this file is read by whoever finds it later.

`deploy/unraid-catalog-maintenance.sh` is a worked User Scripts/cron example: `flock -n` so a second run
refuses rather than queues, `timeout` so a run is bounded, no credential anywhere, and **retention that is a
plan** — it lists the sets, says which a policy *would* remove, prints a digest of the exact enumerated list,
and has no flag that removes anything.

## Phases 279–280 — rehearsing the upgrade and the rollback

This product has no down-migrations. The consequence is that **rolling the image back is not a rollback** once
a migration has run: the old binary meets a schema it does not know. The only real rollback is restoring the
pre-upgrade backup — and an operator finds out whether that works on the day they need it unless something
rehearses it first.

**It happens somewhere else, and "somewhere else" is proved five ways:** a **marker file** created `O_EXCL` in
the disposable root binds it to one project name and one exact plan digest (a root marked for a different
rehearsal is refused rather than adopted, a root holding files this command did not put there is never claimed,
and an unmarked root is never cleaned); the project name carries the `catalog-rehearsal-` marker, so every
container, network and volume is labelled with it and the cleanup removes by exactly that; the disposable root
is resolved and required to be neither production, nor inside it, nor containing it; the project name is
checked against production's including case, because Compose lower-cases project names; and every command's
`cwd` is the disposable root, asserted over the planned commands rather than promised.

**Images must be immutable and already present.** `latest` and its friends are refused by name, a bare
repository is refused (it *means* `latest`), a digest is accepted. Every `up` carries `--pull never`, and
`pull`, `login` and `push` are not in the permitted subcommand set at all.

### The definition you supply must itself be disposable, and that is proved before anything is claimed

**This is the correction that matters most.** A Compose definition decides for itself what it touches. Running
it under a different project name in a different directory changes neither of these:

* a **bind mount** names a host directory — `- /mnt/user/appdata/catalog/pgdata:/var/lib/postgresql/data` is
  your production database directory whatever project is in front of it;
* a **Docker secret** names a host file — the shipped launcher stack points six of them at your real key
  material;
* an **external volume or network** already exists and belongs to something else, and this rehearsal runs
  `down -v` — and `external: false` does **not** mean the opposite. A top-level `name:` puts a volume in the
  **global** namespace where an installation's real volumes live, and `driver_opts: {type: none, o: bind,
  device: /mnt/user/appdata/catalog}` makes a `local` volume a **host directory** that no service's mount list
  ever calls a bind. Every volume and network is therefore checked by its **effective resolved name** — which
  must be exactly the `<project>_<key>` Compose derives for a resource a project owns — and by its
  **mechanism**: no driver options at all, no driver but the default `local`/`bridge`, and no key beyond
  `name`, `external`, `labels`, `driver` and `driver_opts`, because a mechanism this build has not read is one
  it cannot prove is contained;
* `container_name` takes a name **globally**, `network_mode: host`, `privileged`, `devices:` and a Docker
  socket mount each hand the stack the host, and a published `ports:` entry takes a port on the host;
* `${VAR}` means "whatever the shell running this happens to hold", and the shipped stacks default theirs to
  **the production appdata directory**.

So before the marker is claimed and before a container could exist, this command runs `docker compose config`
— which resolves everything and **starts nothing** — and validates Compose's own answer. It is run again after
each override is written, over the merged result, because an override can *add* to a `secrets` or `volumes`
list and cannot remove from one: rather than pretend to have replaced a base entry, this reads what Compose
actually resolved and refuses if a production source survived.

**Your disposable definition must therefore:** declare exactly the four services this product's stack has
(`postgres`, `migrate`, `app`, `sidecar`) and no others; keep every piece of persistent state in
**project-scoped named volumes**; declare **no bind mount**, **no Docker secret or config**, nothing
**external**, and none of the keys above; and contain **no `${…}` at all**. This command mounts the restored
backup itself, out of a workspace it owns, at the exact paths the images read.

**The shipped `docker-compose.unraid.runtime.yml` is not such a definition and is refused as one.** That is
the point: following the previous version of this page would have rehearsed against production while the
report said `touchedProduction: false`. Write a small definition for the rehearsal — for example:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: catalog
      POSTGRES_USER: postgres
    volumes:
      - pgdata:/var/lib/postgresql/data
  migrate:
    image: catalog-authority-ops:pinned-by-the-rehearsal
    environment:
      APP_ENV: production
      CUSTODIAN_MODE: sidecar
      CUSTODIAN_SIDECAR_SOCKET_PATH: /run/catalog-sidecar/catalog-sidecar.sock
    volumes:
      - sidecarrun:/run/catalog-sidecar
  app:
    image: catalog-authority-ops:pinned-by-the-rehearsal
    environment:
      APP_ENV: production
      CUSTODIAN_MODE: sidecar
      CUSTODIAN_SIDECAR_SOCKET_PATH: /run/catalog-sidecar/catalog-sidecar.sock
    volumes:
      - sidecarrun:/run/catalog-sidecar
  sidecar:
    image: catalog-authority-ops:pinned-by-the-rehearsal
    environment:
      APP_ENV: production
      SIDECAR_SOCKET_PATH: /run/catalog-sidecar/catalog-sidecar.sock
    volumes:
      - sidecarrun:/run/catalog-sidecar
volumes:
  pgdata: {}
  sidecarrun: {}
```

The `image:` values above are placeholders: this command pins all three product services itself, so a
reference here that this host does not hold is a *feature* — a leg that failed to pin would not start.

**The environment is an allowlist too.** Every command runs with `PATH`, `HOME` and the three `DOCKER_*`
variables and nothing else, so no `CATALOG_AUTHORITY_*`, `COMPOSE_*` or credential-shaped variable of yours
reaches a compose command or a container.

**The image is selected, not merely named — on every product service.** This command writes two Compose
**override files** into the root it owns, one per role, each pinning **`app`, `migrate` and `sidecar`** to one
exact immutable reference and wiring in the restored components; every boot passes `-f <your definition> -f
<that override>`. In this stack the migration and the custodian sidecar are the *same image as the app*, so
pinning only `app` — which the first version did — ran the candidate app against the **current** build's
migration and the **current** build's custodian, and the migration is the entire reason a rollback is hard.
Which image each service runs is visible in the resolved configuration, and that is what is checked.

**All four components are restored, into the places that read them.** A private restore workspace is prepared
out of the verified set — the database, the keystore, the secret files and the promotion records, plus the
representative import snapshot you name. The keystore becomes the **sidecar's** `SIDECAR_STATE_DIR`, because
in sidecar custody mode that is where every unwrap goes; each required secret file is bound at the exact path
its consumer reads and the variable naming that path is set to it (`postgres` ← `postgres_password`, `migrate`
and `app` ← `admin_database_url` and `database_url`, `app` ← `operator_ui_token`, `sidecar` ←
`completion_secret` and `custodian_kek`); the promotion records and the import snapshot are mounted at their
own consumers. Each of those is checked **against the resolved configuration**, so "the keystore is mounted"
means Compose, after merging, would give the sidecar the copy this rehearsal made. The set itself is only ever
**read**: it is verified before and after, and the report says whether it was unchanged.

**Versions are read, not inferred from a tag.** The plan carries the exact product version and schema version
expected on each image; the run reads both out of the running container (`npm pkg get version`, and the shipped
`ops:version` line) and compares them exactly, on the current image, on the candidate after its migration, and
again after the rollback. A tag is a label somebody typed.

**Nothing runs without the exact plan digest** — which covers the images, all four declared versions, and the
**contents** of the definition, the import snapshot and the backup set, not merely their paths. A file edited,
a snapshot replaced or a whole set written over the same name between the `--plan` you read and the command
you run produces a different digest, and the run is refused. Those three are read again **immediately before
the marker is claimed** and refused if any moved in that window too. Nothing runs without a backup set that
**verifies now**, and whose manifest schema is the one declared for the current image.

**Every successful check requires the process to have succeeded.** A matching body behind a non-zero exit is a
*disagreement*, and a disagreement is its own failure — the doctor's report and the `ops:version` line are both
read on a failure, because their closed sentences are what you act on, but neither can conclude success without
status zero. Output is bounded before anything parses it.

**The representative work really runs**: the import is previewed (writing nothing), applied, and replayed after
the migration — and the replay's **own report** must say it created and updated nothing. Two exit-zero applies
prove only that an import ran twice; an import that re-created every record would exit zero and would have
doubled the catalog. The evidence carries a closed word for what was actually shown: `proved` when the apply
made a durable change and the replay made none, `proved-vacuously` when the snapshot was already present and
the replay had nothing to repeat. The durable history is read, and the catalog is read through a primitive that
must decrypt to answer. Every collection, media-server, acquisition and network gate stays shut — those
commands are not in the plan, and the guard would refuse them if they were.

**The plan and the run are one ordered list.** `planRehearsal` builds the steps; `--plan` renders that list and
the run executes it. There is no second copy of the order to drift from the first.

**The rollback leg is a restore.** It destroys the upgraded disposable state and its volumes entirely, restores
the *same* pre-upgrade set into fresh state, boots the *previous* image, and re-runs the version, schema,
doctor, read and history checks. A failed step **stops the run, keeps the disposable project for diagnosis and
removes nothing** — and even `--cleanup` will not remove a failed run's evidence, or run at all unless the root
still carries this rehearsal's own marker at that moment.

**Cleanup means the files as well as the project.** `cleanup.performed: true` used to mean only that `compose
down` had run, while the private workspace — holding **a copy of your custodian keystore and every secret
file** — stayed on disk under a word that said it had been cleaned up. With `--cleanup`, a successful run and
a marker that still binds the root, this now also removes the workspace, both override files and the marker
(last), each after proving by digest that it is the artifact this run wrote; the tree is walked and refused
whole if it holds a symbolic link, a device, a socket or a pipe, so nothing is ever recursively deleted
through a path this command has not verified. **Your Compose definition is never removed.** If any of that
does not complete, `cleanup.performed` is `false`, `cleanup.artifacts` is `incomplete`, and the report says
what is still there and what it contains. Every run *without* `--cleanup`, and every failed run, keeps
everything for diagnosis — and says plainly that the workspace holds key material.

**The evidence is redacted, including the parts that look harmless.** The durable report carries a
**non-reversible digest of each image reference** and a **closed word** for each version comparison
(`as-declared`, `not-as-declared`, `unreadable`, `not-reached`) — never a reference, never a version string
read out of a container, never a doctor `detail`, never a runner's message, and no host path, registry,
address, secret or anything from inside the backup. Failure details are a closed vocabulary of categories. The
`--plan` output, which you read on your own terminal about references you yourself typed, prints them in full;
that asymmetry is the whole redaction boundary and is the only place it exists.

## The absolute invariant

Catalog Authority never downloads, scrapes, plays or acquires media, and never creates a media symlink. Usenet
acquisition and symlink creation are external systems that may provide inputs only. In this tranche that is
enforced three ways: the permitted-program and permitted-subcommand allowlists, the forbidden-argument scan
that refuses a URL, registry, media path, media extension or acquisition word in **any** argument, and a
post-hoc scan of the command ledger in every suite — "no network, no media, no acquisition and no media-server
command was issued" is a property of what actually ran.

## Proof

| | |
| --- | --- |
| `npm run test:phase277-local` | `test/complete-backup.ts` — the four components from one quiesced moment; stop → dump → keystore → start in that order; private modes; sidecar topology copied from the directory it was told and refused when unstated; each component's absence refusing and publishing nothing; a service that will not stop unwinding what it did stop; a failed start reported rather than swallowed; an interrupted run leaving no set and no lock; a second run refused by the lock; an existing name refused with the existing set byte-identical; symlinks, traversal, absolute paths, broad roots and bad names refused; tamper, removal and addition all caught by verification; a set with no manifest pointing at the tool that needs none; a schema-ahead set refused; the manifest carrying no content; a disclosure scan over every report; a clean command ledger; and the guard refusing a fetch, a media path and a shell. |
| …and the containment correction | **A volume or network given an explicit global name, a `type: none / o: bind / device:` driver option, any driver option at all, a custom volume or network driver, or a key this build has not read — each refused at the preflight, before a marker, a volume or a container exists; `external: false` proved not to be an ownership claim; a project-scoped named volume with the default driver and labels proved to pass, so none of those refusals is a refusal of the whole shape; a mount source matched by either the definition's key or the effective resolved name, and one naming a volume nobody declared still refused; a resolved entry carrying no effective name refused as not-a-resolved-configuration; and the resolved-stack digest proved to move on every one of those values, which the previous digest — over the key and the `external` flag alone — could not have done.** |
| …and the two corrections above | **A dual failure (a dump that fails *and* a restart that fails) raised as `CompleteBackupFailed`, carrying the primary refusal word for word, the outage, and the names of what is still stopped — and printed whole by the CLI's refusal path; a failure with the stack healthy left exactly as it was, with no outage claimed; a failure raised *after* the window still carrying an outage from inside it; the taking report proved to have no `ok` field, in its type, in its serialised form and in its rendering; a set that publishes, restarts and does NOT verify proved to make the cycle `ok: false`; and a scan proving nothing under `src/` calls the unverified taker.** |
| `npm run test:phase278-local` | `test/doctor-monitor.ts` — the shipped contract parsed from the shipped formatter; every state mapping to a distinct exit code; an unreadable or self-contradicting report classified `INVALID` rather than healthy; a durable consecutive count that resets only on health; a WARN that never escalates; a redacted, atomic, private state file with no `detail`; a stale state file as a fresh start; a missing state directory refused before the doctor runs; no outbound mechanism in the module or the CLI; and the Unraid example's lock, bound, plan-only retention and absence of credentials or URLs. |
| `npm run test:phase279-local` | `test/upgrade-rehearsal.ts` — floating and bare image refs refused and digests accepted; a disposable root that is, contains or is inside production refused; a project-name collision refused including by case; a backup set or import snapshot inside the disposable root refused; nothing running without the exact digest, without a set that verifies now, or with a set whose schema is not the declared one; **a modelled disposable stack — the harness performs a real Compose merge and answers `config` from it — in which two different images are really selected, all four components are really in the workspace and mounted into every boot, the set is restored twice byte-identically, and the versions and schema versions are really read and compared** — with the harness's own ability to say no asserted; an unmarked root holding somebody's file never claimed and never cleaned; a root marked for another rehearsal refused; a leftover workspace never silently replaced; a doctor FAIL stopping the run and keeping the evidence; a failed rollback restore reported as "not reversible"; and an evidence report carrying reference digests and closed words but no reference, version string, doctor detail, runner message, path, registry, address or secret. |
| …and the second round of corrections | **A production bind, a Docker secret, an external volume, a `container_name`, `network_mode: host`, `privileged`, a device, a published port, an unpinnable extra service and a missing sidecar are each refused at the preflight — with exactly one command issued (`config`, which starts nothing), no marker, no workspace, no override and no `up` or `down`; the shipped `docker-compose.unraid.runtime.yml` refused as a disposable definition; every ambient `CATALOG_*`/`COMPOSE_*` variable proved absent from a command's environment and an unsubstituted bind source refused; every restored component asserted to be the EFFECTIVE source at the exact target and variable its image reads, in both resolved stacks, with no bind outside the workspace anywhere; `migrate` and `sidecar` proved to run the leg's own image on every boot and an unpinned migration refused; the compose definition, import snapshot and backup set each swapped after `--plan` and refused, and a definition swapped between the resolve and the claim refused at the claim with no marker written; a healthy doctor body and a matching schema line each behind a non-zero exit refused; output past the evidence bound refused; a replay that exits zero while reporting a duplicate write refused, with `proved`/`proved-vacuously`/`not-proved` distinguished; cleanup removing the workspace, both overrides and the marker (last) while preserving the operator's definition, refusing a tampered workspace and reporting `incomplete` rather than `performed`; and a leftover artifact of this command's own name refused before any marker is written.** |
| `npm run test:phase250-local` | `test/release-readiness.ts` — the three new suites are in the single shared required-suite list, so removing any of them from the CI suites job blocks `suites-run-the-acceptances`. |

## Verification status

`npm run typecheck`, the three new suites, the affected existing suites and the aggregate `offline` and `db`
groups were run and passed on this branch.

**No Docker-dependent gate was run, and nothing here should be read as saying one was.** These commands drive
a Docker daemon in production and the suites deliberately do not: they inject a recording runner, so what is
proved is the planners, the argument arrays, the filesystem work and the refusals — not that a real
`docker compose stop` behaves as documented. That distinction is the honest one, and it is why the suites are
in the `offline` group rather than claiming a `docker` capability they do not use.

## Limitations

* **The executable automation targets the shipped Linux/Unraid deployment.** Private modes are POSIX modes and
  are not observable on Windows; the Phase 256 Windows guidance for taking a byte-faithful `pg_dump` by hand
  through `cmd /c` is unchanged and remains the documented path there. This command never involves a shell at
  all, so the re-encoding defect that guidance exists for cannot arise in it.
* **A backup is verified, not restored.** Verification proves what a set contains and that it is unchanged
  since it was taken. It does not prove a restore succeeds — that is what Phase 279's rehearsal is for, and
  even that runs against a disposable stack rather than yours.
* **The lock stops this product's own runs.** It does not stop a person running `docker compose` in another
  terminal, and it does not detect a stale lock automatically, because detecting one means guessing whether
  another process is alive.
* **Retention removes nothing, ever.** There is deliberately no flag that does. Removing a set is a decision
  with a name attached, taken by a person who has just read what they are removing.
* **The rehearsal proves the product against a disposable copy of your data.** It cannot prove anything about
  hardware, about a different host, or about a migration whose failure depends on data your backup does not
  contain.
* **The rehearsal needs a Compose definition you wrote and an import snapshot you chose.** It overrides the
  first and replays the second; it invents neither. A rehearsal against a stack this product wrote for you
  would be a rehearsal of this product's idea of your deployment.
* **The restore workspace holds a copy of your keystore and secret files, at 0600 under a 0700 directory, for
  as long as you keep it.** That is what makes the decrypt checks real. It is left in place after a run so a
  failure can be diagnosed, it is never silently replaced, and removing it is a decision with a name attached.
