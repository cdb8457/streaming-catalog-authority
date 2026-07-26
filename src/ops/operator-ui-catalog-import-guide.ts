import {
  CATALOG_SNAPSHOT_FORMAT,
  CATALOG_SNAPSHOT_VERSION,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_EXTERNAL_ID_LENGTH,
  IMPORT_MAX_ITEMS,
  IMPORT_MAX_METADATA_KEYS,
  IMPORT_MAX_REF_VALUE_LENGTH,
  IMPORT_MAX_TITLE_LENGTH,
  IMPORT_MAX_YEAR,
  IMPORT_MIN_YEAR,
} from '../core/catalog/import-snapshot.js';
import { KNOWN_REF_TYPES } from '../core/catalog/events.js';

// Phase 260 — the import instructions, rendered into the operator UI.
//
// WHY THIS IS IN THE UI AND NOT ONLY IN A DOCUMENT. Someone who has just installed this and opened the page
// has an empty catalog. "Empty" is a healthy state, but it is only a useful one if the page also says what to
// do about it. Sending them to a repository they do not have a checkout of, to read a format they then have
// to hand-copy, is how a working feature goes unused.
//
// IT IS SERVER-RENDERED AND NEEDS NO TOKEN, for the same reason the first-run checklist does not: this is
// static guidance, identical for every installation, and the person who most needs it is often the one who
// cannot log in yet. Nothing here reads the database or an operator's data.
//
// EVERY BOUND COMES FROM import-snapshot.ts. Not one number below is written twice: if a limit changes, this
// panel changes with it, so the page cannot document a format the importer does not accept.

export interface CatalogImportField {
  readonly field: string;
  readonly required: boolean;
  readonly rule: string;
}

export interface CatalogImportStep {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}

export interface CatalogImportCommandPair {
  readonly label: string;
  readonly command: string;
}

export const CATALOG_IMPORT_NOTE =
  'An empty catalog is a healthy state, not a fault. To fill it, write one JSON file describing your records '
  + 'and put it in the folder this stack mounts read-only. Then import it from this page — choose the file, '
  + 'preview it, and only then apply — or run the same import from a terminal with the commands below. Both '
  + 'do exactly the same thing, because both run the same code. A preview writes nothing, so you can always '
  + 'look before you commit, and an apply is bound to the exact file you previewed. The import reads that one '
  + 'file and contacts no provider, media server or library.';

export function catalogImportFieldTable(): readonly CatalogImportField[] {
  return [
    { field: 'format', required: true, rule: `exactly "${CATALOG_SNAPSHOT_FORMAT}"` },
    { field: 'version', required: true, rule: `exactly ${CATALOG_SNAPSHOT_VERSION}` },
    {
      field: 'source',
      required: true,
      rule: 'a label for where these records came from: lower-case letters, digits, dot, dash or underscore. '
        + 'It is part of every record’s identity, so changing it re-imports everything as new records.',
    },
    {
      field: 'items[].externalId',
      required: true,
      rule: `your own key for the record. Printable ASCII, one line, up to ${IMPORT_MAX_EXTERNAL_ID_LENGTH} characters, unique within the file.`,
    },
    { field: 'items[].title', required: true, rule: `up to ${IMPORT_MAX_TITLE_LENGTH} characters, no control characters.` },
    { field: 'items[].year', required: false, rule: `a whole number between ${IMPORT_MIN_YEAR} and ${IMPORT_MAX_YEAR}, or omitted.` },
    {
      field: 'items[].providerRefs',
      required: false,
      rule: `at most one per type, from: ${KNOWN_REF_TYPES.join(', ')}. Values up to ${IMPORT_MAX_REF_VALUE_LENGTH} characters. `
        + 'Values are encrypted and are never shown in this page.',
    },
    {
      field: 'items[].metadata',
      required: false,
      rule: `a flat map of text to text, up to ${IMPORT_MAX_METADATA_KEYS} keys. Nested objects and numbers are rejected.`,
    },
  ];
}

export function catalogImportSteps(): readonly CatalogImportStep[] {
  return [
    {
      id: 'write',
      title: 'Write the file',
      detail: 'One JSON document in the shape below. The release bundle ships example-catalog-snapshot.json '
        + 'next to its README as a complete, valid one to copy.',
    },
    {
      id: 'place',
      title: 'Put it in the import folder',
      detail: './import/ next to your docker-compose.yml, or wherever CATALOG_IMPORT_HOST_DIR points. It is '
        + 'mounted read-only — the container cannot change, rename or delete your file.',
    },
    {
      id: 'preview',
      title: 'Preview it',
      detail: 'Choose the file above and press Preview, or run the preview command below. Nothing is '
        + 'written either way. You are told how many records would be created, how many are already '
        + 'present, and how many are blocked because those items were previously forgotten.',
    },
    {
      id: 'apply',
      title: 'Apply it',
      detail: 'Apply becomes available only once you have read a preview, and it is bound to the exact file '
        + 'you previewed — if the file changes in between, the apply is refused rather than performed. From '
        + 'a terminal it is the same command with --apply. Re-running the same file afterwards changes '
        + 'nothing: record identities are derived from your source and externalId, so an import cannot '
        + 'duplicate a record.',
    },
    {
      id: 'browse',
      title: 'Browse it',
      detail: 'The Catalog panel above reloads itself after an apply. Search, sort, filter and page through '
        + 'what you imported, open a record, and export the whole thing back out as a snapshot file.',
    },
  ];
}

export const CATALOG_IMPORT_STEPS = catalogImportSteps();

export function catalogImportCommands(): readonly CatalogImportCommandPair[] {
  return [
    { label: 'Preview (writes nothing)', command: 'docker compose exec app npm run ops:catalog-import -- --file your-snapshot.json' },
    { label: 'Apply', command: 'docker compose exec app npm run ops:catalog-import -- --file your-snapshot.json --apply' },
  ];
}

export const CATALOG_IMPORT_COMMANDS = catalogImportCommands();

/** The worked example, generated from the constants so it is always a document the importer would accept. */
export const CATALOG_SNAPSHOT_EXAMPLE = JSON.stringify({
  format: CATALOG_SNAPSHOT_FORMAT,
  version: CATALOG_SNAPSHOT_VERSION,
  source: 'my-library',
  items: [
    {
      externalId: 'movie-0001',
      title: 'An Example Film',
      year: 1994,
      providerRefs: [{ type: 'imdb', value: 'tt0000001' }],
      metadata: { shelf: 'a1' },
    },
    { externalId: 'movie-0002', title: 'Another Example' },
  ],
}, null, 2);

/** Stated where an operator will read it, so the bounds are not a surprise discovered by a rejection. */
export const CATALOG_IMPORT_BOUNDS =
  `One file, up to ${Math.round(IMPORT_MAX_BYTES / (1024 * 1024))} MiB and ${IMPORT_MAX_ITEMS} records. `
  + 'A file that breaks any rule is rejected whole, before anything is written, with every problem listed at '
  + 'once — so a bad file never leaves a half-filled catalog behind.';
