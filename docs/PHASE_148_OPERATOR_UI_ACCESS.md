# Phase 148 - Operator UI Access Hardening

Report id: `phase-148-operator-ui-token`

Phase 148 hardens the already-running operator UI by adding safe token operations, clearer dashboard
status, and copy/paste validation steps for Unraid.

Token helper:

```text
ops:operator-ui-token
```

Safe commands:

```bash
npm run ops:operator-ui-token -- --show-path
npm run ops:operator-ui-token -- --status --json
npm run ops:operator-ui-token -- --rotate --confirm --json
```

From Arcane or another Compose launcher, run the same helper through the one-shot `ops` service:

```bash
docker compose -f docker-compose.unraid.runtime.yml run --rm ops ops:operator-ui-token -- --status --json
docker compose -f docker-compose.unraid.runtime.yml run --rm ops ops:operator-ui-token -- --rotate --confirm --json
```

The default token path is:

```text
/mnt/user/appdata/catalog/secrets/operator_ui_token
```

The `ops` service has a dedicated bind mount for only that token file so status, print, and rotation
operate on the same file the Unraid launcher uses.

The running container consumes the same secret at:

```text
/run/secrets/operator_ui_token
```

The token value is not printed by status or rotation. Printing the token requires the explicit
two-flag command:

```bash
npm run ops:operator-ui-token -- --print --confirm-print
```

Use this only when signing into the local operator UI.

Live UI:

```text
http://192.168.1.31:8099/
```

The UI remains read-only first. It now shows:

- service name;
- mode;
- port;
- doctor result;
- pass/warn/fail counts;
- attention items;
- redacted recent logs.

Live validation checklist:

```bash
curl -fsS http://127.0.0.1:8099/healthz
curl -s -o /tmp/catalog-ui-unauth.json -w "%{http_code}" http://127.0.0.1:8099/api/status
TOKEN="$(cat /mnt/user/appdata/catalog/secrets/operator_ui_token)"
curl -fsS -H "x-operator-ui-secret: ${TOKEN}" http://127.0.0.1:8099/api/status
curl -fsS -H "x-operator-ui-secret: ${TOKEN}" http://127.0.0.1:8099/api/logs
```

Expected results:

- `/healthz` returns `ok: true`;
- unauthenticated `/api/status` returns `401`;
- authenticated `/api/status` returns `200` when doctor has no fail checks;
- O4/O5 warnings may still appear and remain expected;
- no token, database URL, KEK, or completion secret is echoed.

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
