# Unraid Backup Encryption Evidence - Redacted

## Scope

- Evidence label: unraid-backup-encryption-2026-07-07
- Host label: Tower
- Backup script label: `catalog-backup-verify`
- Encryption tool: OpenSSL
- Encryption mode: AES-256-CBC with salt and PBKDF2
- PBKDF2 iterations: 200000
- Redaction status: no passphrase, secret values, database URLs, backup artifact contents, key material, or raw identity are retained here

## Script Update

- Backup passphrase file created under protected catalog secrets path: yes
- Backup script updated to:
  - dump backup artifact
  - verify plaintext backup structurally
  - encrypt artifact to `.json.enc`
  - decrypt encrypted artifact to a temporary file
  - verify decrypted temporary artifact structurally
  - remove plaintext and temporary decrypted files
  - retain redacted evidence label

## Proof Run

| Step | Result | Redacted summary |
|---|---:|---|
| backup dump | PASS | 5 tables; ciphertext only; no key material |
| plaintext verify | PASS | offline structural check passed |
| encryption | PASS | `.json.enc` artifact created |
| decrypt-to-temp | PASS | temporary decrypted file created for verification only |
| decrypted verify | PASS | offline structural check passed |
| cleanup | PASS | plaintext and temp decrypted files removed |

## Artifact Labels

- Encrypted backup artifact label: `catalog-20260707-073512.json.enc`
- Redacted evidence label: `backup-encrypt-verify-20260707-073512.redacted.txt`
- Plaintext artifact retained for this run: no
- Temporary decrypted artifact retained for this run: no

## Boundary

- This proves file-level encrypted backup wrapping for the User Script path.
- Backup passphrase custody remains operator responsibility.
- This does not close O4 managed/external custodian evidence.
- This does not close O5 managed KEK custody or rotation automation evidence.
- This does not approve launch, production readiness, a release candidate, or a production release by itself.

