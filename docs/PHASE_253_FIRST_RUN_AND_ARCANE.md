# Phase 253: first-run migration, honest empty-install readiness, and an Arcane/Unraid install path

`v1.1.1`. A usability remediation, driven by a real clean installation of `v1.1.0` on Unraid through Arcane.
Nothing here changes what this product does; it changes what it does to you when you install it.

The install that produced these findings was deliberately isolated, ran no promotion, contacted no provider,
media server or library, and executed no Phase 231 anything. Neither does anything in this phase.

---

## What actually happened

A clean Arcane install on Unraid, into an isolated project directory, with the UI on its own port. The app
and PostgreSQL came up healthy, the image and bundle agreed on `v1.1.0`, the digest was pinned, secrets and
the operator token survived a restart, and the database port was correctly unpublished. Then:

1. **`Database: MISSING`.** The stack had started, reported itself healthy, and had no schema. Recovering
   required `docker compose run --rm app ops:migrate` — a command that appears in no first-run instruction,
   no README, no checklist and no panel.
2. **`NEEDS_SETUP` on a working installation.** Version, database, secrets and keystore all fine, records
   folder deliberately empty, and the verdict said the installation was unfinished. Across the top of the
   page: *"the service answered, but a dependency it needs is not ready"* — naming no dependency.
3. **Bind source not found.** Arcane resolves a project's relative paths inside its own container, under
   `/app/data/projects/…`. The Docker daemon is on the Unraid host and cannot see that. Docker refused the
   mounts, naming a path the operator had never typed.
4. **No bind guidance.** The Unraid stack published the UI on every interface by omission, and there was
   nothing anywhere saying what loopback does or does not mean on a headless server.

Every one of those is a defect in the install, not in the operator.

---

## 1. The database migrates itself, before the UI exists

`ops:bootstrap` is a new one-shot command, and a new `migrate` service in **every stack that starts an
operator UI** — `docker-compose.runtime.yml`, `docker-compose.arcane.yml`, `docker-compose.unraid.yml` and
`docker-compose.unraid.runtime.yml`:

```yaml
app:
  depends_on:
    postgres: { condition: service_healthy }
    migrate:  { condition: service_completed_successfully }
```

It applies the schema, provisions the runtime credential and the completion secret, and then — the step that
would have caught the original defect — **connects as the least-privileged runtime role and confirms that
role can read the applied version**. Everything before that ran as the owner, and an owner connection
succeeding says nothing about whether the connection the app will actually use works.

* **Idempotent.** It runs on every `up`, not just the first. Every statement is `IF NOT EXISTS`,
  `CREATE OR REPLACE` or a privilege statement.
* **Serialised.** The whole migration holds a PostgreSQL advisory lock, so two racing containers produce one
  migration and one no-op rather than two sessions interleaving inside `CREATE ROLE`. A container that cannot
  get the lock exits with `BOOTSTRAP_MIGRATION_LOCK_UNAVAILABLE` — *someone else is migrating* — instead of
  hanging forever, because a container that hangs is indistinguishable from one that is broken.
* **Verified.** The recorded version and the expected relations are read back. A migration whose version
  write silently does not take is reported as `BOOTSTRAP_MIGRATION_UNVERIFIED`, not as success.
* **Fail-closed.** A non-zero exit means the app container is never started. There is no window in which a
  UI is reachable in front of a schema it cannot use.

`/healthz` additionally refuses to answer 200 until the schema is present, when
`OPERATOR_UI_HEALTHZ_REQUIRES_SCHEMA` is set — which all four stacks set. That covers a container started
outside the ordering entirely. It is off by default so the in-process harnesses, and anyone probing liveness
of a UI that is meant to render while the database is down, are unaffected.

**The two Unraid stacks were fixed in a second pass.** The first pass gated only the two consumer stacks and
left `docker-compose.unraid.yml` and `docker-compose.unraid.runtime.yml` with the very defect this phase
exists to close: both had a one-shot `ops` container that defaulted to `ops:migrate`, but nothing ever ran it
as part of starting the stack — the documented start command for the launcher stack is
`up -d postgres app sidecar`, which never included `ops`. So an operator still had to know to migrate by
hand. Both now have their own `migrate` service and the same `service_completed_successfully` gate, and
because the app depends on it, the existing `up -d postgres app sidecar` runbook command now pulls the
migration in automatically without anyone editing a runbook.

`ops` is kept as a SEPARATE service in both. It is the manual, on-demand CLI surface — the doctor, backups,
KEK rotation — with its own mounts and its own default command. Folding the startup gate into it would make
every hand-run `docker compose run --rm ops ...` a startup gate too, and a change to one would silently
change the other. A test asserts nothing in either stack depends on `ops`.

In the launcher stack the migration runs with `CUSTODIAN_MODE: sidecar`, matching it. In that mode
`ops:bootstrap` does not provision the completion secret — the sidecar owns it and this container is never
given it — so the step is reported as SKIPPED rather than silently assumed done.

**Rollback honesty is unchanged and now written down.** There are still no down-migrations. `v1.1.1` moves
the schema from version 3 to 4, so rolling back to `v1.1.0` requires restoring a pre-upgrade backup. See
`LIFECYCLE_MIGRATION_BACKUP_UPGRADE_ROLLBACK.md`, which states the limit rather than implying a rollback that
does not exist.

### A second, related defect found on the way

The readiness probe read `schema_meta` over `DATABASE_URL`. The schema **revokes that table from the runtime
role**. So on any deployment that gave the app its own least-privileged credential, the read was denied, the
denial was caught as "no schema", and the panel reported `SCHEMA_MISSING` against a perfectly migrated
database — forever. It appeared to work only because the ordinary-computer stack was handing the runtime a
superuser URL.

Both halves are fixed: schema v4 adds `cat_schema_version()`, an owner-defined reader granted to the runtime
role that returns one integer and nothing else; and the setup scripts now generate a credential for the
least-privileged `app` role the schema has always created, which `ops:bootstrap` teaches the database. As a
result `ops:doctor`'s `runtime-least-privileged` check passes on a fresh ordinary install because it is
**true**, not because it was silenced. Existing installs are not changed underneath anyone — a setup re-run
never regenerates an existing secret — and the migration doc has the deliberate steps.

---

## 2. READY, with no records loaded

`EMPTY` and `MISSING` were being treated as the same thing. They are not:

* **MISSING** — the container cannot see the folder. The mount is wrong. That is genuinely an unfinished
  installation with somewhere to go and fix it. Still `NEEDS_SETUP`.
* **EMPTY** — the mount is right and there is nothing in it. That is a correct, complete, working
  installation with no evidence loaded. It is the normal state of a fresh install and the permanent state of
  an install nobody intends to load evidence into.

So there is a fourth verdict, `READY_NO_RECORDS`, rendered as **READY - NO RECORDS LOADED**, and a separate
`evidence` field that is `LOADED` or `NONE_LOADED` independently of the verdict.

**It is deliberately not folded into READY, and deliberately not styled as an unqualified green pass.** The
dangerous reading of a working service with an empty evidence folder is *nothing was wrong* — that an audit
ran and found no blockers, that a phase completed, that a promotion is clear. None of that happened. So the
payload carries a fixed sentence saying the absence out loud:

> No promotion record artifacts are loaded, so nothing has been audited and nothing has been concluded. This
> is not a passing audit, not an authorization, not evidence that any phase completed, and not a Phase 231
> result. It means only that the service is operational and the evidence folder is empty.

`promotionAuthorization: 'NOT_IMPLIED'` is unchanged and still on every payload.

The banner is fixed too. `/api/status` answers 503 whenever the self-check has any failing item, and the page
was treating that as a thrown request failure — **discarding a complete body that named the failing check**,
in favour of a sentence that named nothing. Now the Status panel renders from it, Needs Attention lists the
failing checks by name, and the banner points at that panel.

---

## 3. Installing under Arcane on Unraid

Arcane runs in a container and stores a Compose project inside it. Docker resolves a relative bind source
against the project directory, and the daemon is on the host. The two disagree, and the operator sees a path
they never typed.

There are two honest fixes and this phase supports both.

**Make the paths agree** (what Arcane itself recommends, and the better fix because it fixes every project):
bind-mount the host projects directory into the Arcane container at the *same* path and point Arcane's
`PROJECTS_DIRECTORY` at it. After that a project directory means the same thing to both.

**Or name the host path absolutely**: `docker-compose.arcane.yml` takes one required variable,
`CATALOG_AUTHORITY_PROJECT_DIR`, the absolute path this project's folder has on the Unraid host, and builds
every bind source from it. Nothing is relative, so nothing depends on whose filesystem is resolving it.

It is `${VAR:?message}`, not `${VAR:-default}`. **A default would reintroduce the bug in a quieter form**: a
stack that starts against a directory nobody chose, generates a second set of secrets, initialises a second
database, and looks entirely fine while being the wrong installation.

`deploy/arcane-setup.sh <absolute host path>` creates the layout and the secrets on the Unraid host, keeping
every secret that already exists. `npm run ops:arcane-preflight` checks the variables before Docker has to,
and recognises the specific failure this came from — a `/app/data/...` path is reported as
`PROJECT_DIR_LOOKS_CONTAINER_INTERNAL` with both fixes offered, rather than as a baffling missing directory.

**No machine's path, address, hostname or library appears anywhere in the shipped stack, the setup script or
the preflight**, and there is a test that says so. The ordinary-computer release stack is untouched: still
relative by default, still loopback by default, still the single Compose file the bundle ships.

---

## 4. Networking: a deliberate bind, and the truth about loopback

`OPERATOR_UI_BIND_ADDRESS` is **required** in the Arcane stack and now has an explicit `127.0.0.1` default in
both Unraid stacks — `docker-compose.unraid.runtime.yml` and `docker-compose.unraid.yml` — which previously
published on every interface by omission.

* `0.0.0.0`, `::` and `*` are **refused**. Publishing an operator interface on every interface a NAS has is a
  decision someone makes, not one they inherit from a default.
* A hostname is refused. Docker publishes to an address, and a name that resolves differently later would
  move where this UI is reachable from without anyone changing anything.
* **Loopback is allowed and is a good choice — and it is not remotely reachable.** Not from your laptop, not
  from another machine on the LAN, whatever address you type in a browser. The advisory says so outright,
  rather than leaving it to be discovered by a browser that will not connect, and offers an SSH tunnel.
* `--host 0.0.0.0` in the container's own command is unchanged and is not the same thing: that is inside the
  container's network namespace and reaches nothing by itself. The host side of the port mapping is what
  decides who can reach the UI.

---

## What this phase does not do

It publishes nothing, tags nothing, merges nothing and overwrites no image. `v1.0.0` and `v1.1.0` remain
published and immutable. It runs no promotion, approval, execution, archival or deletion; contacts no
provider, media server or library; and neither authorizes nor executes any part of Phase 231. The isolated
Unraid test installation that produced these findings was inspected read-only and was not upgraded, mutated
or promoted.

## Tests

* `test/first-run-migration.ts` — Compose ordering as a structural fact, plus live proofs against a real
  PostgreSQL: idempotency, three genuinely concurrent migrations, a blocked lock failing closed within a
  bounded wait, a swallowed version write reported as unverified, the least-privileged probe, the runtime
  role's denials, and the rollback limit.
* `test/arcane-install.ts` — every way a project path can be the wrong kind of path, missing directories and
  secrets, wildcard and hostname bind addresses, loopback as an advisory rather than a blocker, required
  variables that really are required, and the absence of any particular machine's identity.
* `test/operator-ui-installation-diagnostics.ts` — the empty-versus-missing distinction, the evidence note,
  and the armed health gate failing closed while still leaking nothing.
* `test/operator-ui-csp-assets.ts` — the failing self-check rendering into the Status panel instead of a
  banner about "a dependency".
