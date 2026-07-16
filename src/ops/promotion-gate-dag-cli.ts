import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyGateDag } from './promotion-gate-dag.js';

// Offline gate-DAG CLI. Verifies the Phase 230 gate dependency graph is acyclic and every dependency
// resolves. Never promotes, never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-gate-dag [--out <dag.json>]',
    '',
    'Local, non-live: emits the redaction-safe gate DAG + topological order. Exit 0 = acyclic/valid, 1 = problem.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const dag = verifyGateDag();
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(dag, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-gate-dag-capture',
    ok: dag.ok,
    acyclic: dag.acyclic,
    nodeCount: dag.nodeCount,
    redactionSafe: true,
    topoOrder: dag.topoOrder,
    problems: dag.problems,
    dagDigest: dag.dagDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return dag.ok ? 0 : 1;
}

process.exit(main());
