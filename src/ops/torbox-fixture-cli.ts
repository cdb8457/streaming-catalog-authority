import { writeFileSync } from 'node:fs';
import { createTorBoxFixture, objectBytes } from './torbox-fixture-service.js';
import { createHash } from 'node:crypto';

// The offline TorBox fixture, from the command line.
//
//   serve --token-file F --object ref:size [--object ...] --port N --public-origin URL
//         [--disallowed-origin URL] [--link-lifetime-ms N] [--emit F]
//
// THE TOKEN COMES FROM A FILE, exactly as it does for the real service, so the fixture exercises the same
// handling rather than a shortcut that only the fixture has.

function fail(message: string): never {
  console.error(`torbox-fixture: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const many = (name: string): string[] => {
  const out: string[] = [];
  argv.forEach((token, index) => { if (token === `--${name}`) out.push(argv[index + 1] as string); });
  return out;
};

if ((argv[0] ?? '') !== 'serve') fail('the only command is serve');

const tokenFile = flag('token-file') ?? fail('--token-file is required');
const token = (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim();
if (token === '') fail('the token file is empty');

const objects = many('object').map((raw) => {
  const at = raw.lastIndexOf(':');
  if (at === -1) fail('an --object is ref:size');
  const ref = raw.slice(0, at);
  const sizeBytes = Number(raw.slice(at + 1));
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) fail('an --object size is not a positive integer');
  return { ref, sizeBytes };
});
if (objects.length === 0) fail('at least one --object ref:size is required');

const port = Number(flag('port') ?? '8150');
const publicOrigin = flag('public-origin') ?? `http://127.0.0.1:${port}`;

const fixture = createTorBoxFixture({
  objects,
  token,
  publicOrigin,
  disallowedOrigin: flag('disallowed-origin'),
  linkLifetimeMs: flag('link-lifetime-ms') === undefined ? undefined : Number(flag('link-lifetime-ms')),
});

// THE DESCRIPTOR THE GATE READS. It carries each object's size and the digest of the window the gate will
// compare — computed HERE, outside any mount, which is what makes a mount read falsifiable.
const emit = flag('emit');
if (emit !== undefined) {
  writeFileSync(emit, `${JSON.stringify(objects.map((object, index) => {
    const probeOffset = 1;
    const probeLength = Math.min(65_536, object.sizeBytes - probeOffset);
    return {
      label: `object-${index + 1}`,
      ref: object.ref,
      sizeBytes: object.sizeBytes,
      probeDigests: [{
        offset: probeOffset,
        length: probeLength,
        sha256: createHash('sha256')
          .update(objectBytes(object.ref, probeOffset, probeLength)).digest('hex'),
      }],
    };
  }), null, 2)}\n`);
}

fixture.server.listen(port, '0.0.0.0', () => {
  console.log(`torbox-fixture: listening on 0.0.0.0:${port}, advertising ${publicOrigin}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { fixture.server.close(() => process.exit(0)); });
}
