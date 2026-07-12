# Phase 178 - Launch v1 Decision Record

Report id: `phase-178-launch-v1-decision-record`

Decision: `launch-v1-operator-backend-with-open-o4-o5-warnings`

Phase 178 records the launch decision for the current project state. The approved launch target is a
self-hosted catalog/operator backend on Unraid. This is not a streaming product launch and not a
provider/media integration launch.

## Decision Scope

Approved for Launch v1:

- Git-pullable repo and tagged release history;
- canonical Unraid runtime Compose file;
- local `repo-ops:latest` image build path;
- Postgres service;
- one-shot ops service;
- read-only operator UI service;
- Arcane/User Scripts launcher commands;
- UI evidence save/review;
- O4/O5 packet capture/review;
- redaction-safe launch-candidate evidence.

Not approved for Launch v1:

- provider contact;
- Real-Debrid live mode;
- TorBox live provider mode;
- scraping;
- downloading;
- playback;
- Plex/Jellyfin mutation;
- media-server library writes;
- O4 closure;
- O5 closure;
- claims that managed custody is closed.

## Accepted Open Warnings

| Gate | Launch v1 status | Reason |
|---|---|---|
| O4 external/managed custodian | accepted open warning | The current `FileCustodian` is a hardened reference harness. Sidecar custodian work is ready for design review but not implemented/closed. |
| O5 managed KEK custody/scheduling | accepted open warning | Manual/operator KEK custody remains the current posture. Sidecar-owned KEK custody is the recommended next design path. |
| Provider/media integration | out of scope | Launch v1 is the backend/operator rail only. |

## Launch Claim

Allowed claim:

```text
Catalog Authority Launch v1 is ready as a self-hosted backend/operator foundation with visible
O4/O5 managed-custody warnings and no provider/media behavior.
```

Forbidden claim pattern:

```text
Catalog Authority includes managed-custody production closure, provider integration, downloads,
playback, or media-server orchestration.
```

## Next Recommended Work

After Launch v1, the next engineering track should be the O4/O5 local sidecar custodian design review
and implementation path. Provider and media integration should remain deferred until the custody
boundary is explicitly accepted or Clint authorizes a separate scoped provider phase.
