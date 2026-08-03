import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  HOST_REQUIREMENTS, TRAVERSABLE_MODE, checkPropagation, traversalProblems,
} from '../core/projection/host-preflight.js';

// The host preflight every data-plane gate runs before it starts a container.
//
// WHY ONE CLI FOR THREE GATES. The three gates differ in which media server they drive and agree in every
// assumption they make about the machine underneath them — the same `rshared` bind, the same run directory
// handed to a container uid that did not create it, the same host-side Node. Three copies of this check would
// be three places for it to drift, and the drift would be invisible until an operator's run failed.
//
// IT RUNS BEFORE ANYTHING IS BUILT OR STARTED. A gate that discovers its host cannot host it after building
// an image, migrating a database and encoding four minutes of video has wasted the operator's time to learn
// something it could have said in a second.
//
//   propagation --path P [--require]   can a bind of P be `rshared`?
//   traversal   --path P [--path Q]    can a container uid that did not create these traverse them?
//   requirements                       what an operator's host has to have, and how to check each
//
// EXIT STATUS IS THE POINT. `propagation --require` exits non-zero when the answer is `not-shared`, because
// that is a run that would die at its first container; it exits ZERO on `undetermined`, because Docker
// Desktop cannot be measured this way and demonstrably works. The distinction is deliberate and is the whole
// reason the verdict has three values rather than two.

function fail(message: string): never {
  console.error(`projection-host-preflight: ${message}`);
  process.exit(1);
}

interface Args { readonly command: string; readonly flags: ReadonlyMap<string, string[]> }

function parseArgs(argv: readonly string[]): Args {
  const command = argv[0] ?? '';
  const flags = new Map<string, string[]>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`);
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    if (eq === -1 && (argv[index + 1] === undefined || (argv[index + 1] as string).startsWith('--'))) {
      flags.set(name, [...(flags.get(name) ?? []), '']);
      continue;
    }
    const value = eq === -1 ? (argv[++index] as string) : token.slice(eq + 1);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { command, flags };
}

/**
 * The host's mount table, or `undefined` where there is none.
 *
 * `undefined` IS NOT AN ERROR AND MUST NOT BECOME ONE. A Windows host has no `/proc/self/mountinfo`, and the
 * gates pass there — so a preflight that treated its absence as a failure would break the only environment
 * this has ever run in, to enforce a rule about an environment it has never run in.
 */
function readMountInfo(): string | undefined {
  try {
    if (!existsSync('/proc/self/mountinfo')) return undefined;
    return readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return undefined;
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'propagation': {
      const path = args.flags.get('path')?.[0];
      if (path === undefined || path === '') fail('--path is required');
      const check = checkPropagation(path, readMountInfo());

      if (check.verdict === 'shared') {
        console.log(`  the working directory is on ${check.filesystem} at ${check.mountPoint}, propagation `
          + `${check.propagation}: a bind of it may be rshared`);
        return;
      }
      if (check.verdict === 'undetermined') {
        // NOT A PASS, AND NOT A FAILURE EITHER. It is stated on stderr so it appears in a transcript, and it
        // says what it did not establish rather than staying quiet and looking like a clean check.
        console.error(`  NOTE: mount propagation was NOT verified. ${check.problem}`);
        return;
      }
      console.error('HOST PREFLIGHT FAILED: the daemon container cannot start on this host.');
      console.error('');
      console.error(`  ${check.problem}`);
      console.error('');
      // REFUSING IS ONLY OPTIONAL WHERE THE CALLER SAYS SO. A gate asks with `--require`; a person asking
      // "would this host work?" wants the diagnosis without a non-zero status.
      if ((args.flags.get('require') ?? []).length > 0) process.exit(1);
      return;
    }

    case 'traversal': {
      // THE DIRECTORIES ARE STAT'ED HERE AND JUDGED BY A PURE FUNCTION, so the hostile shapes can be tested
      // without creating them on a filesystem that may not have modes worth speaking of.
      const paths = args.flags.get('path') ?? [];
      if (paths.length === 0) fail('at least one --path is required');

      // A HOST WITHOUT POSIX MODES CANNOT BE ASKED THIS QUESTION, AND MUST NOT BE ANSWERED ANYWAY.
      //
      // THIS CHECK'S OWN FIRST RUN CAUGHT IT: on Windows, Node reports a directory as mode `666` — no execute
      // bit for anybody, because NTFS has no such bit to report. Judged as a POSIX mode that reads as "no
      // container uid could ever traverse this", so the check failed all three gates on the one host they
      // demonstrably pass on. It was about to enforce a rule about Linux by breaking Windows, which is
      // precisely the shape of defect this whole module exists to stop.
      //
      // So it is three-valued exactly as `propagation` is: authoritative where modes are real, explicitly
      // undetermined where they are not, and never quietly a pass.
      if (process.platform === 'win32') {
        console.error('  NOTE: directory traversal was NOT verified. This host does not carry POSIX modes — '
          + 'Node reports every directory here as 666, which is not a mode a container uid could be judged '
          + 'against. On Docker Desktop that is harmless: the host side of a bind carries no modes at all, so '
          + 'the container uid is not gated by them. On a Linux or Unraid host this check runs for real, and '
          + 'a check that did not run is not a check that passed');
        return;
      }
      const directories: Array<{ path: string; mode: number }> = [];
      for (const path of paths) {
        if (!existsSync(path)) fail(`${path} does not exist, so its traversability cannot be checked`);
        directories.push({ path, mode: statSync(path).mode & 0o777 });
      }
      const problems = traversalProblems(directories);
      if (problems.length === 0) {
        console.log(`  ${directories.length} director(ies) are traversable by a container uid that did not `
          + 'create them');
        return;
      }
      console.error('HOST PREFLIGHT FAILED: a container uid could not reach into the run directory.');
      console.error('');
      for (const problem of problems) console.error(`  ${problem}`);
      console.error('');
      console.error(`  The gate makes these ${TRAVERSABLE_MODE.toString(8)} itself; if they are not, the `
        + 'chmod did not run or something changed them afterwards.');
      process.exit(1);
      return;
    }

    case 'requirements': {
      console.log('What a host must have for a projection data-plane gate to run on it:');
      console.log('');
      for (const requirement of HOST_REQUIREMENTS) {
        console.log(`  ${requirement.id}: ${requirement.what}`);
        console.log(`      why:   ${requirement.why}`);
        console.log(`      check: ${requirement.probe}`);
        console.log('');
      }
      return;
    }

    default:
      fail(`unknown command: ${args.command || '(none)'}`);
  }
}

main();
