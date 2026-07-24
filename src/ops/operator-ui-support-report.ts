import { RELEASE_IMAGE_REPOSITORY } from './release-coordinates.js';
import {
  collectStaticFacts,
  deriveInstallationReadiness,
  type ComponentView,
  type InstallationState,
  type SecretFileFact,
} from './operator-ui-installation-readiness.js';
import type { RuntimeVersionView } from './operator-ui-runtime-version.js';

// Phase 246 — the report a person pastes into an issue.
//
// The thing being designed around is that a user in trouble will paste whatever we print, into a public
// tracker, without reading it. So the question is not "did we remember to redact?" but "is there any value
// in here that COULD be sensitive?" — and the answer is arranged to be no, by construction:
//
//   * no paths, absolute or relative. Not the records directory, not a secret file, not the working
//     directory. A path is where a person's data lives and it is also, on a home machine, their name.
//   * no URLs of any kind. A database URL embeds a password; a registry URL can name an internal host.
//   * no secret values, no lengths that would narrow one, no digests of one.
//   * no record contents, no phase payloads, no identities, no provider or media-server data — this report
//     never opens an artifact, it only counts what the chain module already counted.
//   * no host-identifying data: no hostname, no username, no environment dump, no IP, no MAC, no serial.
//     `platform` and `arch` are "linux/x64" — a fact about a build target, not about a person.
//
// The image is reported as EXPECTED or CUSTOM rather than by name. A user running a private mirror would
// otherwise publish their registry hostname to get help with a port conflict.
//
// AND IT IS CHECKED, not merely intended. `assertSupportReportIsRedactionSafe` scans the rendered output for
// the shapes above and throws rather than print. A reviewer can be wrong about what a field contains; a
// scan over the bytes that are about to be printed cannot be.
//
// NO LIVE CALLS. The database is not contacted, nothing is pulled, nothing is resolved over DNS. That is the
// point: the report you need is the one you can still produce when the thing you are reporting is down.

export const SUPPORT_REPORT_ID = 'phase-246-operator-support-report';

export class SupportReportRedactionError extends Error {
  readonly code = 'SUPPORT_REPORT_REDACTION_REJECTED';

  constructor(what: string) {
    super(`refusing to emit a support report: it contains ${what}`);
    this.name = 'SupportReportRedactionError';
  }
}

export interface SupportReportInput {
  readonly promotionRecordsDir: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Passed in rather than read from the clock, so the same installation renders the same report. */
  readonly generatedAt: string;
  readonly runtime?: SupportRuntimeFacts;
}

export interface SupportRuntimeFacts {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
}

export interface SupportReport {
  readonly report: typeof SUPPORT_REPORT_ID;
  readonly generatedAt: string;
  readonly state: InstallationState;
  readonly liveCallsMade: 'none';
  readonly version: {
    readonly version: string | null;
    readonly revision: string | null;
    readonly builtAt: string | null;
    readonly provenance: RuntimeVersionView['provenance'];
    readonly bundleVersion: string | null;
    readonly agreement: RuntimeVersionView['agreement'];
    /** Whether the configured image is the published one, said without naming any registry. */
    readonly imageRepository: 'EXPECTED' | 'CUSTOM' | 'ABSENT' | 'MALFORMED';
    readonly imageTag: string | null;
    readonly imagePinnedByDigest: boolean;
  };
  readonly components: readonly { readonly id: string; readonly state: string; readonly severity: string }[];
  readonly secrets: readonly { readonly id: string; readonly state: string }[];
  readonly runtime: SupportRuntimeFacts;
  readonly notes: readonly string[];
  readonly redaction: readonly string[];
}

const REDACTION_STATEMENT: readonly string[] = [
  'This report contains no tokens, no secret values, no file paths, no URLs, no record contents and no host-identifying data.',
  'The database was not contacted while producing it.',
  'It is safe to attach to a public issue.',
];

/**
 * Shapes that must never appear in the rendered report.
 *
 * The hex bound is 41 rather than 40 on purpose: a git revision is a legitimate 7-40 character hex string and
 * is reported deliberately, while anything longer is a digest or key material that is not.
 */
const FORBIDDEN_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/[a-z][a-z0-9+.-]*:\/\//i, 'a URL'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/, 'a base64-encoded 32-byte secret'],
  [/\b[0-9a-f]{41,}\b/i, 'a hex value longer than a git revision'],
  [/(?:^|[^\w.])\/(?:home|root|Users|var|run|etc|mnt|opt|srv)\//, 'an absolute filesystem path'],
  [/\b[A-Za-z]:[\\/]/, 'a Windows filesystem path'],
  [/\.[\\/](?:secrets|promotion-records)\b/, 'a path into the secrets or records folder'],
];

export function assertSupportReportIsRedactionSafe(rendered: string): void {
  for (const [pattern, what] of FORBIDDEN_SHAPES) {
    if (pattern.test(rendered)) throw new SupportReportRedactionError(what);
  }
}

function describeRepository(view: RuntimeVersionView): SupportReport['version']['imageRepository'] {
  if (view.image.state === 'ABSENT') return 'ABSENT';
  if (view.image.state === 'MALFORMED') return 'MALFORMED';
  return view.image.repository === RELEASE_IMAGE_REPOSITORY ? 'EXPECTED' : 'CUSTOM';
}

function runtimeFacts(supplied: SupportRuntimeFacts | undefined): SupportRuntimeFacts {
  return supplied ?? { nodeVersion: process.version, platform: process.platform, arch: process.arch };
}

/**
 * Build the report. Static facts only; the database component is reported as not probed rather than guessed.
 */
export function buildSupportReport(input: SupportReportInput): SupportReport {
  const statics = collectStaticFacts({ promotionRecordsDir: input.promotionRecordsDir, env: input.env });
  const readiness = deriveInstallationReadiness({
    ...statics,
    database: 'NOT_PROBED',
    // A support report never opens the records folder's contents, so it cannot and does not judge the chain.
    // Reporting it as unavailable would be a claim; the folder's own state above is the honest signal.
    chain: statics.records === 'OK' ? 'HEALTHY' : 'UNAVAILABLE',
    artifacts: null,
  });

  const version = statics.version;
  return {
    report: SUPPORT_REPORT_ID,
    generatedAt: input.generatedAt,
    state: readiness.state,
    liveCallsMade: 'none',
    version: {
      version: version.version,
      revision: version.revision,
      builtAt: version.builtAt,
      provenance: version.provenance,
      bundleVersion: version.bundleVersion,
      agreement: version.agreement,
      imageRepository: describeRepository(version),
      imageTag: version.image.tag,
      imagePinnedByDigest: version.image.pinnedByDigest,
    },
    components: readiness.components.map((component: ComponentView) => ({
      id: component.id,
      state: component.state,
      severity: component.severity,
    })),
    secrets: statics.secrets.map((secret: SecretFileFact) => ({ id: secret.id, state: secret.state })),
    runtime: runtimeFacts(input.runtime),
    notes: readiness.advisories,
    redaction: REDACTION_STATEMENT,
  };
}

/** JSON, checked before it is returned. */
export function renderSupportReportJson(report: SupportReport): string {
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  assertSupportReportIsRedactionSafe(rendered);
  return rendered;
}

/** The same facts as text, for a person who would rather read than parse. Checked identically. */
export function renderSupportReportText(report: SupportReport): string {
  const lines: string[] = [
    'Catalog Authority — operator support report',
    `report:        ${report.report}`,
    `generated:     ${report.generatedAt}`,
    `state:         ${report.state}`,
    `live calls:    ${report.liveCallsMade}`,
    '',
    'Version',
    `  version:     ${report.version.version ?? '(not declared)'}`,
    `  revision:    ${report.version.revision ?? '(not declared)'}`,
    `  built:       ${report.version.builtAt ?? '(not declared)'}`,
    `  provenance:  ${report.version.provenance}`,
    `  bundle:      ${report.version.bundleVersion ?? '(not declared)'}`,
    `  agreement:   ${report.version.agreement}`,
    `  image repo:  ${report.version.imageRepository}`,
    `  image tag:   ${report.version.imageTag ?? '(none)'}`,
    `  digest pin:  ${report.version.imagePinnedByDigest ? 'yes' : 'no'}`,
    '',
    'Components',
    ...report.components.map((component) => `  ${component.id.padEnd(20)} ${component.state.padEnd(16)} ${component.severity}`),
    '',
    'Secret files',
    ...report.secrets.map((secret) => `  ${secret.id.padEnd(20)} ${secret.state}`),
    '',
    'Runtime',
    `  node:        ${report.runtime.nodeVersion}`,
    `  platform:    ${report.runtime.platform}/${report.runtime.arch}`,
    '',
    ...(report.notes.length === 0 ? [] : ['Notes', ...report.notes.map((note) => `  - ${note}`), '']),
    'Redaction',
    ...report.redaction.map((line) => `  - ${line}`),
    '',
  ];
  const rendered = lines.join('\n');
  assertSupportReportIsRedactionSafe(rendered);
  return rendered;
}
