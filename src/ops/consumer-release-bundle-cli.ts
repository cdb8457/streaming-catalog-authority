import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUNDLE_NAME,
  RELEASE_IMAGE_REPOSITORY,
  RELEASE_IMAGE_TAG,
  buildConsumerReleaseBundle,
  ConsumerReleaseBundleError,
  type BundleImagePin,
} from './consumer-release-bundle.js';

// Assembles the Phase 245 consumer install bundle from this checkout. Local and offline: it reads three
// files, writes a folder, and contacts nothing. It publishes nothing, tags nothing and pushes nothing —
// releasing is an explicit, gated CI action, not a side effect of building the thing being released.

function usage(): string {
  return [
    'usage: ops:consumer-release-bundle --out <dir> [--tag vX.Y.Z] [--digest sha256:…] [--revision <sha>] [--created <iso>]',
    '',
    `Assembles the ${BUNDLE_NAME} bundle: runtime Compose, both setup scripts, the image pin, version`,
    'metadata, checksums and install/upgrade/rollback instructions. The output needs Docker to run and',
    'nothing else — no Node.js, no checkout.',
    '',
    '--digest pins the image immutably and is what a release build passes; without it the bundle pins the',
    'version tag, which is honest but weaker. `latest` is refused.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function currentRevision(root: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '0000000';
  }
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }

  const out = valueAfter(args, '--out');
  if (out === undefined) { console.error(usage()); return 2; }

  const root = fileURLToPath(new URL('../..', import.meta.url));
  const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');
  const digest = valueAfter(args, '--digest');
  const image: BundleImagePin = {
    repository: valueAfter(args, '--repository') ?? RELEASE_IMAGE_REPOSITORY,
    tag: valueAfter(args, '--tag') ?? RELEASE_IMAGE_TAG,
    ...(digest === undefined ? {} : { digest }),
  };

  let bundle;
  try {
    bundle = buildConsumerReleaseBundle({
      runtimeCompose: read('docker-compose.runtime.yml'),
      setupBash: read('deploy/local-runtime-setup.sh'),
      setupPowerShell: read('deploy/local-runtime-setup.ps1'),
    }, {
      image,
      revision: valueAfter(args, '--revision') ?? currentRevision(root),
      createdAt: valueAfter(args, '--created') ?? new Date().toISOString(),
    });
  } catch (err) {
    console.error(err instanceof ConsumerReleaseBundleError ? err.message : 'bundle assembly failed safely');
    return 2;
  }

  const target = resolve(out);
  rmSync(target, { recursive: true, force: true });
  for (const file of bundle.files) {
    const path = join(target, file.path);
    mkdirSync(dirname(path), { recursive: true });
    // Explicit binary write: the bundle decided its own line endings, and a Windows checkout must not add
    // carriage returns to a shell script on the way out.
    writeFileSync(path, Buffer.from(file.contents, 'utf8'));
  }

  console.log(JSON.stringify({
    report: 'phase-245-consumer-release-bundle',
    bundle: bundle.name,
    version: bundle.image.tag,
    image: bundle.imageRef,
    digestPinned: bundle.image.digest !== undefined,
    sourceRevision: bundle.revision,
    createdAt: bundle.createdAt,
    outputDir: target,
    files: bundle.files.map((file) => file.path),
    published: false,
  }, null, 2));
  return 0;
}

process.exit(main());
