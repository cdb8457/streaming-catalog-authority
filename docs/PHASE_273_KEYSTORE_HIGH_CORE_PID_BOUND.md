# Phase 273 — High-core keystore preparation PID bound

## Problem

The v1.1.3 consumer stacks run a narrow root-only `keystore-prepare` one-shot before migration and the app.
It has a 64-PID limit by design. On a Docker host exposing 128 CPUs, `tsx` launches esbuild's Go helper before
Catalog Authority repair code runs. Go sizes its runtime from the visible CPU count; the Compose CPU quota
does not change that count. The helper can therefore exhaust the PID limit and exit before the keystore is
checked.

This is fail-closed — migration and the app remain stopped — but it makes a valid installation unavailable.

## Remediation

Both consumer stacks set:

```yaml
environment:
  GOMAXPROCS: "2"
```

The setting applies only to `keystore-prepare`. It bounds the helper's runtime threads while preserving all
existing containment:

- `pids_limit: 64`;
- a one-CPU quota and 256 MiB memory limit;
- no network;
- read-only root filesystem;
- one keystore mount and no secrets;
- all capabilities dropped except `CHOWN`, `FOWNER` and `DAC_OVERRIDE`; and
- `no-new-privileges`.

The long-running app and migration services are unchanged.

## Evidence

The published v1.1.3 image reproduced `failed to create new OS thread` with `errno=11` on a 128-CPU Unraid
host. The same image, PID limit and repair command with `GOMAXPROCS=2` returned `ALREADY_CORRECT`. The patched
stack subsequently passed migration, schema and least-privilege checks, restart/idempotency, authenticated
release identity, and the complete import/browse/history operator workflow.

`test/keystore-repair.ts` requires the bound in both `docker-compose.runtime.yml` and
`docker-compose.arcane.yml`, preventing either consumer path from regressing independently.
