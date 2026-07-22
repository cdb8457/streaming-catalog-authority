import { accessSync, constants as fsConstants, readdirSync, readFileSync, statSync } from 'node:fs';
import {
  OPERATOR_UI_LOCAL_AUTH_MAX_SECRET_BYTES,
  OPERATOR_UI_LOCAL_AUTH_MIN_DISTINCT_CHARS,
  OPERATOR_UI_LOCAL_AUTH_MIN_SECRET_BYTES,
} from './operator-ui-local-auth-runtime.js';
import { buildRuntimeVersionView, type RuntimeVersionView } from './operator-ui-runtime-version.js';
import type { ChecklistStepId } from './operator-ui-first-run-checklist.js';

// Phase 246 — "is this installation usable, and if not, what exactly do I do?"
//
// The existing /api/status answers a different question. It runs the full production self-check, which is the
// right tool for an operator who already knows what a custodian mode is, and the wrong one for the person
// this phase is for: someone who extracted a release bundle, ran `docker compose up -d`, opened a web page,
// and needs to know whether the thing works. `needsAttention: ["FAIL completion-secret-match: ..."]` does not
// tell them to run the setup script.
//
// SHAPE. Facts are gathered, then a PURE function derives the verdict. That split is what makes the
// interesting cases testable: a missing secret file, a database that is up but unmigrated, a records folder
// that exists but cannot be read, and a version mismatch are all a literal in a test rather than a fixture
// that has to be built on a real machine. The collector is a thin, boring reader.
//
// EVERY VALUE IS CATEGORICAL. A component reports one of a closed set of states and an identifier for the
// checklist step that fixes it. It does NOT report the thing it inspected: not the path it stat'd, not the
// bytes it read, not the error the operating system produced. `detail` sentences are fixed strings chosen by
// state — no interpolation, so there is no route by which an environment value, a filename or an exception
// message reaches a page, an API response or a log line.
//
// IT IS NOT AN AUTHORIZATION. READY means the software can read what it needs. It says nothing about whether
// a promotion may proceed, and `promotionAuthorization` states so in the payload, because "the dashboard said
// READY" is precisely the sentence someone would otherwise put in a review.

export type ComponentId = 'version' | 'database' | 'secrets' | 'promotion-records' | 'promotion-chain' | 'keystore';

/** What a component found. Closed set: consumers switch on these and never parse prose. */
export type ComponentState =
  | 'OK'
  | 'EMPTY'
  | 'MISSING'
  | 'UNREADABLE'
  | 'MALFORMED'
  | 'UNREACHABLE'
  | 'NOT_CONFIGURED'
  | 'MISMATCH'
  | 'DEVELOPMENT'
  | 'UNKNOWN';

/** What a state means for the installation as a whole. */
export type ComponentSeverity = 'SATISFIED' | 'SETUP_REQUIRED' | 'IMPAIRED' | 'ADVISORY';

/** The whole verdict. Deliberately three values plus nothing: an operator acts differently on each. */
export type InstallationState = 'READY' | 'NEEDS_SETUP' | 'DEGRADED';

export interface ComponentView {
  readonly id: ComponentId;
  readonly title: string;
  readonly state: ComponentState;
  readonly severity: ComponentSeverity;
  /** A fixed sentence selected by (component, state). Never interpolated. */
  readonly detail: string;
  /** Which checklist step fixes this, when one does. */
  readonly fix: ChecklistStepId | null;
}

/** Presence and shape of one secret file — never its contents, never its path. */
export type SecretFileState = 'OK' | 'MISSING' | 'UNREADABLE' | 'EMPTY' | 'TOO_LARGE' | 'MALFORMED' | 'WEAK';

export const SECRET_FILE_IDS = [
  'admin_database_url',
  'database_url',
  'completion_secret',
  'custodian_kek',
  'operator_ui_token',
] as const;

export type SecretFileId = (typeof SECRET_FILE_IDS)[number];

export interface SecretFileFact {
  readonly id: SecretFileId;
  readonly state: SecretFileState;
}

export type DatabaseFact =
  | 'OK'
  | 'SCHEMA_MISSING'
  | 'SCHEMA_STALE'
  | 'UNREACHABLE'
  | 'NOT_CONFIGURED'
  | 'NOT_PROBED';

export type RecordsFact = 'OK' | 'EMPTY' | 'MISSING' | 'UNREADABLE';
export type ChainFact = 'HEALTHY' | 'UNHEALTHY' | 'UNAVAILABLE';
export type KeystoreFact = 'OK' | 'MISSING' | 'UNREADABLE' | 'NOT_CONFIGURED';

/** A bounded count summary of the chain. Numbers only: no phase contents, no identities, no digests. */
export interface ArtifactSummary {
  readonly present: number;
  readonly expected: number;
  readonly blockers: number;
  readonly terminalPhase: number | null;
  readonly nextRequiredPhase: number | null;
}

export interface ReadinessFacts {
  readonly version: RuntimeVersionView;
  readonly database: DatabaseFact;
  readonly secrets: readonly SecretFileFact[];
  readonly records: RecordsFact;
  readonly chain: ChainFact;
  readonly artifacts: ArtifactSummary | null;
  readonly keystore: KeystoreFact;
}

export interface InstallationReadiness {
  readonly ok: boolean;
  readonly report: 'phase-246-installation-readiness';
  readonly state: InstallationState;
  readonly headline: string;
  readonly components: readonly ComponentView[];
  readonly artifacts: ArtifactSummary | null;
  readonly version: RuntimeVersionView;
  /** Checklist steps worth doing next, most urgent first. Ids, resolved against the checklist by the caller. */
  readonly nextSteps: readonly ChecklistStepId[];
  readonly advisories: readonly string[];
  /** Said out loud so a READY verdict is never quoted as permission to promote anything. */
  readonly promotionAuthorization: 'NOT_IMPLIED';
  readonly authorizationNote: string;
}

const AUTHORIZATION_NOTE =
  'READY means this installation can read what it needs. It is not an approval, an authorization or a '
  + 'verdict about any promotion. Nothing on this surface can authorize, execute, archive or delete anything.';

// -----------------------------------------------------------------------------------------------------------
// Fixed sentences, chosen by state. The only text a component can produce.
// -----------------------------------------------------------------------------------------------------------

const VERSION_DETAIL: Partial<Record<ComponentState, string>> = {
  OK: 'The running image and the bundle that started it report the same release.',
  DEVELOPMENT: 'This is a locally built development image, not a published release.',
  MISMATCH: 'The running image and the bundle that started it report DIFFERENT releases. One of them was changed without the other.',
  UNKNOWN: 'The running image did not declare a version that could be trusted. Nothing is guessed.',
};

const DATABASE_DETAIL: Partial<Record<ComponentState, string>> = {
  OK: 'The database is reachable and its schema is at the version this build expects.',
  MISSING: 'The database is reachable but has no schema yet. It has not been migrated.',
  MALFORMED: 'The database is reachable but its schema is a different version from the one this build expects.',
  UNREACHABLE: 'The database did not answer. It may still be starting, or its password may not match the volume it was initialised with.',
  NOT_CONFIGURED: 'No database connection is configured for this container.',
  UNKNOWN: 'The database was not contacted for this report.',
};

const SECRETS_DETAIL: Partial<Record<ComponentState, string>> = {
  OK: 'Every secret file this container needs is present and has a usable shape.',
  MISSING: 'One or more secret files have not been created yet. The setup script creates all of them.',
  UNREADABLE: 'A secret file exists but this container cannot read it.',
  MALFORMED: 'A secret file exists but does not have a usable shape. Its contents are deliberately not inspected further here.',
};

const RECORDS_DETAIL: Partial<Record<ComponentState, string>> = {
  OK: 'The promotion records folder is mounted and readable.',
  EMPTY: 'The promotion records folder is mounted and readable, and contains no artifacts yet. On a fresh install this is expected.',
  MISSING: 'The promotion records folder is not present inside this container. Check the host folder named by the records mount.',
  UNREADABLE: 'The promotion records folder is present but this container cannot read it.',
};

const CHAIN_DETAIL: Partial<Record<ComponentState, string>> = {
  OK: 'The promotion record chain was read and hangs together. An honestly unfinished chain is healthy.',
  MALFORMED: 'The promotion record chain was read but does not hang together. See the promotion panel for the specific blockers.',
  EMPTY: 'No promotion record chain is readable yet.',
};

const KEYSTORE_DETAIL: Partial<Record<ComponentState, string>> = {
  OK: 'The keystore volume is present and readable.',
  MISSING: 'The keystore volume is not present inside this container.',
  UNREADABLE: 'The keystore volume is present but this container cannot read it.',
  NOT_CONFIGURED: 'No keystore directory is configured for this container.',
};

function detailFor(table: Partial<Record<ComponentState, string>>, state: ComponentState): string {
  return table[state] ?? 'This component reported a state with no description, which is itself a fault worth reporting.';
}

// -----------------------------------------------------------------------------------------------------------
// Pure derivation.
// -----------------------------------------------------------------------------------------------------------

function versionComponent(version: RuntimeVersionView): ComponentView {
  const state: ComponentState = version.agreement === 'MISMATCH'
    ? 'MISMATCH'
    : version.provenance === 'DEVELOPMENT'
      ? 'DEVELOPMENT'
      : version.provenance === 'UNKNOWN'
        ? 'UNKNOWN'
        : 'OK';
  const severity: ComponentSeverity = state === 'MISMATCH' ? 'IMPAIRED' : state === 'OK' ? 'SATISFIED' : 'ADVISORY';
  return {
    id: 'version',
    title: 'Version',
    state,
    severity,
    detail: detailFor(VERSION_DETAIL, state),
    fix: state === 'MISMATCH' ? 'upgrade' : null,
  };
}

function databaseComponent(fact: DatabaseFact): ComponentView {
  const state: ComponentState = fact === 'OK'
    ? 'OK'
    : fact === 'SCHEMA_MISSING'
      ? 'MISSING'
      : fact === 'SCHEMA_STALE'
        ? 'MALFORMED'
        : fact === 'UNREACHABLE'
          ? 'UNREACHABLE'
          : fact === 'NOT_CONFIGURED'
            ? 'NOT_CONFIGURED'
            : 'UNKNOWN';
  const severity: ComponentSeverity = state === 'OK'
    ? 'SATISFIED'
    : state === 'UNKNOWN'
      ? 'ADVISORY'
      : state === 'MISSING' || state === 'NOT_CONFIGURED'
        ? 'SETUP_REQUIRED'
        : 'IMPAIRED';
  return {
    id: 'database',
    title: 'Database',
    state,
    severity,
    detail: detailFor(DATABASE_DETAIL, state),
    fix: severity === 'SETUP_REQUIRED' || severity === 'IMPAIRED' ? 'start-stack' : null,
  };
}

function secretsComponent(facts: readonly SecretFileFact[]): ComponentView {
  const states = facts.map((fact) => fact.state);
  const state: ComponentState = states.includes('UNREADABLE')
    ? 'UNREADABLE'
    : states.includes('MISSING')
      ? 'MISSING'
      : states.some((value) => value === 'EMPTY' || value === 'MALFORMED' || value === 'WEAK' || value === 'TOO_LARGE')
        ? 'MALFORMED'
        : 'OK';
  const severity: ComponentSeverity = state === 'OK' ? 'SATISFIED' : state === 'MISSING' ? 'SETUP_REQUIRED' : 'IMPAIRED';
  return {
    id: 'secrets',
    title: 'Secret files',
    state,
    severity,
    detail: detailFor(SECRETS_DETAIL, state),
    fix: state === 'OK' ? null : 'generate-secrets',
  };
}

function recordsComponent(fact: RecordsFact): ComponentView {
  const state: ComponentState = fact;
  const severity: ComponentSeverity = fact === 'OK'
    ? 'SATISFIED'
    : fact === 'EMPTY' || fact === 'MISSING'
      ? 'SETUP_REQUIRED'
      : 'IMPAIRED';
  return {
    id: 'promotion-records',
    title: 'Promotion records folder',
    state,
    severity,
    detail: detailFor(RECORDS_DETAIL, state),
    fix: fact === 'OK' ? null : 'place-records',
  };
}

function chainComponent(fact: ChainFact): ComponentView {
  const state: ComponentState = fact === 'HEALTHY' ? 'OK' : fact === 'UNHEALTHY' ? 'MALFORMED' : 'EMPTY';
  // An empty chain is a setup step, not a fault: a fresh install legitimately has nothing to audit yet.
  const severity: ComponentSeverity = fact === 'HEALTHY' ? 'SATISFIED' : fact === 'UNHEALTHY' ? 'IMPAIRED' : 'SETUP_REQUIRED';
  return {
    id: 'promotion-chain',
    title: 'Promotion record chain',
    state,
    severity,
    detail: detailFor(CHAIN_DETAIL, state),
    fix: fact === 'HEALTHY' ? null : 'place-records',
  };
}

function keystoreComponent(fact: KeystoreFact): ComponentView {
  const state: ComponentState = fact;
  const severity: ComponentSeverity = fact === 'OK'
    ? 'SATISFIED'
    : fact === 'MISSING' || fact === 'NOT_CONFIGURED'
      ? 'SETUP_REQUIRED'
      : 'IMPAIRED';
  return {
    id: 'keystore',
    title: 'Keystore volume',
    state,
    severity,
    detail: detailFor(KEYSTORE_DETAIL, state),
    fix: fact === 'OK' ? null : 'start-stack',
  };
}

const HEADLINE: Record<InstallationState, string> = {
  READY: 'This installation is set up and can read everything it needs.',
  NEEDS_SETUP: 'This installation is not finished yet. The steps below are what is left.',
  DEGRADED: 'Something that should be working is not. This is a fault, not an unfinished setup step.',
};

/**
 * Turn facts into a verdict.
 *
 * Precedence is deliberate: a real fault outranks an unfinished setup step, because telling someone to run
 * the setup script when the database is refusing connections sends them to the wrong place. An ADVISORY
 * never changes the verdict — a development build is a thing to know, not a thing to fix.
 */
export function deriveInstallationReadiness(facts: ReadinessFacts): InstallationReadiness {
  const components: readonly ComponentView[] = [
    versionComponent(facts.version),
    databaseComponent(facts.database),
    secretsComponent(facts.secrets),
    recordsComponent(facts.records),
    chainComponent(facts.chain),
    keystoreComponent(facts.keystore),
  ];

  const state: InstallationState = components.some((component) => component.severity === 'IMPAIRED')
    ? 'DEGRADED'
    : components.some((component) => component.severity === 'SETUP_REQUIRED')
      ? 'NEEDS_SETUP'
      : 'READY';

  // Order matters more than completeness: the first thing on the list should be the first thing they do.
  const ORDER: readonly ChecklistStepId[] = [
    'generate-secrets', 'start-stack', 'retrieve-token', 'place-records', 'refresh-ui', 'upgrade',
  ];
  const wanted = new Set(components.filter((c) => c.severity !== 'SATISFIED' && c.fix !== null).map((c) => c.fix!));
  const nextSteps = ORDER.filter((step) => wanted.has(step));

  const advisories = components
    .filter((component) => component.severity === 'ADVISORY')
    .map((component) => component.detail)
    .concat(facts.version.notes);

  return {
    ok: state === 'READY',
    report: 'phase-246-installation-readiness',
    state,
    headline: HEADLINE[state],
    components,
    artifacts: facts.artifacts,
    version: facts.version,
    nextSteps,
    advisories: [...new Set(advisories)],
    promotionAuthorization: 'NOT_IMPLIED',
    authorizationNote: AUTHORIZATION_NOTE,
  };
}

// -----------------------------------------------------------------------------------------------------------
// Collection. Filesystem and environment only — no network, no database, no clock-dependent behaviour.
// -----------------------------------------------------------------------------------------------------------

export interface StaticFactsInput {
  readonly promotionRecordsDir: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Environment variables naming each secret file, matching docker-compose.runtime.yml's `app` service. */
const SECRET_ENV: Record<SecretFileId, string> = {
  admin_database_url: 'ADMIN_DATABASE_URL_FILE',
  database_url: 'DATABASE_URL_FILE',
  completion_secret: 'COMPLETION_SECRET_FILE',
  custodian_kek: 'CUSTODIAN_KEK_FILE',
  operator_ui_token: 'OPERATOR_UI_TOKEN_FILE',
};

/**
 * Inspect one secret file without keeping, returning or logging what is in it.
 *
 * The contents ARE read, because "present but empty" and "present but not a database URL" are the failures
 * that actually happen and neither is visible from a `stat`. What escapes this function is one word.
 */
export function inspectSecretFile(id: SecretFileId, path: string | undefined): SecretFileFact {
  if (path === undefined || path.trim() === '') return { id, state: 'MISSING' };
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { id, state: 'MALFORMED' };
    size = stat.size;
  } catch {
    return { id, state: 'MISSING' };
  }
  if (size === 0) return { id, state: 'EMPTY' };
  if (size > OPERATOR_UI_LOCAL_AUTH_MAX_SECRET_BYTES) return { id, state: 'TOO_LARGE' };

  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return { id, state: 'UNREADABLE' };
  }
  const value = raw.toString('utf8').replace(/\r?\n$/, '');
  if (value.trim() === '') return { id, state: 'EMPTY' };

  if (id === 'admin_database_url' || id === 'database_url') {
    return { id, state: /^postgres(?:ql)?:\/\/\S+$/.test(value) ? 'OK' : 'MALFORMED' };
  }
  if (id === 'operator_ui_token') {
    // The same rules the auth runtime enforces at startup, so the panel cannot say a token is fine while
    // the server is refusing to load it.
    if (Buffer.byteLength(value, 'utf8') < OPERATOR_UI_LOCAL_AUTH_MIN_SECRET_BYTES) return { id, state: 'WEAK' };
    if (new Set([...value]).size < OPERATOR_UI_LOCAL_AUTH_MIN_DISTINCT_CHARS) return { id, state: 'WEAK' };
    return { id, state: 'OK' };
  }
  // completion_secret and custodian_kek are opaque key material: length is the only honest check.
  return { id, state: Buffer.byteLength(value, 'utf8') >= 16 ? 'OK' : 'WEAK' };
}

export function inspectSecretFiles(env: NodeJS.ProcessEnv = process.env): readonly SecretFileFact[] {
  return SECRET_FILE_IDS.map((id) => inspectSecretFile(id, env[SECRET_ENV[id]]));
}

/** Directory presence and readability, as three words. The path itself never leaves this function. */
export function inspectDirectory(path: string | undefined): RecordsFact {
  if (path === undefined || path.trim() === '') return 'MISSING';
  try {
    if (!statSync(path).isDirectory()) return 'MISSING';
  } catch {
    return 'MISSING';
  }
  try {
    accessSync(path, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    return 'UNREADABLE';
  }
  try {
    return readdirSync(path).length === 0 ? 'EMPTY' : 'OK';
  } catch {
    return 'UNREADABLE';
  }
}

export function inspectKeystore(env: NodeJS.ProcessEnv = process.env): KeystoreFact {
  const dir = env.CUSTODIAN_KEYSTORE_DIR;
  if (dir === undefined || dir.trim() === '') return 'NOT_CONFIGURED';
  const state = inspectDirectory(dir);
  // A keystore that exists and is empty is a first boot, not a fault: the custodian creates its own files.
  return state === 'UNREADABLE' ? 'UNREADABLE' : state === 'MISSING' ? 'MISSING' : 'OK';
}

/**
 * Everything that can be known without contacting anything.
 *
 * This is the whole input to the support report, which is why it makes no live calls: a report you can
 * produce while the database is down is the report you actually need while the database is down.
 */
export function collectStaticFacts(input: StaticFactsInput): Omit<ReadinessFacts, 'database' | 'chain' | 'artifacts'> {
  const env = input.env ?? process.env;
  return {
    version: buildRuntimeVersionView(env),
    secrets: inspectSecretFiles(env),
    records: inspectDirectory(input.promotionRecordsDir),
    keystore: inspectKeystore(env),
  };
}

/**
 * Reduce a Phase 244 chain snapshot to counts and a single word.
 *
 * The snapshot is rich on purpose — the promotion panel renders every artifact, blocker and proof limit from
 * it — and none of that belongs in a readiness verdict. What survives is how many, not which: no phase
 * contents, no digests, no identities, nothing that says anything about a particular promotion.
 *
 * `ok` is carried through rather than recomputed, so this can never disagree with the promotion panel about
 * whether an unfinished chain counts as healthy.
 */
export function summarizeChainSnapshot(snapshot: {
  readonly ok: boolean;
  readonly availability: string;
  readonly view: {
    readonly presentCount: number;
    readonly artifacts: readonly unknown[];
    readonly blockers: readonly unknown[];
    readonly terminalPhase: number | null;
    readonly nextRequiredPhase: number | null;
  } | null;
}): { readonly chain: ChainFact; readonly artifacts: ArtifactSummary | null } {
  if (snapshot.availability !== 'READABLE' || snapshot.view === null) {
    return { chain: 'UNAVAILABLE', artifacts: null };
  }
  const view = snapshot.view;
  // A readable folder with nothing in it is a chain that has not started, NOT a chain that contradicts
  // itself. The audit reports `ok: false` for both — correctly, since neither can be anchored — and treating
  // that as a fault would make every fresh install report DEGRADED on its first load, which is precisely the
  // false alarm this panel exists to prevent. So emptiness is read off the count, not off the verdict.
  const chain: ChainFact = view.presentCount === 0 ? 'UNAVAILABLE' : snapshot.ok ? 'HEALTHY' : 'UNHEALTHY';
  return {
    chain,
    artifacts: {
      present: view.presentCount,
      expected: view.artifacts.length,
      blockers: view.blockers.length,
      terminalPhase: view.terminalPhase,
      nextRequiredPhase: view.nextRequiredPhase,
    },
  };
}
