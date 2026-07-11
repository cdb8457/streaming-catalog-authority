# Phase 161 - Operator UI Access Validation

Report id: `phase-161-operator-ui-access-validation`

Validated live surface:

- UI URL: `http://192.168.1.31:8099/`
- root UI shell: HTTP `200`
- `/healthz`: HTTP `200`
- unauthenticated `/api/status`: HTTP `401`
- unauthenticated `/api/logs`: HTTP `401`
- launcher `ui-live-check`: `ok=true`

Required access boundary:

- The UI shell may load without a token.
- `/healthz` may load without a token.
- `/api/status` and `/api/logs` must require `X-Operator-UI-Secret`.
- The token must remain file-backed and must not be printed during validation.
- Authenticated checks are performed through `ui-live-check`, which reads the token file inside the
  runtime boundary and emits only redaction-safe status/check summaries.

Still forbidden:

- provider contact;
- scraping;
- downloading;
- playback;
- media-server mutation;
- token printing;
- UI write actions.
