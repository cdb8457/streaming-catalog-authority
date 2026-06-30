import { redactString } from '../redaction/noleak.js';

/**
 * Runtime-only secret access (Phase 2 #1).
 *
 * Secrets (provider API keys, signed/stream URLs, and — later — unwrapped DEKs)
 * are held in memory for the lifetime of the process only. The store has NO
 * persistence surface: it imports nothing about the database, writes nothing to
 * `events`/the projection, and is the source of truth for `redact()`, which
 * scrubs both signature-shaped secrets and any registered secret literal from a
 * string before it is logged.
 */
export class SecretStore {
  private readonly secrets = new Map<string, string>();

  set(name: string, value: string): void {
    this.secrets.set(name, value);
  }

  get(name: string): string | undefined {
    return this.secrets.get(name);
  }

  has(name: string): boolean {
    return this.secrets.has(name);
  }

  delete(name: string): void {
    this.secrets.delete(name);
  }

  /** Number of secrets held — for diagnostics; never logs the values. */
  size(): number {
    return this.secrets.size;
  }

  /**
   * Redacts a string for logging: first the generic signature scan (URLs, keys,
   * magnets, tokens, hashes), then an exact-match mask of every registered
   * secret literal — so even a signature-free secret cannot be logged verbatim.
   */
  redact(message: string): string {
    let out = redactString(message);
    for (const value of this.secrets.values()) {
      if (value && out.includes(value)) {
        out = out.split(value).join('[redacted:secret]');
      }
    }
    return out;
  }
}
