import { accessSync, constants as fsConstants, statSync } from 'node:fs';

// Phase 253 — installing this under Arcane on Unraid, honestly.
//
// WHAT WENT WRONG ON A REAL MACHINE. Arcane runs in a container. A Compose project it manages is stored at a
// path INSIDE that container — `/app/data/projects/<name>` by default — and a relative bind source in a
// Compose file is resolved against the project directory. So `./secrets/postgres_password` in a project
// Arcane created resolved to `/app/data/projects/<name>/secrets/postgres_password`, a path that exists in
// Arcane's filesystem and not on Unraid. The Docker daemon, which is on the HOST, was then asked to bind a
// source that does not exist from where it is standing, and refused. The stack could not start, and the error
// named a path the operator had never typed.
//
// THERE ARE EXACTLY TWO HONEST FIXES AND THIS FILE SUPPORTS BOTH.
//
//   1. MAKE THE PATHS AGREE. Arcane's own recommendation: bind-mount the host projects directory into the
//      Arcane container at the SAME path, and set PROJECTS_DIRECTORY to it. Then a project directory means
//      the same thing to Arcane and to the daemon, and relative sources resolve identically. This is the
//      better fix because it fixes every project, not just this one.
//
//   2. NAME THE HOST PATH ABSOLUTELY. `docker-compose.arcane.yml` takes ONE required variable — the absolute
//      HOST path of this project's directory — and every bind source is built from it. Nothing is relative,
//      so nothing depends on whose filesystem is doing the resolving.
//
// WHAT THIS FILE REFUSES TO DO. It does not guess a path, does not fall back to a default when the variable
// is unset, and does not carry any particular machine's path or address as a constant. A default here would
// reintroduce the whole bug in a quieter form: a stack that starts against the wrong directory, generates a
// second set of secrets, initialises a second database, and looks fine.
//
// EVERYTHING IS CATEGORICAL. A finding is a code and a fixed sentence. Operator-supplied values — the path,
// the bind address — are echoed ONLY in the one place echoing them is the entire point: the CLI's own
// terminal output, to the operator who just typed them. They never reach a log buffer, a web page, an API
// response or a support report.

export class ArcaneInstallError extends Error {
  readonly code = 'ARCANE_INSTALL_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'ArcaneInstallError';
  }
}

/** The one required variable. An absolute HOST path to this project's directory. */
export const ARCANE_PROJECT_DIR_ENV = 'CATALOG_AUTHORITY_PROJECT_DIR';
/** The interface the operator UI is published on. Required under Arcane: there is no safe default. */
export const ARCANE_BIND_ADDRESS_ENV = 'OPERATOR_UI_BIND_ADDRESS';
export const ARCANE_HOST_PORT_ENV = 'OPERATOR_UI_HOST_PORT';

export const ARCANE_PROJECT_DIR_MAX_LENGTH = 512;

/** The subdirectories the stack binds out of the project directory. */
export const ARCANE_REQUIRED_SUBDIRECTORIES: readonly string[] = ['secrets', 'promotion-records'];

/** The secret files the stack mounts. Names only; contents are never read by anything here. */
export const ARCANE_REQUIRED_SECRET_FILES: readonly string[] = [
  'postgres_password', 'admin_database_url', 'database_url', 'completion_secret', 'custodian_kek',
  'operator_ui_token',
];

export type ArcaneFindingCode =
  | 'PROJECT_DIR_UNSET'
  | 'PROJECT_DIR_NOT_ABSOLUTE'
  | 'PROJECT_DIR_NOT_POSIX'
  | 'PROJECT_DIR_TRAVERSAL'
  | 'PROJECT_DIR_TOO_LONG'
  | 'PROJECT_DIR_LOOKS_CONTAINER_INTERNAL'
  | 'PROJECT_DIR_MISSING'
  | 'PROJECT_DIR_NOT_A_DIRECTORY'
  | 'PROJECT_DIR_UNREADABLE'
  | 'SUBDIRECTORY_MISSING'
  | 'SECRET_FILE_MISSING'
  | 'BIND_ADDRESS_UNSET'
  | 'BIND_ADDRESS_WILDCARD'
  | 'BIND_ADDRESS_NOT_AN_ADDRESS'
  | 'BIND_ADDRESS_LOOPBACK_NOT_REMOTE'
  | 'HOST_PORT_INVALID';

export type ArcaneFindingSeverity = 'BLOCKER' | 'ADVISORY';

export interface ArcaneFinding {
  readonly code: ArcaneFindingCode;
  readonly severity: ArcaneFindingSeverity;
  /** A fixed sentence. Never interpolated with an operator value. */
  readonly detail: string;
  /** The fixed sentence saying what to do about it. */
  readonly fix: string;
}

const FINDINGS: Record<ArcaneFindingCode, { severity: ArcaneFindingSeverity; detail: string; fix: string }> = {
  PROJECT_DIR_UNSET: {
    severity: 'BLOCKER',
    detail: `${ARCANE_PROJECT_DIR_ENV} is not set, so every bind source in this stack would be relative.`,
    fix: `Set ${ARCANE_PROJECT_DIR_ENV} to the ABSOLUTE path this project's folder has on the Unraid host — the path Unraid shows you, not the path Arcane shows you. There is deliberately no default: guessing it is how a stack silently starts against the wrong directory.`,
  },
  PROJECT_DIR_NOT_ABSOLUTE: {
    severity: 'BLOCKER',
    detail: `${ARCANE_PROJECT_DIR_ENV} is not an absolute path.`,
    fix: 'Use a path beginning with `/`. A relative path is resolved by whoever reads it, and under Arcane that is not the machine the Docker daemon is on — which is the whole failure this variable exists to prevent.',
  },
  PROJECT_DIR_NOT_POSIX: {
    severity: 'BLOCKER',
    detail: `${ARCANE_PROJECT_DIR_ENV} is not a POSIX path.`,
    fix: 'Use forward slashes and no drive letter. This value is a path on the Unraid host, which is Linux, whatever machine you happen to be typing it from.',
  },
  PROJECT_DIR_TRAVERSAL: {
    severity: 'BLOCKER',
    detail: `${ARCANE_PROJECT_DIR_ENV} contains a traversal or empty segment.`,
    fix: 'Write the path out in full, with no `.` or `..` segment and no doubled slash.',
  },
  PROJECT_DIR_TOO_LONG: {
    severity: 'BLOCKER',
    detail: `${ARCANE_PROJECT_DIR_ENV} is longer than this stack will accept.`,
    fix: 'Move the project somewhere with a shorter path.',
  },
  PROJECT_DIR_LOOKS_CONTAINER_INTERNAL: {
    severity: 'BLOCKER',
    detail: `${ARCANE_PROJECT_DIR_ENV} looks like a path inside the Arcane container rather than on the Unraid host.`,
    fix: 'Arcane stores projects under its own `/app/data/projects` by default, and the Docker daemon cannot see that path. Either give the host path this project really has (what Unraid shows under Shares), or bind-mount the host projects directory into Arcane at the SAME path and set Arcane\'s PROJECTS_DIRECTORY to it, which makes both spellings agree for every project.',
  },
  PROJECT_DIR_MISSING: {
    severity: 'BLOCKER',
    detail: 'The project directory does not exist at the path given.',
    fix: 'Create it on the Unraid host first, then re-run. Docker would otherwise be asked to bind a source that is not there, and refuse the whole stack with an error naming a path you never typed.',
  },
  PROJECT_DIR_NOT_A_DIRECTORY: {
    severity: 'BLOCKER',
    detail: 'The path given exists but is not a directory.',
    fix: 'Point the variable at the project folder itself.',
  },
  PROJECT_DIR_UNREADABLE: {
    severity: 'BLOCKER',
    detail: 'The project directory exists but cannot be read from here.',
    fix: 'Check its permissions on the Unraid host.',
  },
  SUBDIRECTORY_MISSING: {
    severity: 'BLOCKER',
    detail: 'A directory this stack binds is missing from the project directory.',
    fix: 'Run `deploy/arcane-setup.sh` against the project directory. It creates the folders and the secrets, and it keeps every secret that already exists.',
  },
  SECRET_FILE_MISSING: {
    severity: 'BLOCKER',
    detail: 'A secret file this stack mounts is missing.',
    fix: 'Run `deploy/arcane-setup.sh` against the project directory. Docker bind-mounts a missing secret source as a DIRECTORY, which the container then cannot read as a file — so a missing secret does not fail loudly, it fails confusingly.',
  },
  BIND_ADDRESS_UNSET: {
    severity: 'BLOCKER',
    detail: `${ARCANE_BIND_ADDRESS_ENV} is not set, so the operator UI would be published on every interface.`,
    fix: 'Set it to ONE specific address. On Unraid that is normally the server\'s own LAN address, so the UI is reachable from your network and from nowhere else. This stack does not default to 0.0.0.0: publishing an operator interface on every interface is a decision, not a default.',
  },
  BIND_ADDRESS_WILDCARD: {
    severity: 'BLOCKER',
    detail: `${ARCANE_BIND_ADDRESS_ENV} is a wildcard address, which publishes the operator UI on every interface this server has.`,
    fix: 'Name the one interface you mean — normally the server\'s LAN address. If you genuinely want every interface, that belongs in your own Compose override where it is visible, not in the shipped default.',
  },
  BIND_ADDRESS_NOT_AN_ADDRESS: {
    severity: 'BLOCKER',
    detail: `${ARCANE_BIND_ADDRESS_ENV} is not an IP address literal.`,
    fix: 'Use an address, not a hostname. Docker publishes to an address, and a name that resolves differently later would move where this UI is reachable from without anyone changing anything.',
  },
  BIND_ADDRESS_LOOPBACK_NOT_REMOTE: {
    severity: 'ADVISORY',
    detail: 'The operator UI is published on loopback, so it is reachable from the Unraid server itself and from no other machine.',
    fix: 'This is a safe choice and it is NOT remotely reachable — not from your laptop, and not from another machine on your LAN, whatever address you type in a browser. Reach it with an SSH tunnel, or set the bind address to the server\'s LAN address if you want it on your network.',
  },
  HOST_PORT_INVALID: {
    severity: 'BLOCKER',
    detail: `${ARCANE_HOST_PORT_ENV} is not a usable TCP port.`,
    fix: 'Use a number between 1024 and 65535 that nothing else on this server is listening on.',
  },
};

function finding(code: ArcaneFindingCode): ArcaneFinding {
  const entry = FINDINGS[code];
  return { code, severity: entry.severity, detail: entry.detail, fix: entry.fix };
}

export interface ArcaneInstallInput {
  readonly projectDir: string | undefined;
  readonly bindAddress: string | undefined;
  readonly hostPort: string | undefined;
  /** What the filesystem says. Supplied so the derivation is pure and every case is testable. */
  readonly filesystem: ArcaneFilesystemFacts | null;
}

export interface ArcaneFilesystemFacts {
  readonly projectDir: 'OK' | 'MISSING' | 'NOT_A_DIRECTORY' | 'UNREADABLE';
  /** Subdirectory name -> present. Only consulted when `projectDir` is OK. */
  readonly subdirectories: Readonly<Record<string, boolean>>;
  /** Secret file name -> present as a regular file. Only consulted when `projectDir` is OK. */
  readonly secretFiles: Readonly<Record<string, boolean>>;
}

export interface ArcaneInstallReadiness {
  readonly ok: boolean;
  readonly report: 'phase-253-arcane-install';
  readonly findings: readonly ArcaneFinding[];
  /** Said out loud: a startable stack is not an authorization and not an audit result. */
  readonly promotionAuthorization: 'NOT_IMPLIED';
  readonly note: string;
}

const READINESS_NOTE =
  'This checks only that the Arcane/Unraid stack can START: that its paths resolve on the host the Docker '
  + 'daemon runs on, that the files it mounts exist, and that it is published where you meant. It reads no '
  + 'promotion record, contacts no provider, media server or library, and says nothing about whether any '
  + 'promotion may proceed.';

/**
 * Structural checks on the project directory, with NO filesystem access.
 *
 * Split out because the interesting failures — a Windows path, a container-internal path, a traversal — are
 * decidable from the string alone, and a caller (a test, a Compose-config check, a machine that is not the
 * Unraid server) should be able to reach them without a real directory to point at.
 */
export function inspectArcaneProjectDir(raw: string | undefined): readonly ArcaneFinding[] {
  if (raw === undefined || raw.trim() === '') return [finding('PROJECT_DIR_UNSET')];
  const value = raw.trim();
  if (value.length > ARCANE_PROJECT_DIR_MAX_LENGTH) return [finding('PROJECT_DIR_TOO_LONG')];
  // A drive letter or a backslash means someone typed a Windows path for a Linux host. Checked before
  // absoluteness, because `C:\x` is "absolute" in the wrong universe.
  if (/^[A-Za-z]:/.test(value) || value.includes('\\')) return [finding('PROJECT_DIR_NOT_POSIX')];
  if (value.includes('\0')) return [finding('PROJECT_DIR_TRAVERSAL')];
  if (!value.startsWith('/')) return [finding('PROJECT_DIR_NOT_ABSOLUTE')];
  const path = value.replace(/\/+$/, '');
  if (path === '') return [finding('PROJECT_DIR_NOT_ABSOLUTE')];
  const segments = path.split('/');
  for (const [index, segment] of segments.entries()) {
    if (segment === '.' || segment === '..') return [finding('PROJECT_DIR_TRAVERSAL')];
    if (segment === '' && index !== 0) return [finding('PROJECT_DIR_TRAVERSAL')];
  }
  // The exact shape the real failure had. Arcane's default project store is inside its own container, and a
  // path under it is never a host path — recognising it turns a baffling bind-source error into a sentence
  // that names the actual mistake.
  if (/^\/app\/data(?:\/|$)/.test(path)) return [finding('PROJECT_DIR_LOOKS_CONTAINER_INTERNAL')];
  return [];
}

/** IPv4 dotted quad or a bracket-free IPv6 literal. Deliberately not a hostname. */
function isIpLiteral(value: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) <= 255 && String(Number(part)) === part.replace(/^0(?=\d)/, ''));
  }
  // Good enough to separate an address from a name without re-implementing RFC 4291: hex groups and colons,
  // at least one colon, nothing else.
  return /^[0-9a-fA-F:]+$/.test(value) && value.includes(':');
}

export function inspectArcaneBindAddress(raw: string | undefined): readonly ArcaneFinding[] {
  if (raw === undefined || raw.trim() === '') return [finding('BIND_ADDRESS_UNSET')];
  const value = raw.trim();
  if (value === '0.0.0.0' || value === '::' || value === '*') return [finding('BIND_ADDRESS_WILDCARD')];
  if (!isIpLiteral(value)) return [finding('BIND_ADDRESS_NOT_AN_ADDRESS')];
  // Loopback is ALLOWED and is a perfectly good answer; what it is not is remotely reachable, and the
  // advisory says so rather than letting anyone discover it from a browser that will not connect.
  if (value === '127.0.0.1' || value.startsWith('127.') || value === '::1') {
    return [finding('BIND_ADDRESS_LOOPBACK_NOT_REMOTE')];
  }
  return [];
}

export function inspectArcaneHostPort(raw: string | undefined): readonly ArcaneFinding[] {
  if (raw === undefined || raw.trim() === '') return []; // the Compose default applies
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return [finding('HOST_PORT_INVALID')];
  const port = Number(value);
  if (port < 1024 || port > 65535) return [finding('HOST_PORT_INVALID')];
  return [];
}

/** Turn the facts into a verdict. Pure: no filesystem, no environment, no clock. */
export function deriveArcaneInstallReadiness(input: ArcaneInstallInput): ArcaneInstallReadiness {
  const findings: ArcaneFinding[] = [...inspectArcaneProjectDir(input.projectDir)];

  // Only look at the filesystem when the path itself is sound. Reporting "the directory is missing" about a
  // path that is malformed sends an operator to create a directory they should never create.
  if (findings.length === 0 && input.filesystem !== null) {
    const fs = input.filesystem;
    if (fs.projectDir === 'MISSING') findings.push(finding('PROJECT_DIR_MISSING'));
    else if (fs.projectDir === 'NOT_A_DIRECTORY') findings.push(finding('PROJECT_DIR_NOT_A_DIRECTORY'));
    else if (fs.projectDir === 'UNREADABLE') findings.push(finding('PROJECT_DIR_UNREADABLE'));
    else {
      if (ARCANE_REQUIRED_SUBDIRECTORIES.some((name) => fs.subdirectories[name] !== true)) {
        findings.push(finding('SUBDIRECTORY_MISSING'));
      }
      if (ARCANE_REQUIRED_SECRET_FILES.some((name) => fs.secretFiles[name] !== true)) {
        findings.push(finding('SECRET_FILE_MISSING'));
      }
    }
  }

  findings.push(...inspectArcaneBindAddress(input.bindAddress));
  findings.push(...inspectArcaneHostPort(input.hostPort));

  return {
    ok: !findings.some((item) => item.severity === 'BLOCKER'),
    report: 'phase-253-arcane-install',
    findings,
    promotionAuthorization: 'NOT_IMPLIED',
    note: READINESS_NOTE,
  };
}

/**
 * Read the filesystem facts. The thin, boring collector; every decision lives in the pure function above.
 *
 * It stats a fixed set of names joined to one directory. No name here comes from a request, a browser or a
 * record — only from the two constants at the top of this file.
 */
export function collectArcaneFilesystemFacts(projectDir: string): ArcaneFilesystemFacts {
  const empty = { subdirectories: {}, secretFiles: {} };
  try {
    if (!statSync(projectDir).isDirectory()) return { projectDir: 'NOT_A_DIRECTORY', ...empty };
  } catch {
    return { projectDir: 'MISSING', ...empty };
  }
  try {
    accessSync(projectDir, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    return { projectDir: 'UNREADABLE', ...empty };
  }
  const subdirectories: Record<string, boolean> = {};
  for (const name of ARCANE_REQUIRED_SUBDIRECTORIES) {
    try { subdirectories[name] = statSync(`${projectDir}/${name}`).isDirectory(); } catch { subdirectories[name] = false; }
  }
  const secretFiles: Record<string, boolean> = {};
  for (const name of ARCANE_REQUIRED_SECRET_FILES) {
    try { secretFiles[name] = statSync(`${projectDir}/secrets/${name}`).isFile(); } catch { secretFiles[name] = false; }
  }
  return { projectDir: 'OK', subdirectories, secretFiles };
}

/**
 * The whole preflight, against a real environment and a real filesystem.
 *
 * The filesystem is consulted ONLY when the path is structurally sound AND this process can plausibly see the
 * host — which, when the preflight runs on the Unraid server itself, it can. Run from anywhere else the
 * structural findings still hold and the filesystem findings are simply absent rather than wrong, which is why
 * `filesystem` is nullable rather than defaulted.
 */
export function checkArcaneInstall(env: NodeJS.ProcessEnv = process.env, options: { readonly checkFilesystem?: boolean } = {}): ArcaneInstallReadiness {
  const projectDir = env[ARCANE_PROJECT_DIR_ENV];
  const structural = inspectArcaneProjectDir(projectDir);
  const shouldStat = (options.checkFilesystem ?? true) && structural.length === 0 && projectDir !== undefined;
  return deriveArcaneInstallReadiness({
    projectDir,
    bindAddress: env[ARCANE_BIND_ADDRESS_ENV],
    hostPort: env[ARCANE_HOST_PORT_ENV],
    filesystem: shouldStat ? collectArcaneFilesystemFacts(projectDir!.trim().replace(/\/+$/, '')) : null,
  });
}
