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

**Two things cannot be regenerated: your secrets and your database.** Everything else — the image, the Compose
file, the bundle — is downloadable again.

```
docker compose exec -T postgres pg_dump -U postgres catalog > ./catalog-backup.sql
```

and copy the whole `./secrets/` directory somewhere safe.

Take both **before every upgrade**. The dump is the only thing that can return you to the previous schema, for
the reason in the rollback section.

A database dump deliberately does **not** contain your key material: the custodian keystore lives on its own
volume precisely so that a database backup is not also a key backup. Back the keystore up separately, and
treat it with the care you would treat a key.

---

## Upgrade

1. Read the release notes for the version you are moving to.
2. **Back up.** Database dump and `./secrets/`.
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

This works because the pin is always an immutable version tag or a digest, never `latest`. `v1.0.0` and
`v1.1.0` are published and are never re-tagged, rewritten or overwritten, so the old image is still exactly
the old image.

### What rolling back does not do

**Rolling the image back does not roll your data back. There are no down-migrations.**

If the newer version migrated your database, the older image will find a schema version it does not
understand and will refuse to serve against it. That refusal is correct: an older build operating on a newer
schema is how data gets quietly corrupted, and this product would rather stop.

So the honest sequence is:

1. `docker compose down`
2. Restore the database dump you took **before you upgraded**.
3. Set `CATALOG_AUTHORITY_IMAGE` back to the previous version.
4. `docker compose up -d`

**Without that backup, the rollback is not available.** No command in this product can synthesise one, and
nothing here will pretend otherwise. That is the entire reason "back up before you upgrade" is a step rather
than a suggestion.

### Which upgrades change the schema

| Release | Schema version | Notes |
| --- | --- | --- |
| v1.0.0 | 3 | |
| v1.1.0 | 3 | No schema change; rolling back to v1.0.0 needs no restore. |
| v1.1.1 | 4 | Adds an app-readable schema-version reader and an owner-only setter for the runtime role's password. **Rolling back from v1.1.1 to v1.1.0 or v1.0.0 requires restoring a pre-upgrade backup.** |

---

## Moving an existing install onto the least-privileged runtime role

Optional, and only relevant if you installed before v1.1.1.

Before v1.1.1, both `./secrets/admin_database_url` and `./secrets/database_url` held the PostgreSQL superuser.
That meant the connection the application actually used could write every table and read the completion
secret, and `ops:doctor` reported `runtime-least-privileged: FAIL` — correctly — on every such install.

New installs generate a separate credential for the least-privileged `app` role that the schema has always
created. A re-run of the setup script **keeps** an existing `database_url` rather than regenerating it, so
your existing install is not changed underneath you. To move it across deliberately:

1. Back up (database and `./secrets/`).
2. `docker compose down`
3. Delete `./secrets/database_url` and `./secrets/app_password`.
4. Re-run the setup script (`./setup.sh`, or `./deploy/local-runtime-setup.sh` in a checkout). It regenerates
   only the two files you deleted and keeps everything else, including your operator token.
5. `docker compose up -d`. The migration teaches the database the new runtime credential before the app
   starts.

Your operator token, your database contents and your promotion records are unaffected. If you would rather
not, nothing breaks: the doctor keeps reporting the over-privileged runtime connection honestly, which is
what it is for.
