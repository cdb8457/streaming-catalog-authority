import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Is this module the program the user asked to run, or something another module imported?
//
// WHY THIS EXISTS. Every `*-cli.ts` in this repository ends by calling `main()` at the top level. That is
// correct for a program and wrong for a module, and the two are the same file: the moment anything imports a
// CLI — a test reaching for its argument parser, another command reusing a helper — the import RUNS it. The
// importer's own `process.argv` is then parsed as if it were the CLI's, which produced exactly that: a suite
// invoked as `tsx test/catalog-import.ts 5453` made the imported CLI print `unknown option: 5453`, write its
// usage to stderr, and set `process.exitCode = 2` on a process that had done nothing wrong. A suite that
// passes can exit non-zero that way, and one that fails can have its code overwritten — the exit code stops
// meaning what it says.
//
// HOW IT DECIDES. `process.argv[1]` is the script Node was pointed at. If that resolves to this same file,
// this module IS the program; if it resolves to anything else, this module was imported and must stay inert.
//
// IT FAILS CLOSED. Anything unresolvable — no `argv[1]` at all (`node -e`), a path that no longer exists, a
// permission error on the realpath — answers FALSE, so the doubtful case is "do not run". A CLI that
// declines to run when invoked oddly is a visibly missing output; a CLI that runs when it was merely
// imported is a side effect in somebody else's process.
//
// PATHS ARE COMPARED AFTER SYMLINKS, AND CASE-INSENSITIVELY ON WINDOWS. `npm`/`tsx` may hand over a path
// through a symlinked directory or with a differently-cased drive letter than `import.meta.url` carries, and
// a guard that answered "imported" for a real direct run would silently turn a command into a no-op.

/**
 * True when `moduleUrl` names the file Node was asked to execute.
 *
 * Call it with `import.meta.url` from a CLI's top level:
 *
 * ```ts
 * if (isDirectRun(import.meta.url)) { main().then(...); }
 * ```
 */
export function isDirectRun(moduleUrl: string, argv: readonly string[] = process.argv): boolean {
  const entry = argv[1];
  if (entry === undefined || entry === '') return false;
  const self = canonical(fileURLToPath(moduleUrl));
  const invoked = canonical(resolve(entry));
  if (self === null || invoked === null) return false;
  return self === invoked;
}

/** Resolve symlinks and normalise for comparison, or `null` when the path cannot be resolved at all. */
function canonical(path: string): string | null {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }
  const normalized = real.replace(/\\/g, '/');
  // Windows and macOS resolve paths case-insensitively; comparing case-sensitively there would report a real
  // direct run as an import and silently do nothing.
  return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized;
}
