# Phase 60 - UI Design Direction

The approved direction is Graphite + Muted Orange with an Unraid-inspired appliance feel. The
secondary influence is terminal-inspired, but only for technical evidence areas. The whole interface
must not look like a terminal.

This document is a design guide only. It does not add frontend code, CSS, assets, images, routes, or
runtime behavior.

## Recommended Visual Direction

The UI should read as a quiet local appliance console:

- graphite chassis background;
- bordered panels instead of shadow-heavy cards;
- fixed left navigation;
- top status/search strip;
- compact, readable tables;
- restrained status chips;
- muted orange active and focus states;
- terminal flavor only where it clarifies operational evidence.

The personality is professional homelab appliance: local-first, calm, readable, operator-focused,
privacy/security conscious, and medium density.

## Design Tokens

| Token | Value | Use |
| --- | --- | --- |
| `color.background` | `#111214` | App chassis and page background. |
| `color.panel` | `#1A1B1E` | Primary panels, tables, navigation. |
| `color.panelElevated` | `#232428` | Hover, popover, selected row, modal surface. |
| `color.border` | `#303238` | All structural borders and table separators. |
| `color.textPrimary` | `#ECECEC` | Headings and primary row text. |
| `color.textMuted` | `#A0A3A8` | Secondary labels and metadata. |
| `color.accent` | `#D18A3A` | Active nav, focus ring, primary operator intent. |
| `color.success` | `#7E9B75` | Verified, synced, healthy. |
| `color.warning` | `#C09A4A` | Review Required, deferred, drift. |
| `color.danger` | `#B96A64` | Failed, blocked, destructive state labels. |
| `color.info` | `#7D91A8` | Informational status. |
| `radius.small` | `4px` | Buttons, inputs, chips. |
| `radius.panel` | `6px` to `8px` | Main panels and repeated row groups. |
| `spacing.unit` | `4px` | Base rhythm. |
| `spacing.gutter` | `16px` | Panel and grid spacing. |
| `layout.sidebarWidth` | `240px` | Desktop left navigation. |

## Typography

Recommended stack:

- Headings and navigation: Source Sans 3, Atkinson Hyperlegible, or system UI.
- Body: Atkinson Hyperlegible, Source Sans 3, or system UI.
- Technical metadata: JetBrains Mono, Source Code Pro, or a system monospace.

Use monospace only for:

- Event Sequence
- hash/status metadata
- Backup Verified output
- Reconcile Status codes
- Key State metadata
- Custodian Status metadata
- audit log rows
- packet count rows

Do not use monospace for normal buttons, paragraphs, screen titles, or navigation labels unless the
label is an operational code.

## Layout Rules

- Keep desktop navigation fixed on the left.
- Keep the top status strip shallow and persistent.
- Use full-width page bands and bordered panels; do not nest UI cards inside other cards.
- Use compact tables for repeated operational state.
- Keep rows scannable with strong alignment and consistent column widths.
- Prefer 8px or less corner radius.
- Use 1px borders and tonal layering instead of ambient shadows.
- Use focus rings with muted orange.
- On small screens, collapse navigation into a compact drawer or top-level menu while preserving the
  same screen order.

## Table, Log, And Status Rules

Tables:

- Use 8px vertical cell padding.
- Use uppercase or small mono labels for column headers.
- Use row borders, not zebra-striping as the primary separator.
- Use hover and selected states from `color.panelElevated`.
- Keep action controls secondary and never expose unsafe actions from a table row.

Logs:

- Use terminal flavor only for audit logs, event sequence numbers, key state metadata, backup
  verification output, reconciler activity, and hash/status metadata.
- Use muted graphite background and compact monospace rows.
- Do not use fake real timestamps, real actor names, node names, or environment paths.
- Prefer labels such as Event Sequence, Review Required, Backup Verified, and Reconcile Status.

Status:

- Use rectangular chips with a 1px border and subtle tinted background.
- Every chip must include text; never rely on color alone.
- Keep success muted olive, warnings muted clay, danger muted red, and info desaturated blue-gray.
- Use Review Required for human review, not alarmist copy.

## Rejected And Avoided Patterns

- AI-looking gradients, glassmorphism, purple/blue neon, decorative orbs, and bokeh effects.
- Giant rounded SaaS cards, hero sections, marketing copy, and split hero layouts.
- Chatbot panels, AI assistant UI, or conversational command centers.
- Netflix/media browsing layout, poster art, streaming artwork, provider logos, and content imagery.
- Terminal-only visual treatment across the whole UI.
- Fake topology/network maps and fake node names as the central metaphor.
- Export, provision, destructive shred, download, playback, or provider-control CTAs.
- Generated avatars, remote generated images, and ornamental screen art.
- Real-looking timestamps, actors, external IDs, infohashes, magnets, credentials, or user data.

## Screen-Specific Direction

Overview:

- Four to six compact status summaries.
- Recent sanitized activity in a right-side or lower log panel.
- No topology map; use operational summaries instead.

Catalog Authority:

- Dense table first.
- Columns should include Item A/Item B style labels, Provider Count, Shred State, and Reconcile
  Status.
- No provision action.

Privacy & Crypto-Shredding:

- Key State and Custodian Status panels.
- Crypto-shredding state rows.
- No armed destructive action or one-click shred CTA.

Audit Queue:

- Audit table/log hybrid.
- Event Sequence and Review Required must be prominent.
- No export action until a later explicit phase defines redaction-safe export behavior.

Settings / Operator Configuration:

- Quiet panels for local preferences and display policy.
- Future integrations can appear only as disabled placeholders after separate authorization.
