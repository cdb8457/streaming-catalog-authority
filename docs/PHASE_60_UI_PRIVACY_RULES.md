# Phase 60 - UI Privacy Rules

The operator UI must be privacy-safe by design. It should make system state observable without
revealing what the user owns, watches, stores, searches for, downloads, or intends to play.

This is a documentation-only privacy contract for future UI phases.

## Display Boundary

The UI may display:

- Item A and Item B labels;
- Provider Count;
- Shred State;
- Backup Integrity;
- Reconcile Status;
- Event Sequence;
- Packet Count;
- Review Required;
- Key State;
- Custodian Status;
- Backup Verified;
- fixed finding codes and safe operational categories.

The UI must not display:

- real titles;
- external IDs;
- provider names/logos;
- infohashes;
- magnets;
- credentials;
- user library data;
- poster art;
- streaming artwork;
- raw provider refs;
- raw event payloads;
- key material, receipts, handles, or secret paths;
- database URLs, tokens, environment dumps, or operator secrets.

## Synthetic Labels

Examples, fixtures, screenshots, and documentation must use only synthetic operational labels:

```text
Item A
Item B
Provider Count
Shred State
Backup Integrity
Reconcile Status
Event Sequence
Packet Count
Review Required
Key State
Custodian Status
Backup Verified
```

Do not introduce plausible media names, provider brands, user names, host names, node names,
collection names, watch states, artwork, or file labels.

## Screen Rules

Overview:

- Show counts, gate status, and redacted operational labels only.
- Recent activity must use event sequence labels and fixed categories, not actors or raw timestamps.

Catalog Authority:

- Item rows must use Item A, Item B, or similarly synthetic labels.
- Do not expose catalog identity, media metadata, external identifiers, provider refs, or library
  state.

Privacy & Crypto-Shredding:

- Display Key State and Custodian Status as fixed states.
- Display Shred State as a lifecycle label.
- Do not expose key IDs, key handles, ciphertext, receipts, or destructive controls.
- FileCustodian must be labeled as a reference harness only when it appears.

Key Custodian / O4 Status:

- O4 remains open/deferred until separate production evidence is accepted.
- O5 remains open/deferred.
- Do not imply that reference harness status is production KMS status.

Reconciler:

- Display Reconcile Status, Event Sequence, and category counts.
- Do not expose raw records, payload diffs, provider refs, or user content identity.

Backup & Restore:

- Display Backup Integrity and Backup Verified.
- Do not expose backup paths, secret paths, decrypted payloads, or key material.

Provider Availability Packets:

- Display Provider Count, Packet Count, Review Required, and fixed availability categories only.
- Do not display provider names, provider logos, raw refs, external identifiers, response bodies,
  token-bearing URLs, or item identity.

Audit Queue:

- Display Event Sequence, fixed action category, fixed result state, and Review Required.
- Do not display real actors, hostnames, IP addresses, raw timestamps, raw logs, paths, or secrets.

Settings / Operator Configuration:

- Settings may show redaction policy and local display preferences.
- Settings must not collect provider credentials or expose hidden secrets.

## Table And Log Redaction Rules

- Table cells must be allowlisted by field name.
- Log rows must be generated from fixed categories, not raw log text.
- Search must operate on safe labels only.
- Filters must use fixed state values only.
- Empty states must not include examples with real titles or provider identifiers.
- Error messages must not echo unsafe input values.
- Copy-to-clipboard controls must be disabled for fields that could later contain secrets or raw refs.
- Export controls are out of scope until a later phase defines redaction-safe export behavior.

## Warning And Review Language

Use neutral operator language:

- Review Required
- Deferred
- Open
- Verified
- Warning
- Failed
- Blocked
- Synced

Avoid dramatic language that could push operators toward unsafe action:

- do not say "armed" for crypto-shredding state;
- do not add one-click destructive commands;
- do not show "download", "play", "stream", or "open provider" actions;
- do not label provider packet states as media availability for a specific item.

## Future Privacy Tests

Future implementation phases should add automated checks that reject UI packet fields matching unsafe
categories, including:

- title-like fields;
- external identifier fields;
- provider ref fields;
- credential fields;
- token or secret fields;
- raw log fields;
- image/artwork fields;
- playback or download action fields.

The UI should be considered unsafe by default until its packet schema and rendering paths are covered
by these allowlist checks.
