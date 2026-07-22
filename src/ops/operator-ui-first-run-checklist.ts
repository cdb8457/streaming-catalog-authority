// Phase 246 — the first five minutes, for someone who is not a developer.
//
// The checklist is DATA rather than prose in a template, for two reasons. It is asserted by tests (a command
// that drifts from the script it names is a support ticket that reads "the docs are wrong"), and it is
// rendered into both an authenticated web page and a plain-text support report from one source, so the two
// cannot disagree about what the safe next action is.
//
// WHAT A COMMAND MAY CONTAIN. Bundle-relative shapes only: `./setup.sh`, `./secrets/operator_ui_token`,
// `docker compose up -d`. Never an absolute path, never a resolved host directory, never a database URL,
// never a token. The container genuinely does not know where on the host it was extracted, and that is a
// feature here — there is no real path available to leak into a page or a pasted issue.
//
// WHY BUNDLE-RELATIVE AND NOT REPOSITORY-RELATIVE. The audience is a person who downloaded a release, so the
// commands are the ones that work in an extracted bundle, where `docker-compose.yml` IS the runtime stack.
// A maintainer running from a checkout needs `-f docker-compose.runtime.yml` on every compose command, which
// is stated once rather than doubling every entry.

export type ChecklistStepId =
  | 'install-docker'
  | 'generate-secrets'
  | 'start-stack'
  | 'retrieve-token'
  | 'place-records'
  | 'refresh-ui'
  | 'back-up'
  | 'upgrade'
  | 'roll-back'
  | 'stop-stack';

export interface ChecklistCommands {
  /** Linux and macOS. */
  readonly posix: string;
  /** Windows PowerShell. */
  readonly windows: string;
}

export interface ChecklistStep {
  readonly id: ChecklistStepId;
  readonly title: string;
  readonly why: string;
  /** `null` where the step is an action outside a terminal, such as installing Docker. */
  readonly commands: ChecklistCommands | null;
  /** True for the steps that make a fresh install usable; the rest are lifecycle operations. */
  readonly firstRun: boolean;
}

export const REPOSITORY_COMPOSE_NOTE =
  'Running from a source checkout instead of an extracted bundle? Add `-f docker-compose.runtime.yml` to '
  + 'every `docker compose` command, and the setup scripts live under `./deploy/` as `local-runtime-setup.sh` '
  + 'and `local-runtime-setup.ps1`.';

export const TOKEN_HANDLING_NOTE =
  'The operator token is a file on your machine. It is never sent to anyone, never written to a URL, a '
  + 'cookie, browser storage, this page\'s HTML or the server log. Paste it into the Operator token box; it '
  + 'stays in that box for as long as the tab is open and is sent as a request header, nowhere else.';

const STEPS: readonly ChecklistStep[] = [
  {
    id: 'install-docker',
    title: 'Install Docker and start it',
    why: 'Docker Desktop on Windows or macOS; Docker Engine on Linux. Nothing else is required — no Node.js, no source checkout, no build.',
    commands: { posix: 'docker version', windows: 'docker version' },
    firstRun: true,
  },
  {
    id: 'generate-secrets',
    title: 'Generate the secret files and the records folder',
    why: 'Creates ./secrets/ (one file per secret, including your operator token) and an empty ./promotion-records/. Safe to re-run: it keeps every secret that already exists, so it cannot lock you out of a running stack.',
    commands: {
      posix: './setup.sh',
      windows: 'powershell -ExecutionPolicy Bypass -File .\\setup.ps1',
    },
    firstRun: true,
  },
  {
    id: 'start-stack',
    title: 'Start the stack',
    why: 'Starts PostgreSQL and the operator UI. The UI is published to 127.0.0.1 only, so it is reachable from this machine and not from your network.',
    commands: { posix: 'docker compose up -d', windows: 'docker compose up -d' },
    firstRun: true,
  },
  {
    id: 'retrieve-token',
    title: 'Read your operator token',
    why: 'The setup script printed it once. This reads the same file back. Keep it out of chat logs and screenshots.',
    commands: {
      posix: 'cat ./secrets/operator_ui_token',
      windows: 'Get-Content .\\secrets\\operator_ui_token',
    },
    firstRun: true,
  },
  {
    id: 'place-records',
    title: 'Put your chain artifacts in the records folder',
    why: 'Copy your Phase 231-240 artifact files into ./promotion-records/ on this machine. It is mounted read-only: the container can read them and cannot write, rename or delete anything there.',
    commands: {
      posix: 'cp /path/to/your/artifacts/*.json ./promotion-records/',
      windows: 'Copy-Item C:\\path\\to\\your\\artifacts\\*.json .\\promotion-records\\',
    },
    firstRun: true,
  },
  {
    id: 'refresh-ui',
    title: 'Reload the panel',
    why: 'The folder is read when you press Refresh, not when the container started, so new artifacts appear without a restart.',
    commands: null,
    firstRun: true,
  },
  {
    id: 'back-up',
    title: 'Back up before you change anything',
    why: 'Your secrets and your database are the two things an upgrade cannot regenerate. Copy ./secrets/ somewhere safe and dump the database volume.',
    commands: {
      posix: 'docker compose exec -T postgres pg_dump -U postgres catalog > ./catalog-backup.sql',
      windows: 'docker compose exec -T postgres pg_dump -U postgres catalog > .\\catalog-backup.sql',
    },
    firstRun: false,
  },
  {
    id: 'upgrade',
    title: 'Upgrade to a new release',
    why: 'Edit CATALOG_AUTHORITY_IMAGE in .env to the new version tag or digest, then bring the stack back up. Your secrets, database and artifacts are untouched by an image change.',
    commands: {
      posix: 'docker compose down && docker compose up -d',
      windows: 'docker compose down; docker compose up -d',
    },
    firstRun: false,
  },
  {
    id: 'roll-back',
    title: 'Roll back to the previous release',
    why: 'Set CATALOG_AUTHORITY_IMAGE in .env back to the previous value and start again. It works because the pin is a version tag or a digest, never `latest`. Rolling the image back does NOT roll data back: if a migration has run, restore your database backup first.',
    commands: {
      posix: 'docker compose down && docker compose up -d',
      windows: 'docker compose down; docker compose up -d',
    },
    firstRun: false,
  },
  {
    id: 'stop-stack',
    title: 'Stop the stack',
    why: 'Stops both containers. Your secrets, database volume and artifact folder all survive.',
    commands: { posix: 'docker compose down', windows: 'docker compose down' },
    firstRun: false,
  },
];

export function firstRunChecklist(): readonly ChecklistStep[] {
  return STEPS;
}

export type TroubleshootingId =
  | 'port-conflict'
  | 'docker-daemon-unavailable'
  | 'image-pull-denied'
  | 'postgres-unhealthy'
  | 'wrong-token'
  | 'records-folder-missing'
  | 'records-folder-unreadable'
  | 'records-malformed'
  | 'version-mismatch';

export interface TroubleshootingEntry {
  readonly id: TroubleshootingId;
  /** What the person actually sees. */
  readonly symptom: string;
  readonly likelyCause: string;
  /** The safe thing to do. Never destructive, never "delete the volume and start again". */
  readonly fix: string;
  readonly commands: ChecklistCommands | null;
}

const TROUBLESHOOTING: readonly TroubleshootingEntry[] = [
  {
    id: 'port-conflict',
    symptom: '`docker compose up -d` fails with "port is already allocated", or http://127.0.0.1:8099/ shows something that is not this UI.',
    likelyCause: 'Another program on this machine is already listening on port 8099.',
    fix: 'Set OPERATOR_UI_HOST_PORT in .env to a free port and start again. Only the host side moves; the container keeps 8099.',
    commands: { posix: 'docker compose down && docker compose up -d', windows: 'docker compose down; docker compose up -d' },
  },
  {
    id: 'docker-daemon-unavailable',
    symptom: '"Cannot connect to the Docker daemon", or "error during connect" on Windows.',
    likelyCause: 'Docker is installed but not running. On Windows and macOS, Docker Desktop must be started.',
    fix: 'Start Docker Desktop (or `systemctl start docker` on Linux), wait for it to report running, then start the stack again.',
    commands: { posix: 'docker version', windows: 'docker version' },
  },
  {
    id: 'image-pull-denied',
    symptom: '"denied", "manifest unknown" or "not found" while pulling the image.',
    likelyCause: 'The pinned image reference in .env names a tag or digest that does not exist, or a registry this machine cannot read.',
    fix: 'Check CATALOG_AUTHORITY_IMAGE in .env against the VERSION file shipped in this bundle. Do not switch it to `latest` to make the error go away — that replaces a precise failure with an unpredictable install.',
    commands: { posix: 'docker compose pull', windows: 'docker compose pull' },
  },
  {
    id: 'postgres-unhealthy',
    symptom: 'The UI starts but Setup & Diagnostics reports the database as unreachable, or Compose reports the postgres container as unhealthy.',
    likelyCause: 'PostgreSQL has not finished its first-boot initialisation, or its password file is missing or was regenerated while a volume already existed.',
    fix: 'Give it a minute and refresh. If it persists, check that ./secrets/postgres_password exists and was not replaced after the database volume was first created — the volume keeps the password it was initialised with.',
    commands: { posix: 'docker compose ps', windows: 'docker compose ps' },
  },
  {
    id: 'wrong-token',
    symptom: 'Every panel says the operator token is required, or the token box is rejected.',
    likelyCause: 'The pasted value is not the current contents of ./secrets/operator_ui_token — often a stale token, or one copied with a trailing space or a line break.',
    fix: 'Read the file again and paste it with no surrounding whitespace. A re-run of the setup script never regenerates an existing token, so the file is still the one the container is using.',
    commands: { posix: 'cat ./secrets/operator_ui_token', windows: 'Get-Content .\\secrets\\operator_ui_token' },
  },
  {
    id: 'records-folder-missing',
    symptom: 'The promotion panel says no artifacts are readable, and Setup & Diagnostics reports the records folder as missing.',
    likelyCause: 'The host folder named by PROMOTION_RECORDS_HOST_DIR does not exist, so Docker created an empty directory in its place or refused the mount.',
    fix: 'Create the folder next to your docker-compose.yml (or point PROMOTION_RECORDS_HOST_DIR at an existing one), then restart the stack so the mount is re-evaluated.',
    commands: {
      posix: 'mkdir -p ./promotion-records && docker compose up -d',
      windows: 'New-Item -ItemType Directory -Force .\\promotion-records; docker compose up -d',
    },
  },
  {
    id: 'records-folder-unreadable',
    symptom: 'Setup & Diagnostics reports the records folder as unreadable.',
    likelyCause: 'The folder exists but the container user cannot read it — usually restrictive permissions on Linux, or a drive that is not shared with Docker Desktop.',
    fix: 'Make the folder readable by others (`chmod o+rx`), or on Docker Desktop add its drive under Settings > Resources > File sharing, then restart the stack.',
    commands: { posix: 'chmod -R o+rX ./promotion-records', windows: 'docker compose restart app' },
  },
  {
    id: 'records-malformed',
    symptom: 'The promotion panel reports blockers about artifacts that cannot be parsed, or the chain does not hang together.',
    likelyCause: 'A file in the records folder is truncated, is not the artifact it is named as, or was edited by hand.',
    fix: 'Replace the named artifact with the original file from wherever it was produced. Nothing on this page edits, repairs or deletes a record, and the container cannot write to that folder.',
    commands: null,
  },
  {
    id: 'version-mismatch',
    symptom: 'Setup & Diagnostics reports the image and bundle versions as MISMATCH.',
    likelyCause: 'CATALOG_AUTHORITY_IMAGE in .env was changed without extracting the matching bundle, or a new bundle was extracted over an old .env that still pins the previous image.',
    fix: 'Decide which release you meant to run, then make both agree: extract that release\'s bundle and use its .env, or set CATALOG_AUTHORITY_IMAGE to the version recorded in this bundle\'s VERSION file.',
    commands: { posix: 'cat ./VERSION', windows: 'Get-Content .\\VERSION' },
  },
];

export function troubleshootingTable(): readonly TroubleshootingEntry[] {
  return TROUBLESHOOTING;
}
