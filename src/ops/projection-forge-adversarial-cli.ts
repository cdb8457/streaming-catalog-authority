import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  deriveGenerationId,
  manifestContentDigest,
  manifestDigestOfBytes,
  serializeManifestArtifact,
  type ProjectionManifestV1,
} from '../core/projection/manifest-v1.js';
import { readPointer, serializePointer, writeDurable, POINTER_FILE_NAME }
  from '../core/projection/artifact-store.js';

// A GATE TOOL THAT AUTHORS GENERATIONS THE PRODUCER REFUSES TO AUTHOR.
//
// WHY IT HAS TO EXIST. The publisher cannot build a shrinking, relocating or malformed generation — the whole
// point of it is that those are unreachable, and the unit and database suites prove each one is refused at the
// producer. But "the producer cannot emit it" is a different claim from "the daemon would refuse it if
// something else did", and the second is the one that matters when a manifest directory can be written to by
// anything with the credential. So this tool forges exactly the generations a compromised or broken producer
// would emit, publishes them the way a real producer would, and the gate asserts the mount did not move.
//
// IT IS NOT A PRODUCT SURFACE. It is not in `package.json` as an `ops:` script, it is not referenced by any
// runbook, and it writes nothing a recovery pass cannot undo — running the production publisher afterwards
// repairs the pointer from PostgreSQL, which is itself part of what the gate proves.
//
// IT USES THE CONTRACT'S OWN SERIALIZATION. A forged artifact has to be byte-exact in every way EXCEPT the one
// thing being tested, or the daemon refuses it for the wrong reason and the gate proves nothing. So the bytes
// come from `serializeManifestArtifact` and the digests from `manifestDigestOfBytes`, not from a second
// implementation that could drift.

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function fail(message: string): never {
  console.error(`projection-forge: ${message}`);
  process.exit(2);
}

const dir = flag('manifest-dir') ?? fail('--manifest-dir is required');
const mode = flag('mode') ?? fail('--mode is required');

const published = readPointer(dir);
if (published === null) fail('there is no published pointer to forge a successor to');
const pointer = published;

const currentBytes = readFileSync(join(dir, pointer.artifactName));
const current = JSON.parse(currentBytes.toString('utf8')) as ProjectionManifestV1;

/** Everything a forged successor shares with an honest one: the chain, the provenance, the clock. */
function successor(entries: ProjectionManifestV1['entries'], deletions: readonly string[] = []):
ProjectionManifestV1 {
  const sequence = current.generation.sequence + 1;
  const contentDigest = manifestContentDigest('routine', entries, deletions);
  return {
    ...current,
    generation: {
      ...current.generation,
      generationId: deriveGenerationId(sequence, contentDigest, pointer.manifestDigest),
      sequence,
      createdAt: new Date(Date.parse(current.generation.createdAt) + 60_000).toISOString(),
      predecessor: {
        generationId: current.generation.generationId,
        sequence: current.generation.sequence,
        manifestDigest: pointer.manifestDigest,
      },
      admission: { ...current.generation.admission, entryCount: entries.length, deletions: [...deletions] },
    },
    entries,
  };
}

function publish(manifest: ProjectionManifestV1): void {
  const artifact = serializeManifestArtifact(manifest);
  const name = `generation-${manifest.generation.sequence}-${manifest.generation.generationId.slice(4)}.json`;
  writeDurable(dir, name, artifact);
  writeDurable(dir, POINTER_FILE_NAME, serializePointer({
    generationId: manifest.generation.generationId,
    sequence: manifest.generation.sequence,
    artifactName: name,
    artifactBytes: artifact.length,
    manifestDigest: manifestDigestOfBytes(artifact),
  }));
  console.log(JSON.stringify({ forged: mode, sequence: manifest.generation.sequence, artifactName: name }));
}

switch (mode) {
  // A generation that simply loses an entry, with no deletion intent behind it. This is what a failed or
  // short scan looks like, and it is the single failure this whole design exists to make impossible.
  case 'drop-entry': {
    if (current.entries.length < 2) fail('need at least two entries to drop one');
    publish(successor(current.entries.slice(1)));
    break;
  }
  // A carried entry at a different path. v1 has no relocation: a corrected path is a delete and an add.
  case 'relocate-path': {
    const [first, ...rest] = current.entries;
    if (first === undefined) fail('there are no entries to relocate');
    publish(successor([{ ...first, path: `${first.path}.relocated` }, ...rest]));
    break;
  }
  // Bytes that are not a manifest at all, published under a pointer that names them honestly.
  case 'malformed': {
    const artifact = Buffer.from('{ "format": "catalog-authority.projection-manifest", "version": 1, "gene\n', 'utf8');
    const name = `generation-${current.generation.sequence + 1}-forged-malformed.json`;
    writeDurable(dir, name, artifact);
    writeDurable(dir, POINTER_FILE_NAME, serializePointer({
      generationId: current.generation.generationId.replace(/.$/, '0'),
      sequence: current.generation.sequence + 1,
      artifactName: name,
      artifactBytes: artifact.length,
      manifestDigest: manifestDigestOfBytes(artifact),
    }));
    console.log(JSON.stringify({ forged: mode, artifactName: name }));
    break;
  }
  // A pointer claiming an artifact larger than the contract's bound. It is refused BEFORE anything is read,
  // which is why proving it needs no 256 MiB file.
  case 'oversize-pointer': {
    writeDurable(dir, POINTER_FILE_NAME, serializePointer({
      generationId: current.generation.generationId.replace(/.$/, '0'),
      sequence: current.generation.sequence + 1,
      artifactName: pointer.artifactName,
      artifactBytes: 256 * 1024 * 1024 + 1,
      manifestDigest: pointer.manifestDigest,
    }));
    console.log(JSON.stringify({ forged: mode, artifactBytes: 256 * 1024 * 1024 + 1 }));
    break;
  }
  // A pointer whose digest does not describe the artifact it names.
  case 'digest-mismatch': {
    writeDurable(dir, POINTER_FILE_NAME, serializePointer({
      ...pointer,
      sequence: pointer.sequence + 1,
      generationId: current.generation.generationId.replace(/.$/, '0'),
      manifestDigest: `sha256:${'0'.repeat(64)}`,
    }));
    console.log(JSON.stringify({ forged: mode }));
    break;
  }
  default:
    fail('--mode is drop-entry, relocate-path, malformed, oversize-pointer or digest-mismatch');
}
