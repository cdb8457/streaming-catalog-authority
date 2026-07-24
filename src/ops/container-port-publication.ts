// Decide whether a container port is PUBLISHED to a host interface, from Docker's own authoritative record.
//
// `docker compose ps --format '{{.Publishers}}'` reports a service's TARGET (container) port even when there
// is no host binding at all, so grepping its output for "5432" cannot tell an EXPOSED-only port (reachable
// only over the compose network) from a PUBLISHED one (bound to a host port). The distinction lives in the
// container's `NetworkSettings.Ports` map: an exposed-only port maps to `null`, a published one maps to a list
// of `{HostIp, HostPort}` bindings. This module reads exactly that map and answers the only question the
// acceptance orchestrators are actually asking — "is Postgres reachable from the host?" — without ever
// exposing Postgres or printing an address.

export interface DockerHostBinding {
  readonly HostIp?: string | null;
  readonly HostPort?: string | null;
}

/** The shape of `docker inspect --format '{{json .NetworkSettings.Ports}}'`. */
export type DockerPortMap = Record<string, readonly DockerHostBinding[] | null>;

export class ContainerPortPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerPortPublicationError';
  }
}

/**
 * Parse the JSON `docker inspect --format '{{json .NetworkSettings.Ports}}'` prints.
 *
 * `null` and `{}` are both valid and mean "no published ports"; anything else that is not a JSON object is a
 * refusal, so a malformed inspect result fails closed rather than being read as "nothing is published".
 */
export function parseDockerPortMap(json: string): DockerPortMap {
  const text = json.trim();
  if (text === '' || text === 'null') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ContainerPortPublicationError('port map is not valid JSON');
  }
  if (parsed === null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ContainerPortPublicationError('port map is not an object');
  }
  return parsed as DockerPortMap;
}

/**
 * The HOST bindings Docker records for one container port (e.g. "5432/tcp").
 *
 * A binding counts as a host publication only if it actually names a host port or interface: an EXPOSED-only
 * port is `null` here and yields none, and a hypothetical all-empty binding is treated as not-published so the
 * check can never be fooled by one. Any binding that names a HostPort or HostIp — on any address, including
 * loopback — is a real host publication and is returned.
 */
export function hostBindingsForPort(ports: DockerPortMap, port: string): DockerHostBinding[] {
  const binds = ports[port];
  if (!Array.isArray(binds)) return [];
  return binds.filter((bind) => String(bind?.HostPort ?? '') !== '' || String(bind?.HostIp ?? '') !== '');
}

/** True when the container port is bound to at least one host interface/port. */
export function isPortPublishedToHost(ports: DockerPortMap, port: string): boolean {
  return hostBindingsForPort(ports, port).length > 0;
}
