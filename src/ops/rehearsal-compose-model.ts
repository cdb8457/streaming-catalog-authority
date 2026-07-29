import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { MaintenanceRefused } from './maintenance-safety.js';

// Phases 279/280 — PROVING THAT THE STACK A REHEARSAL BOOTS IS DISPOSABLE.
//
// -----------------------------------------------------------------------------------------------------
// THE DEFECT THIS FILE EXISTS FOR.
// -----------------------------------------------------------------------------------------------------
//
// The rehearsal takes an operator-supplied Compose definition and runs it under a different project name in a
// different directory, and then reported `touchedProduction: false` as a constant. Neither of those two facts
// makes the third one true. A Compose definition decides for itself what it touches:
//
//   * A BIND MOUNT NAMES A HOST PATH. `- /mnt/user/appdata/catalog/pgdata:/var/lib/postgresql/data` is the
//     production database directory whatever project name is in front of it, and a rehearsal that boots it
//     writes to the installation it was supposed to be protecting. The shipped Unraid file does exactly this.
//   * A DOCKER SECRET NAMES A HOST FILE. `secrets: custodian_kek: file: …/secrets/custodian_kek` reads the
//     real key material into the disposable stack. The shipped Unraid file does this six times.
//   * AN EXTERNAL VOLUME OR NETWORK IS SOMEBODY ELSE'S. `external: true` means "one that already exists", and
//     `down -v` on a project that mounts one is how a rehearsal deletes production state. AND `external:
//     false` DOES NOT MEAN THE OPPOSITE: a top-level `name:` puts a volume in the GLOBAL namespace where an
//     installation's real volumes live, and `driver_opts: {type: none, o: bind, device: /…}` makes a "local"
//     volume a host bind mount that no service's mount list ever calls a bind. Both are checked by the
//     EFFECTIVE resolved name and mechanism, not by the flag. See `ResolvedTopLevelResource`.
//   * `container_name` TAKES A NAME GLOBALLY. Two projects cannot both have it, so a disposable stack
//     declaring one either fails or replaces the running container of that name.
//   * `network_mode: host`, `privileged`, `devices:` AND A DOCKER SOCKET MOUNT each hand the disposable stack
//     the host. A rehearsal does not need any of them and must not be able to ask for one.
//   * `${VAR}` MEANS "WHATEVER THIS SHELL HAPPENS TO HOLD", and `${VAR:-/mnt/user/appdata/catalog}` means
//     production by default. A definition whose meaning depends on an ambient variable is a definition
//     nobody reviewed.
//
// So the disposable stack is RESOLVED and VALIDATED before a marker is claimed and before a container could
// exist — `docker compose config`, which starts nothing — and every one of those is a refusal. Only a stack
// that survives all of it is one `touchedProduction: false` can honestly be said about.
//
// -----------------------------------------------------------------------------------------------------
// AND IT IS VALIDATED AGAIN AFTER EACH OVERRIDE.
// -----------------------------------------------------------------------------------------------------
//
// Compose MERGES: an override's `volumes` entries replace base entries with the same target and are appended
// otherwise, and its `secrets` list can only ADD. That means an override cannot honestly promise to have
// removed anything — so this never tries to. It reads the MERGED result and refuses it if a production source
// survived. The base definition is therefore held to a rule that makes the merge safe: it declares no bind
// mount and no secret at all, and every piece of persistent state it wants is a project-scoped named volume.
// Everything the rehearsal restores arrives through the override, out of the marker-owned restore workspace.

/** The services a rehearsal of this product's stack must find, and the only ones it will run. */
export const REHEARSAL_SERVICES: readonly string[] = Object.freeze(['postgres', 'migrate', 'app', 'sidecar']);

/**
 * The services that run THIS PRODUCT'S image, and must therefore be pinned to the role's exact reference.
 *
 * THE DEFECT THIS CLOSES. The override pinned `app.image` and nothing else. In the shipped stack `migrate` and
 * `sidecar` are the same product image, so the "candidate" boot ran the candidate app against the CURRENT
 * build's migration and the CURRENT build's custodian sidecar — which is to say it rehearsed neither the
 * migration that is the entire reason a rollback is hard, nor the custody path every decrypt goes through.
 *
 * `ops` is deliberately absent: this rehearsal never invokes it, and pinning a service nothing runs would be
 * a claim with no action behind it. A definition that declares one is refused, because a product-image service
 * this does not pin is a service that could boot the wrong build.
 */
export const REHEARSAL_PRODUCT_SERVICES: readonly string[] = Object.freeze(['migrate', 'app', 'sidecar']);

/** How large a resolved-configuration document this will read before refusing. */
export const MAX_COMPOSE_MODEL_BYTES = 4 * 1024 * 1024;
/** How many services, mounts and entries a disposable stack may declare. */
export const MAX_COMPOSE_SERVICES = 16;
export const MAX_COMPOSE_MOUNTS = 64;
export const MAX_COMPOSE_ENVIRONMENT = 256;

export type ComposeMountType = 'bind' | 'volume' | 'tmpfs' | 'unknown';

export interface ResolvedMount {
  readonly type: ComposeMountType;
  /** The HOST side for a bind, the volume NAME for a volume, empty for tmpfs. */
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

export interface ResolvedService {
  readonly name: string;
  readonly image: string | null;
  readonly environment: Readonly<Record<string, string>>;
  readonly mounts: readonly ResolvedMount[];
  /** Names of Docker secrets and configs this service is given. Both must be empty. */
  readonly secrets: readonly string[];
  readonly configs: readonly string[];
  /** Every key the resolved service carries, so a rule can refuse one by name without knowing its shape. */
  readonly keys: readonly string[];
}

/**
 * A top-level volume or network, as Compose actually resolved it.
 *
 * THE DEFECT THIS SHAPE EXISTS FOR. The first version of this file kept only the definition's KEY and the
 * `external` flag, and treated `external: false` as proof that the resource belonged to this project. It is
 * not, in two separate ways, and both survive `down -v` in the wrong direction:
 *
 *   * AN EXPLICIT `name:` IS A GLOBAL NAME. Compose derives `<project>_<key>` for a resource a project owns,
 *     but a definition may say `name: catalog-pgdata` instead — and that names a volume outside every
 *     project's namespace, one that already exists or is created stable and shared. `external` stays `false`
 *     the whole time. A rehearsal mounting it reads the installation's data, and its `down -v` REMOVES IT.
 *   * A LOCAL VOLUME CAN BE A BIND MOUNT WEARING A VOLUME'S CLOTHES. `driver: local` with
 *     `driver_opts: {type: none, o: bind, device: /mnt/user/appdata/catalog}` is a host directory. It is not
 *     external, it is not a `type: bind` mount in any service, and every check that looked at mounts alone
 *     walked straight past it.
 *
 * So the effective NAME and the MECHANISM are both kept, and every key the entry carries is kept too — an
 * unrecognised one is refused rather than ignored, because a mechanism this build has never heard of is a
 * mechanism it cannot prove is contained.
 */
export interface ResolvedTopLevelResource {
  /** The key in the definition. This is what a service mount's `source` usually names. */
  readonly key: string;
  /** The EFFECTIVE name Docker would use. `<project>_<key>` unless the definition overrode it. */
  readonly name: string;
  readonly external: boolean;
  /** The mechanism, or `null` where the definition named none and Compose's default applies. */
  readonly driver: string | null;
  /** The mechanism's options. Non-empty on a volume is the bind/device disguise above. */
  readonly driverOptions: Readonly<Record<string, string>>;
  /** Every key the resolved entry carries, so an unrecognised mechanism is a refusal. */
  readonly keys: readonly string[];
}

export interface ResolvedComposeModel {
  readonly projectName: string;
  readonly services: readonly ResolvedService[];
  /** Top-level named volumes, as resolved: effective name and mechanism, not merely the key. */
  readonly volumes: readonly ResolvedTopLevelResource[];
  readonly networks: readonly ResolvedTopLevelResource[];
  readonly secrets: readonly string[];
  readonly configs: readonly string[];
}

// -----------------------------------------------------------------------------------------------------------
// Interpolation
// -----------------------------------------------------------------------------------------------------------

/** A `$` that Compose would interpolate. `$$` is Compose's own escape for a literal one and is left alone. */
const INTERPOLATION = /\$(?!\$)\{?[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Refuse a Compose definition whose meaning depends on a variable.
 *
 * WHY ALL OF THEM AND NOT JUST THE PRODUCTION-LOOKING ONES. `${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/…}`
 * is production by DEFAULT, so a rule that only refused variables which were actually set would accept the
 * one spelling that reaches production with certainty. And a definition that reads any variable is one whose
 * resolved meaning is not a function of its bytes — which is what the plan digest binds. Both problems have
 * the same answer: a disposable definition names what it means.
 */
export function assertNoComposeInterpolation(text: string, what: string): void {
  const found = INTERPOLATION.exec(text);
  if (found === null) return;
  throw new MaintenanceRefused(
    `the ${what} interpolates an environment variable, and this command will not resolve one. A variable is `
    + 'whatever the shell that ran this happens to hold, and the shipped stacks default theirs to the '
    + 'PRODUCTION appdata directory — so a rehearsal of a definition carrying one can silently be a rehearsal '
    + 'against the installation it is meant to protect. Write the disposable definition with the values it '
    + 'means. (Compose\'s own "$$" for a literal dollar sign is fine.)');
}

/**
 * Keys that bring bytes or conditions into the resolved stack from OUTSIDE the definition.
 *
 * WHY THESE ARE CHECKED IN THE TEXT AND NOT IN THE RESOLVED MODEL. `config` resolves all four away: an
 * `extends` is inlined, an `include` is merged, an `env_file` becomes plain environment entries, and a
 * `profiles` decision has already been made. They leave no trace to refuse in the output — and each of them
 * means the resolved configuration is NOT a function of the bytes this command digested and bound into the
 * plan an operator confirmed. A definition naming one is therefore refused before it is resolved at all.
 */
export const EXTERNAL_COMPOSE_INPUT_KEYS: readonly string[] = Object.freeze([
  'env_file', 'extends', 'include', 'profiles',
]);

/** Refuse a definition whose resolved meaning depends on a file or a condition this command did not read. */
export function assertNoExternalComposeInputs(text: string, what: string): void {
  for (const key of EXTERNAL_COMPOSE_INPUT_KEYS) {
    if (new RegExp(`(^|\\n)\\s*${key}\\s*:`).test(text)) {
      throw new MaintenanceRefused(
        `the ${what} uses "${key}", which brings part of the resolved stack in from outside the file. This `
        + 'command binds the definition\'s own bytes into the plan digest you confirm, and it cannot do that '
        + 'for bytes it never read. Write the disposable definition as one self-contained file.');
    }
  }
}

// -----------------------------------------------------------------------------------------------------------
// Reading what `docker compose config` answered
// -----------------------------------------------------------------------------------------------------------

/**
 * Parse the fully resolved configuration Compose itself produced.
 *
 * IT IS COMPOSE'S OWN ANSWER, NOT A SECOND PARSER'S OPINION. `docker compose config --format json` applies
 * every merge, extension and normalisation rule the daemon would apply at `up` — and starts nothing. A
 * validator reading a YAML file directly would be validating a different document from the one that boots,
 * which is precisely the class of defect this whole file exists to close.
 */
export function parseResolvedComposeModel(stdout: string, what: string): ResolvedComposeModel {
  if (stdout.length > MAX_COMPOSE_MODEL_BYTES) {
    throw new MaintenanceRefused(`the ${what} is larger than this command will read`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new MaintenanceRefused(`the ${what} did not answer with a configuration this build can read`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MaintenanceRefused(`the ${what} did not answer with a configuration this build can read`);
  }
  const doc = parsed as Record<string, unknown>;
  const projectName = typeof doc.name === 'string' ? doc.name : '';
  const rawServices = asRecord(doc.services, `${what} services`);
  const names = Object.keys(rawServices);
  if (names.length === 0) throw new MaintenanceRefused(`the ${what} declares no services`);
  if (names.length > MAX_COMPOSE_SERVICES) {
    throw new MaintenanceRefused(`the ${what} declares more services than this command will rehearse`);
  }
  const services = names.map((name) => readService(name, asRecord(rawServices[name], `${what} service`), what));
  return {
    projectName,
    services,
    volumes: readTopLevel(doc.volumes, `${what} volumes`),
    networks: readTopLevel(doc.networks, `${what} networks`),
    secrets: Object.keys(doc.secrets === undefined || doc.secrets === null ? {} : asRecord(doc.secrets, `${what} secrets`)),
    configs: Object.keys(doc.configs === undefined || doc.configs === null ? {} : asRecord(doc.configs, `${what} configs`)),
  };
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new MaintenanceRefused(`the ${what} is not a mapping`);
  return value as Record<string, unknown>;
}

function readTopLevel(value: unknown, what: string): readonly ResolvedTopLevelResource[] {
  const map = asRecord(value, what);
  return Object.entries(map).map(([key, body]) => {
    const entry = body === null || body === undefined ? {} : asRecord(body, `${what} entry`);
    // THE EFFECTIVE NAME, AND A REFUSAL WHERE THERE ISN'T ONE. A resolved configuration always carries the
    // name Docker would use; a document that does not is not Compose's own answer, and guessing the default
    // derivation on its behalf would be inventing the very fact this check rests on.
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      throw new MaintenanceRefused(
        `the ${what} entry carries no effective name, so this command cannot prove which volume or network `
        + 'Docker would actually use. That is not a fully resolved configuration. Refused.');
    }
    const driverOptions: Record<string, string> = {};
    for (const [option, optionValue] of Object.entries(asRecord(entry.driver_opts, `${what} driver options`))) {
      driverOptions[option] = optionValue === null || optionValue === undefined ? '' : String(optionValue);
    }
    return {
      key,
      name: entry.name,
      external: entry.external === true,
      driver: typeof entry.driver === 'string' ? entry.driver : null,
      driverOptions,
      keys: Object.keys(entry),
    };
  });
}

function readService(name: string, raw: Record<string, unknown>, what: string): ResolvedService {
  const mounts: ResolvedMount[] = [];
  const volumes = raw.volumes;
  if (Array.isArray(volumes)) {
    if (volumes.length > MAX_COMPOSE_MOUNTS) {
      throw new MaintenanceRefused(`the ${what} declares more mounts than this command will examine`);
    }
    for (const entry of volumes) {
      // `config` normalises every mount to long syntax. A SHORT-SYNTAX STRING SURVIVING HERE means this is not
      // Compose's own resolved output, and it is refused rather than re-parsed by hand.
      if (typeof entry === 'string') {
        throw new MaintenanceRefused(
          `the ${what} carries an unresolved mount, so it is not a fully resolved configuration`);
      }
      const mount = asRecord(entry, `${what} mount`);
      const type = typeof mount.type === 'string' ? mount.type : 'unknown';
      mounts.push({
        type: type === 'bind' || type === 'volume' || type === 'tmpfs' ? type : 'unknown',
        source: typeof mount.source === 'string' ? mount.source : '',
        target: typeof mount.target === 'string' ? mount.target : '',
        readOnly: mount.read_only === true,
      });
    }
  } else if (volumes !== undefined && volumes !== null) {
    throw new MaintenanceRefused(`the ${what} service ${name} declares mounts in a shape this build cannot read`);
  }

  const environment: Record<string, string> = {};
  const rawEnvironment = raw.environment;
  if (Array.isArray(rawEnvironment)) {
    // Docker Compose 2.40 emits the fully resolved JSON model as `["KEY=value", ...]` when `config` is
    // combined with `--no-interpolate`. That is not the short YAML list syntax surviving resolution: every
    // entry has already become an exact assignment. A BARE `KEY`, however, still means "take it from the
    // caller's environment" and is therefore unresolved. Accept only assignments, split at the first `=`
    // (values may contain more), and refuse duplicates rather than inventing which one Compose would use.
    if (rawEnvironment.length > MAX_COMPOSE_ENVIRONMENT) {
      throw new MaintenanceRefused(`the ${what} carries more environment entries than this command will examine`);
    }
    for (const entry of rawEnvironment) {
      if (typeof entry !== 'string') {
        throw new MaintenanceRefused(`the ${what} carries an environment entry this build cannot read`);
      }
      const equals = entry.indexOf('=');
      if (equals <= 0) {
        throw new MaintenanceRefused(`the ${what} carries an unresolved environment, so it is not fully resolved`);
      }
      const key = entry.slice(0, equals);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new MaintenanceRefused(`the ${what} carries an environment name this build cannot read`);
      }
      if (Object.prototype.hasOwnProperty.call(environment, key)) {
        throw new MaintenanceRefused(`the ${what} carries a duplicate environment assignment`);
      }
      environment[key] = entry.slice(equals + 1);
    }
  } else {
    const entries = Object.entries(asRecord(rawEnvironment, `${what} environment`));
    if (entries.length > MAX_COMPOSE_ENVIRONMENT) {
      throw new MaintenanceRefused(`the ${what} carries more environment entries than this command will examine`);
    }
    for (const [key, value] of entries) {
      if (value === null || value === undefined) {
        throw new MaintenanceRefused(`the ${what} carries an unresolved environment, so it is not fully resolved`);
      }
      environment[key] = String(value);
    }
  }

  return {
    name,
    image: typeof raw.image === 'string' ? raw.image : null,
    environment,
    mounts,
    secrets: referenceNames(raw.secrets, `${what} service ${name} secrets`),
    configs: referenceNames(raw.configs, `${what} service ${name} configs`),
    keys: Object.keys(raw),
  };
}

function referenceNames(value: unknown, what: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new MaintenanceRefused(`the ${what} is not a list`);
  return value.map((entry) => {
    if (typeof entry === 'string') return entry;
    const map = asRecord(entry, what);
    return typeof map.source === 'string' ? map.source : 'an unnamed reference';
  });
}

/**
 * A digest over the resolved configuration, canonicalised so key order cannot change it.
 *
 * This is what binds "the stack that was validated" to "the stack that booted": it is recorded in the
 * evidence, and a definition edited between the validation and the boot produces a different one.
 *
 * IT COVERS EVERY VALUE A REFUSAL RESTS ON. It used to hash a top-level resource's KEY and `external` flag —
 * exactly the two fields that turned out not to decide anything. A volume that gained an explicit global
 * name, a `device:` driver option or a different driver produced a byte-identical digest, so the one value
 * that is supposed to say "this is the stack that was checked" could not have told the difference.
 */
export function resolvedComposeDigest(model: ResolvedComposeModel): string {
  const resource = (entry: ResolvedTopLevelResource): unknown => [
    entry.key,
    entry.name,
    entry.external,
    entry.driver,
    Object.entries(entry.driverOptions).slice().sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    [...entry.keys].sort(),
  ];
  const canonical = JSON.stringify([
    model.projectName,
    model.services.map((service) => [
      service.name,
      service.image,
      Object.entries(service.environment).slice().sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      service.mounts.map((mount) => [mount.type, mount.source, mount.target, mount.readOnly]),
      [...service.secrets].sort(),
      [...service.configs].sort(),
      [...service.keys].sort(),
    ]),
    model.volumes.map(resource),
    model.networks.map(resource),
    [...model.secrets].sort(),
    [...model.configs].sort(),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// -----------------------------------------------------------------------------------------------------------
// The rules
// -----------------------------------------------------------------------------------------------------------

/**
 * Service keys a disposable rehearsal stack may not carry, and what each one would reach.
 *
 * A CLOSED LIST OF REFUSALS RATHER THAN A CLOSED LIST OF PERMISSIONS. An allowlist of keys would refuse a
 * `healthcheck` or a `depends_on` an operator legitimately needs and would have to grow with Compose; the
 * things that reach OUT of a project are a short, stable list, and naming them is what makes each refusal
 * explainable.
 */
export const FORBIDDEN_SERVICE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  container_name: 'a container name is global to the host, so a disposable stack declaring one either fails to '
    + 'start or takes the name of a container that is already running',
  network_mode: 'a network mode reaches out of the project — "host" is the host\'s own stack, and '
    + '"service:"/"container:" is somebody else\'s namespace',
  privileged: 'a privileged container is the host',
  devices: 'a device is host hardware',
  device_cgroup_rules: 'a device rule is host hardware',
  cap_add: 'an added capability is a capability the rehearsal does not need',
  pid: 'a shared PID namespace reaches out of the project',
  ipc: 'a shared IPC namespace reaches out of the project',
  userns_mode: 'a user-namespace mode reaches out of the project',
  build: 'a rehearsal proves two images that already exist; building one would rehearse something nobody has',
  extends: 'an extended service is defined in another file this command never validated',
  env_file: 'an environment file makes the resolved stack depend on bytes outside the definition',
  ports: 'a published port is taken on the HOST, so a disposable stack publishing one collides with the '
    + 'installation it is rehearsing for',
  external_links: 'an external link reaches a container this project did not create',
  volumes_from: 'volumes-from reaches another container\'s mounts',
});

/** Host paths that are the host itself. A bind to one is refused by name as well as by containment. */
export const FORBIDDEN_BIND_SOURCES: readonly string[] = Object.freeze([
  '/var/run/docker.sock', '/run/docker.sock', '/var/lib/docker', '/proc', '/sys', '/dev', '/etc', '/boot',
  '/var/run/docker.pid',
]);

export interface ComposeExpectation {
  readonly projectName: string;
  /** The resolved disposable root. Nothing outside it may be named by a bind, a secret or a config. */
  readonly disposableRoot: string;
  /**
   * The prepared restore workspace, when there is one.
   *
   * `null` for the FIRST validation, which runs before the workspace exists — and which therefore requires the
   * definition to declare no bind mount at all. That is the rule that makes the later merge honest.
   */
  readonly workspace: string | null;
  /** Every service that must exist, and the exact image reference each product service must be pinned to. */
  readonly pinnedImages: Readonly<Record<string, string>> | null;
  /** Every mount the rehearsal's own override must have established, once there is a workspace. */
  readonly wiring: readonly RequiredWiring[];
}

/**
 * One thing the restored set must actually reach, stated as a fact about the resolved configuration.
 *
 * A REHEARSAL THAT MOUNTED A KEYSTORE INTO A SERVICE THAT DOES NOT READ ONE PROVED NOTHING. Each entry names
 * the service, the exact container path, the environment variable that must name that path (where the shipped
 * stack uses one), and the entry inside the restore workspace that must be its source.
 */
export interface RequiredWiring {
  readonly service: string;
  readonly containerPath: string;
  /** The variable the shipped image reads that path from, or `null` where the path itself is the contract. */
  readonly env: string | null;
  /**
   * Anything else the running image needs told, as `variable -> exact value`.
   *
   * The import snapshot is the case this exists for: the file is mounted at a path, and the shipped importer
   * resolves a name against the DIRECTORY named by its own variable. Mounting the file without setting that is
   * a mount whose meaning depends on a default.
   */
  readonly alsoEnv?: Readonly<Record<string, string>>;
  /** Relative to the restore workspace. */
  readonly workspaceEntry: string;
  readonly writable: boolean;
  /** What is lost if this is not wired. Closed wording; goes into the refusal. */
  readonly proves: string;
}

/**
 * Validate a fully resolved configuration, or refuse with the reason.
 *
 * FAIL-CLOSED IN EVERY DIRECTION. An unexpected key, an unreadable mount shape, a service nobody declared, a
 * source outside the root, a secret of any kind, an external anything: each is a refusal. Nothing here
 * normalises a finding into something acceptable.
 */
export function validateResolvedCompose(model: ResolvedComposeModel, expect: ComposeExpectation): void {
  if (model.projectName !== expect.projectName) {
    throw new MaintenanceRefused(
      'the resolved disposable stack carries a project name that is not this rehearsal\'s own. Every container, '
      + 'volume and network Compose creates is labelled with that name, and the cleanup removes by exactly it.');
  }

  // ---- EVERY VOLUME AND NETWORK IS THIS PROJECT'S OWN, AND IS WHAT IT SAYS IT IS -------------------------
  //
  // `external: false` PROVES NOTHING ON ITS OWN, which is what the first version of this file got wrong. See
  // `ResolvedTopLevelResource` for the two ways a non-external resource still reaches out.
  for (const [kind, entries] of [['volume', model.volumes], ['network', model.networks]] as const) {
    for (const entry of entries) {
      assertProjectOwnedResource(kind, entry, expect.projectName);
    }
  }
  if (model.secrets.length > 0 || model.configs.length > 0) {
    throw new MaintenanceRefused(
      'the resolved disposable stack declares Docker secrets or configs. Every one of them names a file on the '
      + 'HOST — in the shipped stacks, the real key material — and a rehearsal must read only the copies it '
      + 'made from the verified set. Declare none: this command mounts what it restored, from its own '
      + 'workspace, at the paths the images read.');
  }

  // ---- EXACTLY THE TOPOLOGY THIS PRODUCT'S STACK HAS ----------------------------------------------------
  const present = new Set(model.services.map((service) => service.name));
  for (const required of REHEARSAL_SERVICES) {
    if (!present.has(required)) {
      throw new MaintenanceRefused(
        `the resolved disposable stack has no "${required}" service. A rehearsal of this product's stack needs `
        + `all of ${REHEARSAL_SERVICES.join(', ')}: the migration and the custodian sidecar are where an upgrade `
        + 'actually happens, and a stack missing one rehearses an installation nobody runs.');
    }
  }
  for (const service of model.services) {
    if (!REHEARSAL_SERVICES.includes(service.name)) {
      throw new MaintenanceRefused(
        'the resolved disposable stack declares a service this rehearsal does not know how to pin to an exact '
        + `image (${REHEARSAL_SERVICES.join(', ')} are the ones it does). An unpinned service can boot a build `
        + 'that is neither the current one nor the candidate, which would make the whole comparison meaningless.');
    }
  }

  for (const service of model.services) {
    // ---- KEYS THAT REACH OUT OF THE PROJECT -------------------------------------------------------------
    for (const key of service.keys) {
      const reason = FORBIDDEN_SERVICE_KEYS[key];
      if (reason !== undefined) {
        throw new MaintenanceRefused(
          `the resolved disposable stack declares "${key}", and ${reason}. Remove it from the disposable `
          + 'definition; a rehearsal needs none of them.');
      }
    }
    if (service.secrets.length > 0 || service.configs.length > 0) {
      throw new MaintenanceRefused(
        'a service in the resolved disposable stack is given a Docker secret or config, whose source is a file '
        + 'on the host. The rehearsal mounts what it restored instead.');
    }
    if (service.image === null || service.image.trim() === '') {
      throw new MaintenanceRefused(
        'a service in the resolved disposable stack names no image. A rehearsal boots images that already '
        + 'exist on this host and builds nothing.');
    }

    // ---- EVERY MOUNT --------------------------------------------------------------------------------------
    for (const mount of service.mounts) {
      if (mount.type === 'unknown' || mount.type === 'tmpfs') {
        if (mount.type === 'unknown') {
          throw new MaintenanceRefused(
            'the resolved disposable stack carries a mount of a kind this command cannot classify, so it cannot '
            + 'prove where it points. Refused.');
        }
        continue; // tmpfs is memory: it is gone on stop and names nothing on the host.
      }
      if (mount.type === 'volume') {
        if (mount.source === '') continue; // an anonymous volume is created and destroyed with the project
        // MATCHED AGAINST BOTH SPELLINGS. Compose writes a mount's `source` as the definition's KEY in some
        // versions and as the EFFECTIVE NAME in others, and a check that knew only one of them would either
        // refuse every real stack or accept a mount naming a volume nobody declared. Every declared entry has
        // already been proved to carry the derived name, so the two cannot collide.
        const declared = model.volumes.find(
          (entry) => entry.key === mount.source || entry.name === mount.source);
        if (declared === undefined) {
          throw new MaintenanceRefused(
            'the resolved disposable stack mounts a named volume the definition does not declare, so this '
            + 'command cannot prove it is the project\'s own rather than one that already existed.');
        }
        continue;
      }
      assertBindIsOurs(mount, expect);
    }
  }

  // ---- THE IMAGES, WHERE THEY ARE PINNED ----------------------------------------------------------------
  if (expect.pinnedImages !== null) {
    for (const [name, reference] of Object.entries(expect.pinnedImages)) {
      const service = model.services.find((entry) => entry.name === name);
      if (service === undefined) {
        // A pinned service that is not in the base definition would mean the override INVENTED one. Compose
        // would happily create it, and it would be a service the operator's stack does not have.
        throw new MaintenanceRefused(
          'the rehearsal override names a service the disposable definition does not declare. This command '
          + 'pins the images of services that already exist; it never adds one.');
      }
      if (service.image !== reference) {
        throw new MaintenanceRefused(
          `the resolved disposable stack does not run this leg's image on "${name}". In this product's stack the `
          + 'migration and the custodian sidecar are the SAME image as the app, so a leg that pinned only the '
          + 'app would run the candidate app against the current build\'s migration — which is the one thing an '
          + 'upgrade rehearsal exists to exercise.');
      }
    }
  }

  // ---- AND EVERY RESTORED COMPONENT, AT THE PATH THE IMAGE ACTUALLY READS --------------------------------
  if (expect.workspace !== null) {
    for (const wiring of expect.wiring) {
      const service = model.services.find((entry) => entry.name === wiring.service);
      if (service === undefined) {
        throw new MaintenanceRefused(`the resolved disposable stack has no "${wiring.service}" service`);
      }
      const mount = service.mounts.find((entry) => entry.target === wiring.containerPath);
      if (mount === undefined || mount.type !== 'bind') {
        throw new MaintenanceRefused(
          `the resolved disposable stack does not mount anything at the path "${wiring.service}" reads for `
          + `${wiring.proves}. After Compose merged the definition and this command's override, that component `
          + 'is not where the running image would look for it.');
      }
      const expectedSource = joinInside(expect.workspace, wiring.workspaceEntry);
      if (!samePath(bindSource(mount, expect.disposableRoot), expectedSource)) {
        throw new MaintenanceRefused(
          `the effective source for ${wiring.proves} is NOT the copy this rehearsal restored. Compose merged a `
          + 'base entry over the override, or the definition binds that path itself — either way the disposable '
          + 'stack would be reading the installation\'s own files.');
      }
      if (mount.readOnly === wiring.writable) {
        throw new MaintenanceRefused(
          `the mount for ${wiring.proves} is ${mount.readOnly ? 'read-only and must be writable' : 'writable and must be read-only'}`);
      }
      // AND THE IMAGE MUST BE POINTED AT IT. A file mounted at a path the running build never reads is a
      // restore that happened beside the installation rather than into it.
      if (wiring.env !== null && service.environment[wiring.env] !== wiring.containerPath) {
        throw new MaintenanceRefused(
          `the resolved disposable stack does not tell "${wiring.service}" to read ${wiring.proves} from the `
          + 'restored copy. The mount would be there and the running image would look somewhere else — which on '
          + 'this product\'s stack means the PRODUCTION file the base definition names.');
      }
      for (const [name, value] of Object.entries(wiring.alsoEnv ?? {})) {
        if (service.environment[name] !== value) {
          throw new MaintenanceRefused(
            `the resolved disposable stack does not configure "${wiring.service}" to find ${wiring.proves} where `
            + 'this rehearsal put it.');
        }
      }
    }
    // AND NO WRITABLE BIND ANYWHERE ELSE. A writable bind outside the workspace is durable state landing
    // somewhere this rehearsal does not own and will not clean up.
    for (const service of model.services) {
      for (const mount of service.mounts) {
        if (mount.type !== 'bind' || mount.readOnly) continue;
        if (!isInsideOrEqual(bindSource(mount, expect.disposableRoot), expect.workspace)) {
          throw new MaintenanceRefused(
            'the resolved disposable stack has a WRITABLE bind mount outside the restore workspace. Durable '
            + 'state a rehearsal writes belongs either in the workspace it prepared or in a volume of its own '
            + 'project, so that destroying the project destroys it.');
        }
      }
    }
  }
}

/**
 * Keys a top-level volume or network may carry at all.
 *
 * AN ALLOWLIST HERE, unlike the service-key rule next door, and for the opposite reason: a service legitimately
 * carries dozens of keys and only a short list reaches outside the project, whereas a volume or network this
 * rehearsal needs is described entirely by its name — everything else it can say is a MECHANISM, and a
 * mechanism this build has not read is one it cannot prove is contained. `driver` and `driver_opts` are on the
 * list so that they can be refused SPECIFICALLY, with the reason, rather than as "an unrecognised key".
 */
export const PERMITTED_RESOURCE_KEYS: readonly string[] = Object.freeze([
  'name', 'external', 'labels', 'driver', 'driver_opts',
]);

/**
 * The one mechanism each kind may use: the default that creates something inside the project and nothing else.
 *
 * A `local` volume with no options is a directory Docker manages, labelled with the project and removed by its
 * `down -v`. A `bridge` network is the project's own. Every other driver — and `local` WITH options — either
 * reaches a host path, a remote filesystem or the host's own networking.
 */
export const PERMITTED_RESOURCE_DRIVERS: Readonly<Record<'volume' | 'network', string>> = Object.freeze({
  volume: 'local',
  network: 'bridge',
});

/**
 * Prove a top-level resource belongs to this project and is what it claims to be, or refuse.
 *
 * THE NAME IS THE OWNERSHIP PROOF. Compose derives `<project>_<key>` for a resource a project owns; anything
 * else is a name in the global namespace, which is where an installation's real volumes live. Requiring the
 * derived name exactly refuses an explicit `name:` without having to guess whether the operator meant to
 * reference something that already exists — because the two are indistinguishable at this point and the
 * consequence of guessing wrong is `down -v` on production data.
 */
export function assertProjectOwnedResource(
  kind: 'volume' | 'network',
  entry: ResolvedTopLevelResource,
  projectName: string,
): void {
  if (entry.external) {
    throw new MaintenanceRefused(
      `the resolved disposable stack uses an EXTERNAL ${kind}, which is one that already exists and belongs `
      + 'to something else. This rehearsal destroys its own project\'s volumes, so it will not run against '
      + 'a resource it did not create.');
  }
  const derived = `${projectName}_${entry.key}`;
  if (entry.name !== derived) {
    throw new MaintenanceRefused(
      `the resolved disposable stack gives a ${kind} an explicit name instead of this project's own. Compose `
      + `names a ${kind} a project OWNS "<project>_<key>"; any other name is in the global namespace, where an `
      + `installation's real ${kind}s live — and it stays that way whether or not "external" is set. This `
      + `rehearsal runs "down -v", so a ${kind} it does not provably own is one it must not touch.`);
  }
  for (const key of entry.keys) {
    if (!PERMITTED_RESOURCE_KEYS.includes(key)) {
      throw new MaintenanceRefused(
        `the resolved disposable stack describes a ${kind} with "${key}", which is a mechanism this command `
        + `cannot prove is contained. A ${kind} a rehearsal needs is described by its name and nothing else.`);
    }
  }
  if (Object.keys(entry.driverOptions).length > 0) {
    throw new MaintenanceRefused(
      `the resolved disposable stack gives a ${kind} driver options. On a volume those are how a HOST PATH is `
      + 'mounted while looking like a volume — "type: none, o: bind, device: /some/host/path" is a bind mount '
      + 'wearing a volume\'s clothes, it is not external, and no mount in any service says "bind". This command '
      + 'refuses the mechanism rather than trying to tell the safe options from the dangerous ones.');
  }
  const permitted = PERMITTED_RESOURCE_DRIVERS[kind];
  if (entry.driver !== null && entry.driver !== permitted) {
    throw new MaintenanceRefused(
      `the resolved disposable stack gives a ${kind} a "${entry.driver}" driver. A rehearsal needs only the `
      + `default "${permitted}" one, which creates something inside this project and reaches nothing else; every `
      + 'other driver is a host path, a remote filesystem or the host\'s own networking.');
  }
}

/** A bind mount that is provably this rehearsal's own, or a refusal naming what it would have reached. */
function assertBindIsOurs(mount: ResolvedMount, expect: ComposeExpectation): void {
  if (mount.source === '') {
    throw new MaintenanceRefused(
      'the resolved disposable stack carries a bind mount with no host side, so this command cannot prove where '
      + 'it points. Refused.');
  }
  // A DOLLAR SIGN OR A BRACE SURVIVING INTO A RESOLVED SOURCE means an unsubstituted variable reached this far.
  // Checked BEFORE anything is resolved against the project directory, because `${X}/data` joined to a root
  // looks contained and is not: what Docker would actually mount depends on a variable nobody read.
  if (/[${}]/.test(mount.source)) {
    throw new MaintenanceRefused(
      'a bind mount in the resolved disposable stack still carries a variable, so where it would point depends '
      + 'on the environment rather than on the definition. Refused.');
  }
  // Compose resolves a relative host side against the project directory. Doing the same here — rather than
  // refusing a relative source outright — keeps this a check on WHERE IT POINTS instead of on how it is typed.
  const source = isAbsolute(mount.source) ? mount.source : resolve(expect.disposableRoot, mount.source);
  const comparable = normalise(source);
  for (const forbidden of FORBIDDEN_BIND_SOURCES) {
    if (comparable === forbidden || comparable.startsWith(`${forbidden}/`)) {
      throw new MaintenanceRefused(
        'the resolved disposable stack binds a host path that IS the host — a Docker socket, a device tree or a '
        + 'system directory. A rehearsal that mounted one could reach every container on this machine.');
    }
  }
  if (expect.workspace === null) {
    throw new MaintenanceRefused(
      'the disposable Compose definition declares a BIND MOUNT. Every bind names a directory on this host, and '
      + 'the shipped stacks bind the production appdata folder — so a rehearsal of a definition carrying one '
      + 'can write to the installation it exists to protect. Declare persistent state as named volumes of this '
      + 'project; this command mounts the restored backup itself, out of a workspace it owns.');
  }
  if (!isInsideOrEqual(source, expect.disposableRoot)) {
    throw new MaintenanceRefused(
      'the resolved disposable stack binds a host path OUTSIDE the disposable rehearsal root. That is the '
      + 'production escape this validation exists to catch: whatever project name is in front of it, a bind '
      + 'mount reaches exactly the directory it names.');
  }
  assertReachedWithoutLink(source);
}

/**
 * Refuse a source reached through a symbolic link.
 *
 * Containment established against a NAME says nothing about where the bytes are: `<root>/x` can be a link to
 * the production appdata directory, and Docker follows it. Every component from the filesystem root down is
 * `lstat`ed, and a link anywhere along it is a refusal.
 */
function assertReachedWithoutLink(source: string): void {
  // Built by walking UP to the filesystem (or drive) root and then back down, so a Windows drive letter and a
  // POSIX leading slash are both handled by the platform's own path rules rather than by string surgery.
  const ancestors: string[] = [];
  let walk = source;
  for (let guard = 0; guard < 128; guard += 1) {
    ancestors.unshift(walk);
    const parent = dirname(walk);
    if (parent === walk) break;
    walk = parent;
  }
  for (const current of ancestors) {
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      // A path Compose would CREATE does not exist yet. That is legitimate for a directory inside the root,
      // and nothing below a name that is not there can be a link.
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new MaintenanceRefused(
        'a bind mount in the resolved disposable stack is reached through a symbolic link, so where it points '
        + 'cannot be established from its path. Refused.');
    }
  }
}

/**
 * A bind's host side as an absolute path, resolved the way Compose resolves it.
 *
 * Safe to call only after `assertBindIsOurs` has run over the same mount — which every path into it has, since
 * the per-mount loop refuses a source carrying a variable before any containment is decided.
 */
function bindSource(mount: ResolvedMount, projectDirectory: string): string {
  return isAbsolute(mount.source) ? mount.source : resolve(projectDirectory, mount.source);
}

function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function samePath(a: string, b: string): boolean {
  const left = normalise(a);
  const right = normalise(b);
  // Windows path comparison is case-insensitive; the shipped deployment is Linux and is compared exactly.
  return left === right || (process.platform === 'win32' && left.toLowerCase() === right.toLowerCase());
}

function isInsideOrEqual(candidate: string, root: string): boolean {
  if (samePath(candidate, root)) return true;
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

function joinInside(root: string, entry: string): string {
  return `${normalise(root)}/${entry.split(/[\\/]/).filter((segment) => segment !== '').join('/')}`;
}
