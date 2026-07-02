# Phase 21 - External Custodian Acceptance Harness

Phase 21 turns the Phase 16 external-custodian readiness guidance into repo-native acceptance
mechanics. It adds an importable conformance kit and a deterministic local example suite for future
external or managed custodian adapters. It does not add a real KMS adapter, vendor SDK, cloud
dependency, HTTP service, daemon, scheduler, provider integration, or network requirement.

O4 remains open. This phase narrows O4 by making the acceptance test and evidence path concrete;
O4 can close only after a real external/managed adapter passes operator-run live validation and the
redaction-safe evidence is reviewed.

`FileCustodian` remains a hardened reference harness. It is useful for durability, crash recovery,
backup/restore policy, and local contract coverage, but it is not the production custodian/KMS.

## Importable Contract Kit

Future adapters should import the shared kit from:

```ts
import { runCustodianContract, type CustodianFactory } from '../test/helpers/custodian-contract-kit.js';
import type { KeyCustodian } from '../src/core/crypto/custodian.js';

const makeExternalCustodian: CustodianFactory = (): KeyCustodian => {
  return makeFreshIsolatedExternalCustodian();
};

await runCustodianContract('ExternalCustodian', makeExternalCustodian);
```

The factory must return a fresh isolated custodian for each scenario. For a real service, that means
a dedicated namespace, tenant, project, prefix, or emulator fixture that can be discarded without
touching production state.

The kit is importable without running the executable reference suite. The current reference suite
remains `test/custodian-contract.ts`; it imports the kit and runs it against `InMemoryCustodian`,
`FileCustodian`, and factory-created custodians.

## Deterministic Acceptance Example

`test/custodian-acceptance.ts` is the Phase 21 local acceptance example. It uses a local test-only
wrapper around `InMemoryCustodian` fault injection to model an external custodian boundary without
network, cloud, Docker, credentials, or vendor SDKs.

The suite proves:

- the full `KeyCustodian` contract still applies to an adapter-shaped harness;
- transport/service failures are thrown errors and are never translated into `status()` values;
- lost provision acknowledgements retry to the same `keyId` and DEK;
- lost destroy acknowledgements retry to the durable destruction receipt;
- idempotency and terminal-destroyed semantics remain covered by the shared contract kit.

Run it locally with:

```bash
npm run test:custodian-acceptance
```

This script is deterministic and is safe for CI. It must stay local-only: no Docker, live service,
network, cloud account, operator secret, or credential may be required.

## Operator-Run Live Validation

A real external/managed adapter must run validation outside CI. The operator-run validation must be
explicitly labeled live/manual and must cover at least:

- provision, commit, get, destroy, status, and stale-provisioning flows;
- idempotent retries with the same operation id;
- operation id reuse with different inputs failing closed;
- destroyed being terminal, including delayed commit after destroy;
- lost acknowledgement after provision and destroy;
- transport/auth/service/timeout/rate-limit/quorum failures throwing errors instead of returning
  synthetic `not_found`, `destroyed`, empty lists, or fallback key material;
- fail-closed read behavior when the custodian is unavailable or ambiguous;
- durable, stable, re-verifiable destruction receipts;
- backup/restore behavior where main-DB backups exclude custodian key material and restored systems
  fail closed until external prerequisites are supplied.

The live validation may use the importable contract kit or a stricter adapter-specific superset. It
must not be wired into `npm run ci`.

## Evidence and Redaction

Record external custodian evidence in the production readiness evidence bundle. Safe evidence
includes command shapes, adapter name/version/commit, non-secret mode names, pass/fail summaries,
aggregate counts, receipt ids if the deployment treats them as non-secret, and reviewer conclusions.

Do not include KEKs, DEKs, wrapping keys, master-key material, completion/HMAC secrets, access
tokens, API keys, credentials, seed phrases, private keys, raw custodian secret values, database
URLs, secret file paths, raw identity, provider refs, media titles, catalog item dumps, plaintext
identity, full environment dumps, or unredacted logs.

Full attestations should be omitted or redacted unless the deployment explicitly classifies them as
non-secret and reviewer-safe.

## Static Boundary

Phase 21 keeps CI deterministic:

- no new cloud/KMS/vendor SDK dependency;
- no network client dependency;
- no live external custodian, Docker, cloud account, credentials, or secrets;
- no HTTP framework, web/mobile UI, daemon, scheduler, provider/debrid adapter, scraping,
  downloading, playback, Plex, Jellyfin, Real-Debrid, or TorBox behavior.
