# Phase 146 - Long-Running Service Boundary

Report id: `phase-146-long-running-service-boundary`

Phase 146 defines the first always-on service before implementation. It does not add a service,
change Compose, publish a port, contact providers, or install a UI.

Decision: the first always-on service is **API plus minimal operator UI**.

Product framing:

```text
Catalog Authority is the backend orchestration rail between availability providers and streaming/library consumers.
It is not the streaming product.
```

The service is allowed to expose:

- health status;
- `ops:doctor` style summary;
- schema version;
- database status;
- custodian status;
- production gate warnings;
- static deployment readiness;
- redacted system logs;
- redacted operation logs.

Logs are first-class:

- system logs: service boot, DB connection, migrations, doctor status, backup runs;
- operation logs: user-triggered actions such as doctor, backup, rewrap-plan, and later syncs;
- connector logs: later Real-Debrid, TorBox, Usenet, Plex, Jellyfin, Emby, and Stremio adapter status.

All logs must be redacted by default, visible in the UI/API, and emitted to Docker logs so Arcane can
show them. Logs must not include tokens, raw database URLs, KEKs, raw provider identifiers, raw
identity fields, or secret file contents.

Auth boundary:

```text
local-admin-token-file
```

Planned Unraid secret file:

```text
/mnt/user/appdata/catalog/secrets/operator_ui_token
```

Initial data mode is **read-only first**. Phase 147 may expose status and logs, but command buttons
for backup, rewrap-plan, migrations, or connector syncs should remain separately reviewed.

Next phase id: `phase-147-implement-first-always-on-service`

Port policy:

```text
8099 = planned Catalog Authority operator API/UI port
```

Ports are allowed, but only intentionally. Every published port must be named, documented, scoped,
and tied to a service boundary. No accidental ports.

Compose fit for the next implementation phase:

```yaml
services:
  app:
    image: ${CATALOG_AUTHORITY_APP_IMAGE:-repo-ops:latest}
    command: ["npm", "run", "ops:operator-ui-server"]
    ports:
      - "8099:8099"
    depends_on:
      postgres:
        condition: service_healthy
```

Still forbidden:

- provider contact;
- scraping;
- downloading;
- playback;
- Real-Debrid live mode;
- TorBox live mode;
- Usenet live mode;
- Plex/Jellyfin/Emby mutation;
- Stremio publish;
- raw secret exposure;
- raw identity exposure.

This project remains the backend rail connecting provider/availability systems to streaming/library
consumers. It must not become a player, media server replacement, downloader UI, provider search UI,
or piracy-oriented streaming product.
