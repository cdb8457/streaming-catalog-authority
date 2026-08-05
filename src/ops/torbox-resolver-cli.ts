import { createResolverService, readSecretFile, CredentialError } from './torbox-resolver-service.js';
import { findSecretShapes } from '../core/adapters/torbox-resolver.js';

// The TorBox resolver service, from the command line.
//
//   serve      --credential F --gate-secret F [--host 127.0.0.1] [--port 8140] [--api-origin URL]
//                [--fixture-plaintext-link]   OFFLINE FIXTURE ONLY; refuses plaintext without it
//   preflight  --credential F --gate-secret F
//                checks both files exist, are regular, are non-empty and are mode 0600 — and CONTACTS NOTHING
//
// EVERY SECRET ARRIVES AS A FILE PATH. argv is world-readable: `ps` shows it to every user on the host for
// as long as the process lives, and on this endpoint family the credential is a URL query parameter, so a
// leak here is a leak of the operator's whole TorBox account.

function fail(message: string): never {
  console.error(`torbox-resolver: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const command = argv[0] ?? '';

function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function need(name: string): string {
  const value = flag(name);
  if (value === undefined || value === '') fail(`--${name} is required`);
  return value;
}

// ARGV IS CHECKED BEFORE ANYTHING ELSE HAPPENS. An operator following the template cannot leak a secret; an
// operator improvising can, and the failure is silent and permanent — it is in the shell history and in
// every process listing taken while the service ran.
const argvLeaks = findSecretShapes(argv.join(' '), 'argv');
if (argvLeaks.length > 0) {
  console.error('torbox-resolver: the command line carries something that must never be there:');
  for (const leak of argvLeaks) console.error(`  ${leak.kind}`);
  console.error('  Every credential and reference is passed as a FILE PATH. argv is world-readable.');
  process.exit(1);
}

switch (command) {
  case 'preflight': {
    try {
      readSecretFile(need('credential'), 'TorBox credential');
      readSecretFile(need('gate-secret'), 'gate secret');
    } catch (error) {
      fail(error instanceof CredentialError ? error.message : 'a credential file is not usable');
    }
    console.log('  PREFLIGHT PASSED — both secret files exist, are regular, are non-empty and are mode 0600.');
    console.log('  Nothing was contacted. This says nothing about whether the credential is VALID, which');
    console.log('  only a real request can answer.');
    break;
  }

  case 'serve': {
    const host = flag('host') ?? '127.0.0.1';
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
      fail('this service binds loopback only; a resolver reachable off-host is a credential oracle');
    }
    const port = Number(flag('port') ?? '8140');
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) fail('--port is not a port');

    const config = {
      host,
      port,
      credentialFile: need('credential'),
      gateSecretFile: need('gate-secret'),
      apiOrigin: flag('api-origin'),
      // OFFLINE FIXTURE ONLY, and opt-in. Omitted, a plaintext CDN link is refused.
      allowPlaintextLink: argv.includes('--fixture-plaintext-link'),
    };
    // FAIL CLOSED AT STARTUP. A service that came up and then refused every request would look healthy to a
    // supervisor and be useless to a reader.
    try {
      readSecretFile(config.credentialFile, 'TorBox credential');
      readSecretFile(config.gateSecretFile, 'gate secret');
    } catch (error) {
      fail(error instanceof CredentialError ? error.message : 'a credential file is not usable');
    }

    const server = createResolverService(config);
    server.listen(port, host, () => {
      console.log(`torbox-resolver: listening on ${host}:${port}, POST /resolve`);
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => { server.close(() => process.exit(0)); });
    }
    break;
  }

  default:
    fail(`unknown command: ${command || '(none)'} — expected serve or preflight`);
}
