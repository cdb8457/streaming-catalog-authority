import sys, io

base, doc = sys.argv[1], sys.argv[2]

def patch(path, replacements, count_required=None):
    with io.open(path, 'r', encoding='utf-8') as f:
        s = f.read()
    for old, new in replacements:
        n = s.count(old)
        if n == 0:
            raise SystemExit(f"ANCHOR NOT FOUND in {path}: {old!r}")
        s = s.replace(old, new)
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(s)

# 1) package.json: scripts + gate (both aggregate `test` and `test:phase230-local`)
patch('package.json', [
    ('    "test:promotion-live-boundary-guard": "tsx test/promotion-live-boundary-guard.ts",',
     f'    "ops:{base}": "tsx src/ops/{base}-cli.ts",\n'
     f'    "test:{base}": "tsx test/{base}.ts",\n'
     f'    "test:promotion-live-boundary-guard": "tsx test/promotion-live-boundary-guard.ts",'),
    ('&& tsx test/promotion-live-boundary-guard.ts',
     f'&& tsx test/{base}.ts && tsx test/promotion-live-boundary-guard.ts'),
])

# 2) suite manifest LOCAL_SUITES
patch('test/phase230-local-suite-manifest.ts', [
    ("  'test/promotion-live-boundary-guard.ts',",
     f"  'test/{base}.ts',\n  'test/promotion-live-boundary-guard.ts',"),
])

# 3) live-boundary guard: sources + docs
patch('test/promotion-live-boundary-guard.ts', [
    ('\n];\n\nconst FORBIDDEN_LIVE_HOOKS',
     f"\n  'src/ops/{base}.ts', 'src/ops/{base}-cli.ts',\n];\n\nconst FORBIDDEN_LIVE_HOOKS"),
    ("\n];\n\nconsole.log('Running Phase 230 live-boundary guard",
     f"\n  'docs/{doc}.md',\n];\n\nconsole.log('Running Phase 230 live-boundary guard"),
])

# 4) LOCAL_OPS_REGISTRY
patch('src/ops/promotion-acceptance-meta.ts', [
    ('\n];\n\nexport interface OpMetaCheck',
     f"\n  {{ base: '{base}', doc: '{doc}' }},\n];\n\nexport interface OpMetaCheck"),
])

# 5) closure index table
patch('docs/PHASE_230_LOCAL_CLOSURE_INDEX.md', [
    ('\n\n## Test-only local suites',
     f"\n| `{base}` | {doc} |\n\n## Test-only local suites"),
])

print(f"wired {base}")
