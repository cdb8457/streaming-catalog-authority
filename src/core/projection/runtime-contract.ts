// Projection Phase 0 — the projectiond runtime contract.
//
// WHAT THIS IS. The frozen, machine-readable half of the Phase 0 specification that is not the manifest:
// which filesystem operations exist, which of them may touch a source, what every failure maps to, what the
// deadlines and admission limits are, and where a secret is allowed to be. `projectiond` is written in Go;
// this module is the single place those numbers and enums are DECIDED, so the Go daemon's constants and the
// Phase 1 acceptance gates are derived from one table rather than three that drift.
//
// WHY IT IS HERE AND NOT IN THE GO REPOSITORY. The control plane has to produce manifests the daemon can
// admit, and the Phase 1 acceptance harness has to assert against the same budgets the daemon enforces.
// Anything both sides must agree on lives on the side that also owns the schema.
//
// THE ANTI-HANG CONTRACT IS THE HEADLINE. Every operation in this table either answers from immutable
// memory or answers within a bounded deadline. There is no operation that can block indefinitely, no
// operation whose failure is "the caller waits", and no path on which a provider's silence becomes a media
// server's hung scan. A hang is worse than an error here: an error is one file, a hang is the library.

export const PROJECTIOND_CONTRACT_VERSION = 1;

/**
 * The filesystem operation table. `local` means "answered from the immutable in-memory generation, with zero
 * database calls and zero provider calls, always". That is the entire metadata surface a library scan
 * touches, which is why a scan of a fully remote library costs no provider traffic at all.
 */
export const PROJECTIOND_OPERATIONS = Object.freeze({
  getattr: 'local',
  lookup: 'local',
  readdir: 'local',
  readdirplus: 'local',
  statfs: 'local',
  open: 'local',
  release: 'local',
  read: 'source',
  // Every mutation is absent from the namespace, not merely refused by permissions. v1 exposes no write,
  // rename, delete, mkdir, truncate, link, symlink, chmod, chown or xattr-set surface at all.
  write: 'refused',
  create: 'refused',
  mkdir: 'refused',
  unlink: 'refused',
  rmdir: 'refused',
  rename: 'refused',
  truncate: 'refused',
  setattr: 'refused',
  link: 'refused',
  symlink: 'refused',
  setxattr: 'refused',
  removexattr: 'refused',
  fallocate: 'refused',
} as const);

export type ProjectiondOperationClass = (typeof PROJECTIOND_OPERATIONS)[keyof typeof PROJECTIOND_OPERATIONS];

/**
 * The error map. Left column is what happened; right column is the errno a media server sees. The two rules
 * that matter most: nothing maps to a hang, and nothing that is a transient failure maps to ENOENT.
 *
 * ENOENT means one thing only — the path is not in the admitted generation. A provider outage, an expired
 * locator, an open circuit breaker and an unreachable control plane all map to EIO, because a media server
 * treats ENOENT as "the file was deleted" and will happily remove the item from the library on the strength
 * of it. EIO it retries.
 */
export const PROJECTIOND_ERROR_MAP = Object.freeze({
  'path-not-in-generation': 'ENOENT',
  'entry-degraded': 'EIO',
  'source-unreachable': 'EIO',
  'source-auth-refused': 'EIO',
  'source-not-found': 'EIO',
  'locator-expired': 'EIO',
  'range-unsupported': 'EIO',
  'range-mismatch': 'EIO',
  'short-body': 'EIO',
  'size-disagrees-with-manifest': 'EIO',
  'read-deadline-exceeded': 'EIO',
  'admission-queue-timeout': 'EIO',
  'circuit-open': 'EIO',
  'no-byte-identical-failover': 'EIO',
  'control-plane-unavailable': 'served-from-last-generation',
  'mutation-attempted': 'EROFS',
  'offset-beyond-eof': 'EOF-zero-bytes',
} as const);

/**
 * Every deadline is absolute and every one of them is enforced by the daemon rather than by a library
 * default. A read that has not completed by `READ_DEADLINE_MS` returns EIO; it does not extend, and it does
 * not become the next read's problem.
 */
export const PROJECTIOND_READ_POLICY = Object.freeze({
  /** Wall clock from the FUSE read call to its answer, retries included. */
  READ_DEADLINE_MS: 20_000,
  /** TCP + TLS to a provider endpoint. */
  CONNECT_DEADLINE_MS: 5_000,
  /** Request sent to first byte of the response body. */
  FIRST_BYTE_DEADLINE_MS: 10_000,
  /** Longest gap between two body bytes before the attempt is abandoned. */
  BODY_IDLE_DEADLINE_MS: 15_000,
  /** Retries WITHIN one read, over all sources. */
  MAX_ATTEMPTS_PER_READ: 3,
  /**
   * On a 401/403/410 the daemon MAY re-read its token from the secret file — a rotated credential — and retry
   * the same ranged GET once per source generation. That is the whole of "link refresh" in v1.
   *
   * It is NOT a request for a new locator. The daemon has no endpoint it could ask, and asking one would be
   * the daemon acquiring a provider surface the control plane did not give it. An `expiresAt` that has passed
   * is TERMINAL for the source: the only thing that can produce a fresh locator is a new generation.
   */
  MAX_CREDENTIAL_REFRESH_RETRIES_PER_SOURCE_GENERATION: 1,
  BACKOFF_INITIAL_MS: 200,
  BACKOFF_MAX_MS: 4_000,
  BACKOFF_MULTIPLIER: 2,
  /** A `Retry-After` is honoured, but never past this: a provider cannot make a read outlive its deadline. */
  MAX_HONOURED_RETRY_AFTER_MS: 5_000,
  /** The read unit. Requests are aligned to it so single-flight and cache keys are exact, never overlapping. */
  CHUNK_BYTES: 4 * 1_048_576,
} as const);

/**
 * Failure classification. Retryable means "the same request to the same source could plausibly work"; every
 * other failure fails the SOURCE for this read and moves to the next preference — no source is retried past
 * a non-retryable classification, because that is how one broken link becomes a hundred provider requests.
 */
export const PROJECTIOND_RETRY_CLASSES = Object.freeze({
  retryable: Object.freeze([
    'connection-reset', 'connection-timeout', 'body-idle-timeout',
    'http-408', 'http-429', 'http-500', 'http-502', 'http-503', 'http-504',
  ] as const),
  'credential-refresh-then-retry': Object.freeze(['http-401', 'http-403', 'http-410'] as const),
  terminal: Object.freeze([
    'http-400', 'http-404', 'http-416', 'range-unsupported', 'range-mismatch',
    'short-body', 'size-disagrees-with-manifest', 'tls-verification-failed',
    // Only a new generation can supply a fresh locator, so an expired one ends this source, here.
    'locator-expired',
  ] as const),
} as const);

/**
 * Range discipline. A partial request that comes back as a full body is the single most expensive protocol
 * failure available here: accepting one turns a 64 KiB probe into a 40 GiB download, and it is exactly how a
 * library scan becomes a bandwidth bill. It is treated as a protocol violation of the source, not as a slow
 * success: the connection is aborted at the header, no body byte is buffered, and the source is failed.
 */
export const PROJECTIOND_RANGE_RULES = Object.freeze({
  REQUIRED_STATUS_FOR_PARTIAL: 206,
  /** A 200 answer to a ranged request. Never accepted, never buffered, never "used anyway because it works". */
  FULL_BODY_ANSWER_TO_PARTIAL_REQUEST: 'abort-and-fail-source',
  /** `Content-Range` must state exactly the requested first byte, last byte and the manifest's total size. */
  CONTENT_RANGE_MUST_MATCH_REQUEST_EXACTLY: true,
  /** A body shorter than the granted range is a truncation, not an EOF. */
  SHORT_BODY: 'fail-source',
  /** A `Content-Range` total that disagrees with the manifest size means the bytes are not this version. */
  TOTAL_SIZE_MUST_MATCH_MANIFEST: true,
} as const);

/**
 * Admission control. These are hard caps on concurrency, and the Phase 1 gate asserts the observed provider
 * connection count never exceeds the configured one. A read that cannot get a slot within the queue wait
 * returns EIO — it does not queue behind the read deadline and it does not hang.
 */
export const PROJECTIOND_ADMISSION_LIMITS = Object.freeze({
  GLOBAL_MAX_INFLIGHT_SOURCE_REQUESTS: 8,
  PER_ENDPOINT_MAX_INFLIGHT_REQUESTS: 4,
  PER_ENDPOINT_MAX_CONNECTIONS: 4,
  MAX_QUEUE_WAIT_MS: 5_000,
  /** Two opens of the same chunk of the same projected version produce ONE source request. */
  CROSS_OPEN_SINGLE_FLIGHT: true,
} as const);

/**
 * The circuit breaker, per endpoint. An open breaker is the mechanism by which a provider outage costs zero
 * further provider traffic instead of one failed request per file per scan.
 */
export const PROJECTIOND_CIRCUIT_BREAKER = Object.freeze({
  FAILURE_THRESHOLD: 5,
  FAILURE_WINDOW_MS: 30_000,
  OPEN_COOLDOWN_MS: 60_000,
  /** Half-open lets exactly one request through. Not a fraction, not a burst: one. */
  HALF_OPEN_PROBES: 1,
  /** While open, reads against that endpoint answer EIO from local state. Zero packets leave the host. */
  WHILE_OPEN: 'fail-fast-locally-zero-provider-traffic',
} as const);

/**
 * Caches. Two of them, deliberately different, because they answer two different questions.
 *
 * The PROBE PREFIX cache is small, persistent and per projected version: it holds the bytes a media server's
 * metadata pass reads, so a re-scan of an unchanged library costs zero provider requests. The PLAYBACK cache
 * is ephemeral, memory-bounded and dropped on release: it exists to make sequential playback smooth, not to
 * store anybody's library on the appliance's disk.
 */
export const PROJECTIOND_CACHE_POLICY = Object.freeze({
  probePrefix: Object.freeze({
    PERSISTENT: true,
    /** Per projected version. One probe window: what a scanner reads, and nothing beyond it. */
    BYTES_PER_VERSION: 1_048_576,
    MAX_TOTAL_BYTES: 2 * 1024 * 1024 * 1024,
    /** Keyed by projected-version id, never by path and never by source: a failover keeps its cache. */
    KEY: 'projected-version-id',
    /** Evicted only when the version leaves the namespace or the cap is hit. Never on a degraded transition. */
    EVICTION: 'lru-on-cap-or-version-removed',
  }),
  playback: Object.freeze({
    PERSISTENT: false,
    MAX_TOTAL_BYTES: 512 * 1_048_576,
    MAX_BYTES_PER_OPEN_HANDLE: 64 * 1_048_576,
    EVICTION: 'dropped-on-release',
  }),
} as const);

/**
 * Read-ahead has to tell a scanner from a player, because they want opposite things. A scanner opens, reads
 * a header, and closes: reading ahead for it is pure waste and it is what blows the Phase 1 byte budget. A
 * player reads sequentially forever: not reading ahead for it is a stutter.
 */
export const PROJECTIOND_READAHEAD_POLICY = Object.freeze({
  /** No read-ahead at all inside the probe window. A scan must never pull more than it asked for. */
  SUPPRESSED_WITHIN_BYTES: 1_048_576,
  /** This many sequential, chunk-aligned reads past the probe window before read-ahead starts. */
  SEQUENTIAL_TRIGGER_READS: 3,
  MAX_READAHEAD_CHUNKS: 4,
  /** A seek that is not the next chunk cancels read-ahead immediately; in-flight prefetch is abandoned. */
  CANCEL_ON_NON_SEQUENTIAL: true,
  /** An open handle pins its generation, its bound source and its cached chunks. Eviction cannot take them. */
  ACTIVE_STREAM_PINNING: true,
} as const);

/**
 * Handle binding. An open binds to exactly one entry, one generation and one source generation, and stays
 * valid across manifest swaps — a generation swap during playback is invisible to the player.
 */
export const PROJECTIOND_HANDLE_BINDING = Object.freeze({
  BINDS_TO: Object.freeze(['projectedEntryId', 'generationId', 'sourceId', 'sourceGeneration'] as const),
  SURVIVES_MANIFEST_SWAP: true,
  /** A prior generation is reclaimable only when the last handle pinning it is released. */
  PRIOR_GENERATION_RECLAIM: 'on-last-handle-release',
  /**
   * Mid-handle failover is permitted ONLY to a source carrying byte-identity proof identical to the bound
   * source's. Without that proof the read fails EIO. Handing a player the middle of a different file is
   * worse than failing, because it looks like corruption and it is silent.
   */
  MID_HANDLE_FAILOVER: 'proven-byte-identical-sources-only',
} as const);

/**
 * Secrets and egress. Two separate policies that must never be confused for each other, because they point
 * in opposite directions.
 */
export const PROJECTIOND_SECRET_AND_EGRESS_POLICY = Object.freeze({
  /** Read from a file, at a path given by configuration. Never argv, never an inline environment value. */
  TOKEN_SOURCE: 'secret-file',
  TOKEN_NEVER_IN: Object.freeze(['argv', 'log', 'manifest', 'error-message', 'metric-label', 'core-dump-note'] as const),
  /** The token is composed into an Authorization header at request time. It is never a URL component. */
  TOKEN_PLACEMENT: 'authorization-header',
  /**
   * A provider endpoint is a PUBLIC host, by design. This is the opposite of the media-server rule and it is
   * a SEPARATE allowlist for exactly that reason: relaxing this one must not relax that one, and the Jellyfin
   * private-host URL policy is unchanged by anything here.
   */
  PROVIDER_EGRESS: Object.freeze({
    ALLOWLIST: 'configured-endpoint-hosts-only',
    PUBLIC_HOSTS_PERMITTED: true,
    REDIRECTS_FOLLOWED: false,
    TLS_VERIFICATION_REQUIRED: true,
  }),
  /**
   * The media-server rule, restated so the separation is written down rather than assumed. projectiond does
   * not talk to a media server at all; the control plane does, and only to a private literal or a local name.
   */
  MEDIA_SERVER_EGRESS: Object.freeze({
    OWNER: 'control-plane',
    RULE: 'private-host-url-policy-unchanged',
    PROJECTIOND_MAY_CONTACT_MEDIA_SERVER: false,
  }),
} as const);

/**
 * Where a claim can be proved. This table exists because "the tests pass on my machine" is not a statement
 * about a FUSE mount, and Phase 1 has to be honest about which half of its gates a Windows box can close.
 */
export const PROJECTIOND_PLATFORM_SUPPORT = Object.freeze({
  PRODUCTION: Object.freeze(['linux', 'unraid'] as const),
  /** Windows and Docker Desktop run the contract, unit and fake-Range suites. That is all they prove. */
  DEVELOPMENT_ONLY: Object.freeze(['windows', 'docker-desktop'] as const),
  NOT_PROVABLE_OFF_LINUX: Object.freeze([
    'fuse-mount-propagation',
    'container-mount-visibility',
    'media-server-scan-behaviour',
    'kernel-page-cache-interaction',
    'inode-stability-as-observed-by-a-media-server',
    'daemon-kill-and-remount-recovery',
  ] as const),
} as const);

/**
 * The Phase 1 amplification budget. These are the numbers the acceptance harness asserts, and they are here
 * rather than only in the plan document so a suite can import them instead of copying them.
 */
export const PROJECTION_PHASE_1_BUDGETS = Object.freeze({
  /** Provider requests during one library scan, as a multiple of the entry count. */
  MAX_REQUEST_MULTIPLIER: 1.2,
  /** Provider bytes during one library scan, as a multiple of (probe window x entry count). */
  MAX_BYTE_MULTIPLIER: 1.2,
  /** Not "few". Zero. A 429 means the admission limits did not hold. */
  MAX_HTTP_429: 0,
  /** A re-scan of an unchanged library costs no provider request at all: the probe cache already has it. */
  MAX_RESCAN_REQUEST_MULTIPLIER: 0,
  /** Library items added or removed across a daemon kill and recovery. */
  MAX_LIBRARY_CHURN_ITEMS: 0,
} as const);
