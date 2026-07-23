import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  BUNDLE_NAME,
  RELEASE_IMAGE_REPOSITORY,
  RELEASE_IMAGE_TAG,
  buildConsumerReleaseArchive,
  buildConsumerReleaseBundle,
  type BundleFile,
  type BundleSources,
  type ConsumerReleaseBundle,
} from '../src/ops/consumer-release-bundle.js';
import { buildDeterministicArchive, type ArchiveEntry, type ArchiveResult } from '../src/ops/release-archive.js';
import { releaseArchiveName } from '../src/ops/release-ref.js';
import {
  VERIFICATION_EXIT_CODES,
  ReleaseVerificationError,
  assertVerificationOutputIsRedactionSafe,
  buildSoftwareInventory,
  buildVerificationPacket,
  detectAttestationWiring,
  packetSelfDigestMatches,
  renderPacketJson,
  renderReportJson,
  renderReportText,
  verifyRelease,
  type IntegrityCheck,
  type PacketInputs,
  type VerificationPacket,
} from '../src/ops/release-verification.js';

// Phase 251 — adversarial suite for the consumer-verifiable release integrity packet and offline verifier.
//
// The verifier only matters if it turns INVALID when it should. So the anchor is a healthy release that is
// VERIFIED, and then an adversarial tamper corpus attacks it: a flipped byte, an altered file, an added file,
// a removed file, a doctored SHA256SUMS, a manifest that disagrees with VERSION, a floating tag, an edited
// packet. Each must drive the outcome to INVALID and the RIGHT check to FAIL. A tamper that did not change
// the verdict would be theatre. It also proves what the verifier must NEVER claim: a VERIFIED result never
// asserts publisher identity, and a packet-only run is UNVERIFIED, never a pass.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

console.log('Running Phase 251 release-verification adversarial suite:\n');

const AT = '2020-01-01T00:00:00.000Z';
const TAG = RELEASE_IMAGE_TAG;

function sources(): BundleSources {
  return {
    runtimeCompose: read('docker-compose.runtime.yml'),
    setupBash: read('deploy/local-runtime-setup.sh'),
    setupPowerShell: read('deploy/local-runtime-setup.ps1'),
  };
}

function bundleFor(tag: string = TAG): ConsumerReleaseBundle {
  return buildConsumerReleaseBundle(sources(), {
    image: { repository: RELEASE_IMAGE_REPOSITORY, tag },
    revision: 'a'.repeat(40),
    createdAt: AT,
  });
}

const APP = { name: 'catalog-authority', version: TAG };

function packetInputs(bundle: ConsumerReleaseBundle, archive: ArchiveResult, overrides: Partial<PacketInputs> = {}): PacketInputs {
  return {
    bundle,
    archive,
    lockfileText: read('package-lock.json'),
    dockerfileText: read('Dockerfile.runtime'),
    workflowText: read('.github/workflows/runtime-image.yml'),
    application: APP,
    generatedAt: AT,
    ...overrides,
  };
}

const genuineBundle = bundleFor();
const genuineArchive = buildConsumerReleaseArchive(genuineBundle);
const genuinePacket = buildVerificationPacket(packetInputs(genuineBundle, genuineArchive));

function checkOf(checks: readonly IntegrityCheck[], id: string): IntegrityCheck {
  const found = checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no check with id ${id}`);
  return found;
}

/** Rebuild the archive from an explicit file list, keeping the genuine root and filename. */
function archiveFromFiles(files: ReadonlyArray<{ path: string; contents: string }>): ArchiveResult {
  const entries: ArchiveEntry[] = files.map((f) => ({ path: f.path, contents: f.contents, executable: f.path.endsWith('.sh') }));
  return buildDeterministicArchive(`${BUNDLE_NAME}-${TAG}`, entries, releaseArchiveName(TAG));
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** A new bundle with one file's contents transformed, its digest and byte count recomputed to stay consistent. */
function mutateBundleFile(bundle: ConsumerReleaseBundle, path: string, transform: (contents: string) => string): ConsumerReleaseBundle {
  let found = false;
  const files: BundleFile[] = bundle.files.map((file) => {
    if (file.path !== path) return file;
    found = true;
    const contents = transform(file.contents);
    return { path, contents, sha256: sha256Hex(contents), bytes: Buffer.byteLength(contents, 'utf8') };
  });
  if (!found) throw new Error(`bundle has no file ${path}`);
  return { ...bundle, files };
}

// ---------------------------------------------------------------------------------------------------------
// Baseline: a healthy release verifies, and every claim the packet makes is present and honest.
// ---------------------------------------------------------------------------------------------------------

test('a healthy release is VERIFIED with every integrity check passing', () => {
  const report = verifyRelease({ packet: genuinePacket, archiveBytes: genuineArchive.bytes }, { generatedAt: AT });
  assertEq(report.outcome, 'VERIFIED', 'the outcome is VERIFIED');
  assertEq(report.counts.fail, 0, 'no check fails');
  assertEq(report.counts.unverified, 0, 'no check is unverified when the archive is supplied');
  for (const id of ['packet-self-digest', 'archive-digest', 'archive-size', 'bundle-contents', 'bundle-checksums', 'manifest-consistency']) {
    assertEq(checkOf(report.checks, id).status, 'PASS', `${id} passes on a healthy release`);
  }
  assertEq(report.archive.recomputedSha256, genuineArchive.sha256, 'the recomputed archive digest is reported');
});

test('a VERIFIED result never claims publisher identity, and reports provenance as declared-not-verified', () => {
  const report = verifyRelease({ packet: genuinePacket, archiveBytes: genuineArchive.bytes }, { generatedAt: AT });
  assertEq(report.outcome, 'VERIFIED', 'integrity is VERIFIED');
  assertEq(report.publisherIdentity.status, 'NOT_ESTABLISHED_OFFLINE', 'publisher identity is explicitly not established');
  assert(/does NOT prove who/i.test(report.publisherIdentity.note), 'the identity note is explicit that identity is not proven');
  assertEq(report.attestation.status, 'DECLARED_NOT_VERIFIED_OFFLINE', 'attestation is declared, not verified offline');
  assertEq(report.attestation.imageProvenance, 'declared-by-ci', 'provenance is declared by CI');
  assertEq(report.attestation.imageSbom, 'declared-by-ci', 'an SBOM attestation is declared by CI');
  assert(/integrity, NOT about who/i.test(report.outcomeMeaning), 'the outcome meaning separates integrity from identity');
});

test('the packet describes the exact coordinates and carries copy-paste commands for all three platforms', () => {
  assertEq(genuinePacket.archive.sha256, genuineArchive.sha256, 'the packet carries the real archive digest');
  assertEq(genuinePacket.archive.bytes, genuineArchive.bytes.length, 'the packet carries the real archive size');
  assertEq(genuinePacket.release.version, TAG, 'the packet names the release version');
  assertEq(genuinePacket.release.imageRef, genuineBundle.imageRef, 'the packet names the image ref');
  assert(genuinePacket.verify.linux.some((c) => c.includes('sha256sum')), 'Linux gets sha256sum');
  assert(genuinePacket.verify.macos.some((c) => c.includes('shasum -a 256')), 'macOS gets shasum');
  assert(genuinePacket.verify.windows.some((c) => c.includes('Get-FileHash')), 'Windows gets Get-FileHash');
  assert(genuinePacket.verify.windows.some((c) => c.includes(genuineArchive.sha256)), 'Windows is told the expected digest to compare against');
  assert(genuinePacket.verify.attestationOnline.some((c) => c.includes('gh attestation verify')), 'online provenance verification is offered');
  assert(genuinePacket.verify.attestationOnline.some((c) => /require|network/i.test(c)), 'and is clearly marked as needing the network');
});

// ---------------------------------------------------------------------------------------------------------
// The software inventory (minimal SBOM): the production closure, from the lockfile, without build paths.
// ---------------------------------------------------------------------------------------------------------

test('the SBOM is the production closure — pg is in, dev-only typescript and embedded-postgres are out', () => {
  const inv = genuinePacket.inventory;
  const names = new Set(inv.runtimeDependencies.map((p) => p.name));
  assert(names.has('pg'), 'pg (a production dependency) is inventoried');
  assert(names.has('tsx'), 'tsx (the production runtime) is inventoried');
  assert(!names.has('typescript'), 'typescript (dev-only) is excluded, exactly as --omit=dev would');
  assert(!names.has('embedded-postgres'), 'embedded-postgres (dev-only) is excluded');
  assert(inv.dependencyCount === inv.runtimeDependencies.length, 'the count matches the list');
  assert(inv.dependencyCount >= 40, `the closure is the full production set, got ${inv.dependencyCount}`);
});

test('every inventoried package carries a version and an SRI integrity hash, and the base image is digest-pinned', () => {
  const inv = genuinePacket.inventory;
  for (const pkg of inv.runtimeDependencies) {
    assert(pkg.version.length > 0, `${pkg.name} has a version`);
    assert(pkg.integrity !== null && /^sha(?:512|256|384)-/.test(pkg.integrity), `${pkg.name} has an SRI integrity hash`);
  }
  assert(inv.baseImage !== null, 'the base image is recorded');
  assert(/^sha256:[0-9a-f]{64}$/.test(inv.baseImage!.digest), 'the base image is pinned by digest');
  assertEq(inv.imageLabels.title, 'catalog-authority-ops', 'the static OCI title label is captured');
  assertEq(inv.imageLabels.licenses, 'UNLICENSED', 'the static OCI licenses label is captured');
  assert(inv.imageLabels.version === undefined, 'the build-arg templated version label is NOT captured as a static fact');
});

test('the SBOM leaks no build-machine path and is deterministic across two builds', () => {
  const a = buildSoftwareInventory(read('package-lock.json'), read('Dockerfile.runtime'), APP);
  const b = buildSoftwareInventory(read('package-lock.json'), read('Dockerfile.runtime'), APP);
  assertEq(JSON.stringify(a), JSON.stringify(b), 'the same lockfile and Dockerfile produce an identical inventory');
  const rendered = JSON.stringify(a);
  assert(!/node_modules\//.test(rendered), 'no node_modules path leaks into the inventory');
  assert(!/[A-Za-z]:\\\\/.test(rendered), 'no Windows drive path leaks');
  assert(!/\/(home|root|Users|mnt)\//.test(rendered), 'no absolute host path leaks');
});

test('a malformed lockfile is a safe, explicit failure, not a silent empty SBOM', () => {
  let threw = false;
  try { buildSoftwareInventory('{ not json', read('Dockerfile.runtime'), APP); } catch { threw = true; }
  assert(threw, 'an unparseable lockfile throws rather than pretending there are zero dependencies');
});

// ---------------------------------------------------------------------------------------------------------
// Determinism and the packet self-digest.
// ---------------------------------------------------------------------------------------------------------

test('the packet is deterministic: same inputs, identical self-digest and identical body', () => {
  const again = buildVerificationPacket(packetInputs(genuineBundle, genuineArchive, { generatedAt: '2099-12-31T00:00:00.000Z' }));
  assertEq(again.selfDigest, genuinePacket.selfDigest, 'the self-digest is independent of the wall clock');
  const { generatedAt: _a, ...bodyA } = genuinePacket;
  const { generatedAt: _b, ...bodyB } = again;
  assertEq(JSON.stringify(bodyA), JSON.stringify(bodyB), 'the packet body is byte-identical across builds');
});

test('the packet self-digest is sensitive: editing any claim without recomputing is caught', () => {
  const tampered = { ...genuinePacket, archive: { ...genuinePacket.archive, sha256: 'f'.repeat(64) } };
  assert(!packetSelfDigestMatches(tampered), 'a doctored packet no longer matches its own self-digest');
  const report = verifyRelease({ packet: tampered, archiveBytes: genuineArchive.bytes }, { generatedAt: AT });
  assertEq(checkOf(report.checks, 'packet-self-digest').status, 'FAIL', 'the edited packet fails the self-digest check');
  assertEq(report.outcome, 'INVALID', 'and the overall outcome is INVALID');
});

// ---------------------------------------------------------------------------------------------------------
// Packet-only (no artifact) is UNVERIFIED — a skip is never a pass.
// ---------------------------------------------------------------------------------------------------------

test('verifying a packet with no archive is UNVERIFIED, never VERIFIED', () => {
  const report = verifyRelease({ packet: genuinePacket }, { generatedAt: AT });
  assertEq(report.outcome, 'UNVERIFIED', 'without the bytes, integrity is not claimed');
  assertEq(report.archive.recomputedSha256, null, 'nothing was recomputed');
  assertEq(checkOf(report.checks, 'archive-digest').status, 'UNVERIFIED', 'the archive-digest check is unverified');
  assertEq(checkOf(report.checks, 'packet-self-digest').status, 'PASS', 'but the packet self-consistency still holds');
});

// ---------------------------------------------------------------------------------------------------------
// The adversarial tamper corpus. Each mutation must drive the outcome to INVALID and the right check to FAIL.
// ---------------------------------------------------------------------------------------------------------

test('tamper: a single flipped byte in the archive is INVALID (archive-digest)', () => {
  const bytes = Buffer.from(genuineArchive.bytes);
  const idx = Math.floor(bytes.length / 2);
  bytes[idx] = (bytes[idx] ?? 0) ^ 0xff;
  const report = verifyRelease({ packet: genuinePacket, archiveBytes: bytes }, { generatedAt: AT });
  assertEq(report.outcome, 'INVALID', 'a flipped byte is rejected');
  assertEq(checkOf(report.checks, 'archive-digest').status, 'FAIL', 'the archive-digest check fails');
});

test('tamper: a truncated archive is INVALID', () => {
  const bytes = genuineArchive.bytes.subarray(0, genuineArchive.bytes.length - 32);
  const report = verifyRelease({ packet: genuinePacket, archiveBytes: bytes }, { generatedAt: AT });
  assertEq(report.outcome, 'INVALID', 'a truncated archive is rejected');
  assertEq(checkOf(report.checks, 'archive-digest').status, 'FAIL', 'the archive-digest check fails');
});

test('tamper: a file altered inside the archive is INVALID (bundle-contents), even if the outer digest is re-pinned', () => {
  const altered = genuineBundle.files.map((f) =>
    f.path === 'README.md' ? { path: f.path, contents: `${f.contents}\nmalicious footer\n` } : { path: f.path, contents: f.contents });
  const tamperedArchive = archiveFromFiles(altered);
  // The attacker re-pins the packet's OUTER digest to the tampered archive, but the per-file digests still
  // describe the genuine bundle. The per-file check must catch the swap the outer digest alone would not.
  const packet = buildVerificationPacket(packetInputs(genuineBundle, tamperedArchive));
  const report = verifyRelease({ packet, archiveBytes: tamperedArchive.bytes }, { generatedAt: AT });
  assertEq(checkOf(report.checks, 'archive-digest').status, 'PASS', 'the outer digest was re-pinned and matches');
  assertEq(checkOf(report.checks, 'bundle-contents').status, 'FAIL', 'but the altered file is caught');
  assertEq(report.outcome, 'INVALID', 'the release is INVALID');
});

test('tamper: an extra file smuggled into the archive is INVALID (bundle-contents)', () => {
  const withExtra = [...genuineBundle.files.map((f) => ({ path: f.path, contents: f.contents })), { path: 'EVIL.sh', contents: '#!/bin/sh\nrm -rf /\n' }];
  const tamperedArchive = archiveFromFiles(withExtra);
  const packet = buildVerificationPacket(packetInputs(genuineBundle, tamperedArchive));
  const report = verifyRelease({ packet, archiveBytes: tamperedArchive.bytes }, { generatedAt: AT });
  assertEq(checkOf(report.checks, 'bundle-contents').status, 'FAIL', 'a file in the archive but not in the packet is caught');
  assertEq(report.outcome, 'INVALID', 'the release is INVALID');
});

test('tamper: a file removed from the archive is INVALID (bundle-contents)', () => {
  const without = genuineBundle.files.filter((f) => f.path !== 'setup.sh').map((f) => ({ path: f.path, contents: f.contents }));
  const tamperedArchive = archiveFromFiles(without);
  const packet = buildVerificationPacket(packetInputs(genuineBundle, tamperedArchive));
  const report = verifyRelease({ packet, archiveBytes: tamperedArchive.bytes }, { generatedAt: AT });
  assertEq(checkOf(report.checks, 'bundle-contents').status, 'FAIL', 'a file the packet expects but the archive lacks is caught');
  assertEq(report.outcome, 'INVALID', 'the release is INVALID');
});

test('tamper: a doctored SHA256SUMS (a wrong digest line) is INVALID (bundle-checksums)', () => {
  // The bundle's own SHA256SUMS is edited so one line claims a digest its file does not have; the whole
  // bundle (archive + packet) is rebuilt self-consistently around the doctored file, so bundle-contents
  // passes. The verifier still recomputes SHA256SUMS against the real files, exactly as `sha256sum -c` does.
  const badBundle = mutateBundleFile(genuineBundle, 'SHA256SUMS', (text) =>
    text.replace(/^([0-9a-f]{64})(  README\.md)$/m, `${'0'.repeat(64)}$2`));
  const badArchive = buildConsumerReleaseArchive(badBundle);
  const packet = buildVerificationPacket(packetInputs(badBundle, badArchive));
  const report = verifyRelease({ packet, archiveBytes: badArchive.bytes }, { generatedAt: AT });
  assertEq(checkOf(report.checks, 'bundle-contents').status, 'PASS', 'the bundle is internally self-consistent about its own bytes');
  assertEq(checkOf(report.checks, 'bundle-checksums').status, 'FAIL', 'but SHA256SUMS does not verify against the real files');
  assertEq(report.outcome, 'INVALID', 'the release is INVALID');
});

test('tamper: a manifest whose version disagrees with the release is INVALID (manifest-consistency)', () => {
  const badBundle = mutateBundleFile(genuineBundle, 'bundle-manifest.json', (text) =>
    text.replace(/"version":\s*"v1\.0\.0"/, '"version": "v9.9.9"'));
  const badArchive = buildConsumerReleaseArchive(badBundle);
  const packet = buildVerificationPacket(packetInputs(badBundle, badArchive));
  const report = verifyRelease({ packet, archiveBytes: badArchive.bytes }, { generatedAt: AT });
  assertEq(checkOf(report.checks, 'bundle-contents').status, 'PASS', 'the manifest bytes match the packet');
  assertEq(checkOf(report.checks, 'manifest-consistency').status, 'FAIL', 'but the manifest version disagrees with the release');
  assertEq(report.outcome, 'INVALID', 'the release is INVALID');
});

test('tamper: a bundle repinned to a floating :latest tag is INVALID (manifest-consistency)', () => {
  const badBundle = mutateBundleFile(genuineBundle, 'docker-compose.yml', (text) =>
    text.replace(genuineBundle.imageRef, `${RELEASE_IMAGE_REPOSITORY}:latest`));
  const badArchive = buildConsumerReleaseArchive(badBundle);
  const packet = buildVerificationPacket(packetInputs(badBundle, badArchive));
  const report = verifyRelease({ packet, archiveBytes: badArchive.bytes }, { generatedAt: AT });
  assertEq(checkOf(report.checks, 'manifest-consistency').status, 'FAIL', 'a floating tag in the shipped Compose is caught');
  assertEq(report.outcome, 'INVALID', 'the release is INVALID');
});

test('tamper: swapping the archive for a different release is INVALID against the original packet', () => {
  const otherBundle = bundleFor('v2.0.0');
  const otherArchive = buildConsumerReleaseArchive(otherBundle);
  const report = verifyRelease({ packet: genuinePacket, archiveBytes: otherArchive.bytes }, { generatedAt: AT });
  assertEq(report.outcome, 'INVALID', 'a different release does not satisfy this packet');
  assertEq(checkOf(report.checks, 'archive-digest').status, 'FAIL', 'the digest does not match');
});

test('tamper: garbage that is not an archive at all is INVALID, not a crash', () => {
  const packet = buildVerificationPacket(packetInputs(genuineBundle, { ...genuineArchive, sha256: sha256Hex('garbage'), bytes: Buffer.from('garbage') }));
  const report = verifyRelease({ packet, archiveBytes: Buffer.from('garbage') }, { generatedAt: AT });
  assertEq(report.outcome, 'INVALID', 'unreadable bytes are INVALID');
  assertEq(checkOf(report.checks, 'bundle-contents').status, 'FAIL', 'extraction failure is a FAIL, handled not thrown');
});

// ---------------------------------------------------------------------------------------------------------
// Attestation wiring is structural and honest — it never gates the integrity outcome.
// ---------------------------------------------------------------------------------------------------------

test('attestation wiring is read structurally from the workflow: the real workflow declares provenance and sbom', () => {
  const wiring = detectAttestationWiring(read('.github/workflows/runtime-image.yml'));
  assertEq(wiring.imageProvenance, true, 'the publish job declares provenance: true');
  assertEq(wiring.imageSbom, true, 'the publish job declares sbom: true');
  const none = detectAttestationWiring('jobs:\n  build:\n    steps:\n      - run: echo no build-push here\n');
  assertEq(none.imageProvenance, false, 'a workflow without the build-push step declares no provenance');
  assertEq(none.imageSbom, false, 'and no sbom');
});

test('a release with no declared attestation is still VERIFIED for integrity — attestation is not a gate', () => {
  const packet = buildVerificationPacket(packetInputs(genuineBundle, genuineArchive, {
    workflowText: 'jobs:\n  publish:\n    steps:\n      - run: echo nothing\n',
  }));
  assertEq(packet.attestation.imageProvenance, 'not-declared', 'the packet honestly records no provenance');
  const report = verifyRelease({ packet, archiveBytes: genuineArchive.bytes }, { generatedAt: AT });
  assertEq(report.outcome, 'VERIFIED', 'integrity is still VERIFIED — the bytes match');
  assertEq(report.attestation.imageProvenance, 'not-declared', 'while the report still reports the absence honestly');
});

// ---------------------------------------------------------------------------------------------------------
// Redaction: the packet and the report are safe to paste anywhere; a leak refuses to print.
// ---------------------------------------------------------------------------------------------------------

test('the genuine packet and report render redaction-safe', () => {
  renderPacketJson(genuinePacket); // throws on any leak
  const report = verifyRelease({ packet: genuinePacket, archiveBytes: genuineArchive.bytes }, { generatedAt: AT });
  renderReportJson(report);
  renderReportText(report);
});

test('the redaction backstop refuses a private key, a token, a db password and host paths', () => {
  const leaks = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'ghp_0123456789abcdefghijALPHA',
    'postgres://user:supersecret@db:5432/app',
    '/home/clint/secret',
    'C:\\Users\\clint\\secret',
    '/mnt/user/media/Movies',
  ];
  for (const leak of leaks) {
    let threw = false;
    try { assertVerificationOutputIsRedactionSafe(`some output ${leak} more`); } catch (err) {
      threw = err instanceof ReleaseVerificationError;
    }
    assert(threw, `the backstop refuses ${leak}`);
  }
});

test('a packet carrying a secret in a field refuses to render', () => {
  const poisoned = { ...genuinePacket, identityNote: 'note ghp_0123456789abcdefghijALPHA leaked' };
  let threw = false;
  try { renderPacketJson(poisoned); } catch (err) { threw = err instanceof ReleaseVerificationError; }
  assert(threw, 'a poisoned packet is not printed');
});

// ---------------------------------------------------------------------------------------------------------
// Fixed exit codes and the CLI against the real checkout.
// ---------------------------------------------------------------------------------------------------------

test('the outcome exit codes are fixed and distinct', () => {
  assertEq(VERIFICATION_EXIT_CODES.VERIFIED, 0, 'VERIFIED is 0');
  assertEq(VERIFICATION_EXIT_CODES.UNVERIFIED, 20, 'UNVERIFIED is 20');
  assertEq(VERIFICATION_EXIT_CODES.INVALID, 21, 'INVALID is 21');
});

test('the CLI emits a packet, verifies the real archive VERIFIED, catches a tampered archive INVALID, and is UNVERIFIED packet-only', () => {
  const work = mkdtempSync(join(tmpdir(), 'phase251-cli-'));
  try {
    const cli = join(root, 'src/ops/release-verification-cli.ts');
    const bundleCli = join(root, 'src/ops/consumer-release-bundle-cli.ts');
    const commonArgs = ['--revision', 'a'.repeat(40), '--created', AT];
    const run = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', ...args], { cwd: root, encoding: 'utf8', timeout: 300000 });
      return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
    };

    // Assemble the real bundle + archive, then emit the packet with the SAME coordinates.
    const asm = run([bundleCli, '--out', join(work, 'bundle'), '--archive-dir', join(work, 'archive'), ...commonArgs]);
    assertEq(asm.status, 0, `assembly succeeds — ${asm.stderr}`);
    const emit = run([cli, '--emit-packet', '--archive-dir', join(work, 'archive'), ...commonArgs, '--generated-at', AT]);
    assertEq(emit.status, 0, `emit succeeds — ${emit.stderr}`);

    const archivePath = join(work, 'archive', `${releaseArchiveName(TAG)}`);
    const packetPath = `${archivePath}.verification.json`;
    assert(existsSync(packetPath), 'the packet was written next to the archive');

    const ok = run([cli, '--verify', '--archive', archivePath, '--packet', packetPath, '--generated-at', AT]);
    assertEq(ok.status, 0, `the real archive verifies VERIFIED (exit 0) — ${ok.stderr}`);
    assertEq(JSON.parse(ok.stdout).outcome, 'VERIFIED', 'and says so');

    const only = run([cli, '--verify', '--packet', packetPath, '--generated-at', AT]);
    assertEq(only.status, 20, `packet-only is UNVERIFIED (exit 20) — ${only.stderr}`);

    // Tamper the on-disk archive and re-verify.
    const bytes = readFileSync(archivePath);
    const idx = Math.floor(bytes.length / 2);
    bytes[idx] = (bytes[idx] ?? 0) ^ 0xff;
    writeFileSync(archivePath, bytes);
    const bad = run([cli, '--verify', '--archive', archivePath, '--packet', packetPath, '--generated-at', AT]);
    assertEq(bad.status, 21, `a tampered archive is INVALID (exit 21) — ${bad.stdout}`);
    assertEq(JSON.parse(bad.stdout).outcome, 'INVALID', 'and says so');
    assert(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(bad.stdout ?? ''), 'no secret in any output');
  } finally { rmSync(work, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------
// Docs, package wiring, and release-assembly / publishing-gate integration.
// ---------------------------------------------------------------------------------------------------------

test('the Phase 251 doc and package scripts are present and consistent', () => {
  assert(existsSync(join(root, 'docs/PHASE_251_RELEASE_VERIFICATION.md')), 'the Phase 251 doc exists');
  const doc = read('docs/PHASE_251_RELEASE_VERIFICATION.md');
  for (const required of ['Phase 251', 'ops:release-verification', 'VERIFIED', 'UNVERIFIED', 'INVALID', 'SBOM', 'provenance', 'identity', 'sha256sum', 'Get-FileHash', 'shasum']) {
    assert(doc.includes(required), `the doc mentions ${required}`);
  }
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['ops:release-verification'], 'tsx src/ops/release-verification-cli.ts', 'the ops script is wired');
  assertEq(pkg.scripts['test:release-verification'], 'tsx test/release-verification.ts', 'the test script is wired');
  assertEq(pkg.scripts['test:phase251-local'], 'tsx test/release-verification.ts', 'the phase251-local alias is wired');
});

test('release assembly emits and self-verifies the packet, and the publish gate attaches it', () => {
  const check = read('deploy/ci/release-bundle-check.sh');
  assert(check.includes('release-verification-cli.ts') || check.includes('ops:release-verification'), 'the bundle check emits the packet');
  assert(check.includes('--emit-packet'), 'the bundle check emits a packet');
  assert(check.includes('--verify'), 'and verifies the assembled archive against it');
  assert(check.includes('verification.json'), 'the packet asset is named');

  const upload = read('deploy/ci/release-asset-upload.sh');
  assert(upload.includes('verification.json'), 'the publish gate attaches the packet');
  assert(!/gh release create|gh release delete|git push|git tag/.test(upload), 'the upload still creates, deletes and pushes nothing');
});

test('the workflow suites job runs the Phase 251 local suite', () => {
  const wf = read('.github/workflows/runtime-image.yml');
  assert(wf.includes('test:phase251-local'), 'CI runs test:phase251-local before publishing');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
