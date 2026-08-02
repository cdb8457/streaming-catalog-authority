import { readFileSync } from 'node:fs';
import {
  deriveProjectedEntryId,
  normalizeProjectedPath,
  type ProjectionDegradedReason,
  type ProjectionSourceKind,
} from '../core/projection/manifest-v1.js';
import {
  degradeEntry, registerEntry, registerRoot, registerVersion, restoreEntry, retireEntry,
  RegistrationError, withRegistry, type ProbeInput, type SourceRegistration,
} from '../core/projection/source-registry.js';

// The projection source registry, from the command line.
//
//   npm run ops:projection-register -- root    --id media --kind local
//   npm run ops:projection-register -- version --key movie-a --size 3145728 --mtime 2026-06-01T10:00:00.000Z \
//                                              [--probe head:0:1048576:<sha256> ...]
//   npm run ops:projection-register -- entry   --item <uuid> --version-key movie-a --path "Movies/A/A.bin" \
//                                              --source local:media:a.bin [--source http-range:vault:obj-a]
//   npm run ops:projection-register -- batch   --file corpus.json
//                                              { "versions": [{ "key", "size", "mtime", "probes": [...] }],
//                                                "entries":  [{ "item", "versionKey", "path", "sources" }] }
//   npm run ops:projection-register -- retire  --path "Movies/A/A.bin" --intent-key drop-a \
//                                              --declared-at <ts> --grace <ts>
//   npm run ops:projection-register -- degrade --path "Movies/A/A.bin" --reason source-unreachable --since <ts>
//   npm run ops:projection-register -- restore --path "Movies/A/A.bin"
//
// THIS IS THE ONLY WRITE PATH. The publisher reads; it never registers. Keeping the two apart is what makes
// "the manifest is a picture of what the control plane was told" checkable: everything in a generation was
// asserted here first, by somebody, at a time the database recorded.
//
// A SOURCE IS `kind:rootId:objectRef` AND NOTHING ELSE. There is no field for a URL, a token, a header or an
// expiry, so the shape of the argument makes ephemeral access material unrepresentable rather than merely
// discouraged. `objectRef` may itself contain colons; only the first two are separators.

interface Args {
  readonly command: string;
  readonly flags: ReadonlyMap<string, readonly string[]>;
}

function parseArgs(argv: readonly string[]): Args {
  const command = argv[0] ?? '';
  const flags = new Map<string, string[]>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`);
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    const value = eq === -1 ? argv[++index] : token.slice(eq + 1);
    if (value === undefined) fail(`--${name} needs a value`);
    const list = flags.get(name) ?? [];
    list.push(value);
    flags.set(name, list);
  }
  return { command, flags };
}

function fail(message: string): never {
  console.error(`projection-register: ${message}`);
  process.exit(2);
}

function one(args: Args, name: string): string {
  const values = args.flags.get(name);
  if (values === undefined || values.length !== 1 || values[0] === undefined) fail(`--${name} is required, once`);
  return values[0] as string;
}

function many(args: Args, name: string): readonly string[] {
  return args.flags.get(name) ?? [];
}

/** `position:offset:length:sha256`. The offsets are checked against the size by the registry, not here. */
function parseProbe(raw: string): ProbeInput {
  const parts = raw.split(':');
  if (parts.length !== 4) fail(`a probe is position:offset:length:sha256, not ${parts.length} fields`);
  return {
    position: parts[0] as string,
    offset: Number(parts[1]),
    length: Number(parts[2]),
    sha256: parts[3] as string,
  };
}

/** `kind:rootId:objectRef`. Split on the FIRST two colons: an object reference may contain more. */
function parseSource(raw: string, preference: number): SourceRegistration {
  const firstColon = raw.indexOf(':');
  const secondColon = raw.indexOf(':', firstColon + 1);
  if (firstColon === -1 || secondColon === -1) fail('a source is kind:rootId:objectRef');
  const kind = raw.slice(0, firstColon) as ProjectionSourceKind;
  if (kind !== 'local' && kind !== 'http-range') fail(`unknown source kind: ${kind}`);
  return {
    kind,
    rootId: raw.slice(firstColon + 1, secondColon),
    objectRef: raw.slice(secondColon + 1),
    preference,
  };
}

function entryIdFor(args: Args): string {
  const direct = args.flags.get('entry-id');
  if (direct !== undefined) return direct[0] as string;
  const path = normalizeProjectedPath(one(args, 'path'));
  if (!path.ok) fail(`the path is not normalized: ${path.code ?? 'PATH_INVALID'}`);
  return deriveProjectedEntryId(path.path as string);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  await withRegistry(async (db) => {
    switch (args.command) {
      case 'root': {
        const kind = one(args, 'kind') as ProjectionSourceKind;
        await registerRoot(db, one(args, 'id'), kind);
        console.log(JSON.stringify({ registered: 'root', rootId: one(args, 'id'), kind }));
        return;
      }
      case 'version': {
        const probes = many(args, 'probe').map(parseProbe);
        const versionId = await registerVersion(db, {
          versionKey: one(args, 'key'),
          sizeBytes: Number(one(args, 'size')),
          mtime: one(args, 'mtime'),
          probes: probes.length === 0 ? null : probes,
        });
        console.log(JSON.stringify({ registered: 'version', projectedVersionId: versionId, probes: probes.length }));
        return;
      }
      case 'entry': {
        const sources = many(args, 'source').map((raw, index) => parseSource(raw, index));
        if (sources.length === 0) fail('--source is required at least once');
        const entryId = await registerEntry(db, {
          itemId: one(args, 'item'),
          versionKey: one(args, 'version-key'),
          path: one(args, 'path'),
          sources,
        });
        console.log(JSON.stringify({ registered: 'entry', projectedEntryId: entryId, sources: sources.length }));
        return;
      }
      case 'retire': {
        const entryId = entryIdFor(args);
        const intentId = await retireEntry(db, entryId, {
          intentKey: one(args, 'intent-key'),
          declaredAt: one(args, 'declared-at'),
          graceDeadline: one(args, 'grace'),
        });
        console.log(JSON.stringify({ registered: 'retirement', projectedEntryId: entryId, deletionIntentId: intentId }));
        return;
      }
      case 'degrade': {
        const entryId = entryIdFor(args);
        await degradeEntry(db, entryId, one(args, 'reason') as ProjectionDegradedReason, one(args, 'since'));
        console.log(JSON.stringify({ registered: 'degraded', projectedEntryId: entryId }));
        return;
      }
      case 'restore': {
        const entryId = entryIdFor(args);
        await restoreEntry(db, entryId);
        console.log(JSON.stringify({ registered: 'available', projectedEntryId: entryId }));
        return;
      }
      case 'batch': {
        // THE SAME WRITE PATH, ONCE PER PROCESS INSTEAD OF ONCE PER ROW.
        //
        // WHY THIS EXISTS. The acceptance plan's corpus is ~50 entries. Registering it a flag at a time costs
        // a hundred Node starts and several minutes before a gate has done anything, which is the kind of
        // cost that ends with somebody quietly shrinking the corpus until the gate is fast — and a
        // fifty-entry gate run against five entries is the failure this whole tranche exists to stop.
        //
        // WHAT IT IS NOT. It is not a second write path, and that is deliberate: it calls `registerVersion`
        // and `registerEntry`, in order, exactly as the single-row commands do. There is no bulk insert, no
        // second validation and no way to register something through here that the flags could not register.
        // If it grew one, the registry would have two ideas of what a valid registration is and one of them
        // would drift.
        const parsed = JSON.parse(readFileSync(one(args, 'file'), 'utf8')) as {
          versions?: Array<{ key: string; size: number; mtime: string; probes?: string[] }>;
          entries?: Array<{ item: string; versionKey: string; path: string; sources: string[] }>;
        };
        let versions = 0;
        for (const version of parsed.versions ?? []) {
          const probes = (version.probes ?? []).map(parseProbe);
          await registerVersion(db, {
            versionKey: version.key,
            sizeBytes: version.size,
            mtime: version.mtime,
            probes: probes.length === 0 ? null : probes,
          });
          versions += 1;
        }
        let entries = 0;
        for (const entry of parsed.entries ?? []) {
          await registerEntry(db, {
            itemId: entry.item,
            versionKey: entry.versionKey,
            path: entry.path,
            sources: entry.sources.map((raw, index) => parseSource(raw, index)),
          });
          entries += 1;
        }
        console.log(JSON.stringify({ registered: 'batch', versions, entries }));
        return;
      }
      default:
        fail('usage: root | version | entry | batch | retire | degrade | restore');
    }
  });
}

main().catch((error: unknown) => {
  // A registration problem is a CODE, never the value that caused it: a path, a locator or an object
  // reference must not reach a log line, here or anywhere else in this repository.
  if (error instanceof RegistrationError) {
    console.error(`projection-register: refused (${error.code}): ${error.message}`);
    process.exit(3);
  }
  console.error(`projection-register: ${(error as Error).message}`);
  process.exit(1);
});
