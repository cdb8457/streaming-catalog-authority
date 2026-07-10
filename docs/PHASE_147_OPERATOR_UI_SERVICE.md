# Phase 147 - Operator UI Service

Report id: `phase-147-operator-ui-service`

Phase 147 implements the first long-running service for Catalog Authority:

```text
API plus minimal operator UI
```

This is the first intentional Unraid-published port:

```text
8099:8099
```

The service is still read-only first. It exposes:

- `GET /` - browser operator shell;
- `GET /healthz` - Docker healthcheck with no sensitive operational data;
- `GET /api/status` - token-protected doctor/status JSON;
- `GET /api/logs` - token-protected redacted service logs.

Auth boundary:

```text
local-admin-token-file
```

Container secret path:

```text
/run/secrets/operator_ui_token
```

Unraid secret path:

```text
/mnt/user/appdata/catalog/secrets/operator_ui_token
```

The service reads the token through:

```text
OPERATOR_UI_TOKEN_FILE=/run/secrets/operator_ui_token
```

Requests to `/api/status` and `/api/logs` must provide the token in:

```text
X-Operator-UI-Secret
```

Logs are first-class and redacted:

```text
redacted-system-operation-connector
```

Docker Compose fit:

- `docker-compose.unraid.yml` adds an `app` service with `build: .`;
- `docker-compose.unraid.runtime.yml` adds an `app` service using `${CATALOG_AUTHORITY_OPS_IMAGE:-repo-ops:latest}`;
- `ops` remains a one-shot command container;
- `postgres` remains the durable database service;
- `app` uses `restart: unless-stopped`;
- `app` publishes only `8099:8099`.

The service command is:

```text
npm run ops:operator-ui-server -- --serve --host 0.0.0.0 --port 8099
```

Start through Compose:

```text
docker compose -f docker-compose.unraid.runtime.yml up -d postgres app
```

Still forbidden:

- provider contact;
- scraping;
- downloading;
- playback;
- command execution from the UI;
- migrations from the UI;
- backup or KEK rewrap buttons from the UI;
- live provider mode;
- media-server mutation;
- raw secret exposure;
- raw identity exposure.

Product framing remains:

```text
Catalog Authority is the backend orchestration rail, not a streaming product.
```
