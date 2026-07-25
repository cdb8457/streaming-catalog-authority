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
    why: 'Starts PostgreSQL, migrates the database, then starts the operator UI. The migration runs by itself, in that order, every time: there is no separate migrate command to remember, it is safe to repeat, and if it fails the UI is deliberately not started at all rather than served in front of a database it cannot use. The UI is published to 127.0.0.1 only, so it is reachable from this machine and not from your network.',
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
    why: 'Copy your Phase 231-240 artifact files into ./promotion-records/ on this machine. It is mounted read-only: the container can read them and cannot write, rename or delete anything there. Leaving it empty is a valid, permanent choice — the installation reports READY with no records loaded, which means the service works and nothing has been audited. It never means an audit passed.',
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
    why: 'Your secrets and your database are the two things an upgrade cannot regenerate. Copy ./secrets/ somewhere safe and dump the database. Do this BEFORE every upgrade, because an upgrade may migrate the schema and there are no down-migrations: this dump is the only way back to the previous schema.',
    commands: {
      posix: 'docker compose exec -T postgres pg_dump -U postgres catalog > ./catalog-backup.sql',
      windows: 'docker compose exec -T postgres pg_dump -U postgres catalog > .\\catalog-backup.sql',
    },
    firstRun: false,
  },
  {
    id: 'upgrade',
    title: 'Upgrade to a new release',
    why: 'Back up first, then edit CATALOG_AUTHORITY_IMAGE in .env to the new version tag or digest and bring the stack back up. Your secrets and artifacts are untouched by an image change; your database may be MIGRATED by the new version, automatically, before its UI starts. That is the step a backup exists for.',
    commands: {
      posix: 'docker compose down && docker compose up -d',
      windows: 'docker compose down; docker compose up -d',
    },
    firstRun: false,
  },
  {
    id: 'roll-back',
    title: 'Roll back to the previous release',
    why: 'Set CATALOG_AUTHORITY_IMAGE in .env back to the previous value and start again. It works because the pin is a version tag or a digest, never `latest`. THE LIMIT: rolling the image back does not roll data back, and there are no down-migrations. If the newer version migrated your database, the older image will refuse to serve against it — correctly, because it does not understand that schema. Restore the backup you took before the upgrade, then start the older image. Without that backup the rollback is not available, and no command in this product can synthesise one.',
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
  | 'version-mismatch'
  | 'migration-failed'
  | 'ready-no-records'
  | 'bind-source-not-found'
  | 'not-reachable-from-network';

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
  {
    id: 'migration-failed',
    symptom: '`docker compose up -d` reports that the `migrate` container exited non-zero, and the app container never starts.',
    likelyCause: 'The database setup step failed, so the stack refused to serve a UI in front of a database it cannot use. Its last line names one code: a bad or missing database secret, a database that never became reachable, or a schema left at a version this build does not accept.',
    fix: 'Read the migrate container\'s log — it prints a step code and a fixed sentence, never a password or a connection string. Fix what it names, then run `docker compose up -d` again. The step is idempotent: repeating it after a partial failure resumes rather than conflicts, and it never re-runs work that is already done.',
    commands: { posix: 'docker compose logs migrate', windows: 'docker compose logs migrate' },
  },
  {
    id: 'ready-no-records',
    symptom: 'Setup & Diagnostics says READY - NO RECORDS LOADED, and you expected READY.',
    likelyCause: 'Nothing is wrong. The service is installed and operational, and the promotion records folder is readable and empty. This is the normal state of a fresh install, and the permanent state of an install you never intend to load evidence into.',
    fix: 'Nothing, unless you meant to load evidence — in which case put your artifacts in the records folder and press Load everything again. Read the verdict literally: it says the service works and that no evidence has been read. It is not a passing audit, not an authorization, and not a result for any phase.',
    commands: null,
  },
  {
    id: 'bind-source-not-found',
    symptom: 'On Unraid, under Arcane or a similar launcher, the stack will not start and Docker reports a bind source path that does not exist — often one under /app/data that you never typed.',
    likelyCause: 'The launcher runs in a container and stores the project inside it, so a relative bind source resolves against the launcher\'s filesystem while the Docker daemon is looking at the host\'s. The two disagree about what the project directory is.',
    fix: 'Use the Arcane stack file (docker-compose.arcane.yml in the source repository) and set CATALOG_AUTHORITY_PROJECT_DIR to the project folder\'s absolute path ON THE UNRAID HOST, or bind-mount your host projects directory into the launcher at the same path and set its PROJECTS_DIRECTORY to match. That stack refuses to start with an explanatory message rather than guessing, so a config check tells you before Docker has to.',
    commands: {
      posix: 'docker compose -f docker-compose.arcane.yml config --quiet',
      windows: 'docker compose -f docker-compose.arcane.yml config --quiet',
    },
  },
  {
    id: 'not-reachable-from-network',
    symptom: 'The stack is running and healthy on the server, but the UI does not load from another machine on your network.',
    likelyCause: 'The UI is published to loopback, which means the server itself and no other machine. This is the default, and it is not a fault.',
    fix: 'Set OPERATOR_UI_BIND_ADDRESS to that server\'s LAN address and restart, understanding that this puts an operator interface on your network. If you would rather not, reach it over an SSH tunnel instead. Do not set it to 0.0.0.0 to make the problem go away: that publishes it on every interface the server has, including ones you were not thinking about.',
    commands: null,
  },
];

export function troubleshootingTable(): readonly TroubleshootingEntry[] {
  return TROUBLESHOOTING;
}
