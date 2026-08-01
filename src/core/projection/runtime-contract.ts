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
 * access lease, an open circuit breaker and an unreachable control plane all map to EIO, because a media server
 * treats ENOENT as "the file was deleted" and will happily remove the item from the library on the strength
 * of it. EIO it retries.
 */
export const PROJECTIOND_ERROR_MAP = Object.freeze({
  'path-not-in-generation': 'ENOENT',
  'entry-degraded': 'EIO',
  'source-unreachable': 'EIO',
  'source-auth-refused': 'EIO',
  'source-not-found': 'EIO',
  // The ephemeral access material the daemon resolved has lapsed. Recoverable in-band; see
  // PROJECTIOND_ACCESS_RESOLUTION. It reaches a caller as EIO only after a refresh has been tried and failed.
  'access-lease-expired': 'EIO',
  // The endpoint would not turn the stable reference into access material at all.
  'access-resolution-failed': 'EIO',
  // The endpoint says it does not know the stable reference. The namespace still does not change.
  'source-reference-unknown': 'EIO',
  'access-url-outside-endpoint-allowlist': 'EIO',
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
   * Access-lease refreshes inside ONE read. See PROJECTIOND_ACCESS_RESOLUTION for the per-source budget the
   * whole daemon shares; this is only the per-read ceiling, and it is one so that a read cannot become a
   * refresh loop.
   */
  MAX_ACCESS_REFRESHES_PER_READ: 1,
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
  /**
   * Re-resolve the STABLE reference into fresh access material, then retry the identical ranged request once.
   * Bounded, single-flighted and cooldown-limited by PROJECTIOND_ACCESS_RESOLUTION.
   *
   * These statuses are here rather than in `terminal` because for a debrid/CDN-shaped source they are the
   * NORMAL end of a signed URL's life, not a failure. A playback routinely outlives a lease.
   */
  'access-refresh-then-retry': Object.freeze([
    'http-401', 'http-403', 'http-410', 'access-lease-expired',
  ] as const),
  terminal: Object.freeze([
    'http-400', 'http-404', 'http-416', 'range-unsupported', 'range-mismatch',
    'short-body', 'size-disagrees-with-manifest', 'tls-verification-failed',
    // The endpoint does not know the stable reference, or would not resolve it. A refresh cannot help, and
    // only the control plane can decide what that means for the namespace.
    'source-reference-unknown', 'access-resolution-failed',
    // A resolved URL pointing somewhere outside the endpoint's configured hosts. Never followed, never
    // retried: it is the one failure here that could otherwise be a redirect to an attacker.
    'access-url-outside-endpoint-allowlist',
  ] as const),
} as const);

/**
 * TRANSPORT RESOLUTION — turning a stable reference into something you can actually GET.
 *
 * THE DISTINCTION THIS WHOLE BLOCK EXISTS TO HOLD. The control plane decides *which source*, and proves the
 * bytes are the projected version. That is catalog and source-selection policy, and it does not move. The
 * daemon decides *how to reach* the source the control plane already chose — resolving `endpointId` plus
 * `objectRef` into a signed URL, a redirect target, a lease with a lifetime. That is transport, and it has to
 * live in the daemon, because a debrid or CDN access URL expires on the provider's schedule and a playback
 * routinely outlives one.
 *
 * WHY IT CANNOT BE THE MANIFEST'S JOB. Putting the access URL in the manifest would mean publishing a new
 * namespace generation every time a lease lapsed: ordinary reads coupled to catalog churn, a swap storm
 * during a movie, and a generation-pinned handle broken by its own transport. The first draft of this
 * contract did exactly that and it was wrong.
 *
 * WHAT A REFRESH MAY NOT DO. It may not change which source is being read, which entry, which generation,
 * which source generation or which byte identity — the handle stays pinned to all five, and a refreshed
 * response is held to the identical Range, Content-Range, total-size and byte-identity rules as the first
 * one. A refresh is a new envelope for the same bytes, or it is a failure.
 */
export const PROJECTIOND_ACCESS_RESOLUTION = Object.freeze({
  /** Who chose this source, and who may not re-choose it. */
  SOURCE_SELECTION_OWNER: 'control-plane',
  /** What the daemon is permitted to do on its own. */
  DAEMON_SCOPE: 'transport-resolution-only',
  /** Never written down. Not to the manifest, not to disk, not to a log, not to a metric, not to argv. */
  LEASE_STORAGE: 'memory-only',
  LEASE_NEVER_IN: Object.freeze([
    'manifest', 'disk', 'probe-prefix-cache', 'log', 'metric-label', 'argv', 'error-message', 'core-dump-note',
  ] as const),
  /** The long-lived credential that authorises a resolution still comes from a secret file, as before. */
  CREDENTIAL_SOURCE: 'secret-file',
  /**
   * One refresh per source per cooldown, daemon-wide. Not per read, not per handle: twenty handles hitting an
   * expired lease at once cost ONE resolution, and a source whose resolutions keep failing cannot be made to
   * resolve again for a minute however many readers ask.
   */
  MAX_REFRESHES_PER_SOURCE_PER_COOLDOWN: 1,
  REFRESH_COOLDOWN_MS: 30_000,
  /**
   * Concurrent waiters share one in-flight resolution and its result. This is the anti-stampede rule, and it
   * is the same shape as the read path's cross-open single-flight for exactly the same reason.
   */
  SINGLE_FLIGHT: true,
  /** A resolution is itself a bounded request, and it is spent from the read's absolute deadline. */
  RESOLUTION_DEADLINE_MS: 5_000,
  INSIDE_ABSOLUTE_READ_DEADLINE: true,
  /**
   * A resolved URL is data from a provider, so it is treated as untrusted input. Its host must be in the
   * endpoint's configured allowlist; otherwise the read fails and nothing is fetched. Redirects are still
   * never followed, which is what stops a resolution from becoming an open redirect.
   */
  RESOLVED_URL_HOST_MUST_BE_IN_ENDPOINT_ALLOWLIST: true,
  RESOLVED_URL_REDIRECTS_FOLLOWED: false,
  RESOLVED_URL_TLS_VERIFICATION_REQUIRED: true,
  /** Refreshing access material changes none of these. A refresh is transport, not identity. */
  PINNED_ACROSS_REFRESH: Object.freeze([
    'projectedEntryId', 'generationId', 'sourceId', 'sourceGeneration', 'projectedVersionId', 'inode',
    'sizeBytes', 'mtime',
  ] as const),
  /** The refreshed response is held to every rule the first one was. */
  POST_REFRESH_RESPONSE_RULES: 'identical-range-content-range-total-size-and-byte-identity',
  /** Exhausted budget, failed resolution, or a deadline reached: EIO. The namespace does not move. */
  ON_REFRESH_FAILURE: 'EIO-without-namespace-change',
  /** There is no path on which a refresh triggers another refresh. */
  REFRESH_MAY_TRIGGER_REFRESH: false,
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
  /**
   * A lease lapsing and being successfully re-resolved is NOT a failure and MUST NOT count toward the
   * threshold. It is the normal life of a signed URL, and counting it would mean a healthy endpoint with a
   * short lease trips its own breaker during ordinary playback — turning the correction in
   * PROJECTIOND_ACCESS_RESOLUTION back into the outage it exists to prevent.
   *
   * A resolution that FAILS is a failure and does count: that is an endpoint not answering, which is what
   * this breaker is for.
   */
  SUCCESSFUL_ACCESS_REFRESH_COUNTS_AS_FAILURE: false,
  FAILED_ACCESS_RESOLUTION_COUNTS_AS_FAILURE: true,
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
  /**
   * Refreshing the ephemeral access material underneath a handle is NOT a failover and NOT a rebind. Nothing
   * in BINDS_TO moves, and the player is never told. This is what makes a lease shorter than a film a
   * non-event rather than a stutter, a re-open or a library refresh.
   */
  ACCESS_REFRESH_REBINDS_HANDLE: false,
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
   * Ephemeral access material — a signed URL, a lease, a redirect target the daemon resolved — is a SECRET
   * with a short life, and gets the same treatment. It lives in memory for as long as it is useful and is
   * written down nowhere: see PROJECTIOND_ACCESS_RESOLUTION.LEASE_NEVER_IN, which includes the probe-prefix
   * cache, because that one IS on disk and holds bytes keyed by projected version.
   */
  ACCESS_MATERIAL_STORAGE: 'memory-only',
  ACCESS_MATERIAL_NEVER_IN: Object.freeze([
    'manifest', 'disk', 'probe-prefix-cache', 'log', 'metric-label', 'argv', 'error-message', 'core-dump-note',
  ] as const),
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
    /**
     * A URL the daemon RESOLVED is provider-supplied data, so it is checked against the same allowlist as a
     * URL the daemon composed. Without this, transport resolution would be a hole straight through the
     * allowlist: the provider would simply hand back the host it wanted contacted.
     */
    RESOLVED_ACCESS_URLS_CHECKED_AGAINST_ALLOWLIST: true,
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
