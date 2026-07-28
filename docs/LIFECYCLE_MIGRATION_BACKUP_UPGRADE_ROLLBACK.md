# Migration, backup, upgrade and rollback

What happens to your database when you install, upgrade or go back — and what this product cannot do for you.

Read the last section before you upgrade. It is the one with the limit in it.

---

## Migration

### It runs by itself, before the UI exists

`docker compose up -d` starts PostgreSQL, waits for it to be healthy, runs a one-shot `migrate` container to
completion, and only then starts the operator UI.

```
docker compose up -d
```

There is no separate migrate command to remember. In v1.1.0 there was — `docker compose run --rm app
ops:migrate` — and it appeared in none of the first-run instructions, so a fresh install produced a UI that
reported itself healthy in front of a database with no schema. That is the defect this ordering closes.

### It is idempotent

The `migrate` container runs on **every** `up`, not only the first. Every statement it applies is
`IF NOT EXISTS`, `CREATE OR REPLACE` or a privilege statement, so a run against an already-migrated database
ends at the same version it started at and changes nothing. You never have to decide whether to run it.

### It is serialised

The whole migration runs under a PostgreSQL advisory lock. Two containers starting at once — a restart racing
an `up`, a launcher that starts services in parallel — produce one migration and one no-op, rather than two
sessions interleaving inside `CREATE ROLE` and deadlocking. A container that cannot get the lock within its
timeout exits with `BOOTSTRAP_MIGRATION_LOCK_UNAVAILABLE`, which means *someone else is migrating*, not *your
database is broken*. Start again once the other one has finished.

### It is fail-closed

The app service declares:

```yaml
depends_on:
  migrate:
    condition: service_completed_successfully
```

If the migration exits non-zero, **the UI container is never started**. There is no window in which you can
open a page that is lying to you about a database it cannot use. The app also refuses to answer `/healthz`
with a 200 until the schema is at the version it requires (`OPERATOR_UI_HEALTHZ_REQUIRES_SCHEMA=1`), which
covers a container started outside this ordering — `docker run`, or a launcher that ignores `depends_on`.

### It is verified, not assumed

The migration reads back the recorded schema version and the relations it was supposed to create, then
connects **as the least-privileged runtime role** and confirms that role can read the applied version. A green
`migrate` container is therefore evidence that the app will work, rather than evidence that some SQL was sent.

### When it fails

```
docker compose logs migrate
```

The last line is one of a fixed set of codes with a fixed sentence. It never contains a password, a
connection string or a host path.

| Code | What it means |
| --- | --- |
| `BOOTSTRAP_CONFIG_INVALID` | A required secret file is missing or malformed. The message names the variable, never the value. |
| `BOOTSTRAP_DATABASE_UNREACHABLE` | PostgreSQL did not answer. Usually still starting, or a password that does not match the volume it was initialised with. |
| `BOOTSTRAP_MIGRATION_LOCK_UNAVAILABLE` | Another migration holds the lock. Wait, then start again. |
| `BOOTSTRAP_MIGRATION_FAILED` | The schema statements themselves failed. |
| `BOOTSTRAP_MIGRATION_UNVERIFIED` | They ran, but the database is not at the version this build requires. |
| `BOOTSTRAP_RUNTIME_CREDENTIAL_FAILED` | The runtime role's password could not be set. |
| `BOOTSTRAP_COMPLETION_SECRET_FAILED` | The completion secret could not be provisioned. |
| `BOOTSTRAP_RUNTIME_ROLE_UNUSABLE` | The migration worked, but the connection the app will use cannot read the schema. The app would not have worked; it was not started. |

Fix what it names and run `docker compose up -d` again. Repeating it is always safe.

---

## Backup

**A complete backup is four things.** None of them can be downloaded again. Everything else — the image, the
Compose file, the bundle — is.

This list used to say two ("your secrets and your database"), and the operator-facing checklist said the same.
That was wrong in the way that matters: it was a *closed* list, so nobody went looking for a third thing. See
`PHASE_256_COMPLETE_BACKUP.md`. The authoritative list now lives in `src/ops/backup-components.ts`; the
checklist step and the **Backup & restore** panel render from it, and a test holds this document to it.

| # | Component | What is lost without it |
| --- | --- | --- |
| 1 | **The database** | Everything this installation has ever recorded. |
| 2 | **The custodian keystore** | The database restores and *nothing in it can be decrypted*. The service starts, passes its checks, and reads nothing. |
| 3 | **The secret files** | The KEK unwraps nothing, shred completion can never verify, and PostgreSQL refuses the password its volume was initialised with. |
| 4 | **The promotion record artifacts** | The evidence you loaded. This product never produced those files and cannot recreate them. |

The **import history** added in v1.1.3 lives inside the database, so component 1 already covers it — there is
no fifth thing to back up. A catalog **export** from the UI is not a backup either: it is deterministic and
re-importable, but it deliberately omits every provider reference value, so it can never stand in for the
database and the keystore together.

```
docker compose exec -T postgres pg_dump -U postgres catalog > ./catalog-backup.sql
docker compose cp app:/var/lib/catalog/keystore ./keystore-backup
cp -a ./secrets ./secrets-backup
cp -a ./promotion-records ./promotion-records-backup
```

**On Windows, run the dump through `cmd /c`**, not PowerShell:

```
cmd /c "docker compose exec -T postgres pg_dump -U postgres catalog > catalog-backup.sql"
```

PowerShell's `>` is `Out-File`, which re-encodes a native command's output rather than passing bytes through
— measured, it prepends a byte-order mark — and produces a dump `psql` refuses, silently, until the day you
try to restore it. PowerShell also has no `<` operator at all, so the restore has to go the same way. The
**Backup & restore** panel shows the right form for each platform.

Take all four **before every upgrade**. The dump is the only thing that can return you to the previous schema,
for the reason in the rollback section — and the keystore from the *same* backup is the only thing that makes
the restored dump readable.

A database dump deliberately does **not** contain your key material: the custodian keystore is kept apart
precisely so that a database backup is not also a key backup. That is a good decision and it is exactly why
the keystore has to be backed up on purpose. Treat the copy the way you would treat a key.

**On the Unraid launcher stack the keystore is somewhere else.** That stack runs the custodian as a sidecar
whose `SIDECAR_STATE_DIR` holds the same material, under your appdata directory. Same consequence, second
place to forget. Copy it directly, with the stack stopped.

### Checking a backup before you need it

```
CATALOG_AUTHORITY_BACKUP_DIR=./backup npm run ops:backup-inspect
```

reads a backup directory offline — no database, no network — and reports which of the four components are
present and which schema version the dump holds. There is no default directory: the bare command refuses
rather than inspecting somewhere nobody asked about. From a bundle, with no toolchain, the **Backup &
restore** panel carries the `docker compose run` form. See `PHASE_257_BACKUP_INSPECT.md`. A backup nobody has
ever looked at is a hope, not a rollback plan.

---

## Upgrade

1. Read the release notes for the version you are moving to.
2. **Back up all four components.** Database dump, keystore, `./secrets/`, `./promotion-records/`.
3. `docker compose down`
4. Edit `CATALOG_AUTHORITY_IMAGE` in `.env` to the new version tag or digest. Alternatively, extract the new
   bundle alongside the old one and copy your `secrets/` and `promotion-records/` folders across.
5. `docker compose up -d`

Step 5 migrates the database automatically, before the new UI starts. Your secrets and your promotion records
are untouched by an image change. Your database **may not be** — that is what step 2 is for.

The UI's **Setup & Diagnostics** panel reports `MISMATCH` if the image and the bundle disagree about which
release you are running. Editing `.env` to silence a mismatch does not resolve it; make the two agree.

---

## Rollback, and the limit on it

Set `CATALOG_AUTHORITY_IMAGE` in `.env` back to the previous tag or digest and start again:

```
docker compose down && docker compose up -d
```

This works because the pin is always an immutable version tag or a digest, never `latest`. `v1.0.0` through
`v1.1.2` are published and are never re-tagged, rewritten or overwritten, so the old image is still exactly
the old image.

### What rolling back does not do

**Rolling the image back does not roll your data back. There are no down-migrations.**

If the newer version migrated your database, the older image will find a schema version it does not
understand and will refuse to serve against it. That refusal is correct: an older build operating on a newer
schema is how data gets quietly corrupted, and this product would rather stop.

So the honest sequence is:

1. `docker compose down`
2. Restore the database dump you took **before you upgraded**, and the **keystore from that same backup**.
   The two belong together: a dump restored beside a newer keystore, or beside no keystore, gives you an
   installation that starts and cannot read anything.
3. Set `CATALOG_AUTHORITY_IMAGE` back to the previous version.
4. `docker compose up -d`

**Without that backup, the rollback is not available.** No command in this product can synthesise one, and
nothing here will pretend otherwise. That is the entire reason "back up before you upgrade" is a step rather
than a suggestion.

`ops:backup-inspect` will tell you which schema version a dump holds before you rely on it, so "the backup I
took before I upgraded" is something you can check rather than something you remember.

### Which upgrades change the schema

| Release | Schema version | Notes |
| --- | --- | --- |
| v1.0.0 | 3 | |
| v1.1.0 | 3 | No schema change; rolling back to v1.0.0 needs no restore. |
| v1.1.1 | 4 | Adds an app-readable schema-version reader and an owner-only setter for the runtime role's password. **Rolling back from v1.1.1 to v1.1.0 or v1.0.0 requires restoring a pre-upgrade backup.** |
| v1.1.2 | 4 | Consumer-readiness remediation; no schema change from v1.1.1. |
| v1.1.3 | 9 | Adds recovery-proof fields, identity-free import and collection-control history, the active-intent invariant, and the managed-collection model. **Rolling back from v1.1.3 requires restoring a pre-upgrade database and keystore backup.** |

### Upgrading onto v1.1.3: the keystore is repaired for you, once

Docker creates a fresh named volume **root-owned**, while this container runs as `node`. An installation
created before v1.1.3 therefore has a keystore the application cannot write, which is `EACCES` on the first
custodian construction — `ops:doctor`, `/api/status` and the whole Catalog panel. The image now ships the
directory owned by `node`, which fixes new installs and cannot reach back into a volume that already exists.

`docker compose up -d` now runs a one-shot `keystore-prepare` before anything else. It is the **only** thing
in the stack that runs as root, it has no network, no secrets and one mount, it changes **ownership and
nothing else**, and it **refuses** — stopping the stack rather than guessing — on any ownership or content
state it does not understand. On a keystore that is already correct it writes nothing at all.

**Nothing about it needs a backup first**, because it reads, writes, moves and deletes no key material. Check
what it would do, without changing anything:

```
docker compose run --rm keystore-prepare ops:keystore-check
```

The manual fallback, every refusal code, and how to undo the ownership change are in
`docs/PHASE_263_KEYSTORE_REPAIR.md`.

The stacks that run their containers as **root** — `docker-compose.unraid.yml` and
`docker-compose.deploy.yml` — deliberately do not get this one-shot: root ownership is correct there, and a
chown to `node` would break them.

---

## Moving an existing install onto the least-privileged runtime role

Optional, and only relevant if you installed before v1.1.1.

Before v1.1.1, both `./secrets/admin_database_url` and `./secrets/database_url` held the PostgreSQL superuser.
That meant the connection the application actually used could write every table and read the completion
secret, and `ops:doctor` reported `runtime-least-privileged: FAIL` — correctly — on every such install.

New installs generate a separate credential for the least-privileged `app` role that the schema has always
created. A re-run of the setup script **keeps** an existing `database_url` rather than regenerating it, so
your existing install is not changed underneath you. To move it across deliberately:

1. Back up all four components (see **Backup** above).
2. `docker compose down`
3. Delete `./secrets/database_url` and `./secrets/app_password`.
4. Re-run the setup script (`./setup.sh`, or `./deploy/local-runtime-setup.sh` in a checkout). It regenerates
   only the two files you deleted and keeps everything else, including your operator token.
5. `docker compose up -d`. The migration teaches the database the new runtime credential before the app
   starts.

Your operator token, your database contents and your promotion records are unaffected. If you would rather
not, nothing breaks: the doctor keeps reporting the over-privileged runtime connection honestly, which is
what it is for.
