import { createHash } from 'node:crypto';
import {
  RELEASE_IMAGE_REPOSITORY,
  RELEASE_REPOSITORY_OWNER,
  normaliseImageRepository,
  RELEASE_IMAGE_REGISTRY,
  RELEASE_IMAGE_PACKAGE,
} from './release-coordinates.js';
import {
  assertReleaseConsistency,
  decideRelease,
  isVersionTag,
  releaseArchiveName,
  type ReleaseDecision,
} from './release-ref.js';
import {
  RELEASE_IMAGE_TAG,
  BUNDLE_CHECKSUM_FILENAME,
  BUNDLE_MANIFEST_FILENAME,
  type ConsumerReleaseBundle,
} from './consumer-release-bundle.js';
import type { ArchiveResult } from './release-archive.js';
import { parseYaml, asMap, stringList, yamlStrings, ComposeYamlError, type YamlMap, type YamlValue } from './minimal-yaml.js';

// Phase 250 — first-public-release readiness proof.
//
// This is EVIDENCE, not approval. It answers one question deterministically and offline: do the many copies
// of "which release is this" — the version tag, the image reference, the bundle's declared version, the
// archive's name and digest, the release asset, the docs, and the CI workflow that would publish them — all
// say the same thing, and is the publish path structurally incapable of going out over a skipped gate or a
// leaked credential? A green result means a human MAY now decide to release; it never decides for them, and
// it authorises nothing.
//
// It reads local Git and files and assembles the bundle in memory. It never publishes, pushes, tags, merges,
// deploys, uses a credential, contacts GitHub or any provider, runs a promotion, reads the Movies library, or
// authorises Phase 231. Every one of those is outside what a readiness PROOF is allowed to do — the whole
// point is that it can be run a hundred times and change nothing.
//
// The four outcomes are distinct on purpose:
//   * READY_FOR_HUMAN_RELEASE_DECISION — every check passed. Evidence that a release decision may be made.
//   * BLOCKED — a check found a real problem (drift, a floating pin, a missing gate, a leaked secret, a dirty
//     tree). The coordinates do not line up, or the publish path is not safe.
//   * INVALID — an input could not even be interpreted (the workflow does not parse, a coordinate is
//     malformed). The question could not be posed.
//   * NOT_RUN — a required piece of evidence could not be gathered offline (there is no Git here, or the tag
//     is not present locally to verify HEAD against). We refuse to claim readiness on incomplete evidence.
//
// Precedence, most severe first: INVALID > BLOCKED > NOT_RUN > READY.

export type CheckStatus = 'PASS' | 'BLOCK' | 'INVALID' | 'NOT_RUN';

export type ReadinessOutcome =
  | 'READY_FOR_HUMAN_RELEASE_DECISION'
  | 'BLOCKED'
  | 'INVALID'
  | 'NOT_RUN';

/** Fixed, documented exit codes. A caller scripts against these, so they never move. */
export const READINESS_EXIT_CODES: Readonly<Record<ReadinessOutcome, number>> = {
  READY_FOR_HUMAN_RELEASE_DECISION: 0,
  BLOCKED: 10,
  INVALID: 11,
  NOT_RUN: 12,
};

export class ReleaseReadinessError extends Error {
  readonly code = 'RELEASE_READINESS_REDACTION_REJECTED';
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseReadinessError';
  }
}

export interface ReadinessCheck {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  /** A fixed or coordinate-derived sentence. Never a secret, a path, a URL, or an environment dump. */
  readonly detail: string;
}

export interface GitEvidence {
  /** False when there is no usable Git here — the checkout-state checks then report NOT_RUN. */
  readonly available: boolean;
  /** Whether `git status --porcelain` was empty. Meaningful only when available. */
  readonly clean: boolean;
  /** The current commit, a public hash. 40 hex — deliberately under the 41-hex redaction threshold. */
  readonly head: string;
  /** Whether a local Git tag exactly equal to the target tag exists. */
  readonly localTagPresent: boolean;
  /** Whether that local tag points at HEAD. */
  readonly localTagAtHead: boolean;
}

export interface ReadinessEvidence {
  /** The version tag this release would carry, e.g. `v1.0.0`. */
  readonly targetTag: string;
  /** `github.repository`, `owner/name`. */
  readonly repository: string;
  /** `github.repository_owner`. */
  readonly repositoryOwner: string;
  readonly git: GitEvidence;
  /** `.github/workflows/runtime-image.yml`, verbatim. Parsed here so a malformed file is INVALID. */
  readonly workflowText: string;
  /** `docker-compose.runtime.yml`, verbatim — checked for a floating image pin. */
  readonly composeText: string;
  /** `Dockerfile.runtime`, verbatim — checked for a digest-pinned base. */
  readonly dockerfileText: string;
  /** The consumer bundle assembled offline with `targetTag`. */
  readonly bundle: ConsumerReleaseBundle;
  /** The deterministic archive assembled from that bundle. */
  readonly archive: ArchiveResult;
  /** Which Phase docs are present (repo-relative paths). Presence only — contents are read separately. */
  readonly presentDocs: readonly string[];
}

export interface ReleaseReadinessReport {
  readonly report: 'phase-250-release-readiness';
  readonly generatedAt: string;
  readonly outcome: ReadinessOutcome;
  readonly outcomeIsEvidenceNotApproval: true;
  readonly authorityNote: string;
  readonly targetTag: string;
  readonly coordinates: {
    readonly tag: string;
    readonly imageRepository: string;
    readonly imageRef: string;
    readonly archiveName: string;
    readonly archiveSha256: string;
    readonly bundleVersion: string;
    readonly sourceRevision: string;
  };
  readonly checks: readonly ReadinessCheck[];
  readonly counts: { readonly pass: number; readonly block: number; readonly invalid: number; readonly notRun: number };
  readonly boundaries: readonly string[];
  readonly selfDigest: string;
}

const AUTHORITY_NOTE =
  'READY_FOR_HUMAN_RELEASE_DECISION is EVIDENCE that the release coordinates line up and the publish path is '
  + 'safe. It is not an approval, an authorization, or a decision to release. A human decides; this proof '
  + 'never does, and it publishes, pushes, tags and deploys nothing.';

const BOUNDARIES: readonly string[] = [
  'reads local Git and files and assembles the bundle in memory only',
  'never publishes, pushes, tags, merges, or deploys',
  'never uses a credential or contacts GitHub, Jellyfin, or any provider',
  'never runs a promotion, reads the Movies library, or authorizes Phase 231',
];

const SELF_DIGEST_SCOPE = 'phase-250-release-readiness';

// -----------------------------------------------------------------------------------------------------------
// Redaction: the report must be safe to paste anywhere. 64-hex digests are legitimate here (they are the
// point), so the generic "long hex" rule is deliberately absent; everything a report should NEVER carry is.
// -----------------------------------------------------------------------------------------------------------

// The report is entirely CONTROLLED text — coordinates, fixed check sentences, a public commit hash and
// digests — and it deliberately NAMES Jellyfin, providers and the Movies library in its boundary prose to
// state what it never does. So this backstop scans for leaked live DATA (a real secret, a credential, an
// absolute host path, the actual Movies path), NOT for the mere mention of a provider. 64-hex digests are
// legitimate here (they are the point), so the generic "long hex" rule is deliberately absent.
const FORBIDDEN_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bghp_[A-Za-z0-9]{20,}\b/, 'a GitHub token'],
  [/postgres(?:ql)?:\/\/[^\s:@/]+:[^\s:@/]{6,}@/i, 'a database URL with a password'],
  [/\b[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/, 'a base64-encoded 32-byte secret'],
  [/(?:^|[^\w.])\/(?:home|root|Users|mnt|opt|srv)\//, 'an absolute host filesystem path'],
  [/\b[A-Za-z]:\\Users\\/, 'a Windows user path'],
  [/\/mnt\/user\/media\/Movies/i, 'the Movies library path'],
];

export function assertReadinessReportIsRedactionSafe(rendered: string): void {
  for (const [pattern, what] of FORBIDDEN_SHAPES) {
    if (pattern.test(rendered)) throw new ReleaseReadinessError(`refusing to emit a readiness report: it contains ${what}`);
  }
}

// -----------------------------------------------------------------------------------------------------------
// The bundle files this proof independently re-reads. Named here so a check can look them up by path.
// -----------------------------------------------------------------------------------------------------------

function bundleFile(bundle: ConsumerReleaseBundle, path: string): { contents: string; sha256: string } | null {
  const file = bundle.files.find((candidate) => candidate.path === path);
  return file === undefined ? null : { contents: file.contents, sha256: file.sha256 };
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

// -----------------------------------------------------------------------------------------------------------
// Individual checks. Each returns exactly one ReadinessCheck. Details are fixed or coordinate-derived and
// carry nothing a redaction scan would reject.
// -----------------------------------------------------------------------------------------------------------

type Check = (evidence: ReadinessEvidence, workflow: WorkflowView | null) => ReadinessCheck;

function pass(id: string, title: string, detail: string): ReadinessCheck { return { id, title, status: 'PASS', detail }; }
function block(id: string, title: string, detail: string): ReadinessCheck { return { id, title, status: 'BLOCK', detail }; }
function invalid(id: string, title: string, detail: string): ReadinessCheck { return { id, title, status: 'INVALID', detail }; }
function notRun(id: string, title: string, detail: string): ReadinessCheck { return { id, title, status: 'NOT_RUN', detail }; }

const checkTargetTag: Check = (evidence) => {
  const id = 'target-tag-immutable';
  const title = 'The target tag is an immutable version tag';
  if (evidence.targetTag === 'latest') return block(id, title, '`latest` is a name that moves, not a release');
  if (!isVersionTag(evidence.targetTag)) return block(id, title, `the target tag is not an immutable vX.Y.Z tag`);
  return pass(id, title, 'the target tag is a vX.Y.Z immutable tag');
};

const checkShippedTagMatchesTarget: Check = (evidence) => {
  const id = 'shipped-version-no-drift';
  const title = 'The checked-in bundle version matches the tag being released';
  if (RELEASE_IMAGE_TAG !== evidence.targetTag) {
    return block(id, title, 'the shipped RELEASE_IMAGE_TAG differs from the target tag — version drift between the checkout and the release');
  }
  return pass(id, title, 'the shipped bundle version equals the target tag');
};

const checkReleaseDecision: Check = (evidence) => {
  const id = 'publish-decision-approves';
  const title = 'The tested publish decision approves exactly these coordinates';
  let decision: ReleaseDecision;
  try {
    decision = decideRelease({
      eventName: 'release',
      ref: `refs/tags/${evidence.targetTag}`,
      releaseTagName: evidence.targetTag,
      releaseDraft: false,
      repository: evidence.repository,
      repositoryOwner: evidence.repositoryOwner,
    });
  } catch (err) {
    return invalid(id, title, `the release decision could not be evaluated: ${(err as Error).name}`);
  }
  if (!decision.publish) return block(id, title, `a real release of this tag would be refused: ${decision.reason}`);
  if (decision.tag !== evidence.targetTag) return block(id, title, 'the approved tag differs from the target tag');
  const expectedRef = `${RELEASE_IMAGE_REPOSITORY}:${evidence.targetTag}`;
  if (decision.imageRef !== expectedRef) return block(id, title, 'the approved image reference is not the canonical one');
  if (decision.archiveName !== releaseArchiveName(evidence.targetTag)) return block(id, title, 'the approved archive name is not the canonical one');
  return pass(id, title, 'the decision approves this tag with the canonical image and archive');
};

const checkReleaseConsistency: Check = (evidence) => {
  const id = 'release-coordinates-consistent';
  const title = 'Tag, bundle version, archive name and image tag are one fact';
  const version = bundleVersionFromVersionFile(evidence.bundle);
  try {
    assertReleaseConsistency({
      tag: evidence.targetTag,
      bundleVersion: version ?? '(absent)',
      archiveName: evidence.archive.filename,
      imageRef: `${RELEASE_IMAGE_REPOSITORY}:${evidence.targetTag}`,
    });
  } catch (err) {
    return block(id, title, `the release coordinates disagree: ${(err as Error).message.replace(version ?? '', 'the bundle version')}`);
  }
  return pass(id, title, 'the four copies of the version agree');
};

function bundleVersionFromVersionFile(bundle: ConsumerReleaseBundle): string | null {
  const file = bundleFile(bundle, 'VERSION');
  if (file === null) return null;
  const match = /^version:\s*(\S+)/m.exec(file.contents);
  return match === null ? null : match[1]!;
}

const checkBundleCoordinates: Check = (evidence) => {
  const id = 'bundle-declares-target';
  const title = 'Every generated bundle file declares the target version';
  const problems: string[] = [];
  if (evidence.bundle.image.tag !== evidence.targetTag) problems.push('the bundle image pin');
  const versionFile = bundleVersionFromVersionFile(evidence.bundle);
  if (versionFile !== evidence.targetTag) problems.push('the VERSION file');
  const env = bundleFile(evidence.bundle, '.env');
  if (env === null || !env.contents.includes(`CATALOG_AUTHORITY_BUNDLE_VERSION=${evidence.targetTag}`)) problems.push('the .env bundle version');
  const manifest = bundleFile(evidence.bundle, BUNDLE_MANIFEST_FILENAME);
  if (manifest === null) {
    problems.push('the manifest is missing');
  } else {
    try {
      const parsed = JSON.parse(manifest.contents) as { version?: string; image?: { ref?: string } };
      if (parsed.version !== evidence.targetTag) problems.push('the manifest version');
      if (parsed.image?.ref !== `${RELEASE_IMAGE_REPOSITORY}:${evidence.targetTag}`) problems.push('the manifest image ref');
    } catch { problems.push('the manifest is not valid JSON'); }
  }
  if (problems.length > 0) return block(id, title, `these declare a different version or image: ${problems.join(', ')}`);
  return pass(id, title, 'the bundle pin, VERSION, .env and manifest all name the target version');
};

const checkArchiveAndChecksums: Check = (evidence) => {
  const id = 'archive-and-checksums-verify';
  const title = 'The asset name and every checksum verify by recomputation';
  // A non-version tag has no canonical asset name; the target-tag check is the primary signal for that.
  if (!isVersionTag(evidence.targetTag)) return block(id, title, 'the target tag is not a version tag, so no canonical asset name exists');
  if (evidence.archive.filename !== releaseArchiveName(evidence.targetTag)) {
    return block(id, title, 'the archive is not named for the target tag');
  }
  // The archive digest, recomputed from its bytes, must equal the stated digest and its sidecar.
  const recomputed = createHash('sha256').update(evidence.archive.bytes).digest('hex');
  if (recomputed !== evidence.archive.sha256) return block(id, title, 'the archive digest does not match its own bytes');
  if (!evidence.archive.checksum.startsWith(`${recomputed}  ${evidence.archive.filename}`)) {
    return block(id, title, 'the archive checksum sidecar does not match the archive');
  }
  // Every bundle file's digest, recomputed from its contents, must equal the SHA256SUMS line for it.
  const sums = bundleFile(evidence.bundle, BUNDLE_CHECKSUM_FILENAME);
  if (sums === null) return block(id, title, 'the bundle has no SHA256SUMS');
  const listed = new Map<string, string>();
  for (const line of sums.contents.split('\n')) {
    const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (m !== null) listed.set(m[2]!, m[1]!);
  }
  for (const file of evidence.bundle.files) {
    if (file.path === BUNDLE_CHECKSUM_FILENAME) continue;
    const recomputedFile = sha256Hex(file.contents);
    if (listed.get(file.path) !== recomputedFile) {
      return block(id, title, `a bundle file's recomputed digest does not match SHA256SUMS: ${file.path}`);
    }
  }
  return pass(id, title, 'the archive digest, its sidecar, and every SHA256SUMS entry recompute correctly');
};

const checkImageRepository: Check = (evidence) => {
  const id = 'image-repository-owned';
  const title = 'The image repository is the owned, registry-qualified, canonical one';
  const canonical = normaliseImageRepository(RELEASE_IMAGE_REGISTRY, RELEASE_REPOSITORY_OWNER, RELEASE_IMAGE_PACKAGE);
  if (RELEASE_IMAGE_REPOSITORY !== canonical) return block(id, title, 'the shipped image repository is not the canonical derivation');
  if (!RELEASE_IMAGE_REPOSITORY.startsWith(`${RELEASE_IMAGE_REGISTRY}/${RELEASE_REPOSITORY_OWNER}/`)) {
    return block(id, title, 'the image repository is not in this repository owner\'s namespace');
  }
  if (RELEASE_IMAGE_REPOSITORY !== RELEASE_IMAGE_REPOSITORY.toLowerCase()) return block(id, title, 'the image repository is not lowercase');
  if (evidence.bundle.image.repository !== RELEASE_IMAGE_REPOSITORY) return block(id, title, 'the bundle pins a different image repository');
  return pass(id, title, 'the image repository is ghcr.io in the owner namespace, lowercase and canonical');
};

const checkNoFloatingPins: Check = (evidence) => {
  const id = 'no-floating-image-pins';
  const title = 'No release artifact points at a moving tag, and the base image is digest-pinned';
  const floating: string[] = [];
  const floatingTag = /:latest(?:[^A-Za-z0-9.-]|$)/;
  for (const path of ['.env', '.env.example', 'docker-compose.yml', 'VERSION']) {
    const file = bundleFile(evidence.bundle, path);
    if (file !== null && floatingTag.test(file.contents)) floating.push(`bundle ${path}`);
  }
  if (floatingTag.test(evidence.composeText)) floating.push('docker-compose.runtime.yml');
  if (floating.length > 0) return block(id, title, `these point at a moving tag: ${floating.join(', ')}`);
  // The runtime Compose default must be a version tag, never latest.
  const composeDefault = /image:\s*\$\{CATALOG_AUTHORITY_IMAGE:-([^}]+)\}/.exec(evidence.composeText);
  if (composeDefault === null) return block(id, title, 'the Compose file does not pin a default image');
  const defaultTag = composeDefault[1]!.includes('@') ? null : composeDefault[1]!.slice(composeDefault[1]!.lastIndexOf(':') + 1);
  if (defaultTag !== null && !isVersionTag(defaultTag)) return block(id, title, 'the Compose default image is not pinned to a version tag');
  // The build base must be pinned by digest.
  if (!/ARG NODE_IMAGE=\S+@sha256:[0-9a-f]{64}/.test(evidence.dockerfileText)) {
    return block(id, title, 'the runtime image base is not pinned by digest');
  }
  return pass(id, title, 'no moving tags in the bundle or Compose, and the base image is digest-pinned');
};

const checkBundleRedaction: Check = (evidence) => {
  const id = 'bundle-carries-no-secret-or-live-data';
  const title = 'The assembled bundle carries no secret, host path, or live-provider data';
  const shapes: ReadonlyArray<readonly [RegExp, string]> = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
    [/postgres(?:ql)?:\/\/[^\s:@/]+:(?!change-me|<)[^\s:@/$]{8,}@/, 'a database URL with a real password'],
    [/\b[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/, 'a base64-encoded 32-byte secret'],
    [/\bghp_[A-Za-z0-9]{20,}\b/, 'a GitHub token'],
    [/(?:^|[^\w.])\/(?:home|root|Users)\//, 'an absolute host home path'],
    [/\b[A-Za-z]:\\Users\\/, 'a Windows user path'],
    [/\/mnt\/user\/media\/Movies/i, 'the Movies library path'],
    [/\bjellyfin\b|real-debrid|\btorbox\b/i, 'a live provider or media-server reference'],
  ];
  for (const file of evidence.bundle.files) {
    for (const [pattern, what] of shapes) {
      if (pattern.test(file.contents)) return block(id, title, `${file.path} appears to contain ${what}`);
    }
  }
  return pass(id, title, 'no secret, host path, or live-provider data in any bundle file');
};

// -----------------------------------------------------------------------------------------------------------
// Workflow checks. The workflow is parsed once; a parse failure makes every workflow check INVALID.
// -----------------------------------------------------------------------------------------------------------

interface WorkflowView {
  readonly doc: YamlMap;
  readonly jobs: YamlMap;
  jobText(name: string): string;
  jobMap(name: string): YamlMap | null;
}

function viewWorkflow(text: string): WorkflowView | null {
  let doc: YamlMap;
  try {
    doc = parseYaml(text);
  } catch (err) {
    if (err instanceof ComposeYamlError) return null;
    throw err;
  }
  let jobs: YamlMap;
  try {
    jobs = asMap(doc.jobs ?? null, 'jobs');
  } catch {
    return null;
  }
  return {
    doc,
    jobs,
    jobMap(name: string): YamlMap | null {
      const value = jobs[name];
      if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) return null;
      return value;
    },
    jobText(name: string): string {
      const map = this.jobMap(name);
      return map === null ? '' : yamlStrings(map).join('\n');
    },
  };
}

const REQUIRED_PUBLISH_NEEDS = ['suites', 'image', 'bundle', 'release-candidate', 'lifecycle'] as const;

const checkPublishDependencyGraph: Check = (_evidence, workflow) => {
  const id = 'publish-needs-all-gates';
  const title = 'Publish depends on every gate, including the browser and lifecycle acceptances';
  if (workflow === null) return invalid(id, title, 'the workflow could not be parsed');
  const publish = workflow.jobMap('publish');
  if (publish === null) return invalid(id, title, 'the workflow has no publish job');
  let needs: string[];
  try {
    needs = stringList(publish.needs ?? null, 'needs');
  } catch {
    return block(id, title, 'the publish job declares no dependency list');
  }
  const missing = REQUIRED_PUBLISH_NEEDS.filter((gate) => !needs.includes(gate));
  if (missing.length > 0) return block(id, title, `publish does not require these gates: ${missing.join(', ')}`);
  // A dependency on a job that does not exist is a dangling gate — GitHub would error, but a readiness proof
  // should catch it here rather than at release time.
  const dangling = needs.filter((gate) => workflow.jobMap(gate) === null);
  if (dangling.length > 0) return block(id, title, `publish depends on jobs that do not exist: ${dangling.join(', ')}`);
  return pass(id, title, 'publish requires suites, image, bundle, release-candidate and lifecycle, and all exist');
};

const checkAcceptanceGatesNotSkippable: Check = (_evidence, workflow) => {
  const id = 'acceptance-gates-run-on-every-event';
  const title = 'The acceptance gates carry no `if:` that could conditionally skip them';
  if (workflow === null) return invalid(id, title, 'the workflow could not be parsed');
  const skippable: string[] = [];
  for (const gate of ['release-candidate', 'lifecycle']) {
    const map = workflow.jobMap(gate);
    if (map === null) return block(id, title, `the ${gate} gate job is missing`);
    if (map.if !== undefined) skippable.push(gate);
  }
  if (skippable.length > 0) return block(id, title, `these gates have an if: and could be skipped, letting publish through: ${skippable.join(', ')}`);
  return pass(id, title, 'both acceptance gates run on every event that can reach publish');
};

const checkPublishFailClosed: Check = (_evidence, workflow) => {
  const id = 'publish-fails-closed';
  const title = 'Publish is gated to a release/dispatch and never runs over a failed dependency';
  if (workflow === null) return invalid(id, title, 'the workflow could not be parsed');
  const publish = workflow.jobMap('publish');
  if (publish === null) return invalid(id, title, 'the workflow has no publish job');
  const condition = String(publish.if ?? '');
  if (!condition.includes("github.event_name == 'release'")) return block(id, title, 'publish is not gated to a published release');
  if (!(condition.includes('workflow_dispatch') && condition.includes('inputs.publish'))) return block(id, title, 'publish is not gated to a deliberate dispatch');
  if (/always\(\)|failure\(\)|cancelled\(\)|success\(\)\s*==\s*false/.test(condition)) {
    return block(id, title, 'publish uses a status function that could let it run despite a failed gate');
  }
  return pass(id, title, 'publish runs only on a release or deliberate dispatch, and only when its gates succeeded');
};

const checkPermissionsScoped: Check = (_evidence, workflow) => {
  const id = 'permissions-least-privilege';
  const title = 'The workflow default is read-only and only publish is granted write';
  if (workflow === null) return invalid(id, title, 'the workflow could not be parsed');
  let defaultContents: YamlValue;
  try {
    defaultContents = asMap(workflow.doc.permissions ?? null, 'permissions').contents ?? null;
  } catch {
    return block(id, title, 'the workflow declares no default read-only permissions');
  }
  if (defaultContents !== 'read') return block(id, title, 'the workflow default permission is not contents: read');
  for (const name of Object.keys(workflow.jobs)) {
    const map = workflow.jobMap(name);
    if (map === null) continue;
    if (name === 'publish') {
      const perms = map.permissions;
      if (perms === undefined || perms === null || typeof perms !== 'object' || Array.isArray(perms)) return block(id, title, 'publish declares no explicit write permissions');
      if (perms.contents !== 'write' || perms.packages !== 'write') return block(id, title, 'publish does not scope its write permissions to contents+packages');
      continue;
    }
    if (map.permissions !== undefined) return block(id, title, `job ${name} declares its own permissions instead of inheriting read-only`);
  }
  return pass(id, title, 'default is read-only; only publish holds contents+packages write');
};

const checkNoPublishCapabilityOutsidePublish: Check = (_evidence, workflow) => {
  const id = 'no-publish-capability-outside-publish';
  const title = 'No job except publish can push an image, tag, or touch a release';
  if (workflow === null) return invalid(id, title, 'the workflow could not be parsed');
  // Step-level capabilities appear as `uses:`/`run:` string values, which the flattened text carries.
  const stepStringCapabilities: ReadonlyArray<readonly [RegExp, string]> = [
    [/docker\/login-action/, 'a registry login'],
    [/docker push/, 'a docker push'],
    [/gh release (?:create|upload|edit|delete)/, 'a release write'],
    [/git push|git tag/, 'a git push or tag'],
  ];
  const offenders: string[] = [];
  for (const name of Object.keys(workflow.jobs)) {
    if (name === 'publish') continue;
    const map = workflow.jobMap(name);
    if (map === null) continue;
    const text = workflow.jobText(name);
    for (const [pattern, what] of stepStringCapabilities) {
      if (pattern.test(text)) offenders.push(`${name} (${what})`);
    }
    // Structural: a write permission is a publish capability — and it is a `key: value` pair the flattened
    // text splits apart, so it must be read from the parsed map, not matched as a substring.
    const perms = map.permissions;
    if (perms !== undefined && perms !== null && typeof perms === 'object' && !Array.isArray(perms)) {
      if ((perms as YamlMap).contents === 'write' || (perms as YamlMap).packages === 'write') offenders.push(`${name} (a write permission)`);
    }
    // Structural: any step that pushes an image (a build-push-action with `push: true`).
    const steps = Array.isArray(map.steps) ? map.steps : [];
    for (const step of steps) {
      if (typeof step !== 'object' || step === null || Array.isArray(step)) continue;
      const withBlock = (step as YamlMap).with;
      if (withBlock !== undefined && withBlock !== null && typeof withBlock === 'object' && !Array.isArray(withBlock) && (withBlock as YamlMap).push === true) {
        offenders.push(`${name} (an image push)`);
      }
    }
  }
  if (offenders.length > 0) return block(id, title, `a non-publish job can publish: ${offenders.join(', ')}`);
  return pass(id, title, 'only the publish job can push, tag, or write a release');
};

const checkPublishTagFromGate: Check = (evidence, workflow) => {
  const id = 'publish-tag-from-tested-gate';
  const title = 'Publish pushes exactly the gate-decided immutable tag, never latest';
  if (workflow === null) return invalid(id, title, 'the workflow could not be parsed');
  const publish = workflow.jobMap('publish');
  if (publish === null) return invalid(id, title, 'the workflow has no publish job');
  const steps = Array.isArray(publish.steps) ? publish.steps : [];
  const gate = steps.find((s) => typeof s === 'object' && s !== null && !Array.isArray(s) && String((s as YamlMap).run ?? '').includes('ops:release-ref'));
  if (gate === undefined) return block(id, title, 'the tested release-ref gate does not run before publishing');
  const push = steps.find((s) => typeof s === 'object' && s !== null && !Array.isArray(s) && String((s as YamlMap).uses ?? '').startsWith('docker/build-push-action'));
  if (push === undefined) return block(id, title, 'the publish job has no build-push step');
  const withBlock = (push as YamlMap).with;
  if (withBlock === undefined || typeof withBlock !== 'object' || Array.isArray(withBlock)) return block(id, title, 'the build-push step has no inputs');
  const tags = String((withBlock as YamlMap).tags ?? '');
  if (!tags.includes('steps.release.outputs.image_ref')) return block(id, title, 'the pushed tag does not come from the release-ref gate');
  if (/latest/.test(tags)) return block(id, title, 'the publish job could push a latest tag');
  if (tags.split('\n').filter((line) => line.trim() !== '').length !== 1) return block(id, title, 'the publish job pushes more than one tag');
  if (String((withBlock as YamlMap).file) !== 'Dockerfile.runtime') return block(id, title, 'the publish job builds an image other than Dockerfile.runtime');
  if (!String((withBlock as YamlMap).platforms).includes('env.PUBLISH_PLATFORMS')) return block(id, title, 'the published architecture is not the single declared list');
  if (evidence.targetTag === 'latest') return block(id, title, 'the target tag is latest');
  return pass(id, title, 'publish pushes one immutable tag from the gate, from Dockerfile.runtime, on the declared architecture');
};

const checkArchitectureClaim: Check = (_evidence, workflow) => {
  const id = 'architecture-claim-single-source';
  const title = 'The published architecture is stated once and matches the docs';
  if (workflow === null) return invalid(id, title, 'the workflow could not be parsed');
  let platforms: YamlValue;
  try {
    platforms = asMap(workflow.doc.env ?? null, 'env').PUBLISH_PLATFORMS ?? null;
  } catch {
    return block(id, title, 'the workflow declares no PUBLISH_PLATFORMS');
  }
  if (String(platforms) !== 'linux/amd64') return block(id, title, 'the published platform is not linux/amd64 as the docs claim');
  return pass(id, title, 'the workflow publishes linux/amd64, the single verified architecture');
};

const checkSuitesRunAcceptances: Check = (_evidence, workflow) => {
  const id = 'suites-run-the-acceptances';
  const title = 'The suites job runs the Phase 245-249 acceptance suites';
  if (workflow === null) return invalid(id, title, 'the workflow could not be parsed');
  const text = workflow.jobText('suites');
  if (text === '') return invalid(id, title, 'the workflow has no suites job');
  const required = ['test:phase245-local', 'test:phase246-local', 'test:phase247-local', 'test:phase248-local', 'test:phase249-local', 'npm run typecheck'];
  const missing = required.filter((need) => !text.includes(need));
  if (missing.length > 0) return block(id, title, `the suites job does not run: ${missing.join(', ')}`);
  return pass(id, title, 'the suites job runs typecheck and the Phase 245-249 acceptance suites');
};

const checkDocsInstallUpgradeRollback: Check = (evidence) => {
  const id = 'docs-install-upgrade-rollback';
  const title = 'The bundle README documents install, upgrade and honest rollback';
  const readme = bundleFile(evidence.bundle, 'README.md');
  if (readme === null) return block(id, title, 'the bundle ships no README');
  const body = readme.contents;
  const missing: string[] = [];
  if (!/## Upgrading/.test(body)) missing.push('an Upgrading section');
  if (!/## Rolling back/.test(body)) missing.push('a Rolling back section');
  if (!/Rolling the image back does not roll data back/.test(body)) missing.push('the honest "rollback does not roll data back" note');
  if (!body.includes(`sha256sum -c ${BUNDLE_CHECKSUM_FILENAME}`)) missing.push('the checksum-verification command');
  if (!body.includes(evidence.targetTag)) missing.push('the version it is for');
  if (missing.length > 0) return block(id, title, `the README is missing: ${missing.join(', ')}`);
  return pass(id, title, 'the README documents install, upgrade, and an honest rollback with verification');
};

const checkReleaseDocsPresent: Check = (evidence) => {
  const id = 'release-docs-present';
  const title = 'The release documentation set is present';
  const required = [
    'docs/PHASE_245_CONSUMER_RELEASE_IMAGE.md',
    'docs/PHASE_248_RELEASE_CANDIDATE_ACCEPTANCE.md',
    'docs/PHASE_249_LIFECYCLE_ACCEPTANCE.md',
  ];
  const missing = required.filter((doc) => !evidence.presentDocs.includes(doc));
  if (missing.length > 0) return block(id, title, `missing release docs: ${missing.map((m) => m.replace('docs/', '')).join(', ')}`);
  return pass(id, title, 'the Phase 245, 248 and 249 release docs are present');
};

const checkGitClean: Check = (evidence) => {
  const id = 'git-clean-checkout';
  const title = 'The working tree is clean';
  if (!evidence.git.available) return notRun(id, title, 'no Git here — the checkout state cannot be verified offline (a CI/human step)');
  if (!evidence.git.clean) return block(id, title, 'the working tree has uncommitted changes — a release must be cut from a clean checkout');
  return pass(id, title, 'the working tree is clean');
};

const checkGitHeadAtTag: Check = (evidence) => {
  const id = 'git-head-at-release-tag';
  const title = 'HEAD is the commit the release tag names';
  if (!evidence.git.available) return notRun(id, title, 'no Git here — the tag position cannot be verified offline');
  if (!evidence.git.localTagPresent) {
    return notRun(id, title, 'the target tag is not present locally — verifying HEAD against it is a CI/human step and needs no network here');
  }
  if (!evidence.git.localTagAtHead) return block(id, title, 'the local tag for this release does not point at HEAD — wrong ref/tag');
  return pass(id, title, 'the local release tag points at HEAD');
};

const ALL_CHECKS: readonly Check[] = [
  checkTargetTag,
  checkShippedTagMatchesTarget,
  checkReleaseDecision,
  checkReleaseConsistency,
  checkBundleCoordinates,
  checkArchiveAndChecksums,
  checkImageRepository,
  checkNoFloatingPins,
  checkBundleRedaction,
  checkPublishDependencyGraph,
  checkAcceptanceGatesNotSkippable,
  checkPublishFailClosed,
  checkPermissionsScoped,
  checkNoPublishCapabilityOutsidePublish,
  checkPublishTagFromGate,
  checkArchitectureClaim,
  checkSuitesRunAcceptances,
  checkDocsInstallUpgradeRollback,
  checkReleaseDocsPresent,
  checkGitClean,
  checkGitHeadAtTag,
];

// -----------------------------------------------------------------------------------------------------------
// Evaluation and rendering
// -----------------------------------------------------------------------------------------------------------

function deriveOutcome(checks: readonly ReadinessCheck[]): ReadinessOutcome {
  if (checks.some((c) => c.status === 'INVALID')) return 'INVALID';
  if (checks.some((c) => c.status === 'BLOCK')) return 'BLOCKED';
  if (checks.some((c) => c.status === 'NOT_RUN')) return 'NOT_RUN';
  return 'READY_FOR_HUMAN_RELEASE_DECISION';
}

function computeSelfDigest(body: Omit<ReleaseReadinessReport, 'selfDigest' | 'generatedAt'>): string {
  // Canonical over the verdict-bearing fields (not the wall clock). Same evidence -> same digest.
  const canonical = JSON.stringify({
    scope: SELF_DIGEST_SCOPE,
    outcome: body.outcome,
    targetTag: body.targetTag,
    coordinates: body.coordinates,
    checks: body.checks.map((c) => ({ id: c.id, status: c.status })),
  });
  return createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
}

export interface EvaluateOptions {
  /** Passed in, never read from the clock, so the same evidence renders the same report. */
  readonly generatedAt: string;
}

export function evaluateReleaseReadiness(evidence: ReadinessEvidence, options: EvaluateOptions): ReleaseReadinessReport {
  const workflow = viewWorkflow(evidence.workflowText);
  const checks = ALL_CHECKS.map((check) => check(evidence, workflow));
  const outcome = deriveOutcome(checks);
  const counts = {
    pass: checks.filter((c) => c.status === 'PASS').length,
    block: checks.filter((c) => c.status === 'BLOCK').length,
    invalid: checks.filter((c) => c.status === 'INVALID').length,
    notRun: checks.filter((c) => c.status === 'NOT_RUN').length,
  };
  const coordinates = {
    tag: evidence.targetTag,
    imageRepository: RELEASE_IMAGE_REPOSITORY,
    imageRef: `${RELEASE_IMAGE_REPOSITORY}:${evidence.targetTag}`,
    archiveName: evidence.archive.filename,
    archiveSha256: evidence.archive.sha256,
    bundleVersion: bundleVersionFromVersionFile(evidence.bundle) ?? '(absent)',
    sourceRevision: evidence.bundle.revision,
  };
  const bodyWithoutDigest = {
    report: 'phase-250-release-readiness' as const,
    outcome,
    outcomeIsEvidenceNotApproval: true as const,
    authorityNote: AUTHORITY_NOTE,
    targetTag: evidence.targetTag,
    coordinates,
    checks,
    counts,
    boundaries: BOUNDARIES,
  };
  const selfDigest = computeSelfDigest(bodyWithoutDigest);
  return { ...bodyWithoutDigest, generatedAt: options.generatedAt, selfDigest };
}

/** JSON, checked for redaction safety before it is returned. */
export function renderReadinessJson(report: ReleaseReadinessReport): string {
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  assertReadinessReportIsRedactionSafe(rendered);
  return rendered;
}

const STATUS_MARK: Record<CheckStatus, string> = { PASS: 'PASS ', BLOCK: 'BLOCK', INVALID: 'INVAL', NOT_RUN: 'NOTRN' };

/** A concise human summary, checked identically. */
export function renderReadinessText(report: ReleaseReadinessReport): string {
  const lines: string[] = [
    'Catalog Authority — release readiness',
    `report:        ${report.report}`,
    `generated:     ${report.generatedAt}`,
    `target tag:    ${report.targetTag}`,
    `outcome:       ${report.outcome}`,
    '',
    'Coordinates',
    `  image:       ${report.coordinates.imageRef}`,
    `  archive:     ${report.coordinates.archiveName}`,
    `  archive sha: ${report.coordinates.archiveSha256}`,
    `  bundle ver:  ${report.coordinates.bundleVersion}`,
    `  revision:    ${report.coordinates.sourceRevision}`,
    '',
    `Checks (${report.counts.pass} pass, ${report.counts.block} block, ${report.counts.invalid} invalid, ${report.counts.notRun} not-run)`,
    ...report.checks.map((c) => `  ${STATUS_MARK[c.status]}  ${c.title} — ${c.detail}`),
    '',
    `self-digest:   ${report.selfDigest}`,
    '',
    report.authorityNote,
    '',
  ];
  const rendered = lines.join('\n');
  assertReadinessReportIsRedactionSafe(rendered);
  return rendered;
}
