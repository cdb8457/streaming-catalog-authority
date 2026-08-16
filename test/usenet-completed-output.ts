import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createHarness, assert, assertEq, createFakeClock, createFakeFileSystem, mediaBytes, SMALL_MEDIA_BYTES,
  type FakeNode,
} from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  USENET_MEDIA_EXTENSIONS,
  USENET_RESIDUE_SUFFIXES,
  findAdmissibleOutput,
  proveOutput,
  relativeSegmentsUnderRoot,
  sameFile,
  splitAbsolutePosixPath,
  walkNoFollow,
  type OutputStat,
} from '../src/core/usenet/completed-output.js';
import { USENET_ADMISSION_BOUNDS } from '../src/core/usenet/sab-contract.js';
import { PROJECTION_PROBE_PLAN, probeOffsetsFor } from '../src/core/projection/manifest-v1.js';

// Projection Phase 9 §3, FOURTH DELIVERABLE, and §4's three hardest refusals:
//
//   "publish a path while the worker can still mutate it"
//   "follow a symlink or admit a device, FIFO, socket or directory as media"
//   "infer success from a job disappearing from the queue"
//
// WHY THE FILESYSTEM IS A FAKE HERE AND A REAL ONE IN THE GATE. Half the conditions below cannot be produced
// deterministically on a real filesystem at all: a file that changes size between two stats, a file replaced
// during a read, a rename-over that happens after the digest and before the final check. The other half —
// symlinks, FIFOs, devices — need privileges the developer host may not grant. A fake filesystem makes every
// one of them a two-line setup that runs identically on Windows, macOS and Linux, and `output-fs.ts` is the
// thirty lines the operator gate exercises against a real kernel.

const h = createHarness('Projection Phase 9 — completed-output admission');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const ROOT = '/downloads/complete/projection';
const JOB = ['Some.Job'];
const MEDIA = mediaBytes(SMALL_MEDIA_BYTES);

const dir = (): FakeNode => ({ kind: 'directory' });
const file = (bytes: Buffer): FakeNode => ({ kind: 'file', bytes });

function tree(extra: Readonly<Record<string, FakeNode>> = {}): Record<string, FakeNode> {
  return {
    '/downloads': dir(),
    '/downloads/complete': dir(),
    [ROOT]: dir(),
    [`${ROOT}/Some.Job`]: dir(),
    [`${ROOT}/Some.Job/feature.mkv`]: file(MEDIA),
    ...extra,
  };
}

h.section('paths, split and contained');

test('an absolute POSIX path splits into segments, and anything else is refused', () => {
  const ok = splitAbsolutePosixPath('/a/b/c.mkv');
  assert(ok.ok && ok.value.join('|') === 'a|b|c.mkv', 'a plain path');
  const cases: ReadonlyArray<[string, string]> = [
    ['', 'output-path-not-normalized'],
    ['relative/path', 'output-path-not-normalized'],
    ['/a/b\\c', 'output-path-not-normalized'],
    ['/a//b', 'output-path-not-normalized'],
    ['/a/./b', 'output-path-escapes-root'],
    ['/a/../b', 'output-path-escapes-root'],
    ['/', 'output-path-not-normalized'],
    [`/${'x'.repeat(300)}`, 'output-path-not-normalized'],
    [`/a/${'x'.repeat(5000)}`, 'output-path-not-normalized'],
  ];
  for (const [input, reason] of cases) {
    const result = splitAbsolutePosixPath(input);
    assert(!result.ok, `"${input}" was accepted`);
    assertEq(result.reason, reason as never, `"${input}" reason`);
  }
});

test('a control character or a non-NFC path is refused rather than normalized', () => {
  assert(!splitAbsolutePosixPath('/a/\u0000b').ok, 'a NUL');
  assert(!splitAbsolutePosixPath('/a/b\u0007').ok, 'a BEL');
  const decomposed = '/a/cafe\u0301.mkv';
  assert(!splitAbsolutePosixPath(decomposed).ok, 'a decomposed name is refused rather than composed');
});

test('containment is checked on SEGMENTS, so a prefix that is not a parent is refused', () => {
  const inside = relativeSegmentsUnderRoot('/downloads/complete', '/downloads/complete/job/a.mkv');
  assert(inside.ok && inside.value.join('/') === 'job/a.mkv', 'a path below the root');
  // THE CLASSIC MISTAKE. `startsWith` would accept this one.
  const sibling = relativeSegmentsUnderRoot('/downloads/complete', '/downloads/complete-other/a.mkv');
  assert(!sibling.ok && sibling.reason === 'output-path-escapes-root', 'a sibling directory sharing a prefix');
  const above = relativeSegmentsUnderRoot('/downloads/complete', '/downloads/a.mkv');
  assert(!above.ok, 'a path above the root');
  const equal = relativeSegmentsUnderRoot('/downloads/complete', '/downloads/complete');
  assert(!equal.ok, 'the root itself is not an output below the root');
  const traversal = relativeSegmentsUnderRoot('/downloads/complete', '/downloads/complete/../secrets/a.mkv');
  assert(!traversal.ok && traversal.reason === 'output-path-escapes-root', 'a traversal');
});

h.section('the no-follow walk');

test('a plain path to a regular file is accepted', async () => {
  const fs = createFakeFileSystem(tree());
  const result = await walkNoFollow(fs, ROOT, ['Some.Job', 'feature.mkv'], 'file');
  assert(result.ok, 'a plain file was refused');
  assertEq(result.value.kind, 'file', 'the kind');
});

test('A SYMLINKED PARENT IS REFUSED, which one lstat on the leaf would never have caught', async () => {
  const fs = createFakeFileSystem(tree({ [`${ROOT}/Some.Job`]: { kind: 'symlink' } }));
  const result = await walkNoFollow(fs, ROOT, ['Some.Job', 'feature.mkv'], 'file');
  assert(!result.ok, 'a symlinked parent was walked through');
  assertEq(result.reason, 'output-component-is-symlink', 'the reason');
});

test('a symlinked LEAF is refused rather than resolved', async () => {
  const fs = createFakeFileSystem(tree({ [`${ROOT}/Some.Job/feature.mkv`]: { kind: 'symlink' } }));
  const result = await walkNoFollow(fs, ROOT, ['Some.Job', 'feature.mkv'], 'file');
  assert(!result.ok, 'a symlinked output was followed');
  assertEq(result.reason, 'output-is-symlink', 'the reason');
});

const nonFiles: ReadonlyArray<[OutputStat['kind'], string]> = [
  ['directory', 'output-not-regular-file'],
  ['block-device', 'output-not-regular-file'],
  ['character-device', 'output-not-regular-file'],
  ['fifo', 'output-not-regular-file'],
  ['socket', 'output-not-regular-file'],
  ['unknown', 'output-not-regular-file'],
];

for (const [kind, reason] of nonFiles) {
  test(`a ${kind} named as media is refused as ${reason}`, async () => {
    const fs = createFakeFileSystem(tree({ [`${ROOT}/Some.Job/feature.mkv`]: { kind } }));
    const result = await walkNoFollow(fs, ROOT, ['Some.Job', 'feature.mkv'], 'file');
    assert(!result.ok, `a ${kind} was admitted as media`);
    assertEq(result.reason, reason as never, 'the reason');
  });
}

test('a completed root that is missing, a link, or not a directory is refused before anything is walked', async () => {
  const missing = await walkNoFollow(createFakeFileSystem({}), ROOT, JOB, 'directory');
  assert(!missing.ok && missing.reason === 'output-root-unusable', 'a missing root');
  const linked = await walkNoFollow(createFakeFileSystem({ [ROOT]: { kind: 'symlink' } }), ROOT, JOB, 'directory');
  assert(!linked.ok && linked.reason === 'output-root-unusable', 'a symlinked root');
  const notDir = await walkNoFollow(createFakeFileSystem({ [ROOT]: file(MEDIA) }), ROOT, JOB, 'directory');
  assert(!notDir.ok && notDir.reason === 'output-root-unusable', 'a root that is a file');
});

test('a missing component is output-missing rather than an exception', async () => {
  const fs = createFakeFileSystem(tree());
  const result = await walkNoFollow(fs, ROOT, ['Other.Job', 'feature.mkv'], 'file');
  assert(!result.ok && result.reason === 'output-missing', 'a missing component');
});

h.section('finding the one media file');

test('exactly one publishable file is found under the job directory', async () => {
  const fs = createFakeFileSystem(tree({
    [`${ROOT}/Some.Job/sample`]: dir(),
    [`${ROOT}/Some.Job/readme.txt`]: file(Buffer.alloc(100)),
  }));
  const found = await findAdmissibleOutput(fs, ROOT, JOB);
  assert(found.ok, 'the output was not found');
  assertEq(found.value.segments.join('/'), 'Some.Job/feature.mkv', 'the segments');
});

test('a nested media file is found, and a directory of them is refused as ambiguous', async () => {
  const nested = createFakeFileSystem(tree({
    [`${ROOT}/Some.Job/feature.mkv`]: dir(),
    [`${ROOT}/Some.Job/feature.mkv/inner.mkv`]: file(MEDIA),
  }));
  const found = await findAdmissibleOutput(nested, ROOT, JOB);
  assert(found.ok, 'a nested output was not found');
  assertEq(found.value.segments.join('/'), 'Some.Job/feature.mkv/inner.mkv', 'the nested segments');

  const two = createFakeFileSystem(tree({ [`${ROOT}/Some.Job/second.mkv`]: file(mediaBytes(SMALL_MEDIA_BYTES, 9)) }));
  const ambiguous = await findAdmissibleOutput(two, ROOT, JOB);
  assert(!ambiguous.ok, 'two publishable files were resolved by a heuristic');
  assertEq(ambiguous.reason, 'output-not-uniquely-identified', 'the reason');
});

test('a job with nothing publishable is a named refusal rather than an empty success', async () => {
  const fs = createFakeFileSystem({
    '/downloads': dir(), '/downloads/complete': dir(), [ROOT]: dir(), [`${ROOT}/Some.Job`]: dir(),
    [`${ROOT}/Some.Job/notes.txt`]: file(Buffer.alloc(10)),
  });
  const result = await findAdmissibleOutput(fs, ROOT, JOB);
  assert(!result.ok && result.reason === 'output-not-uniquely-identified', 'nothing publishable');
});

test('a media file below the minimum size is not a candidate, so a sample cannot be published', async () => {
  const fs = createFakeFileSystem({
    '/downloads': dir(), '/downloads/complete': dir(), [ROOT]: dir(), [`${ROOT}/Some.Job`]: dir(),
    [`${ROOT}/Some.Job/sample.mkv`]: file(Buffer.alloc(4096)),
  });
  const result = await findAdmissibleOutput(fs, ROOT, JOB);
  assert(!result.ok && result.reason === 'output-not-uniquely-identified', 'a sample was published');
});

for (const suffix of USENET_RESIDUE_SUFFIXES) {
  test(`an unpack artefact "${suffix}" beside the output is a transient refusal`, async () => {
    const fs = createFakeFileSystem(tree({ [`${ROOT}/Some.Job/leftover${suffix}`]: file(Buffer.alloc(1000)) }));
    const result = await findAdmissibleOutput(fs, ROOT, JOB);
    assert(!result.ok, `${suffix} did not stop the admission`);
    assertEq(result.reason, 'output-unpack-residue', 'the reason');
    assert(result.transient, 'an unpack artefact is worth looking at again');
  });
}

test('the worker may name the FILE rather than the folder, and that is admitted the same way', async () => {
  const fs = createFakeFileSystem(tree());
  const found = await findAdmissibleOutput(fs, ROOT, ['Some.Job', 'feature.mkv']);
  assert(found.ok, 'a worker that named the file directly was refused');
  assertEq(found.value.segments.join('/'), 'Some.Job/feature.mkv', 'the segments');
});

test('a directly-named file that is not media, is residue, or is too small is refused by its own reason', async () => {
  const notMedia = createFakeFileSystem(tree({ [`${ROOT}/Some.Job/notes.txt`]: file(MEDIA) }));
  const a = await findAdmissibleOutput(notMedia, ROOT, ['Some.Job', 'notes.txt']);
  assert(!a.ok && a.reason === 'output-not-uniquely-identified', 'a directly-named non-media file');

  const residue = createFakeFileSystem(tree({ [`${ROOT}/Some.Job/part.rar`]: file(MEDIA) }));
  const b = await findAdmissibleOutput(residue, ROOT, ['Some.Job', 'part.rar']);
  assert(!b.ok && b.reason === 'output-unpack-residue', 'a directly-named archive');

  const tiny = createFakeFileSystem(tree({ [`${ROOT}/Some.Job/sample.mkv`]: file(Buffer.alloc(1024)) }));
  const c = await findAdmissibleOutput(tiny, ROOT, ['Some.Job', 'sample.mkv']);
  assert(!c.ok && c.reason === 'output-empty', 'a directly-named sample');
});

test('a directly-named SYMLINK is still refused as a symlink rather than as an unusable root', async () => {
  const fs = createFakeFileSystem(tree({ [`${ROOT}/Some.Job/feature.mkv`]: { kind: 'symlink' } }));
  const found = await findAdmissibleOutput(fs, ROOT, ['Some.Job', 'feature.mkv']);
  assert(!found.ok, 'a symlinked output was accepted');
  assertEq(found.reason, 'output-is-symlink', 'the reason names what was actually wrong');
});

test('a leftover .nzb does NOT block admission, because it is the operator\'s input and not an artefact', async () => {
  assert(!USENET_RESIDUE_SUFFIXES.includes('.nzb'),
    'an NZB backup written into the completed folder would refuse every job as residue — transiently, so '
    + 'reconciliation would retry it forever and never tell anybody why');
  const fs = createFakeFileSystem(tree({ [`${ROOT}/Some.Job/original.nzb`]: file(Buffer.alloc(2048)) }));
  const found = await findAdmissibleOutput(fs, ROOT, JOB);
  assert(found.ok, 'a leftover NZB blocked the admission');
  assertEq(found.value.segments.join('/'), 'Some.Job/feature.mkv', 'the media file was still found');
});

test('an ordinary sidecar — a .nfo, an .srt, a .jpg — is ignored rather than refused', async () => {
  const fs = createFakeFileSystem(tree({
    [`${ROOT}/Some.Job/feature.nfo`]: file(Buffer.alloc(1024)),
    [`${ROOT}/Some.Job/feature.srt`]: file(Buffer.alloc(4096)),
    [`${ROOT}/Some.Job/poster.jpg`]: file(Buffer.alloc(65_536)),
  }));
  const found = await findAdmissibleOutput(fs, ROOT, JOB);
  assert(found.ok, 'a sidecar blocked the admission');
  assertEq(found.value.segments.join('/'), 'Some.Job/feature.mkv', 'the media file was still found');
});

test('a symlink ANYWHERE under the job directory refuses the whole job', async () => {
  const fs = createFakeFileSystem(tree({ [`${ROOT}/Some.Job/elsewhere`]: { kind: 'symlink' } }));
  const result = await findAdmissibleOutput(fs, ROOT, JOB);
  assert(!result.ok && result.reason === 'output-component-is-symlink', 'a symlink under the job');
});

test('a FIFO under the job directory refuses the job rather than being skipped', async () => {
  const fs = createFakeFileSystem(tree({ [`${ROOT}/Some.Job/pipe`]: { kind: 'fifo' } }));
  const result = await findAdmissibleOutput(fs, ROOT, JOB);
  assert(!result.ok && result.reason === 'output-not-regular-file', 'a FIFO under the job');
});

test('the extension allowlist is short, lower-case and holds no executable or archive', () => {
  for (const extension of USENET_MEDIA_EXTENSIONS) {
    assert(/^[a-z0-9]{2,5}$/.test(extension), `${extension} is not a plain extension`);
  }
  for (const forbidden of ['exe', 'sh', 'rar', 'par2', 'zip', 'js', 'lnk']) {
    assert(!USENET_MEDIA_EXTENSIONS.includes(forbidden), `${forbidden} must not be publishable`);
  }
});

h.section('proving the output');

test('a stable file is proved, with its whole digest and the fixed probe plan', async () => {
  const fs = createFakeFileSystem(tree());
  const clock = createFakeClock();
  const result = await proveOutput(fs, clock, ROOT, ['Some.Job', 'feature.mkv']);
  assert(result.ok, 'a stable file was refused');
  assertEq(result.value.sizeBytes, SMALL_MEDIA_BYTES, 'the size');
  assert(/^[0-9a-f]{64}$/.test(result.value.sha256), 'the digest shape');
  assertEq(result.value.probes.length, probeOffsetsFor(SMALL_MEDIA_BYTES, PROJECTION_PROBE_PLAN.WINDOW_BYTES).length,
    'the probe plan is the one the size implies');
  assertEq(result.value.sealedPath.kind, 'completed-path', 'the path comes back sealed');
  assert(!JSON.stringify(result.value).includes('/downloads/'), 'the proof stringifies without the path');
});

test('THE DWELL HAPPENS, and it is the contract\'s dwell rather than a number chosen here', async () => {
  const fs = createFakeFileSystem(tree());
  const clock = createFakeClock();
  await proveOutput(fs, clock, ROOT, ['Some.Job', 'feature.mkv']);
  assertEq(clock.sleeps().length, USENET_ADMISSION_BOUNDS.STABLE_SAMPLES - 1, 'one dwell per extra sample');
  assertEq(clock.sleeps()[0], USENET_ADMISSION_BOUNDS.STABLE_DWELL_MS, 'the contract\'s dwell');
});

test('a file whose SIZE changes between the two samples is refused as still changing', async () => {
  const nodes = tree();
  const fs = createFakeFileSystem(nodes, {
    beforeStat: (path) => {
      if (path.endsWith('feature.mkv')) {
        fs.set(path, { kind: 'file', bytes: mediaBytes(SMALL_MEDIA_BYTES + growth) });
        growth += 4096;
      }
    },
  });
  let growth = 0;
  const result = await proveOutput(fs, createFakeClock(), ROOT, ['Some.Job', 'feature.mkv']);
  assert(!result.ok, 'a growing file was proved');
  assertEq(result.reason, 'output-still-changing', 'the reason');
  assert(result.transient, 'a file still being written is worth looking at again');
});

test('a file whose MTIME changes between the two samples is refused, even at the same size', async () => {
  const fs = createFakeFileSystem(tree(), {
    beforeStat: (path, sample) => {
      if (path.endsWith('feature.mkv') && sample > 4) {
        fs.set(path, { kind: 'file', bytes: MEDIA, mtimeMs: 1_800_000_000_000 });
      }
    },
  });
  const result = await proveOutput(fs, createFakeClock(), ROOT, ['Some.Job', 'feature.mkv']);
  assert(!result.ok && result.reason === 'output-still-changing', 'an mtime move was not caught');
});

test('a file whose INODE changes between the two samples is refused — an atomic replace', async () => {
  const fs = createFakeFileSystem(tree(), {
    beforeStat: (path, sample) => {
      if (path.endsWith('feature.mkv') && sample > 4) fs.set(path, { kind: 'file', bytes: MEDIA, ino: '999999' });
    },
  });
  const result = await proveOutput(fs, createFakeClock(), ROOT, ['Some.Job', 'feature.mkv']);
  assert(!result.ok && result.reason === 'output-still-changing', 'an inode move was not caught');
});

test('A FILE REPLACED WHILE IT IS BEING READ is refused by the descriptor\'s own stat', async () => {
  const fs = createFakeFileSystem(tree(), {
    duringDigest: (path) => { fs.set(path, { kind: 'file', bytes: mediaBytes(SMALL_MEDIA_BYTES, 99), ino: '424242' }); },
  });
  const result = await proveOutput(fs, createFakeClock(), ROOT, ['Some.Job', 'feature.mkv']);
  assert(!result.ok, 'a file replaced during the read was proved');
  assertEq(result.reason, 'output-mutated-during-digest', 'the reason');
});

test('a file that vanishes while it is being read is refused rather than throwing', async () => {
  const fs = createFakeFileSystem(tree(), {
    duringDigest: (path) => { fs.remove(path); },
  });
  const result = await proveOutput(fs, createFakeClock(), ROOT, ['Some.Job', 'feature.mkv']);
  assert(!result.ok && result.reason === 'output-mutated-during-digest', 'a vanishing file');
});

test('a file with a SECOND HARD LINK is refused, because something else can still replace its bytes', async () => {
  const fs = createFakeFileSystem(tree({ [`${ROOT}/Some.Job/feature.mkv`]: { kind: 'file', bytes: MEDIA, nlink: 2 } }));
  const result = await proveOutput(fs, createFakeClock(), ROOT, ['Some.Job', 'feature.mkv']);
  assert(!result.ok, 'a multiply-linked file was proved');
  assertEq(result.reason, 'output-multiply-linked', 'the reason');
  assert(!result.transient, 'a second hard link is not a transient condition');
});

test('a file below the minimum and one above the maximum are both refused, by their own reasons', async () => {
  const small = createFakeFileSystem(tree({ [`${ROOT}/Some.Job/feature.mkv`]: file(Buffer.alloc(1024)) }));
  const smallResult = await proveOutput(small, createFakeClock(), ROOT, ['Some.Job', 'feature.mkv']);
  assert(!smallResult.ok && smallResult.reason === 'output-empty', 'a tiny file');

  const huge = createFakeFileSystem(tree({
    [`${ROOT}/Some.Job/feature.mkv`]: { kind: 'file', bytes: Buffer.alloc(0) },
  }));
  huge.set(`${ROOT}/Some.Job/feature.mkv`, {
    kind: 'file', bytes: { byteLength: USENET_ADMISSION_BOUNDS.MAX_OUTPUT_BYTES + 1 } as unknown as Buffer,
  });
  const hugeResult = await proveOutput(huge, createFakeClock(), ROOT, ['Some.Job', 'feature.mkv']);
  assert(!hugeResult.ok && hugeResult.reason === 'output-too-large', 'an implausibly large file');
});

h.section('the stat comparison itself');

test('sameFile agrees only when kind, device, inode, size and mtime all agree', () => {
  const base: OutputStat = { kind: 'file', sizeBytes: 10, dev: '1', ino: '2', mtimeMs: 3, nlink: 1 };
  assert(sameFile(base, { ...base }), 'identical');
  assert(!sameFile(base, { ...base, sizeBytes: 11 }), 'size');
  assert(!sameFile(base, { ...base, ino: '3' }), 'inode');
  assert(!sameFile(base, { ...base, dev: '2' }), 'device');
  assert(!sameFile(base, { ...base, mtimeMs: 4 }), 'mtime');
  assert(!sameFile(base, { ...base, kind: 'symlink' }), 'kind');
});

h.section('the real filesystem adapter');

test('the real adapter lstats rather than stats, and opens with O_NOFOLLOW', () => {
  const source = read('src/core/usenet/output-fs.ts');
  assert(source.includes('fsPromises.lstat'), 'the adapter does not lstat');
  assert(!/fsPromises\.stat\(/.test(source), 'the adapter stats a path, which describes a symlink\'s TARGET');
  assert(source.includes('O_NOFOLLOW'), 'the adapter opens without O_NOFOLLOW, so a link swapped in after the '
    + 'walk is followed silently');
  assert(source.includes('handle.stat('), 'the adapter does not stat the descriptor it actually read from');
});

test('the real adapter computes the whole digest and the probes in ONE pass', () => {
  const source = read('src/core/usenet/output-fs.ts');
  assertEq((source.match(/handle\.read\(/g) ?? []).length, 1, 'more than one read loop means more than one pass');
});

h.section('wiring');

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/usenet-completed-output.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'usenet-completed-output.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();
