import { createHash } from 'node:crypto';
import { buildDeterministicArchive, type ArchiveEntry, type ArchiveResult } from './release-archive.js';
import {
  firstRunChecklist,
  troubleshootingTable,
  type ChecklistStep,
} from './operator-ui-first-run-checklist.js';
import { RELEASE_IMAGE_REPOSITORY as CANONICAL_IMAGE_REPOSITORY } from './release-coordinates.js';
import { releaseArchiveName } from './release-ref.js';

// Phase 245 — the distributable install bundle.
//
// What a person who wants to RUN this needs is small and does not include this repository: a Compose file
// that names a prebuilt image, one setup script per platform, the pin that says exactly which image, and
// instructions for upgrading and going back. That is the whole bundle. It contains no TypeScript, no
// package.json and no lockfile, because needing Node.js to install a Docker application would be a bug.
//
// The bundle is built by a pure function so its contents can be asserted without touching a filesystem, and
// so the same bytes are produced on Windows and Linux: every file is emitted LF-terminated regardless of how
// the checkout it was assembled from happens to be stored. A `.sh` with CRLF endings is not a script, it is
// a support ticket.

export class ConsumerReleaseBundleError extends Error {}

/**
 * The published image this release pins to. Never a moving tag, and never a namespace this repository does
 * not own — the repository is derived in one place (release-coordinates.ts) and read here.
 */
export const RELEASE_IMAGE_REPOSITORY = CANONICAL_IMAGE_REPOSITORY;
/**
 * The ACTIVE, NOT-YET-RELEASED tag. v1.1.2 (Phase 254) — consumer readiness: the Arcane install path is
 * actually IN the archive, a registry-unqualified local build is classified as local rather than malformed,
 * and a release must prove that a stranger with no credential can pull the image it pins.
 *
 * v1.0.0 and v1.1.0 are published, immutable and untouched: this constant selects what a NEW bundle pins,
 * and nothing in this repository rewrites, re-tags or overwrites an existing release. Rolling back to v1.1.0
 * remains exactly the documented `.env` edit, because that tag still resolves to the image it always did.
 */
export const RELEASE_IMAGE_TAG = 'v1.1.2';
export const RELEASE_IMAGE_REF = `${RELEASE_IMAGE_REPOSITORY}:${RELEASE_IMAGE_TAG}`;

/** The bundle root: the folder a user extracts and runs `docker compose up -d` in. */
export const BUNDLE_NAME = 'catalog-authority-operator-ui';

export const BUNDLE_MANIFEST_FILENAME = 'bundle-manifest.json';
export const BUNDLE_CHECKSUM_FILENAME = 'SHA256SUMS';

export interface BundleSources {
  /** docker-compose.runtime.yml, verbatim. */
  readonly runtimeCompose: string;
  /** deploy/local-runtime-setup.sh, verbatim. */
  readonly setupBash: string;
  /** deploy/local-runtime-setup.ps1, verbatim. */
  readonly setupPowerShell: string;
  /**
   * docker-compose.arcane.yml, verbatim.
   *
   * v1.1.2. v1.1.1 built an Arcane/Unraid install path and then shipped a bundle that did not contain it:
   * the archive held only the ordinary-computer stack, whose bind sources are RELATIVE — which is precisely
   * what breaks when a launcher relocates the project under its own `/app/data/projects`. So the one class of
   * user that release was written for downloaded an archive with no way to follow it, and the README told
   * them about a file that was not there. Shipping it is the fix.
   */
  readonly arcaneCompose: string;
  /** deploy/arcane-setup.sh, verbatim. */
  readonly arcaneSetupBash: string;
}

export interface BundleImagePin {
  readonly repository: string;
  readonly tag: string;
  /** `sha256:…` when the release has been built and its digest is known; absent before that. */
  readonly digest?: string;
}

export interface BundleOptions {
  readonly image: BundleImagePin;
  /** Source commit the bundle was assembled from. */
  readonly revision: string;
  /** ISO-8601 build timestamp. Passed in, never read from the clock, so a build is reproducible. */
  readonly createdAt: string;
}

export interface BundleFile {
  readonly path: string;
  readonly contents: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ConsumerReleaseBundle {
  readonly name: string;
  readonly image: BundleImagePin;
  readonly imageRef: string;
  readonly revision: string;
  readonly createdAt: string;
  readonly files: readonly BundleFile[];
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Traces of the machine a release was BUILT on, which must never reach the machine it is installed on.
 *
 * v1.1.2. This is separate from `SECRET_SHAPES` because it is a different kind of leak: not a credential, but
 * somebody's network and filesystem layout. The Arcane work came out of one specific Unraid server, and the
 * one thing a bundle must never carry is that server's identity — a LAN address a stranger's stack would try
 * to bind, a media library path that exists on nobody else's machine, or a project directory only one person
 * has. Checked against the ASSEMBLED bytes, so it holds however the sources were edited.
 */
const HOST_IDENTITY_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  // RFC1918 literals. A documentation example must use a documentation range (192.0.2.0/24), not a real LAN.
  [/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/, 'a private LAN address'],
  [/\/mnt\/user\/media\//, 'a media library path'],
  [/catalog-authority-v\d+\d*-test/, 'a particular test project directory'],
];

/**
 * Values that must never leave a maintainer's machine inside a bundle. This is checked against the ASSEMBLED
 * output rather than trusted of the inputs: the interesting failure is a maintainer whose ./secrets got
 * pulled in by a careless glob, not one who typed a password into the README.
 */
const SECRET_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  // A password that is a shell/PowerShell variable reference is a template, not a secret — the setup
  // scripts legitimately ship the URL they will later fill in.
  [/postgresql:\/\/[^\s:@/]+:(?!change-me|<)[^\s:@/$]{8,}@/, 'a database URL with a real password'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/, 'a base64-encoded 32-byte secret'],
  [/\bghp_[A-Za-z0-9]{20,}\b/, 'a GitHub token'],
];

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** One line ending, one trailing newline — whatever the checkout this was read from uses. */
function normalise(text: string): string {
  const lf = text.replace(/\r\n/g, '\n');
  return lf.endsWith('\n') ? lf : `${lf}\n`;
}

export function formatImageRef(image: BundleImagePin): string {
  return image.digest === undefined ? `${image.repository}:${image.tag}` : `${image.repository}@${image.digest}`;
}

function validateOptions(options: BundleOptions): void {
  const { image } = options;
  if (image.repository.trim() === '') throw new ConsumerReleaseBundleError('the image repository is required');
  if (image.tag === 'latest') throw new ConsumerReleaseBundleError('`latest` is not a release: pin a version tag');
  if (!TAG_PATTERN.test(image.tag)) throw new ConsumerReleaseBundleError(`not a version tag: ${image.tag}`);
  if (image.digest !== undefined && !DIGEST_PATTERN.test(image.digest)) {
    throw new ConsumerReleaseBundleError(`not a sha256 digest: ${image.digest}`);
  }
  if (!/^[0-9a-f]{7,40}$/.test(options.revision)) throw new ConsumerReleaseBundleError('revision must be a git commit sha');
  if (Number.isNaN(Date.parse(options.createdAt))) throw new ConsumerReleaseBundleError('createdAt must be an ISO-8601 timestamp');
}

function envFile(options: BundleOptions, imageRef: string): string {
  return [
    '# Generated by the release build. Docker Compose reads this file automatically.',
    '#',
    '# CATALOG_AUTHORITY_IMAGE is the exact image this bundle was tested against. Changing it changes what',
    '# you run; deleting it falls back to the version tag written into docker-compose.yml. It is never',
    '# `latest`, so `docker compose up -d` cannot quietly move you to a different build.',
    `CATALOG_AUTHORITY_IMAGE=${imageRef}`,
    '',
    '# The version THIS bundle is. Compose passes it into the container, which compares it against the',
    '# version baked into the image itself and reports a MISMATCH in Setup & Diagnostics if you change one',
    '# without the other. Editing this to silence a mismatch does not fix the mismatch.',
    `CATALOG_AUTHORITY_BUNDLE_VERSION=${options.image.tag}`,
    '',
    '# Where your Phase 231-240 chain artifacts live on THIS machine. Mounted read-only.',
    'PROMOTION_RECORDS_HOST_DIR=./promotion-records',
    '',
    '# The UI is published to loopback only. Change the bind address deliberately, and understand that any',
    '# other value exposes an operator interface to your network.',
    'OPERATOR_UI_BIND_ADDRESS=127.0.0.1',
    'OPERATOR_UI_HOST_PORT=8099',
  ].join('\n');
}

function envExample(imageRef: string, tag: string): string {
  return [
    '# Copy to .env and edit. The shipped .env already contains the pinned image for this release.',
    '#',
    '# The image to run. Use a version tag or, better, a digest:',
    `#   CATALOG_AUTHORITY_IMAGE=${imageRef}`,
    `#   CATALOG_AUTHORITY_IMAGE=${RELEASE_IMAGE_REPOSITORY}@sha256:<digest>`,
    '# Never `latest`.',
    `CATALOG_AUTHORITY_IMAGE=${imageRef}`,
    '',
    '# The version this bundle is. Keep it equal to the image above, or the UI will report a MISMATCH.',
    `CATALOG_AUTHORITY_BUNDLE_VERSION=${tag}`,
    '',
    '# Host folder holding your promotion record artifacts (mounted read-only into the container).',
    'PROMOTION_RECORDS_HOST_DIR=./promotion-records',
    '',
    '# Where the UI is published. 127.0.0.1 means "this machine only".',
    'OPERATOR_UI_BIND_ADDRESS=127.0.0.1',
    'OPERATOR_UI_HOST_PORT=8099',
    '',
    '# NO SECRETS BELONG IN THIS FILE. The setup script generates them into ./secrets/ as files, which',
    '# Compose mounts as Docker secrets. Nothing that is a secret is ever an environment variable here.',
  ].join('\n');
}

/**
 * The install instructions are GENERATED from the same checklist the operator UI renders.
 *
 * Written by hand they would be a second copy, and a second copy of a command is a command that is wrong in
 * one of the two places. The panel a stuck user reads and the README they read before they are stuck now
 * cannot disagree about what to type — a test asserts the README contains every shipped command verbatim.
 */
function stepMarkdown(step: ChecklistStep, index: number | null): string {
  const heading = index === null ? `### ${step.title}` : `${index}. **${step.title}**`;
  const body = index === null ? step.why : `\n   ${step.why}`;
  if (step.commands === null) return `${heading}${index === null ? `\n\n${step.why}` : body}\n`;
  const fence = (label: string, command: string): string =>
    index === null
      ? `\n**${label}**\n\n\`\`\`\n${command}\n\`\`\`\n`
      : `\n   **${label}**\n\n   \`\`\`\n   ${command}\n   \`\`\`\n`;
  const { posix, windows } = step.commands;
  // Most commands are `docker compose ...` and identical everywhere. Printing the same line twice under two
  // headings makes a reader look for the difference, and there isn't one.
  const commands = posix === windows
    ? fence('Any platform', posix)
    : `${fence('Linux or macOS', posix)}${fence('Windows (PowerShell)', windows)}`;
  return `${heading}${body}\n${commands}`;
}

function firstRunMarkdown(): string {
  const steps = firstRunChecklist();
  const numbered = steps.filter((step) => step.firstRun)
    .map((step, index) => stepMarkdown(step, index + 1)).join('\n');
  const rest = steps.filter((step) => !step.firstRun).map((step) => stepMarkdown(step, null)).join('\n');
  // A command reference, not a second explanation: the sections further down say WHY an upgrade works the
  // way it does, and repeating that here would give a reader two places to disagree with each other.
  return `${numbered}\n## Everyday commands\n\n${rest}`;
}

/** A pipe inside a cell would end the column early; nothing shipped has one, and this keeps it that way. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function troubleshootingMarkdown(): string {
  const rows = troubleshootingTable()
    .map((entry) => `| ${cell(entry.symptom)} | ${cell(entry.likelyCause)} | ${cell(entry.fix)} |`)
    .join('\n');
  return `| What you see | Likely cause | Do this |\n| --- | --- | --- |\n${rows}`;
}

function versionFile(options: BundleOptions, imageRef: string): string {
  return [
    `bundle: ${BUNDLE_NAME}`,
    `version: ${options.image.tag}`,
    `image: ${imageRef}`,
    `image_digest: ${options.image.digest ?? '(not pinned by digest in this build)'}`,
    `source_revision: ${options.revision}`,
    `built: ${options.createdAt}`,
  ].join('\n');
}

function readme(options: BundleOptions, imageRef: string): string {
  return `# Catalog Authority — operator UI

An authenticated, read-only web UI for your promotion record chain, on \`http://127.0.0.1:8099/\`.

Version \`${options.image.tag}\` — image \`${imageRef}\`.

You need **Docker** and nothing else. No source checkout, no Node.js, no build.

## Five minutes, start to finish

Extract this bundle to a folder you own, then work down this list. When you are done, open
<http://127.0.0.1:8099/>, paste your operator token, and press **Load everything** — the
**Setup & Diagnostics** panel tells you whether the installation is READY, what is still missing, and the
exact command for whatever is left.

${firstRunMarkdown()}
## When something is wrong

The **Setup & Diagnostics** panel names the component and the next command. This table covers the failures
that happen before you can see that panel.

${troubleshootingMarkdown()}

### Getting help

Run the diagnostics report and attach its output to your issue:

\`\`\`
docker compose exec app npm run ops:support-report
\`\`\`

It makes no live calls — it works while the database is down — and it contains no tokens, secret values,
file paths, URLs, record contents or anything identifying your machine. Add \`-- --text\` for a readable
version instead of JSON.

## Installing on Unraid, through Arcane or another launcher

Use \`docker-compose.arcane.yml\` instead of \`docker-compose.yml\`. It is in this bundle.

A launcher like Arcane runs in a container and stores your project inside it, under a path such as
\`/app/data/projects/<name>\`. Docker resolves a **relative** bind source against that project directory, and
the Docker daemon is on the Unraid host — so \`./secrets\` becomes a path the daemon cannot see, and the stack
fails to start naming a path you never typed. The ordinary \`docker-compose.yml\` above is relative by design,
because on an ordinary computer that is correct; on a relocating launcher it is the whole problem.

\`docker-compose.arcane.yml\` builds every mount from ONE required variable — the absolute path your project
folder has **on the Unraid host** — so nothing depends on whose filesystem is doing the resolving.

1. On the Unraid host, create the folder and its secrets:

   \`\`\`
   bash ./arcane-setup.sh /mnt/user/projects/catalog-authority
   \`\`\`

   Substitute your own path. Nothing here knows or assumes where your projects live, and the script refuses a
   relative path, a Windows path, or a path inside the launcher's own container.

2. Put both required variables in this project's \`.env\`:

   \`\`\`
   CATALOG_AUTHORITY_PROJECT_DIR=/mnt/user/projects/catalog-authority
   OPERATOR_UI_BIND_ADDRESS=<your Unraid server's LAN address>
   \`\`\`

   Neither has a default. A default project directory would start a second installation against a folder
   nobody chose and look entirely fine; a default bind address would be \`0.0.0.0\`, which publishes an
   operator interface on every interface the server has. \`127.0.0.1\` is a valid choice and means that server
   **only** — not your laptop, whatever address you type in a browser.

3. Check it before Docker has to, then start:

   \`\`\`
   docker compose -f docker-compose.arcane.yml config --quiet
   docker compose -f docker-compose.arcane.yml up -d
   \`\`\`

The better fix, if you would rather change the launcher than the stack, is to make the paths agree: bind-mount
your host projects directory into the launcher at the **same** path and point its \`PROJECTS_DIRECTORY\` at it.
That fixes every project you will ever run, not only this one. Both approaches work, and they compose.

## Where your token is

In \`./secrets/operator_ui_token\`, a plain file created by the setup script inside \`./secrets/\`, a directory
the setup script locks to you alone (mode 0700) — no other user on your machine can reach anything inside it.
It is mounted into the container as a Docker secret at \`/run/secrets/operator_ui_token\`; it is never an
environment variable, never in the Compose file, and never in a URL, a cookie or a log. (The secret files the
non-root app must read carry a read bit so the container can read them through the mount; the 0700 directory,
not the file bit, is what keeps them private on your machine.)

Lost it? \`cat ./secrets/operator_ui_token\` (PowerShell: \`Get-Content .\\secrets\\operator_ui_token\`).

Re-running the setup script is safe: it **keeps** every secret that already exists and never regenerates
one, so it cannot lock you out of a running stack.

## Where your records go

Put your chain artifacts in \`./promotion-records/\` (or point \`PROMOTION_RECORDS_HOST_DIR\` in \`.env\` at
another folder). It is mounted **read-only** — the container cannot write, rename or delete anything in it.

## Upgrading

The image is pinned in \`.env\`. An upgrade is a deliberate edit, never a surprise:

1. Read the release notes for the new version.
2. \`docker compose down\`
3. Edit \`CATALOG_AUTHORITY_IMAGE\` in \`.env\` to the new tag or digest — or extract the new bundle
   alongside this one and copy your \`secrets/\` and \`promotion-records/\` folders across.
4. \`docker compose up -d\`

Your secrets, database volume and artifact folder are untouched by an image change.

## Rolling back

Set \`CATALOG_AUTHORITY_IMAGE\` back to the previous value and \`docker compose up -d\`. That is the entire
rollback, and it works because the pin is a digest or an immutable version tag rather than \`latest\` — the
old image is still exactly the old image.

If a database migration has run and you need the previous schema, restore your database backup before
starting the older image. Rolling the image back does not roll data back.

## Verifying what you downloaded

\`\`\`bash
sha256sum -c ${BUNDLE_CHECKSUM_FILENAME}
\`\`\`

\`\`\`powershell
Get-FileHash -Algorithm SHA256 docker-compose.yml
\`\`\`

\`${BUNDLE_MANIFEST_FILENAME}\` records the same digests, plus the image and the source revision this bundle
was assembled from.

## What this does not do

It contacts no provider, media server or library. It performs no promotion, approval, execution, archival or
deletion. Every route except \`/healthz\` requires the operator token, and \`/healthz\` reveals no operational
data. The database is reachable only from the app container, never published to your network.
`;
}

function checksumFile(files: readonly BundleFile[]): string {
  return files.map((file) => `${file.sha256}  ${file.path}`).join('\n');
}

function toFile(path: string, contents: string): BundleFile {
  const normalised = normalise(contents);
  return { path, contents: normalised, sha256: sha256(normalised), bytes: Buffer.byteLength(normalised, 'utf8') };
}

function assertNoSecrets(files: readonly BundleFile[]): void {
  for (const file of files) {
    for (const [pattern, what] of SECRET_SHAPES) {
      if (pattern.test(file.contents)) {
        throw new ConsumerReleaseBundleError(`refusing to ship ${file.path}: it contains what looks like ${what}`);
      }
    }
    for (const [pattern, what] of HOST_IDENTITY_SHAPES) {
      if (pattern.test(file.contents)) {
        throw new ConsumerReleaseBundleError(`refusing to ship ${file.path}: it contains ${what} from the machine this was built on`);
      }
    }
  }
}

/**
 * Assemble the bundle. Pure: same inputs, same bytes, no clock, no filesystem, no network.
 *
 * The result is ordered, and the last two entries are the manifest and the checksum file, in that order —
 * the manifest covers the content files, and SHA256SUMS covers everything except itself.
 */
export function buildConsumerReleaseBundle(sources: BundleSources, options: BundleOptions): ConsumerReleaseBundle {
  validateOptions(options);
  const imageRef = formatImageRef(options.image);

  const content: BundleFile[] = [
    toFile('README.md', readme(options, imageRef)),
    toFile('docker-compose.yml', sources.runtimeCompose),
    toFile('setup.sh', sources.setupBash),
    toFile('setup.ps1', sources.setupPowerShell),
    // The Arcane/Unraid path, shipped under the SAME names a checkout uses. A launcher user who reads the
    // project's documentation finds the file the documentation names, in the archive they downloaded.
    toFile('docker-compose.arcane.yml', sources.arcaneCompose),
    toFile('arcane-setup.sh', sources.arcaneSetupBash),
    toFile('.env', envFile(options, imageRef)),
    toFile('.env.example', envExample(imageRef, options.image.tag)),
    toFile('VERSION', versionFile(options, imageRef)),
  ];

  if (!content.some((file) => file.path === 'docker-compose.yml' && file.contents.includes('CATALOG_AUTHORITY_IMAGE'))) {
    throw new ConsumerReleaseBundleError('the shipped Compose file does not read CATALOG_AUTHORITY_IMAGE, so the pin would do nothing');
  }
  if (content.some((file) => file.path === 'docker-compose.yml' && /^\s*build:/m.test(file.contents))) {
    throw new ConsumerReleaseBundleError('the shipped Compose file builds from source, which a bundle cannot do');
  }

  // ---------------------------------------------------------------------------------------------------------
  // The Arcane stack, held to the properties that make it usable by a launcher user rather than by us.
  // ---------------------------------------------------------------------------------------------------------
  const arcane = content.find((file) => file.path === 'docker-compose.arcane.yml')?.contents ?? '';
  if (/^\s*build:/m.test(arcane)) {
    throw new ConsumerReleaseBundleError('the shipped Arcane Compose builds from source, which a bundle cannot do');
  }
  if (!arcane.includes('CATALOG_AUTHORITY_IMAGE')) {
    throw new ConsumerReleaseBundleError('the shipped Arcane Compose does not read CATALOG_AUTHORITY_IMAGE, so the pin would do nothing');
  }
  // RELATIVE BIND SOURCES ARE THE WHOLE BUG. A launcher resolves them against a project directory inside its
  // own container, so `./secrets` becomes a path the Docker daemon cannot see. Every source in this file must
  // be built from the declared absolute host path instead.
  if (/^\s*-\s*\.{1,2}\//m.test(arcane)) {
    throw new ConsumerReleaseBundleError('the shipped Arcane Compose has a relative bind source, which is exactly what a launcher relocation breaks');
  }
  // And the required host-project variable must stay REQUIRED. A default would start the wrong installation
  // against a directory nobody chose, generate a second set of secrets, and look entirely fine.
  if (/\$\{CATALOG_AUTHORITY_PROJECT_DIR:-/.test(arcane) || !/\$\{CATALOG_AUTHORITY_PROJECT_DIR:\?/.test(arcane)) {
    throw new ConsumerReleaseBundleError('the shipped Arcane Compose must REQUIRE CATALOG_AUTHORITY_PROJECT_DIR, never default it');
  }

  const manifest = toFile(BUNDLE_MANIFEST_FILENAME, `${JSON.stringify({
    bundle: BUNDLE_NAME,
    version: options.image.tag,
    image: {
      repository: options.image.repository,
      tag: options.image.tag,
      digest: options.image.digest ?? null,
      ref: imageRef,
    },
    sourceRevision: options.revision,
    createdAt: options.createdAt,
    requires: ['docker'],
    files: content.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
  }, null, 2)}\n`);

  const withManifest = [...content, manifest];
  const checksums = toFile(BUNDLE_CHECKSUM_FILENAME, checksumFile(withManifest));
  const files = [...withManifest, checksums];
  assertNoSecrets(files);
  if (!/^\S+\/\S+\/\S+$/.test(imageRef.split('@')[0]!.split(':')[0]!)) {
    throw new ConsumerReleaseBundleError(`the pinned image is not a registry-qualified reference: ${imageRef}`);
  }
  return {
    name: BUNDLE_NAME,
    image: options.image,
    imageRef,
    revision: options.revision,
    createdAt: options.createdAt,
    files,
  };
}

/**
 * The consumer download: the verified bundle, and only the verified bundle, as one deterministic archive.
 *
 * Nothing is added on the way in — the archive's entries are exactly the files `buildConsumerReleaseBundle`
 * produced and its own checksum file already covers, so "what was checked" and "what was published" are the
 * same set. The scripts a user runs keep their executable bit; nothing else does.
 */
export function buildConsumerReleaseArchive(bundle: ConsumerReleaseBundle): ArchiveResult {
  const entries: ArchiveEntry[] = bundle.files.map((file) => ({
    path: file.path,
    contents: file.contents,
    executable: file.path.endsWith('.sh'),
  }));
  return buildDeterministicArchive(`${BUNDLE_NAME}-${bundle.image.tag}`, entries, releaseArchiveName(bundle.image.tag));
}
