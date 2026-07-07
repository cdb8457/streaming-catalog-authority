# Backup Encryption Policy Evidence - Redacted

## Scope

- Evidence label: backup-encryption-policy-2026-07-07
- Host label: Tower
- Backup path label: `/mnt/user/appdata/catalog/backups`
- Redaction status: no secret values, database URLs, backup artifact contents, key material, or raw identity are retained here

## Observed Backup Storage

- Backup artifacts observed: yes
- Artifact labels observed:
  - `catalog-20260706-213318.json`
  - `catalog-20260706-215333.json`
  - `catalog-20260707-044002.json`
- Filesystem label: `/mnt/user`
- Share config label: `appdata`
- Share security: `public`
- Cache policy: `shareUseCache="yes"`, `shareCachePool="cache"`
- File-level `age` available on host: no

## Decision Status

- Backup dump and verification: PASS
- Restore rehearsal: PASS
- Backup encryption at rest: OPEN
- Current evidence supports treating backup artifacts as unencrypted JSON files stored under the operator appdata share.
- This does not satisfy backup encryption-at-rest closure.

## Recommended Remediation Options

1. Install and use file-level encryption such as `age`, then update the backup script to encrypt verified artifacts.
2. Move backup artifacts to an operator-protected/encrypted storage location and document that storage policy.
3. Keep the current layout only as validation-stage storage, not as final protected backup retention.

## Boundary

- This evidence does not include backup contents.
- This evidence does not approve production readiness.
- This evidence does not close O4 or O5.

