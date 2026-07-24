import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUNDLE_NAME,
  RELEASE_IMAGE_TAG,
  buildConsumerReleaseArchive,
  buildConsumerReleaseBundle,
  ConsumerReleaseBundleError,
  type BundleImagePin,
} from './consumer-release-bundle.js';
import { RELEASE_REPOSITORY_OWNER, resolveImageRepository } from './release-coordinates.js';
import { assertReleaseConsistency } from './release-ref.js';
import {
  VERIFICATION_EXIT_CODES,
  ReleaseVerificationError,
  buildVerificationPacket,
  renderPacketJson,
  renderReportJson,
  renderReportText,
  verifyRelease,
  type VerificationPacket,
} from './release-verification.js';

// Phase 251 — `ops:release-verification`, the command that generates the verification packet and, given an
// archive and a packet, verifies a downloaded release offline.
//
//   npm run ops:release-verification -- --emit-packet --archive-dir dist/release-archive   # generate packet
//   npm run ops:release-verification -- --verify --archive <path.tar.gz> --packet <path.json>  # verify offline
//   npm run ops:release-verification -- --verify --packet <path.json>                       # packet only
//
// It contacts no network, uses no credential, and publishes/pushes/tags nothing. Emitting re-assembles the
// bundle and archive in memory from the SAME coordinates the release uses (deterministic), so the packet is a
// pure function of the checkout. Verifying reads bytes off disk and recomputes digests. Exit codes:
// 0 VERIFIED, 20 UNVERIFIED, 21 INVALID (verify); 0 on a successful emit; 2 usage; 3 a refused render.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function repoFile(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function currentRevision(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '0000000';
  }
}

function applicationIdentity(tag: string): { name: string; version: string } {
  const pkg = JSON.parse(repoFile('package.json')) as { name?: unknown };
  const name = typeof pkg.name === 'string' ? pkg.name : 'catalog-authority';
  return { name, version: tag };
}

function assembleForEmit(args: readonly string[]): VerificationPacket {
  const digest = valueAfter(args, '--digest');
  const repository = resolveImageRepository({
    owner: RELEASE_REPOSITORY_OWNER,
    ...(valueAfter(args, '--repository') === undefined ? {} : { override: valueAfter(args, '--repository') }),
  });
  const image: BundleImagePin = {
    repository,
    tag: valueAfter(args, '--tag') ?? RELEASE_IMAGE_TAG,
    ...(digest === undefined ? {} : { digest }),
  };
  const bundle = buildConsumerReleaseBundle({
    runtimeCompose: repoFile('docker-compose.runtime.yml'),
    setupBash: repoFile('deploy/local-runtime-setup.sh'),
    setupPowerShell: repoFile('deploy/local-runtime-setup.ps1'),
  }, {
    image,
    revision: valueAfter(args, '--revision') ?? currentRevision(),
    createdAt: valueAfter(args, '--created') ?? new Date().toISOString(),
  });
  const archive = buildConsumerReleaseArchive(bundle);
  // The same one-fact consistency the assembler asserts, so a packet is never built for a mislabelled asset.
  assertReleaseConsistency({
    tag: bundle.image.tag,
    bundleVersion: bundle.image.tag,
    archiveName: archive.filename,
    imageRef: bundle.imageRef,
  });
  return buildVerificationPacket({
    bundle,
    archive,
    lockfileText: repoFile('package-lock.json'),
    dockerfileText: repoFile('Dockerfile.runtime'),
    workflowText: repoFile('.github/workflows/runtime-image.yml'),
    application: applicationIdentity(bundle.image.tag),
    generatedAt: valueAfter(args, '--generated-at') ?? new Date().toISOString(),
  });
}

function emit(args: readonly string[]): number {
  let packet: VerificationPacket;
  try {
    packet = assembleForEmit(args);
  } catch (err) {
    console.error(err instanceof ConsumerReleaseBundleError ? err.message : `packet assembly failed safely: ${(err as Error).message}`);
    return 2;
  }

  const archiveDir = valueAfter(args, '--archive-dir');
  const explicitOut = valueAfter(args, '--out');
  const outPath = explicitOut !== undefined
    ? resolve(explicitOut)
    : archiveDir !== undefined
      ? join(resolve(archiveDir), `${packet.archive.name}.verification.json`)
      : undefined;

  let rendered: string;
  try {
    rendered = renderPacketJson(packet);
  } catch (err) {
    if (!(err instanceof ReleaseVerificationError)) throw err;
    console.error(`FAIL: ${err.message}. Nothing was written.`);
    return 3;
  }

  if (outPath === undefined) {
    process.stdout.write(rendered);
    return 0;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(rendered, 'utf8'));
  console.log(JSON.stringify({
    report: 'phase-251-verification-packet-emitted',
    packet: outPath,
    archive: packet.archive.name,
    archiveSha256: packet.archive.sha256,
    version: packet.release.version,
    imageRef: packet.release.imageRef,
    dependencyCount: packet.inventory.dependencyCount,
    provenance: packet.attestation.imageProvenance,
    sbom: packet.attestation.imageSbom,
    published: false,
  }, null, 2));
  return 0;
}

function verify(args: readonly string[]): number {
  const packetPath = valueAfter(args, '--packet');
  if (packetPath === undefined) { console.error('FAIL: --verify needs --packet <path.json>.'); return 2; }
  if (!existsSync(packetPath)) { console.error(`FAIL: no packet at ${packetPath}.`); return 2; }
  let packet: VerificationPacket;
  try {
    packet = JSON.parse(readFileSync(packetPath, 'utf8')) as VerificationPacket;
  } catch {
    console.error('FAIL: the packet is not valid JSON.');
    return 2;
  }
  if (packet.packet !== 'phase-251-release-verification-packet') {
    console.error('FAIL: that file is not a Phase 251 verification packet.');
    return 2;
  }

  const archivePath = valueAfter(args, '--archive');
  let archiveBytes: Buffer | undefined;
  if (archivePath !== undefined) {
    if (!existsSync(archivePath)) { console.error(`FAIL: no archive at ${archivePath}.`); return 2; }
    archiveBytes = readFileSync(archivePath);
  }

  const generatedAt = valueAfter(args, '--generated-at') ?? new Date().toISOString();
  const report = verifyRelease(
    archiveBytes === undefined ? { packet } : { packet, archiveBytes },
    { generatedAt },
  );

  try {
    console.log(args.includes('--text') ? renderReportText(report) : renderReportJson(report));
  } catch (err) {
    if (!(err instanceof ReleaseVerificationError)) throw err;
    console.error(`FAIL: ${err.message}. Nothing was printed.`);
    return 3;
  }
  return VERIFICATION_EXIT_CODES[report.outcome];
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || (!args.includes('--emit-packet') && !args.includes('--verify'))) {
    console.log('usage: ops:release-verification --emit-packet [--archive-dir <dir> | --out <path>] [--tag vX.Y.Z]');
    console.log('                                             [--digest sha256:…] [--repository r/o/n] [--revision <sha>] [--created <iso>]');
    console.log('       ops:release-verification --verify --packet <path.json> [--archive <path.tar.gz>] [--text]');
    console.log('');
    console.log('Generates the consumer verification packet, or verifies a downloaded release offline. No network,');
    console.log('no credential, publishes nothing. Verify outcomes: VERIFIED (0), UNVERIFIED (20), INVALID (21).');
    console.log('VERIFIED means the bytes match the packet — NOT a claim about who published them.');
    return args.includes('--help') ? 0 : 2;
  }
  return args.includes('--emit-packet') ? emit(args) : verify(args);
}

process.exit(main());
