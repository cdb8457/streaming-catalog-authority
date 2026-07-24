// The YAML reader used across these suites now lives in src/ops/minimal-yaml.ts, so the release-readiness
// proof (Phase 250) shares the exact parser the tests exercise rather than a second copy that could drift.
// This module re-exports it unchanged, so every existing `./helpers/compose-yaml.js` import keeps working.
export {
  ComposeYamlError,
  parseYaml,
  yamlStrings,
  parseMount,
  asMap,
  asList,
  stringList,
  service,
  type YamlValue,
  type YamlMap,
  type ComposeMount,
} from '../../src/ops/minimal-yaml.js';
