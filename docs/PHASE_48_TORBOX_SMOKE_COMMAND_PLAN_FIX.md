# Phase 48 - TorBox Smoke Command Plan Fix

Phase 48 corrects the static Phase 45 TorBox live-smoke operator command shapes after an operator
dry run showed that plain `npm run smoke:torbox-readonly -- --live-smoke ...` is not copy/paste
safe in this repo.

The fixed shape is:

```bash
npm run --silent smoke:torbox-readonly -- -- --live-smoke ...
```

The `--silent` flag keeps redirected JSON clean, and the extra `--` after the npm script separator
prevents npm from consuming smoke CLI flags.

## Scope

Included:

- update static live-smoke command shapes;
- update static saved-report preflight command shapes to use `--silent`;
- test that generated plan output uses the copy/paste-safe form;
- preserve all redaction and operator-run boundaries.

Not included:

- no credential values;
- no credential-file reads;
- no live TorBox calls;
- no command execution from the plan command;
- no SDK dependency;
- no provider writes;
- no downloads, playback, scheduler, UI, or provider payload persistence.

O4 and O5 remain open/deferred, and `FileCustodian` remains a hardened reference harness rather than
production KMS.
