# Backup Passphrase Custody Evidence - Redacted

## Scope

- Evidence label: backup-passphrase-custody-2026-07-07
- Host label: Tower
- Secret label: backup encryption passphrase
- Redaction status: passphrase value is not retained; no secret values, database URLs, key material, backup contents, or raw identity are retained here

## Observed State

- Passphrase file exists: yes
- File permission mode: `-rw-------`
- Owner label: root
- Size: 64 bytes
- Used by: `catalog-backup-verify` User Script for OpenSSL backup encryption/decryption verification

## Custody Requirement

- The passphrase is required to decrypt `.json.enc` backup artifacts.
- Loss of the passphrase means encrypted backup artifacts cannot be restored.
- The passphrase must be backed up separately from:
  - encrypted backup artifacts
  - DB data
  - FileCustodian keystore
  - runtime secret files

## Decision Status

- Local file presence and permissions: PASS
- Separate off-host/passphrase backup: operator action required
- Custody policy fully closed: no, until operator confirms a separate protected backup exists

## Boundary

- This evidence does not include the passphrase.
- This evidence does not close O4 managed/external custodian evidence.
- This evidence does not close O5 managed KEK custody or rotation automation evidence.

