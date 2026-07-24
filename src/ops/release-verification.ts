import { createHash } from 'node:crypto';
import {
  BUNDLE_CHECKSUM_FILENAME,
  BUNDLE_MANIFEST_FILENAME,
  type ConsumerReleaseBundle,
} from './consumer-release-bundle.js';
import { readDeterministicArchive, type ArchiveResult } from './release-archive.js';

// Phase 251 — consumer-verifiable release integrity and supply-chain packet.
//
// This module builds two things and nothing else — it is a pure function of its inputs, contacts no network,
// runs no credential, and reads no filesystem of its own (the CLI gathers the bytes and hands them in):
//
//   1. a VERIFICATION PACKET — a deterministic, redaction-safe description of exactly what a release ships:
//      the archive's SHA-256, every bundle file's digest, a minimal software inventory (SBOM) built purely
//      from the committed lockfile's production closure and the image's own declared metadata, whether CI is
//      wired to attach SLSA provenance and an SBOM attestation to the published image, and copy-paste
//      verification commands for Linux, macOS and Windows. It ships ALONGSIDE the archive as a release asset.
//
//   2. an OFFLINE VERIFIER — given a downloaded archive's bytes and this packet, it independently recomputes
//      the archive digest, extracts the archive in memory, recomputes every file's digest, and cross-checks
//      the bundle's own MANIFEST / CHECKSUMS / VERSION / Compose image pin against the packet and against each
//      other. It returns one of three integrity outcomes:
//
//        * VERIFIED   — the bytes are EXACTLY what this packet describes and the packet is internally
//                       consistent. This is a statement about INTEGRITY, not about authorship.
//        * INVALID    — a digest or a coordinate did not match. Something was tampered with, or the packet and
//                       the artifact disagree.
//        * UNVERIFIED — the check could not be completed offline (the artifact was not supplied, only the
//                       packet), so integrity is neither confirmed nor denied. A skip is never a pass.
//
// The honesty line this module never crosses: a matching checksum proves the bytes match this packet. It does
// NOT prove WHO produced them. Publisher identity requires a cryptographic signature (Sigstore / GitHub
// attestations against the PUBLISHED image), which is an online step this offline packet describes but never
// performs and never pretends to have performed. `attestation` and `publisherIdentity` are reported in their
// own fields and DELIBERATELY do not gate the integrity outcome — VERIFIED means the bytes match, no more.

export type IntegrityStatus = 'PASS' | 'FAIL' | 'UNVERIFIED';

export type IntegrityOutcome = 'VERIFIED' | 'UNVERIFIED' | 'INVALID';

/** Fixed, documented exit codes. A caller scripts against these, so they never move. */
export const VERIFICATION_EXIT_CODES: Readonly<Record<IntegrityOutcome, number>> = {
  VERIFIED: 0,
  UNVERIFIED: 20,
  INVALID: 21,
};

export class ReleaseVerificationError extends Error {
  readonly code = 'RELEASE_VERIFICATION_REDACTION_REJECTED';
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseVerificationError';
  }
}

// -----------------------------------------------------------------------------------------------------------
// Software inventory (minimal SBOM), built purely from the committed lockfile and the image's Dockerfile.
// -----------------------------------------------------------------------------------------------------------

export interface SoftwarePackage {
  readonly name: string;
  readonly version: string;
  /** SPDX license string as the lockfile records it, or null if the lockfile does not state one. */
  readonly license: string | null;
  /** The lockfile's Subresource Integrity (SRI) hash, e.g. `sha512-…`. The supply-chain anchor. */
  readonly integrity: string | null;
}

export interface SoftwareInventory {
  readonly format: 'catalog-authority-min-sbom';
  readonly schema: 1;
  readonly application: { readonly name: string; readonly version: string };
  /** The base image, pinned by digest, as `Dockerfile.runtime` declares it. */
  readonly baseImage: { readonly ref: string; readonly digest: string } | null;
  /** Static OCI image labels (the templated version/revision/created are deliberately excluded). */
  readonly imageLabels: Readonly<Record<string, string>>;
  /** The production dependency closure, `npm ci --omit=dev`, sorted by name then version. */
  readonly runtimeDependencies: readonly SoftwarePackage[];
  readonly dependencyCount: number;
  readonly source: string;
  readonly note: string;
}

const SBOM_NOTE =
  'Declared production closure from package-lock.json (equivalent to `npm ci --omit=dev`). Platform-specific '
  + 'optional binaries appear as declared; only those matching the image platform are installed. `integrity` '
  + 'is the lockfile Subresource Integrity hash. No filesystem paths or build-machine data are included.';

interface LockfilePackage {
  readonly version?: unknown;
  readonly license?: unknown;
  readonly integrity?: unknown;
  readonly dev?: unknown;
  readonly link?: unknown;
}

/** The package name is the segment after the LAST `node_modules/` in a lockfile v3 package key. */
function packageNameFromKey(key: string): string {
  const marker = 'node_modules/';
  const at = key.lastIndexOf(marker);
  return at < 0 ? key : key.slice(at + marker.length);
}

/**
 * Build the minimal SBOM from the lockfile's production closure and the image's declared metadata. Pure and
 * deterministic: the same lockfile and Dockerfile always produce the same inventory, byte for byte.
 */
export function buildSoftwareInventory(
  lockfileText: string,
  dockerfileText: string,
  application: { readonly name: string; readonly version: string },
): SoftwareInventory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockfileText);
  } catch {
    throw new Error('package-lock.json is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('package-lock.json is not an object');
  const packages = (parsed as { packages?: unknown }).packages;
  if (typeof packages !== 'object' || packages === null) throw new Error('package-lock.json has no packages map (needs lockfileVersion 3)');

  const byIdentity = new Map<string, SoftwarePackage>();
  for (const [key, raw] of Object.entries(packages as Record<string, unknown>)) {
    if (key === '') continue; // the root project, not a dependency
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as LockfilePackage;
    if (entry.dev === true) continue;   // dev-only — excluded by --omit=dev
    if (entry.link === true) continue;  // a workspace link, not a shipped package
    const version = typeof entry.version === 'string' ? entry.version : null;
    if (version === null) continue;     // no version to pin; not a real dependency entry
    const name = packageNameFromKey(key);
    const license = typeof entry.license === 'string' ? entry.license : null;
    const integrity = typeof entry.integrity === 'string' ? entry.integrity : null;
    byIdentity.set(`${name}@${version}`, { name, version, license, integrity });
  }

  const runtimeDependencies = [...byIdentity.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0);

  return {
    format: 'catalog-authority-min-sbom',
    schema: 1,
    application,
    baseImage: baseImageFromDockerfile(dockerfileText),
    imageLabels: staticImageLabels(dockerfileText),
    runtimeDependencies,
    dependencyCount: runtimeDependencies.length,
    source: 'package-lock.json production closure (dev !== true)',
    note: SBOM_NOTE,
  };
}

function baseImageFromDockerfile(dockerfileText: string): { ref: string; digest: string } | null {
  const match = /ARG\s+NODE_IMAGE=([^\s@]+)@(sha256:[0-9a-f]{64})/.exec(dockerfileText);
  if (match === null) return null;
  return { ref: match[1]!, digest: match[2]! };
}

/** OCI labels whose value is a literal (templated `${…}` values — version/revision/created — are excluded). */
function staticImageLabels(dockerfileText: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const pattern = /org\.opencontainers\.image\.([a-z]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(dockerfileText)) !== null) {
    const key = match[1]!;
    const value = match[2]!;
    if (value.includes('${')) continue; // build-arg templated; not a static fact about the image
    labels[key] = value;
  }
  return labels;
}

// -----------------------------------------------------------------------------------------------------------
// Attestation wiring: does CI attach SLSA provenance and an SBOM attestation to the PUBLISHED image? This is
// a STRUCTURAL read of the workflow — it says whether these WILL be produced, never that they are signed or
// present. Verifying the actual attestation needs the registry and a signature, which this packet never does.
// -----------------------------------------------------------------------------------------------------------

export interface AttestationWiring {
  readonly imageProvenance: boolean;
  readonly imageSbom: boolean;
}

export function detectAttestationWiring(workflowText: string): AttestationWiring {
  const lines = workflowText.split(/\r?\n/);
  const usesAt = lines.findIndex((line) => /^\s*(?:-\s*)?uses:\s*docker\/build-push-action/.test(line));
  if (usesAt < 0) return { imageProvenance: false, imageSbom: false };
  // Anchor on the column of the `uses` KEYWORD, which is the step's field indent in both `- uses:` and a
  // bare `uses:` layout. Its `with:` block is a sibling at that same field indent and its keys are deeper,
  // so we read forward until a line dedents ABOVE the field indent — the next step or the next job.
  const fieldIndent = lines[usesAt]!.indexOf('uses');
  let provenance = false;
  let sbom = false;
  for (let i = usesAt + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const indent = line.search(/\S/);
    if (indent < fieldIndent) break; // dedented out of this step
    if (/^\s*provenance:\s*true\s*$/.test(line)) provenance = true;
    if (/^\s*sbom:\s*true\s*$/.test(line)) sbom = true;
  }
  return { imageProvenance: provenance, imageSbom: sbom };
}

// -----------------------------------------------------------------------------------------------------------
// The verification packet.
// -----------------------------------------------------------------------------------------------------------

export interface PacketFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface VerificationPacket {
  readonly packet: 'phase-251-release-verification-packet';
  readonly schema: 1;
  readonly release: {
    readonly name: string;
    readonly version: string;
    readonly imageRepository: string;
    readonly imageRef: string;
    readonly imageDigest: string | null;
    readonly sourceRevision: string;
  };
  readonly archive: { readonly name: string; readonly sha256: string; readonly bytes: number };
  readonly bundle: {
    readonly files: readonly PacketFile[];
    readonly manifestSha256: string;
    readonly checksumsSha256: string;
  };
  readonly inventory: SoftwareInventory;
  readonly attestation: {
    readonly imageProvenance: 'declared-by-ci' | 'not-declared';
    readonly imageSbom: 'declared-by-ci' | 'not-declared';
    readonly verifiedOffline: false;
    readonly note: string;
  };
  readonly identityNote: string;
  readonly verify: {
    readonly linux: readonly string[];
    readonly macos: readonly string[];
    readonly windows: readonly string[];
    readonly attestationOnline: readonly string[];
  };
  readonly boundaries: readonly string[];
  readonly generatedAt: string;
  readonly selfDigest: string;
}

const ATTESTATION_NOTE =
  'SLSA provenance and an SBOM attestation are produced by the CI publish job and attached to the PUBLISHED '
  + 'image. This packet does not contain, sign, or verify them; verify them against the published image with '
  + 'the attestationOnline commands below, which require the network.';

const IDENTITY_NOTE =
  'A matching checksum proves the bytes are identical to what this packet describes. It does NOT prove who '
  + 'published them. Publisher identity requires a cryptographic signature (GitHub attestations / Sigstore '
  + 'against the published image); this offline packet does not establish it and never implies it.';

const PACKET_BOUNDARIES: readonly string[] = [
  'describes bytes and their digests only; asserts no publisher identity without a cryptographic signature',
  'built offline from the committed lockfile and Dockerfile; contacts no network and uses no credential',
  'contains no build-machine path, secret, or live-provider data',
];

const PACKET_SELF_DIGEST_SCOPE = 'phase-251-release-verification-packet';

function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function ownerFromImageRef(imageRef: string): string | null {
  // ghcr.io/<owner>/<name>:<tag> — the owner is the first path segment after the registry host.
  const withoutTag = imageRef.split(':')[0] ?? imageRef;
  const parts = withoutTag.split('/');
  return parts.length >= 3 ? parts[1]! : null;
}

function bundleFileContents(bundle: ConsumerReleaseBundle, path: string): string | null {
  const file = bundle.files.find((candidate) => candidate.path === path);
  return file === undefined ? null : file.contents;
}

export interface PacketInputs {
  readonly bundle: ConsumerReleaseBundle;
  readonly archive: ArchiveResult;
  readonly lockfileText: string;
  readonly dockerfileText: string;
  readonly workflowText: string;
  readonly application: { readonly name: string; readonly version: string };
  /** Passed in, never read from the clock, so the same inputs render the same packet. */
  readonly generatedAt: string;
}

export function buildVerificationPacket(inputs: PacketInputs): VerificationPacket {
  const { bundle, archive } = inputs;
  const archiveRoot = archive.filename.replace(/\.tar\.gz$/, '');
  const manifest = bundle.files.find((file) => file.path === BUNDLE_MANIFEST_FILENAME);
  const checksums = bundle.files.find((file) => file.path === BUNDLE_CHECKSUM_FILENAME);
  if (manifest === undefined) throw new Error(`the bundle has no ${BUNDLE_MANIFEST_FILENAME}`);
  if (checksums === undefined) throw new Error(`the bundle has no ${BUNDLE_CHECKSUM_FILENAME}`);

  const files: PacketFile[] = bundle.files
    .map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const wiring = detectAttestationWiring(inputs.workflowText);
  const inventory = buildSoftwareInventory(inputs.lockfileText, inputs.dockerfileText, inputs.application);

  const imageRef = bundle.imageRef;
  const owner = ownerFromImageRef(imageRef);
  const expected = archive.sha256;

  const verify = {
    linux: [
      `# 1. the archive is exactly these bytes`,
      `sha256sum -c ${archive.filename}.sha256`,
      `# 2. or compute and compare to this packet's archive.sha256`,
      `sha256sum ${archive.filename}   # expect: ${expected}`,
      `# 3. extract and verify every file inside`,
      `tar -xzf ${archive.filename}`,
      `cd ${archiveRoot} && sha256sum -c ${BUNDLE_CHECKSUM_FILENAME}`,
    ],
    macos: [
      `# 1. the archive is exactly these bytes`,
      `shasum -a 256 -c ${archive.filename}.sha256`,
      `# 2. or compute and compare to this packet's archive.sha256`,
      `shasum -a 256 ${archive.filename}   # expect: ${expected}`,
      `# 3. extract and verify every file inside`,
      `tar -xzf ${archive.filename}`,
      `cd ${archiveRoot} && shasum -a 256 -c ${BUNDLE_CHECKSUM_FILENAME}`,
    ],
    windows: [
      `# 1. the archive is exactly these bytes (compare to this packet's archive.sha256)`,
      `(Get-FileHash -Algorithm SHA256 ${archive.filename}).Hash.ToLower()   # expect: ${expected}`,
      `# 2. extract (tar ships with Windows 10+)`,
      `tar -xzf ${archive.filename}`,
      `# 3. verify every file inside`,
      `Get-Content ${archiveRoot}\\${BUNDLE_CHECKSUM_FILENAME} | ForEach-Object { $h,$f = $_ -split '  ',2; if ((Get-FileHash -Algorithm SHA256 (Join-Path ${archiveRoot} $f)).Hash.ToLower() -ne $h) { Write-Error "MISMATCH: $f" } }`,
    ],
    attestationOnline: [
      `# INTEGRITY above is offline. The commands below need the network and the PUBLISHED image, and are what`,
      `# establish PROVENANCE and publisher identity — which this packet does not.`,
      owner === null
        ? `gh attestation verify oci://${imageRef} --owner <owner>`
        : `gh attestation verify oci://${imageRef} --owner ${owner}`,
      `cosign verify-attestation --type slsaprovenance ${imageRef}`,
    ],
  };

  const bodyWithoutDigest = {
    packet: 'phase-251-release-verification-packet' as const,
    schema: 1 as const,
    release: {
      name: inputs.application.name,
      version: bundle.image.tag,
      imageRepository: bundle.image.repository,
      imageRef,
      imageDigest: bundle.image.digest ?? null,
      sourceRevision: bundle.revision,
    },
    archive: { name: archive.filename, sha256: archive.sha256, bytes: archive.bytes.length },
    bundle: {
      files,
      manifestSha256: manifest.sha256,
      checksumsSha256: checksums.sha256,
    },
    inventory,
    attestation: {
      imageProvenance: (wiring.imageProvenance ? 'declared-by-ci' : 'not-declared') as 'declared-by-ci' | 'not-declared',
      imageSbom: (wiring.imageSbom ? 'declared-by-ci' : 'not-declared') as 'declared-by-ci' | 'not-declared',
      verifiedOffline: false as const,
      note: ATTESTATION_NOTE,
    },
    identityNote: IDENTITY_NOTE,
    verify,
    boundaries: PACKET_BOUNDARIES,
  };

  const selfDigest = computePacketSelfDigest(bodyWithoutDigest);
  return { ...bodyWithoutDigest, generatedAt: inputs.generatedAt, selfDigest };
}

function computePacketSelfDigest(body: Omit<VerificationPacket, 'generatedAt' | 'selfDigest'>): string {
  // Canonical over everything that describes the release (not the wall clock). Same inputs -> same digest,
  // and any change to what is claimed changes it, so the packet can be pinned and re-verified.
  const canonical = JSON.stringify({ scope: PACKET_SELF_DIGEST_SCOPE, body });
  return createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
}

/** Recompute a packet's self-digest and confirm it matches — proof the packet itself was not edited. */
export function packetSelfDigestMatches(packet: VerificationPacket): boolean {
  const { generatedAt, selfDigest, ...body } = packet;
  void generatedAt;
  return computePacketSelfDigest(body) === selfDigest;
}

// -----------------------------------------------------------------------------------------------------------
// The offline verifier.
// -----------------------------------------------------------------------------------------------------------

export interface IntegrityCheck {
  readonly id: string;
  readonly title: string;
  readonly status: IntegrityStatus;
  readonly detail: string;
}

export interface VerificationReport {
  readonly report: 'phase-251-release-verification';
  readonly generatedAt: string;
  readonly outcome: IntegrityOutcome;
  readonly outcomeMeaning: string;
  readonly archive: {
    readonly name: string;
    readonly expectedSha256: string;
    readonly recomputedSha256: string | null;
  };
  readonly checks: readonly IntegrityCheck[];
  readonly counts: { readonly pass: number; readonly fail: number; readonly unverified: number };
  readonly attestation: {
    readonly imageProvenance: 'declared-by-ci' | 'not-declared';
    readonly imageSbom: 'declared-by-ci' | 'not-declared';
    readonly status: 'DECLARED_NOT_VERIFIED_OFFLINE';
    readonly note: string;
  };
  readonly publisherIdentity: { readonly status: 'NOT_ESTABLISHED_OFFLINE'; readonly note: string };
  readonly boundaries: readonly string[];
  readonly selfDigest: string;
}

export interface VerifyEvidence {
  readonly packet: VerificationPacket;
  /** The downloaded archive's bytes. Omit to verify the packet's internal consistency only (UNVERIFIED). */
  readonly archiveBytes?: Buffer;
}

const OUTCOME_MEANING =
  'VERIFIED means the archive bytes are exactly what this packet describes and the packet is internally '
  + 'consistent. It is a statement about integrity, NOT about who published the release; publisher identity '
  + 'and provenance are reported separately and require the online attestation commands.';

const REPORT_BOUNDARIES: readonly string[] = [
  'recomputes digests from the supplied bytes in memory; contacts no network and uses no credential',
  'never asserts a signature or publisher identity that is not cryptographically established',
  'a check it cannot complete offline is UNVERIFIED, never silently a pass',
];

const REPORT_SELF_DIGEST_SCOPE = 'phase-251-release-verification';

function pass(id: string, title: string, detail: string): IntegrityCheck { return { id, title, status: 'PASS', detail }; }
function fail(id: string, title: string, detail: string): IntegrityCheck { return { id, title, status: 'FAIL', detail }; }
function unverified(id: string, title: string, detail: string): IntegrityCheck { return { id, title, status: 'UNVERIFIED', detail }; }

/** Strip the single archive-root directory from an extracted path: `root/README.md` -> `README.md`. */
function withoutRoot(path: string): string {
  const slash = path.indexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

interface VersionFields {
  readonly version: string | null;
  readonly image: string | null;
  readonly imageDigest: string | null;
}

function parseVersionFile(text: string): VersionFields {
  const field = (key: string): string | null => {
    const match = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(text);
    return match === null ? null : match[1]!.trim();
  };
  return { version: field('version'), image: field('image'), imageDigest: field('image_digest') };
}

export function verifyRelease(evidence: VerifyEvidence, options: { readonly generatedAt: string }): VerificationReport {
  const { packet } = evidence;
  const checks: IntegrityCheck[] = [];

  // 0. The packet describes itself honestly: its own self-digest recomputes. If not, nothing it claims can be
  //    trusted, so this is a hard FAIL (INVALID), not merely UNVERIFIED.
  if (packetSelfDigestMatches(packet)) {
    checks.push(pass('packet-self-digest', 'The packet has not been edited since it was generated',
      'the packet self-digest recomputes to the stored value'));
  } else {
    checks.push(fail('packet-self-digest', 'The packet has not been edited since it was generated',
      'the packet self-digest does not match its contents — the packet itself was altered'));
  }

  let recomputedArchiveSha: string | null = null;

  if (evidence.archiveBytes === undefined) {
    checks.push(unverified('archive-digest', 'The archive bytes match the packet',
      'no archive was supplied — only the packet was checked for internal consistency'));
    checks.push(unverified('archive-size', 'The archive size matches the packet', 'no archive was supplied'));
    checks.push(unverified('bundle-contents', 'Every file inside the archive matches its digest', 'no archive was supplied'));
    checks.push(unverified('bundle-checksums', 'The archive\'s own SHA256SUMS verifies', 'no archive was supplied'));
    checks.push(unverified('manifest-consistency', 'MANIFEST, VERSION and the image pin agree', 'no archive was supplied'));
  } else {
    const bytes = evidence.archiveBytes;
    recomputedArchiveSha = createHash('sha256').update(bytes).digest('hex');

    // 1. Archive digest and size.
    if (recomputedArchiveSha === packet.archive.sha256) {
      checks.push(pass('archive-digest', 'The archive bytes match the packet', 'the recomputed SHA-256 equals the packet digest'));
    } else {
      checks.push(fail('archive-digest', 'The archive bytes match the packet',
        'the recomputed SHA-256 does not equal the packet digest — these are not the bytes the packet describes'));
    }
    if (bytes.length === packet.archive.bytes) {
      checks.push(pass('archive-size', 'The archive size matches the packet', `the archive is ${bytes.length} bytes as stated`));
    } else {
      checks.push(fail('archive-size', 'The archive size matches the packet',
        `the archive is ${bytes.length} bytes; the packet states ${packet.archive.bytes}`));
    }

    // 2. Extract and re-digest every file, cross-checking the packet, the bundle's own SHA256SUMS and MANIFEST.
    appendExtractionChecks(checks, bytes, packet);
  }

  const counts = {
    pass: checks.filter((c) => c.status === 'PASS').length,
    fail: checks.filter((c) => c.status === 'FAIL').length,
    unverified: checks.filter((c) => c.status === 'UNVERIFIED').length,
  };
  const outcome: IntegrityOutcome = counts.fail > 0 ? 'INVALID' : counts.unverified > 0 ? 'UNVERIFIED' : 'VERIFIED';

  const bodyWithoutDigest = {
    report: 'phase-251-release-verification' as const,
    outcome,
    outcomeMeaning: OUTCOME_MEANING,
    archive: {
      name: packet.archive.name,
      expectedSha256: packet.archive.sha256,
      recomputedSha256: recomputedArchiveSha,
    },
    checks,
    counts,
    attestation: {
      imageProvenance: packet.attestation.imageProvenance,
      imageSbom: packet.attestation.imageSbom,
      status: 'DECLARED_NOT_VERIFIED_OFFLINE' as const,
      note: packet.attestation.note,
    },
    publisherIdentity: { status: 'NOT_ESTABLISHED_OFFLINE' as const, note: packet.identityNote },
    boundaries: REPORT_BOUNDARIES,
  };
  const selfDigest = computeReportSelfDigest(bodyWithoutDigest);
  return { ...bodyWithoutDigest, generatedAt: options.generatedAt, selfDigest };
}

function appendExtractionChecks(checks: IntegrityCheck[], bytes: Buffer, packet: VerificationPacket): void {
  let extracted: ReturnType<typeof readDeterministicArchive>;
  try {
    extracted = readDeterministicArchive(bytes);
  } catch {
    checks.push(fail('bundle-contents', 'Every file inside the archive matches its digest', 'the archive could not be extracted — it is not a readable deterministic archive'));
    checks.push(fail('bundle-checksums', 'The archive\'s own SHA256SUMS verifies', 'the archive could not be extracted'));
    checks.push(fail('manifest-consistency', 'MANIFEST, VERSION and the image pin agree', 'the archive could not be extracted'));
    return;
  }

  // File contents by bundle-relative path (directory entries and the root dir are dropped).
  const contentsByPath = new Map<string, string>();
  for (const entry of extracted) {
    if (entry.typeflag === '5') continue;      // directory
    if (entry.path.endsWith('/')) continue;
    contentsByPath.set(withoutRoot(entry.path), entry.contents);
  }

  // 2a. Every packet-listed file is present with the stated digest, and no unexpected file was added.
  const packetPaths = new Set(packet.bundle.files.map((f) => f.path));
  const problems: string[] = [];
  for (const file of packet.bundle.files) {
    const contents = contentsByPath.get(file.path);
    if (contents === undefined) { problems.push(`${file.path} is missing from the archive`); continue; }
    const digest = sha256Hex(contents);
    if (digest !== file.sha256) problems.push(`${file.path} does not match its packet digest`);
    if (Buffer.byteLength(contents, 'utf8') !== file.bytes) problems.push(`${file.path} is not ${file.bytes} bytes`);
  }
  for (const path of contentsByPath.keys()) {
    if (!packetPaths.has(path)) problems.push(`${path} is in the archive but not in the packet`);
  }
  if (problems.length === 0) {
    checks.push(pass('bundle-contents', 'Every file inside the archive matches its digest',
      `all ${packet.bundle.files.length} files match the packet, with none added or missing`));
  } else {
    checks.push(fail('bundle-contents', 'Every file inside the archive matches its digest', problems[0]!));
  }

  // 2b. The bundle's OWN SHA256SUMS verifies against the extracted files (what `sha256sum -c` does), and its
  //     digest matches the packet.
  const checksumsText = contentsByPath.get(BUNDLE_CHECKSUM_FILENAME);
  if (checksumsText === undefined) {
    checks.push(fail('bundle-checksums', 'The archive\'s own SHA256SUMS verifies', `${BUNDLE_CHECKSUM_FILENAME} is missing from the archive`));
  } else if (sha256Hex(checksumsText) !== packet.bundle.checksumsSha256) {
    checks.push(fail('bundle-checksums', 'The archive\'s own SHA256SUMS verifies', `${BUNDLE_CHECKSUM_FILENAME} does not match the packet digest`));
  } else {
    const sumsProblem = verifyChecksumsFile(checksumsText, contentsByPath);
    if (sumsProblem === null) {
      checks.push(pass('bundle-checksums', 'The archive\'s own SHA256SUMS verifies',
        'every SHA256SUMS entry matches its file, exactly as `sha256sum -c` would report'));
    } else {
      checks.push(fail('bundle-checksums', 'The archive\'s own SHA256SUMS verifies', sumsProblem));
    }
  }

  // 2c. MANIFEST, VERSION and the Compose/.env image pin all name the same version and image ref.
  appendManifestConsistency(checks, contentsByPath, packet);
}

/** Return null when every `sha256  path` line matches; otherwise the first mismatch, redaction-safe. */
function verifyChecksumsFile(checksumsText: string, contentsByPath: Map<string, string>): string | null {
  for (const line of checksumsText.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line);
    if (match === null) return 'a SHA256SUMS line is malformed';
    const [, digest, path] = match;
    if (path === BUNDLE_CHECKSUM_FILENAME) return `${BUNDLE_CHECKSUM_FILENAME} must not list itself`;
    const contents = contentsByPath.get(path!);
    if (contents === undefined) return `SHA256SUMS lists ${path}, which is not in the archive`;
    if (sha256Hex(contents) !== digest) return `SHA256SUMS digest does not match ${path}`;
  }
  return null;
}

function appendManifestConsistency(
  checks: IntegrityCheck[],
  contentsByPath: Map<string, string>,
  packet: VerificationPacket,
): void {
  const id = 'manifest-consistency';
  const title = 'MANIFEST, VERSION and the image pin agree';
  const manifestText = contentsByPath.get(BUNDLE_MANIFEST_FILENAME);
  const versionText = contentsByPath.get('VERSION');
  const composeText = contentsByPath.get('docker-compose.yml');
  const envText = contentsByPath.get('.env');
  if (manifestText === undefined || versionText === undefined || composeText === undefined || envText === undefined) {
    checks.push(fail(id, title, 'the bundle is missing a manifest, VERSION, docker-compose.yml or .env'));
    return;
  }

  let manifest: { version?: unknown; image?: unknown };
  try {
    manifest = JSON.parse(manifestText) as { version?: unknown; image?: unknown };
  } catch {
    checks.push(fail(id, title, 'the bundle manifest is not valid JSON'));
    return;
  }
  const image = (typeof manifest.image === 'object' && manifest.image !== null) ? manifest.image as { ref?: unknown } : {};
  const manifestVersion = typeof manifest.version === 'string' ? manifest.version : null;
  const manifestRef = typeof image.ref === 'string' ? image.ref : null;
  const versionFields = parseVersionFile(versionText);

  const problems: string[] = [];
  if (manifestVersion !== packet.release.version) problems.push('the manifest version differs from the packet version');
  if (manifestRef !== packet.release.imageRef) problems.push('the manifest image ref differs from the packet image ref');
  if (versionFields.version !== packet.release.version) problems.push('the VERSION file version differs from the packet version');
  if (versionFields.image !== packet.release.imageRef) problems.push('the VERSION file image ref differs from the packet image ref');
  // The shipped Compose stack and .env must pin the EXACT image ref — never a floating tag.
  if (!composeText.includes(packet.release.imageRef)) problems.push('docker-compose.yml does not pin the packet image ref');
  if (!envText.includes(packet.release.imageRef)) problems.push('.env does not pin the packet image ref');
  if (/:latest(\s|$|["'])/.test(composeText) || /:latest(\s|$|["'])/.test(envText)) problems.push('the bundle points at a floating :latest tag');
  // If the release is digest-pinned, VERSION must carry that same digest.
  if (packet.release.imageDigest !== null && versionFields.imageDigest !== packet.release.imageDigest) {
    problems.push('the VERSION image_digest differs from the packet digest');
  }

  if (problems.length === 0) {
    checks.push(pass(id, title, 'the manifest, VERSION and the Compose/.env pin all name the same version and image'));
  } else {
    checks.push(fail(id, title, problems[0]!));
  }
}

function computeReportSelfDigest(body: Omit<VerificationReport, 'generatedAt' | 'selfDigest'>): string {
  const canonical = JSON.stringify({
    scope: REPORT_SELF_DIGEST_SCOPE,
    outcome: body.outcome,
    archive: body.archive,
    checks: body.checks.map((c) => ({ id: c.id, status: c.status })),
    attestation: { imageProvenance: body.attestation.imageProvenance, imageSbom: body.attestation.imageSbom },
  });
  return createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
}

// -----------------------------------------------------------------------------------------------------------
// Redaction: both the packet and the report must be safe to paste anywhere. They are controlled text —
// coordinates, fixed sentences, public digests, registry package names and SRI hashes — and this backstop
// scans the rendered output for leaked live DATA (a private key, a credential, an absolute host path, the
// Movies library path), refusing to emit rather than print anything unsafe. 64-hex and SRI hashes are the
// whole point here, so no generic "long hex/base64" rule is present.
// -----------------------------------------------------------------------------------------------------------

const FORBIDDEN_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bghp_[A-Za-z0-9]{20,}\b/, 'a GitHub token'],
  [/postgres(?:ql)?:\/\/[^\s:@/]+:[^\s:@/]{6,}@/i, 'a database URL with a password'],
  [/(?:^|[^\w./-])\/(?:home|root|Users|mnt|opt|srv)\//, 'an absolute host filesystem path'],
  [/\b[A-Za-z]:\\Users\\/, 'a Windows user path'],
  [/\/mnt\/user\/media\/Movies/i, 'the Movies library path'],
];

export function assertVerificationOutputIsRedactionSafe(rendered: string): void {
  for (const [pattern, what] of FORBIDDEN_SHAPES) {
    if (pattern.test(rendered)) throw new ReleaseVerificationError(`refusing to emit: the output contains ${what}`);
  }
}

export function renderPacketJson(packet: VerificationPacket): string {
  const rendered = `${JSON.stringify(packet, null, 2)}\n`;
  assertVerificationOutputIsRedactionSafe(rendered);
  return rendered;
}

export function renderReportJson(report: VerificationReport): string {
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  assertVerificationOutputIsRedactionSafe(rendered);
  return rendered;
}

const STATUS_MARK: Record<IntegrityStatus, string> = { PASS: 'PASS ', FAIL: 'FAIL ', UNVERIFIED: 'UNVER' };

export function renderReportText(report: VerificationReport): string {
  const lines: string[] = [
    'Catalog Authority — release integrity verification',
    `report:        ${report.report}`,
    `generated:     ${report.generatedAt}`,
    `archive:       ${report.archive.name}`,
    `expected sha:  ${report.archive.expectedSha256}`,
    `recomputed:    ${report.archive.recomputedSha256 ?? '(archive not supplied)'}`,
    `outcome:       ${report.outcome}`,
    '',
    `Checks (${report.counts.pass} pass, ${report.counts.fail} fail, ${report.counts.unverified} unverified)`,
    ...report.checks.map((c) => `  ${STATUS_MARK[c.status]}  ${c.title} — ${c.detail}`),
    '',
    `provenance:    image=${report.attestation.imageProvenance} sbom=${report.attestation.imageSbom} (${report.attestation.status})`,
    `identity:      ${report.publisherIdentity.status}`,
    '',
    report.outcomeMeaning,
    '',
    report.publisherIdentity.note,
    '',
    `self-digest:   ${report.selfDigest}`,
    '',
  ];
  const rendered = lines.join('\n');
  assertVerificationOutputIsRedactionSafe(rendered);
  return rendered;
}
