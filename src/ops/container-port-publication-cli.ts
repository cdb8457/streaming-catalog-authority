import {
  ContainerPortPublicationError,
  hostBindingsForPort,
  isPortPublishedToHost,
  parseDockerPortMap,
} from './container-port-publication.js';

// Reads the JSON port map on stdin — the output of
//   docker inspect --format '{{json .NetworkSettings.Ports}}' <container>
// — and decides whether the given port is published to a host interface.
//
//   exit 0  the port has NO host binding (internal to the compose network only) — the safe state
//   exit 1  the port IS bound to a host interface — the acceptance orchestrators treat this as a failure
//   exit 2  the input could not be read as a port map — fail closed, never "assume nothing is published"
//
// It prints only a bounded verdict and the port asked about. It never prints the port map, a host address, or
// anything that could be a secret, so it is safe to run in a CI log.

interface ParsedArgs {
  readonly port: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let port: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--port') {
      port = argv[index + 1];
      index += 1;
      continue;
    }
  }
  if (port === undefined || port.trim() === '') {
    throw new ContainerPortPublicationError('--port <port/proto> is required (for example: --port 5432/tcp)');
  }
  return { port };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  try {
    const { port } = parseArgs(process.argv.slice(2));
    const ports = parseDockerPortMap(await readStdin());
    if (isPortPublishedToHost(ports, port)) {
      // The count only — never the address that would say WHICH interface it is bound to.
      const count = hostBindingsForPort(ports, port).length;
      process.stderr.write(`PUBLISHED: ${port} is bound to ${count} host interface(s)\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`INTERNAL_ONLY: ${port} has no host binding\n`);
  } catch (err) {
    process.stderr.write(`container port publication check failed: ${(err as Error).message}\n`);
    process.exitCode = 2;
  }
}

void main();
