# Phase 197 - Production Custody Switch Retry

Report id: `phase-197-production-custody-switch-retry`

Phase 197 re-executed the Phase 193 runtime cutover plan after the Phase 196 parser fix. The retry
completed successfully. Production now runs with `CUSTODIAN_MODE=sidecar` for both `app` and `ops`.

No provider, scraping, download, playback, Plex, Jellyfin, media-server, or public sidecar exposure
changes were made.

## Preconditions

All required preconditions passed before the runtime switch:

- Phase 196 parser fix was present at HEAD and tagged `phase-196`.
- `test:cutover-parser` passed at HEAD before cutover.
- Phase 193 cutover plan existed and defined rollback/abort semantics.
- Phase 194 sidecar service was healthy and idle.
- Sidecar access was socket-only with no published ports.
- Runtime began in `CUSTODIAN_MODE=file`.
- A fresh pre-cutover doctor checkpoint parsed as `healthy`.
- UI live check returned `ok:true`.
- Fresh custody-state backup and snapshots were captured and verified readable/restorable.

Pre-cutover evidence manifest digest:
`e031eb7326f8acb0bf79d9e77ed2f64ffe4c6b67a43ffb43f55c13c90ae4f49f`

Backup evidence digests:

- database dump: `64206d787bfe51a669130f4f6647bcc25990473cca6598b2c281fc9f573b6c0d`
- database restore-list verification: `fc5d4ef82f536f47f7e4814b5f3612534788bd975532f69823c150f6a96962e5`
- file-custodian keystore snapshot: `6cb6fdaa17222ebcb89dd0b36dc537019fadb42929787490ef211e9786de1663`
- file-custodian keystore snapshot listing: `72d8282429d23045d2afcc81e368dfc43867103d1cdbc2e302c2c9d5dde52b00`
- sidecar state snapshot: `2d9035896da81478581a15ca7eb0638d65b748a2fa756b50f659b80595962a4c`
- sidecar state snapshot listing: `bff10f04ee776e889f8e1c5f10d5b9f2d4c0191cbe655be35a47c7cf55d3c632`

## Runtime Change

The planned runtime diff was applied to `app` and `ops`:

- `CUSTODIAN_MODE=file` changed to `CUSTODIAN_MODE=sidecar`.
- `CUSTODIAN_SIDECAR_SOCKET_PATH=/run/catalog-sidecar/catalog-sidecar.sock` was added.
- The sidecar run socket mount replaced the file keystore mount for `app` and `ops`.
- `completion_secret` and `custodian_kek` mounts were removed from `app` and `ops`.
- Postgres, operator UI port, and the sidecar service public exposure boundary were unchanged.

Sidecar-mode runtime compose snapshot digest:
`de4ef3f252dba52e87c318080df1aa1412ede3062949b61b123e75dba536807e`

## Execution Log

| Runbook Step | Result | Evidence |
|---|---|---|
| Pre-check Phase 196 parser | `pass` | `test:cutover-parser` passed; digest in pre-cutover manifest |
| Pre-check sidecar socket-only health | `pass` | no published sidecar ports; socket stat captured by digest |
| Capture backup and snapshots | `pass` | database, keystore, sidecar state, and compose snapshots verified |
| Stop app only | `pass` | Postgres and sidecar stayed healthy |
| Apply runtime diff | `pass` | sidecar-mode compose snapshot retained |
| Recreate app | `pass` | app reached healthy with `CUSTODIAN_MODE=sidecar` |
| Corrected post-switch doctor checkpoint | `pass` | parser attempt 1 returned `healthy` |
| UI/API health | `pass` | live UI returned `ok:true` |
| App-path custody assertion | `pass` | running app container doctor parsed `healthy` in sidecar mode |
| Sidecar exposure proof | `pass` | sidecar had no published ports after switch |
| Restart persistence | `pass` | app restart and sidecar restart both returned healthy parser verdicts |

Doctor checkpoint log:

```text
attempt=1 doctor_exit=0 parser_exit=0 verdict=healthy
```

Corrected parser result for the post-switch checkpoint:

```json
{"status":"healthy","retryable":false,"ok":true,"reportVersion":1,"pass":11,"warn":1,"fail":0,"total":12}
```

## Post-Switch Evidence

Post-switch evidence manifest digest:
`334703bb045778a3ec5da0fc90606542f895fe9524e245985c701fe48a1c4448`

Selected post-switch evidence digests:

- post-switch doctor output: `6f063b983353f1a41d56778734c3c2c18146033da4b328ede1cc4894eafad6cf`
- post-switch doctor parser output: `39814d9d462470f02407b268b1f2e2d96b7b4d4aef647f77b5e98cb7cb9ba7ed`
- post-switch UI live check: `243cf663972ba95d69c9ad6b422a47f216208282eab7bbb642c81ead3aee0406`
- app-path doctor output: `7161a73be6918153f0d6c1fcf2bf4d8cc45f7ae135539193fc6c655781eb0dcd`
- app-path doctor parser output: `14ff8e88b63e5c60480c8e5f4a614666f01d5aba8c45bd7bda013d8ace45aafa`
- ops-path doctor parser output: `93111d42790c85b144b49cf1b30f01c1f50103cf2a9341445a2ec289ce2f1263`
- sidecar exposure proof: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- sidecar socket stat: `2a9edbfaec4ac5d656e1ad3ab7f4eeb447bc6a295a098b3b84ff51643dda1bd8`
- compose status: `65587b25f42bdd1edb129afab053c27298be2583bfa145a39a22a1df4fcff475`

App-path custody assertion:

- doctor reported `custodian mode=sidecar`;
- doctor reported completion secret delegation to the sidecar custodian;
- doctor reported `custodian-reachable`;
- parser verdict was `healthy`, `ok:true`, `fail:0`.

## Restart Persistence

Persistence evidence manifest digest:
`b88250caeefdd48dd5a296d49ff5b03489d19326da4d614758809c79d61abbb0`

Selected persistence digests:

- after app restart parser output: `f4d51ceba83fc12223a83fdac3c49016fbf9e1f6012d4d0f2191a885efbef53f`
- after app restart UI live check: `243cf663972ba95d69c9ad6b422a47f216208282eab7bbb642c81ead3aee0406`
- after sidecar restart parser output: `1587787a4a85692820dad3548a88958a3c3979b87e612b43b5da9a1c316a443d`
- after sidecar restart UI live check: `a586f672c8495e9ee64c494234adcf1dbf71cedb437da180a497a4b46e800c9a`
- persistence compose status: `7b94601063a7146c893085fdecefcb806b40c1fac2434c7908889baed432afc4`

Both persistence parser verdicts were:

```json
{"status":"healthy","retryable":false,"ok":true,"reportVersion":1,"pass":11,"warn":1,"fail":0,"total":12}
```

## Rollback

Rollback was not triggered.

The Phase 193 rollback path remains valid if a future regression requires returning from
`CUSTODIAN_MODE=sidecar` to `CUSTODIAN_MODE=file`. Any future rollback must preserve both sidecar
state and file-custodian keystore state for reconciliation review.

## Status

Phase 195 retry result: `production-sidecar-custody-active`

O4 status after Phase 197: `closure-eligible`

O5 status after Phase 197: `open/deferred`

Phase 197 satisfies the production custody switch criterion in the Phase 192 readiness gate. O4 is
closure-eligible, not silently closed by this record. O5 is unchanged and remains the only custody
gate left open/deferred.
