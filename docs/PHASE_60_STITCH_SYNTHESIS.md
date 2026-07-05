# Phase 60 - Stitch Design Synthesis

Four Stitch export folders were inspected as reference material only:

- `overview.design.md`
- `CatalogAuthority.Design.MD`
- `privacy.design.md`
- `audit.queue.design.md`

Each folder includes `DESIGN.md`, `code.html`, and `screen.png`. The generated HTML and images are
not implementation inputs and must not be copied into the product. They are useful only for design
signals.

## Shared Contribution

All four `DESIGN.md` files contributed the same Graphite Appliance design language:

- deep graphite background;
- slightly elevated graphite panels;
- muted orange primary accent;
- compact spacing on a 4px rhythm;
- left navigation around 240px wide;
- fixed status/search strip;
- bordered panels and tables;
- small rectangular status chips;
- readable sans typography with monospace reserved for technical metadata.

This shared base aligns with the approved direction: Graphite + Muted Orange, Unraid-inspired,
terminal-influenced but polished.

## Folder Contributions

| Stitch folder | Useful contributions | Sanitized interpretation |
| --- | --- | --- |
| `overview.design.md` | Fixed left navigation, top status strip, health summary cards, recent activity rows, compact operational density. | Use Overview as a status cockpit with System Health, Backup Integrity, Reconcile Status, Provider Count, Packet Count, Review Required, and recent sanitized activity. |
| `CatalogAuthority.Design.MD` | Dense table layout, search strip, status chips, hoverable rows, provider count and shred/reconcile columns. | Use Catalog Authority as the primary table pattern, but replace specific item names with Item A and Item B and remove provision actions. |
| `privacy.design.md` | Key state panels, security module tables, warning/success chip language, crypto-shredding emphasis. | Use Privacy & Crypto-Shredding for Key State, Custodian Status, and Shred State panels; remove armed/destructive shred controls and fake enclave/module names. |
| `audit.queue.design.md` | Audit table, Event Sequence column, review/log density, top search/filter strip, status result chips. | Use Audit Queue for redacted event sequence review; remove export controls, fake real actors, node names, and real-looking timestamps. |

## Patterns To Keep

- Fixed left navigation with muted orange active marker.
- Top status/search strip for safe search and operational warnings.
- Dense tables for operator workflows.
- Bordered panels with graphite tonal layering.
- Status chips with text labels and muted semantic colors.
- Review Required badges.
- Audit/log rows with limited terminal flavor.
- Monospace for Event Sequence, Key State metadata, Backup Verified output, hash/status metadata, and
  Reconcile Status.
- Medium-density screen layouts that prioritize scan speed over decoration.

## Patterns To Reject

- Fake node names, host names, cluster names, and actor names.
- Real-looking timestamps.
- Topology/network map as the main Overview pattern.
- Provision, export, destructive shred, download, playback, or provider-control actions.
- Generated avatars, generated remote images, or ornamental image assets.
- Terminal styling applied to the entire application.
- Overly serif or command-line-only styling.
- AI-looking gradients, purple/blue neon, glassmorphism, giant rounded cards, or marketing hero
  sections.
- Media browsing layouts, provider logos, poster art, streaming artwork, real content titles,
  external IDs, infohashes, magnets, credentials, or user library data.

## Final Recommended Synthesis

The future operator UI should synthesize the exports into a restrained appliance console:

- Overview: system health summary plus recent sanitized activity, no topology map.
- Catalog Authority: dense table with Item A/Item B, Provider Count, Shred State, and Reconcile
  Status.
- Privacy & Crypto-Shredding: key-control state and crypto-shredding lifecycle, no destructive CTA.
- Key Custodian / O4 Status: explicit O4/O5 open-deferred posture and FileCustodian reference-harness
  boundary.
- Reconciler: event-sequence activity and drift/lost-ack status.
- Backup & Restore: Backup Integrity, Backup Verified, and replay-and-compare status.
- Provider Availability Packets: count-only packet review with Review Required badges.
- Audit Queue: redacted event sequence table with warning/error states.
- Settings / Operator Configuration: local appliance preferences and redaction policy panels.

## Design Token Proposal

Use the Phase 60 baseline rather than the warmer brown tones emitted by the exports:

| Role | Recommended value |
| --- | --- |
| Background | `#111214` |
| Panel | `#1A1B1E` |
| Panel elevated | `#232428` |
| Border | `#303238` |
| Text primary | `#ECECEC` |
| Text muted | `#A0A3A8` |
| Accent | `#D18A3A` |
| Success | `#7E9B75` |
| Warning | `#C09A4A` |
| Danger | `#B96A64` |
| Info | `#7D91A8` |

Typography:

- Source Sans 3, Atkinson Hyperlegible, or system UI for primary interface text.
- Monospace only for technical metadata, sequence numbers, hashes, logs, and status codes.

## Implementation Guardrails For Later Phases

- Start from a safe UI packet schema before adding a runtime UI.
- Build contract tests that reject unsafe fields before any screen renders data.
- Keep provider availability advisory and count-only.
- Keep O4 and O5 visible as open/deferred.
- Keep FileCustodian clearly labeled as reference harness only.
- Treat all Stitch folders as non-committed reference material.
- Do not import generated HTML, generated images, remote image URLs, or Stitch assets.
