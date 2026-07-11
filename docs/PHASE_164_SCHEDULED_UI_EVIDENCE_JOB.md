# Phase 164 - Scheduled UI Evidence Job

Report id: `phase-164-scheduled-ui-evidence-job`

Phase 164 adds a narrow scheduled evidence wrapper:

```text
deploy/unraid-ui-evidence-check.sh
```

The wrapper runs:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check-save
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-evidence-review <latest-saved-evidence>
```

Recommended Unraid User Script:

```text
/boot/config/plugins/user.scripts/scripts/catalog-ui-evidence-check
```

Script body:

```bash
#!/bin/bash
set -euo pipefail
/mnt/user/appdata/catalog/repo/deploy/unraid-ui-evidence-check.sh
```

Recommended cadence:

- hourly or daily, depending on how much retained evidence the operator wants;
- alert on non-zero exit;
- retain evidence under `/mnt/user/appdata/catalog/backups/evidence`;
- periodically prune old retained evidence according to the operator backup policy.

Allowed behavior:

- save redaction-safe operator UI live-check JSON;
- review the latest saved JSON for valid JSON, schema completeness, recency, and passing check state;
- exit nonzero on any failed live-check or evidence-review gate.

Forbidden behavior:

- token printing;
- backup restore;
- KEK rotation;
- provider contact;
- scraping;
- downloading;
- playback;
- media-server mutation;
- UI write actions.
