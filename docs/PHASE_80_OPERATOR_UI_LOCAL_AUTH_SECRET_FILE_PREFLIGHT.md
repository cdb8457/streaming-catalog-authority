# Phase 80 - Operator UI Local Auth Secret File Preflight

Phase 80 adds the `operator-ui-local-auth-secret-file-preflight` report as a redaction-safe Local Auth Secret File Preflight for the operator UI boundary selected in Phase 79. It is preflight-only: runtime auth remains blocked, authImplementation remains `not-implemented`, and no auth/runtime/route/provider/UI/data expansion is added.

Run the preflight with one explicit descriptor JSON file:

```bash
npm run --silent ops:operator-ui-local-auth-secret-file-preflight -- -- <descriptor.json> --json
```

The report name is `operator-ui-local-auth-secret-file-preflight`, version `phase-80.v1`, code `OPERATOR_UI_LOCAL_AUTH_SECRET_FILE_PREFLIGHT_REPORTED`, and status `ready-for-review/preflight-only` only when the descriptor is complete. Incomplete or invalid input reports `blocked/preflight-only`. The selected boundary remains `local-operator-secret-file-with-explicit-path-and-redacted-evidence`; `authImplementation` remains `not-implemented`; runtime auth remains blocked.

The CLI accepts a single explicit operator JSON descriptor file. The descriptor path is never echoed, descriptor values are never echoed, the future secret file path is not read, and the future secret path is not validated against the filesystem. The pure module evaluates only a descriptor object and performs no fs, environment, network, DB, runtime route, or secret-read behavior.

Accepted descriptor fields are labels and booleans only:

```json
{
  "boundaryId": "local-operator-secret-file-with-explicit-path-and-redacted-evidence",
  "operatorFilePathProvided": true,
  "defaultPathDisabled": true,
  "envSecretValueDisabled": true,
  "cliSecretValueDisabled": true,
  "maxSecretFileBytes": 4096,
  "trimOneTrailingNewlineOnly": true,
  "rejectEmptyOrWhitespace": true,
  "rejectLowEntropyOrShort": true,
  "constantTimeComparisonPlanned": true,
  "secretNeverLoggedOrPersisted": true,
  "redactionSafeErrors": true,
  "loopbackOnly": true,
  "browserStorageCookieSessionBearerBasicOAuthDisabled": true,
  "reviewerGoRecorded": true,
  "operatorAcceptanceRecorded": true
}
```

`maxSecretFileBytes` must be positive and <= 4096. The `constantTimeComparisonPlanned` field is only an acceptance label for a later reviewed implementation; Phase 80 does not implement comparison, credential validation, password parsing, tokens, cookies, sessions, bearer/basic auth, OAuth, route handlers, API routes, DB reads, file-secret reads, environment secret reads, or config secret reads.

Forbidden descriptor fields fail closed without echoing values: `secret`, `secretValue`, `path`, `secretPath`, `filePath`, `token`, `password`, `authorization`, `cookie`, `url`, `databaseUrl`, `rawRef`, `infohash`, `magnet`, `title`, `providerName`, `packetContents`, and `artifactContents`. Unknown fields also fail closed without echoing the field value.

Input failures use fixed redaction-safe codes/messages and do not echo descriptor path, descriptor contents, secret values, token-like strings, external IDs, provider names, infohashes, magnets, raw packet/artifact contents, DB URLs, credentials, or user library data. Covered failure codes include `DESCRIPTOR_FILE_REQUIRED`, `DESCRIPTOR_FILE_READ_FAILED`, `DESCRIPTOR_FILE_IS_DIRECTORY`, `DESCRIPTOR_FILE_TOO_LARGE`, `DESCRIPTOR_JSON_MALFORMED`, and `DESCRIPTOR_OBJECT_REQUIRED`.

Current static runtime routes remain exactly `GET /, GET /healthz, GET /manifest.json`. Forbidden current routes such as `/login`, `/auth`, `/session`, `/token`, `/callback`, `/logout`, `/oauth`, `/sso`, `/admin`, `/api/packets`, `/packets`, `/packet`, and `/operator-packets` remain fixed 404 paths. Known static routes keep fixed 405 responses for unsupported methods.

Runtime auth remains blocked until an explicit later implementation phase, independent reviewer GO for implementation, redaction-safe evidence, operator acceptance, and static route-surface regression evidence. O4/O5 remain open/deferred, FileCustodian remains a hardened reference harness only, and Provider availability remains packet/count/advisory only.
