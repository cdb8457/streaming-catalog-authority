import { ConfigError, resolveVar, type Env } from '../../config/env.js';
import type { PublisherAdapter, PublishableField } from './publisher.js';
import { FakePublisherAdapter } from './fake-publisher.js';

/**
 * Phase 8 — publisher selection (mirrors the ref-resolver adapter + custodian factories).
 *
 * `PUBLISHER_MODE`: `fake` (the local reference publisher) | `none` (no publisher; the default when
 * unset). Publishing is OPT-IN — with no publisher, identity never crosses the publisher boundary.
 * Unknown modes FAIL CLOSED (`ConfigError`). No real media servers, no network — Phase 8 ships only
 * the local fake, and real external publishing is a deferred policy gate (crypto-shredding conflict).
 */
export type PublisherMode = 'none' | 'fake';
export type PublisherConfig = { mode: 'none' } | { mode: 'fake'; requires?: ReadonlyArray<PublishableField> };

const SUPPORTED_MODES: readonly PublisherMode[] = ['none', 'fake'];

/** Parse + validate `PUBLISHER_MODE` (default `none`). Unknown values throw {@link ConfigError}. */
export function loadPublisherConfig(env: Env = process.env): PublisherConfig {
  const problems: string[] = [];
  const modeVar = resolveVar(env, 'PUBLISHER_MODE');
  if (modeVar.problem) problems.push(modeVar.problem);
  const mode = modeVar.value ?? 'none'; // unset -> no publisher configured
  if (!modeVar.problem && !SUPPORTED_MODES.includes(mode as PublisherMode)) {
    problems.push(`PUBLISHER_MODE must be one of: ${SUPPORTED_MODES.join(', ')} (got "${mode}")`);
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return mode === 'fake' ? { mode: 'fake' } : { mode: 'none' };
}

/**
 * Construct a {@link PublisherAdapter} (or null for `none`). Unknown/unsupported modes FAIL CLOSED
 * with a {@link ConfigError}.
 */
export function createPublisher(config: PublisherConfig): PublisherAdapter | null {
  switch (config.mode) {
    case 'none':
      return null;
    case 'fake':
      return new FakePublisherAdapter(config.requires);
    default: {
      const unknown = config as { mode?: string };
      throw new ConfigError([`unsupported publisher mode "${String(unknown.mode)}" (fail-closed; no publisher)`]);
    }
  }
}

/** Convenience: load from env and construct in one step. */
export function publisherFromEnv(env: Env = process.env): PublisherAdapter | null {
  return createPublisher(loadPublisherConfig(env));
}
