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
   * resolve again until REFRESH_COOLDOWN_MS has elapsed, however many readers ask.
   *
   * THE FIRST RESOLUTION OF A SOURCE IS NOT A REFRESH. Obtaining a lease for the first time is simply how a
   * source becomes readable; charging it to this budget would mean the very first read spent the allowance
   * the first expiry needs. Every later resolution — including replacing one that has lapsed — is a refresh.
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
 * is process-ephemeral and memory-bounded, keyed by exact byte identity: it exists to make sequential playback
 * smooth and to let the next open of the same bytes reuse the last open's work, not to store anybody's library
 * on the appliance's disk.
 */
export const PROJECTIOND_CACHE_POLICY = Object.freeze({
  probePrefix: Object.freeze({
    PERSISTENT: true,
    /**
     * Per projected version: the THREE fixed scan windows (head, middle, tail) of the manifest's own probe
     * plan, and nothing beyond them.
     *
     * AMENDED IN PHASE 1. This was one window, on the assumption that a metadata pass reads a header and
     * stops. The access pattern this contract CHOOSES TO SUPPORT is a header, something near the middle, and
     * the tail — where a container keeps its index. With only the head persistent, the other two probes
     * landed in memory-only playback chunks that no restart could recover and that survive only while they
     * win the playback LRU, so a re-scan re-fetched them and "a re-scan costs zero provider requests" was
     * unachievable by construction rather than by defect.
     *
     * THIS IS A DESIGN CHOICE, NOT A MEASUREMENT. No Plex, Jellyfin or Emby scan has been run against this
     * namespace. The Phase 1 harness is a SYNTHETIC scanner that reads exactly these three windows; whether a
     * real media server's metadata pass stays inside them is an open question and a later evidence gate.
     */
    BYTES_PER_VERSION: 3 * 1_048_576,
    /** How many fixed windows that is. The byte budget below is measured against this many per entry. */
    SCAN_WINDOWS_PER_ENTRY: 3,
    MAX_TOTAL_BYTES: 2 * 1024 * 1024 * 1024,
    /** Keyed by projected-version id, never by path and never by source: a failover keeps its cache. */
    KEY: 'projected-version-id',
    /** Evicted only when the version leaves the namespace or the cap is hit. Never on a degraded transition. */
    EVICTION: 'lru-on-cap-or-version-removed',
  }),
  playback: Object.freeze({
    /** Memory only, and this process only: a restart starts empty. Nothing here is ever written to disk. */
    PERSISTENT: false,
    MAX_TOTAL_BYTES: 512 * 1_048_576,
    /**
     * An ADMISSION ceiling, not a readership one. It bounds what a single open handle may ADD; a cache hit is
     * free reuse that transfers no ownership and spends none of it, and a handle that would exceed it evicts
     * its own oldest admissions first.
     */
    MAX_BYTES_PER_OPEN_HANDLE: 64 * 1_048_576,
    /**
     * CORRECTED. This said `dropped-on-release`, and the daemon did exactly that: `release` deleted every
     * entry the handle had cached. Because entries are keyed by byte identity rather than by handle, the
     * deleted entry was precisely what the next open would ask for — so a media server's open-read-release
     * scan followed by an analyse pass refetched the same block once per open. Measured through the real read
     * path: four sequential opens of one object, the identical block at offset 1,048,576 for 2,724,273 bytes,
     * fetched four times.
     *
     * A release now discharges that handle's admission accounting and RETAINS the bytes as an unowned
     * candidate in the global LRU. What ends an entry is the hard 512 MiB total, by recency, and nothing else.
     */
    EVICTION: 'lru-on-cap-not-on-release',
  }),
} as const);

/**
 * Read-ahead has to tell a scanner from a player, because they want opposite things. A scanner opens, reads
 * a header, and closes: reading ahead for it is pure waste and it is what blows the Phase 1 byte budget. A
 * player reads sequentially forever: not reading ahead for it is a stutter.
 */
export const PROJECTIOND_READAHEAD_POLICY = Object.freeze({
  /**
   * No read-ahead at all inside any of the three fixed scan windows. A scan must never pull more than it
   * asked for, and the tail window is the one where naive read-ahead would be most expensive: a scanner
   * seeking to the end must not drag the preceding chunks with it.
   */
  SUPPRESSED_WITHIN_SCAN_WINDOWS: true,
  SUPPRESSED_WITHIN_BYTES: 1_048_576,
  /** This many sequential, chunk-aligned reads past the probe window before read-ahead starts. */
  SEQUENTIAL_TRIGGER_READS: 3,
  MAX_READAHEAD_CHUNKS: 4,
  /** A seek that is not the next chunk cancels read-ahead immediately; in-flight prefetch is abandoned. */
  CANCEL_ON_NON_SEQUENTIAL: true,
  /**
   * An open handle pins its generation, its bound source and its cached chunks.
   *
   * A PIN IS A PREFERENCE, NOT AN EXEMPTION, and an earlier version of this line said eviction could not take
   * a pinned chunk. Both caps are hard: the scan cache retains pinned records last but evicts them rather
   * than exceed 2 GiB, and the playback cache evicts within its 512 MiB by recency alone, whether or not an
   * open handle admitted the entry. An appliance that ran out of space because a stream asked it to would be
   * a worse failure than a cache miss.
   */
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
 * HOW A CONSUMER MUST ATTACH TO THE PROJECTED PATH, AND IT IS A DEPLOYMENT REQUIREMENT RATHER THAN ADVICE.
 *
 * WHAT WAS MEASURED, on a real Unraid host, with two consumers differing in EXACTLY ONE THING — the moment
 * they attached — and with no provider and no media server in the experiment:
 *
 *                                            bound a PLAIN DIRECTORY     bound an EXISTING mount
 *   after the daemon's first mount                   reads                        reads
 *   graceful daemon stop, then restart               READS                     cannot read
 *   external umount + --auto-remount                 READS                     cannot read
 *
 * THE DAEMON IS CORRECT IN BOTH COLUMNS. It logged the serve death and the remount, and a container created
 * AFTERWARDS saw the namespace every time. What differs is only which mount peer group the consumer's bind
 * belongs to: a bind taken while the path is a plain directory is a slave of the PARENT's peer group, so
 * every later mount at that path propagates into it; a bind taken over an existing mount is a slave of THAT
 * MOUNT's peer group only, and once that mount is gone the next one belongs to a group the container never
 * joined. Nothing the daemon does can reach it, and no product change can make it.
 *
 * WHY A SIGKILL RESTART IS THE EXCEPTION, AND WHY IT MISLED THIS REPOSITORY FOR SO LONG. A SIGKILL unmounts
 * nothing, so the restart STACKS a new mount on the same mountpoint — inside the peer group the container
 * did join — and it propagates. That is the only recovery path Phase 1's G12 exercises, which is why every
 * data-plane gate has always passed while binding the mountpoint directly, and why the two paths that
 * REMOVE the mount went unexamined until Projection Phase 3 ran them with consumers attached.
 *
 * THIS SUPERSEDES THE PARENT-BIND REMEDY. The first reading of the evidence was that a consumer must bind
 * the PARENT of the mountpoint. That would work, and it is strictly more disruptive: it changes the
 * topology behind every Phase 1 data-plane result, none of which were taken on it. The two-consumer
 * experiment above is the narrower and stronger finding — the bind spelling never needed to change at all,
 * only its ORDER — so the contract requires the order and leaves the topology alone.
 */
export const PROJECTIOND_CONSUMER_ATTACHMENT = Object.freeze({
  /** A consumer binds the projected path BEFORE the daemon has ever mounted there. */
  BIND_BEFORE_FIRST_MOUNT: true,
  /** The bind spelling is unchanged by this rule: same source, same target, same propagation. */
  BIND_PROPAGATION: 'rslave',
  /** Bind the mountpoint itself, not its parent. The parent-bind remedy is superseded; see above. */
  BIND_TARGET: 'the-mountpoint-itself',
  /**
   * What a consumer that attached too late survives, and what it does not. Stated as an enumeration because
   * "restart the consumer" is the only remedy once it has happened, and an operator is entitled to know
   * which maintenance actions require it.
   */
  LATE_BINDER_SURVIVES: Object.freeze(['daemon-sigkill-and-restart'] as const),
  LATE_BINDER_DOES_NOT_SURVIVE: Object.freeze([
    'daemon-graceful-stop-and-restart',
    'external-umount-with-auto-remount',
  ] as const),
  /** There is no daemon behaviour that repairs a late binder. It is mount propagation, not this product. */
  REPAIRABLE_BY_THE_DAEMON: false,
} as const);

/**
 * WHAT THE DAEMON MAY ASSUME ABOUT THE MOUNT POINT IT IS GIVEN, AND WHAT IT MUST NOT.
 *
 * THE DEFECT THIS RECORDS. A daemon that had ever restarted over one of its own corpses could not
 * auto-remount again — permanently, after about a minute. Measured on the real Unraid host with three media
 * servers attached: the connection was aborted, the serve loop died, the supervisor drained its own dead
 * layer down to the startup floor exactly as designed, and then every remount was refused with ENOTCONN,
 * while the same daemon had mounted over that same corpse minutes earlier at startup.
 *
 * THE MECHANISM, and the arithmetic that makes it a time bomb rather than a coin flip. Mounting through
 * go-fuse stats the mount point for one field, `rootmode`, and with a strict direct mount that stat's error
 * IS the mount error. `stat` on the root of a FUSE mount is answered from the kernel's attribute cache while
 * it is warm and reaches the connection once it is not, and the daemon sets its attribute timeout to 60
 * seconds. So stacking over a corpse succeeds for the first minute of its death and fails for ever after.
 * A SIGKILL-and-restart lands inside that minute, which is why every gate that exercises one has always
 * passed; an abort minutes into a cycle lands outside it, which is why nothing caught this until a phase
 * ran both in the same cycle.
 *
 * WHY THE CORPSE IS NOT SIMPLY REMOVED. In a container the mount point IS the operator's bind, and a bind of
 * a path a previous daemon mounted carries that daemon's dead superblock: it is simultaneously a corpse and
 * the propagation anchor. Removing it does not free the mount point, it disconnects it — the next mount gets
 * the CONTAINER's root as its parent, in a peer group with no host peer, and recovers for the daemon and for
 * nobody else. That was measured too.
 */
export const PROJECTIOND_MOUNT_TARGET = Object.freeze({
  /**
   * The mount point may be one of this daemon's own dead mounts, and the daemon must cope. This is the
   * ordinary state of any deployment that has ever been killed, not an edge case.
   */
  MAY_BE_OUR_OWN_CORPSE: true,
  /**
   * ...and mounting over it may not depend on it answering anything. The root mode is supplied from
   * S_IFDIR, which is knowable: a mount point that was not a directory could not have been mounted over.
   */
  MOUNT_MAY_NOT_STAT_THE_MOUNT_POINT: true,
  /**
   * The corpse is the propagation anchor in every containerised topology, so it is never removed to make
   * room. Recovery stacks over it.
   */
  ANCHOR_IS_NEVER_DETACHED_TO_MAKE_ROOM: true,
  /** Only ever over our own stale mount. Anything else keeps go-fuse's refusal, unaltered and unretried. */
  SELF_MOUNT_ONLY_OVER: 'stale-projectiond',
} as const);

/**
 * WHAT THE DAEMON REPORTS ABOUT ITS OWN MOUNT, AND WHY REMEMBERING IS NOT REPORTING.
 *
 * THE GAP THIS CLOSES, AND THIS PRODUCT HAS FALLEN INTO IT TWICE. `status.mounted` is an in-process boolean
 * set once when the daemon believes it has mounted, and `ready` is that boolean AND the absence of an
 * observed serve death. Neither is ever compared against what is actually at the mount point. So the two
 * worst failures in this product's history both presented as a healthy daemon:
 *
 *   - Phase 2's `--auto-remount` defect: the supervisor removed the operator's bind and remounted into a
 *     namespace with no host peer. The daemon logged success, `/readyz` answered ready, and all three media
 *     servers read nothing.
 *   - The cold corpse of `PROJECTIOND_MOUNT_TARGET` above: every remount refused `ENOTCONN` while the
 *     process was alive and believed itself to be serving.
 *
 * Phase 3 proved the recovery path works. This is the other half: making the daemon able to SAY when it does
 * not. It is an OBSERVATION ALONGSIDE the belief, never a replacement for it — `ready` and `mounted` keep
 * exactly the meanings every closed gate was measured against.
 *
 * WHY THE OBSERVATION CANNOT BE TAKEN ON THE REQUEST PATH. `ProbeMountpoint` decides with `statfs`, and
 * statfs is the transport check precisely BECAUSE it reaches the connection — a live mount answers it out of
 * the daemon's own serve loop. A health endpoint that probed inline would therefore block for exactly as
 * long as the thing it exists to report on is broken, and a hung `/readyz` is a worse answer than a stale
 * one. So the probe runs on its own cadence and the endpoint answers from the last sample it completed.
 *
 * ...AND A BLOCKED PROBE IS NOT CANCELLABLE, WHICH IS WHAT `SINGLE_FLIGHT` IS FOR. `syscall.Statfs` cannot be
 * interrupted; a probe against a wedged connection returns when the connection is torn down and not before.
 * The timeout below therefore bounds HOW LONG THE SAMPLER WAITS, not how long the syscall runs, and only one
 * probe is ever outstanding — otherwise a wedged mount would accumulate one stuck goroutine per interval for
 * as long as it stayed wedged. A probe that overruns leaves the previous sample in place and ages it, so
 * **a probe that cannot answer manifests as a stale sample rather than as a hung endpoint**, which is why
 * the age is published beside the verdict and is worthless without it.
 */
export const PROJECTIOND_MOUNT_OBSERVATION = Object.freeze({
  /**
   * What the OBSERVATION still does not change.
   *
   * IT SAID `['ready', 'mounted']` THROUGHOUT PHASE 4 AND THAT RECORD STANDS. Phase 4 was additive on
   * purpose: it put an observation beside the belief and changed neither, so that no gate closed in Phases
   * 1-3 could start failing on a tranche whose whole content was a new read-only field. §5 of
   * `docs/PROJECTION_PHASE_4_MOUNT_TRUTH.md` then named the remaining half explicitly — *"Folding the
   * observation into `ready` is explicitly NOT in this tranche... it is deferred, named here so it is a
   * decision somebody takes rather than a thing that drifts in."*
   *
   * **PHASE 5 IS THAT DECISION, TAKEN DELIBERATELY, AND `ready` HAS THEREFORE LEFT THIS LIST.** It is not a
   * lapsed guarantee: it is the one this repository wrote down in advance so that changing it would have to
   * be an act. `PROJECTIOND_MOUNT_HEALTH` is the policy that replaced it, and Phase 5's contract document
   * carries the state machine, the reason precedence and the regression matrix that came with it.
   *
   * `mounted` REMAINS UNTOUCHED, and that is the whole of what is left here. It is still the boolean the
   * daemon sets when it believes it has mounted, still never re-checked, and still the thing every closed
   * gate was measured against — which is exactly why readiness had to stop being a synonym for it.
   */
  DOES_NOT_CHANGE: Object.freeze(['mounted'] as const),
  /**
   * What the sampler may report. The first four are `fusefs.ProbeResult`'s own states, unchanged; the last
   * two are states only a SAMPLER has and a probe does not.
   */
  STATES: Object.freeze([
    // SPELLED AS `fusefs.ProbeResult.String()` SPELLS THEM, not as this file would have chosen to. The first
    // draft used `live` and `stale`, which reads better and would have been a SECOND VOCABULARY for the same
    // four states — the thing the paragraph above warns about, written into the contract meant to prevent it.
    'live-projectiond', 'stale-projectiond', 'empty', 'foreign',
    /** A probe was outstanding past `PROBE_TIMEOUT_MS` and the sampler stopped waiting for it. */
    'timeout',
    /** No probe has completed yet, or no observer is wired. Never conflated with a negative result. */
    'unchecked',
  ] as const),
  /**
   * How often the sampler probes, in milliseconds. **CHOSEN, with both bounds named.**
   *
   * BELOW: one statfs a second against a live mount is one extra FUSE operation per second, which is noise
   * beside a single directory scan — and a health signal that lags its own subject by more than about a
   * second is not one an operator can act on.
   * ABOVE: it must stay well under the freshness ceiling, or a HEALTHY daemon's sample would routinely
   * present as stale and the freshness assertion would be measuring the sampler's cadence instead of the
   * mount.
   */
  SAMPLE_INTERVAL_MS: 1_000,
  /**
   * How long the sampler waits for one probe before giving up on it, in milliseconds. **CHOSEN, with both
   * bounds named.**
   *
   * BELOW: a statfs against a healthy mount is a map read in the daemon's own process and returns in well
   * under a millisecond, so any bound in the hundreds already separates "answering" from "not answering".
   * ABOVE: it is what the endpoint's latency budget must beat, and a bound approaching the read deadline
   * would let a wedged mount look merely slow for twenty seconds.
   */
  PROBE_TIMEOUT_MS: 2_000,
  /** Exactly one probe outstanding at a time. See the paragraph above: it is what bounds a wedged mount. */
  SINGLE_FLIGHT: true,
  /**
   * The oldest a sample may be while the daemon is healthy, in milliseconds. DERIVED: one full interval may
   * elapse before a probe starts, and that probe may take up to its whole timeout.
   */
  SAMPLE_MAX_AGE_MS: 1_000 + 2_000,
  /**
   * What `/readyz` may take to answer, in milliseconds, in EVERY state including a wedged mount. **CHOSEN**,
   * and the number matters far less than the property asserted beside it: it is **strictly under
   * `PROBE_TIMEOUT_MS`**, so a handler that had waited for a probe could not pass this. That is the whole
   * assertion — the budget exists to catch the endpoint being put back on the probe's path by a later edit.
   */
  READYZ_LATENCY_BUDGET_MS: 1_000,
} as const);

/**
 * The endpoint may not be able to wait for a probe, and this is the derived fact that says so.
 *
 * IT IS A CHECK RATHER THAN A COMMENT, in the shape `ROTATION_REFUSAL_BELOW_BREAKER` already uses: if the
 * latency budget ever stopped being strictly under the probe timeout, a `/readyz` that blocked on the probe
 * would satisfy its own budget and the arm asserting it does not would quietly stop meaning anything.
 */
export const READYZ_CANNOT_HAVE_WAITED_FOR_A_PROBE =
  PROJECTIOND_MOUNT_OBSERVATION.READYZ_LATENCY_BUDGET_MS < PROJECTIOND_MOUNT_OBSERVATION.PROBE_TIMEOUT_MS;

/**
 * Projection Phase 5 — the observation becomes OPERATIONALLY AUTHORITATIVE, and liveness stops being
 * conflated with it.
 *
 * WHAT PHASE 4 LEFT ON THE TABLE, DELIBERATELY. Phase 4 §5 said, in as many words: *"Folding the observation
 * into `ready` is explicitly NOT in this tranche. It is a behaviour change to an endpoint three closed phases
 * were measured against, and it is deferred, named here so it is a decision somebody takes rather than a
 * thing that drifts in."* **This is that decision, taken.** `mounted` is untouched and still means what it
 * always meant; `ready` now also requires that the mount was actually OBSERVED to be live.
 *
 * WHY A BARE `observed == live` WOULD BE A DEFECT, NOT A FIX. The observation is a SAMPLE, and a sample is
 * late by construction: a probe runs on its own cadence, a probe that overruns leaves the previous sample to
 * age, and a remount restores the mount up to a full interval before the next sample sees it. Wiring `ready`
 * straight to the latest sample would therefore make a HEALTHY daemon flap — not-ready for a second every
 * time a probe was slow, and not-ready for a second after every successful recovery. So the endpoint answers
 * from a bounded POLICY over the sample stream, and the policy has exactly three moving parts:
 *
 *   - a BOOTSTRAP GRACE, so a daemon that has not yet been able to look is not accused of being broken;
 *   - a FAULT HOLD, so one late or one non-live sample cannot flap health;
 *   - a RECOVERY CONFIRMATION, so one lucky sample cannot restore it either.
 *
 * ...AND LIVENESS IS A DIFFERENT QUESTION FROM READINESS, WHICH IS THE OTHER HALF OF THIS TRANCHE. Once
 * `ready` can be false while the process is perfectly alive, a supervisor that keys on the only endpoint
 * there is cannot tell "restart me" from "do not send me traffic". `/healthz` therefore answers ONLY whether
 * the process and its status server are alive, and it says so in the document rather than leaving it to be
 * inferred: `claimsMountUsable` is `false`, always, by construction.
 */
export const PROJECTIOND_MOUNT_HEALTH = Object.freeze({
  /**
   * The closed set of readiness reason codes, in the PRECEDENCE ORDER the daemon evaluates them. First match
   * wins, and `readyReason` is always present — including when it is `ok`.
   *
   * THEY ARE CODES AND NOTHING ELSE. No path, no URL, no origin, no provider reference, no object identity,
   * no OS error string. This surface is meant to be pasteable into an issue, which is the same rule
   * `AdmitRecord.Refusal` has always been held to.
   *
   * THE ORDER IS THE INTERESTING PART, NOT THE LIST. `serve-loop-dead` outranks every mount-observation
   * reason because the supervisor's own knowledge that the serve loop exited is DIRECT evidence, while the
   * observation is a late sample of the same event; reporting the sample first would name the symptom and
   * bury the cause. `no-generation-admitted` outranks everything because a daemon with nothing to serve is
   * not a mount-health question at all.
   *
   * `serve-loop-dead` ALSO OUTRANKS `not-mounted`, AND THAT ORDER WAS CORRECTED AFTER MEASUREMENT. It was
   * predeclared the other way round, and the first real run proved that formulation makes the code
   * UNREPORTABLE: on a serve-loop death the supervisor runs `SetMounted(false)` and THEN
   * `RecordServeDeath(...)`, and on a successful remount it runs `ClearServeDeath()` and THEN
   * `SetMounted(true)`. So `mounted` is false for the whole window in which a death is recorded, and a
   * `not-mounted` that outranked it would be the only thing `/readyz` ever said — a reason code that cannot
   * occur. It is also the worse of the two answers: a death is WHY the daemon is not mounted, and reporting
   * the state instead of the cause is the same mistake as reporting the sample instead of the supervisor.
   * **The readiness BOOLEAN is identical either way** — both make `ready` false — so this reorders which
   * code is published and changes no behaviour any closed gate was measured against.
   */
  READY_REASONS: Object.freeze([
    /** Ready. Every condition below was checked and none of them fired. */
    'ok',
    /** No generation has ever been admitted, so there is nothing to serve. Pre-existing readiness rule. */
    'no-generation-admitted',
    /** The supervisor observed the FUSE serve loop exit. Pre-existing readiness rule, unchanged. */
    'serve-loop-dead',
    /** The daemon does not believe it is mounted. Pre-existing readiness rule, unchanged. */
    'not-mounted',
    /** The last completed observation was `stale-projectiond`, `foreign` or `empty`, past the fault hold. */
    'mount-observed-not-live',
    /**
     * The last completed observation said live, but it is older than `SAMPLE_MAX_AGE_MS` and has been for
     * longer than the fault hold. THIS IS THE WEDGED-MOUNT SIGNATURE: a probe that cannot answer leaves the
     * previous sample in place to age, so a mount nobody can read presents as a verdict that stops advancing.
     */
    'mount-observation-stale',
    /** No observation has ever completed, or the sampler gave up on one, and the bootstrap grace is over. */
    'mount-observation-unavailable',
    /**
     * The mount is observed live and fresh, but the live run is younger than `MOUNT_RECOVERY_CONFIRM_MS`
     * AND the fault that preceded that run was one readiness was actually withheld for.
     *
     * THE SECOND CLAUSE WAS ADDED AFTER MEASUREMENT AND THE ARM THAT FORCED IT IS `MH6`. As predeclared the
     * confirmation was UNCONDITIONAL, which makes it the mirror image of the very flap the fault hold exists
     * to prevent: any transient long enough to produce one non-live sample necessarily restarts the live
     * run, so an unconditional confirmation takes the appliance out of service for a whole second at the
     * TAIL of every transient the hold just protected the front of. The first real Tower run measured
     * exactly that — `MH6` recorded `lostReady=1 (code 503)` on a two-second fault. **Hysteresis confirms on
     * the way back only if it actually left**, and that is what this now says. No threshold moved.
     */
    'mount-recovering',
  ] as const),
  /**
   * How long after the daemon FIRST mounts an ABSENT observation does not make readiness false, in
   * milliseconds. **CHOSEN, with both bounds named.**
   *
   * BELOW: it must comfortably exceed `SAMPLE_MAX_AGE_MS` plus the time a cold container takes to reach its
   * first completed probe, or a healthy daemon on a loaded host would answer not-ready at startup for a
   * reason that is about the host rather than about the mount — and every gate that waits for `ready` would
   * inherit that flake.
   * ABOVE: this is the ONLY window in which readiness can be true without the mount having been observed at
   * all, so it is the window in which the failures this tranche exists to catch could still hide. It is held
   * strictly under the shipped healthcheck's start period, so the first healthcheck probe that Docker
   * actually counts is one the grace can no longer answer.
   *
   * IT IS NOT A GRACE FOR A BROKEN MOUNT. A DEFINITIVELY non-live observation — `foreign`, `empty`,
   * `stale-projectiond` — is never covered by it, at any age of the process. The grace covers "we have not
   * been able to look yet", never "we looked and it is not live".
   *
   * ...AND IT IS FORFEITED PERMANENTLY BY A SERVE-LOOP DEATH. A daemon that has already lost its namespace
   * once has proved it can; granting a recovery a fresh window in which it need not be observed at all is
   * precisely how both of this product's worst failures stayed invisible.
   */
  MOUNT_BOOTSTRAP_GRACE_MS: 15_000,
  /**
   * How long a fault must PERSIST before it makes readiness false, in milliseconds, measured from the moment
   * the mount was last observed live. **DERIVED:** `2 x SAMPLE_MAX_AGE_MS`.
   *
   * TWO FULL WORST-CASE SAMPLING WINDOWS, and the derivation is the argument. One window is the longest a
   * healthy daemon can legitimately go without a fresh verdict (a full interval before a probe starts, plus a
   * probe that takes its whole timeout). A hold of ONE window would therefore fire on the ordinary worst case
   * and readiness would flap on a busy host. Two is the smallest multiple that requires a fault to survive a
   * complete observation opportunity it could not have merely slept through.
   */
  MOUNT_FAULT_HOLD_MS: 2 * (1_000 + 2_000),
  /**
   * How long the mount must be CONTINUOUSLY observed live before readiness returns, in milliseconds.
   * **DERIVED:** `SAMPLE_INTERVAL_MS`.
   *
   * A live run spanning a full interval cannot consist of one sample, so this is the shortest bound that
   * guarantees TWO distinct completed live observations. One lucky sample restoring readiness is the mirror
   * of one unlucky sample destroying it, and a policy that guarded only one direction would be half a policy.
   */
  MOUNT_RECOVERY_CONFIRM_MS: 1_000,
  /**
   * What `/healthz` may take to answer, in milliseconds, in EVERY state including a wedged mount. **CHOSEN**,
   * and as with the readiness budget the number matters far less than the property beside it: it is strictly
   * under `PROBE_TIMEOUT_MS`, so a liveness endpoint that had somehow been put on the probe's path could not
   * pass it. Liveness that can block on the mount is not liveness.
   */
  LIVEZ_LATENCY_BUDGET_MS: 1_000,
  /** The shipped container healthcheck's interval, in seconds. */
  HEALTHCHECK_INTERVAL_S: 10,
  /** The shipped container healthcheck's per-probe timeout, in seconds. */
  HEALTHCHECK_TIMEOUT_S: 5,
  /**
   * The shipped container healthcheck's start period, in seconds. Held strictly ABOVE the bootstrap grace:
   * a probe answered on the strength of the grace must never be one Docker counts toward `healthy`.
   */
  HEALTHCHECK_START_PERIOD_S: 20,
  /** Consecutive failing probes before Docker calls the container unhealthy. */
  HEALTHCHECK_RETRIES: 3,
  /**
   * The longest a sustained mount fault may take to show up as an UNHEALTHY container, in milliseconds.
   * **DERIVED:** the daemon's own fault hold, plus every retry Docker will spend, plus one whole probe
   * timeout for the last of them. It is the gate's upper bound and nothing else — not a target, and not a
   * claim about how fast a fault is noticed.
   */
  HEALTHCHECK_UNHEALTHY_BOUND_MS: (2 * (1_000 + 2_000)) + (3 * 10 * 1_000) + (5 * 1_000),
  /**
   * How long the gate holds a TRANSIENT mount fault, in milliseconds. **DERIVED, with both bounds named.**
   *
   * ABOVE `SAMPLE_INTERVAL_MS`: shorter and the fault could come and go between two probes, so the arm would
   * assert that readiness survived a fault the daemon never saw — the unfailable shape this repository has
   * now found five separate times. The arm therefore also requires that a non-live observation was ACTUALLY
   * REPORTED during the transient, and this bound is what makes that requirement satisfiable.
   * BELOW `MOUNT_FAULT_HOLD_MS - SAMPLE_MAX_AGE_MS`: longer and readiness would be ENTITLED to go false, so
   * a run in which it did would be the product behaving correctly and the arm would be wrong to fail it.
   */
  ANTI_FLAP_TRANSIENT_MS: 2_000,
} as const);

/**
 * `/healthz` could not have waited for a probe either, and this is the derived fact that says so. Same shape
 * as `READYZ_CANNOT_HAVE_WAITED_FOR_A_PROBE`, and it exists for the same reason: the liveness budget is only
 * worth asserting while it is strictly under the probe timeout.
 */
export const LIVEZ_CANNOT_HAVE_WAITED_FOR_A_PROBE =
  PROJECTIOND_MOUNT_HEALTH.LIVEZ_LATENCY_BUDGET_MS < PROJECTIOND_MOUNT_OBSERVATION.PROBE_TIMEOUT_MS;

/**
 * The bootstrap grace is over before Docker counts anything, and this is the derived fact that says so.
 *
 * WITHOUT IT THE SHIPPED HEALTHCHECK WOULD BE MEASURING THE GRACE. Docker ignores failures during
 * `start-period`; if the start period were the SHORTER of the two, the first probe it counted could be one
 * that `/readyz` answered `ok` purely because the daemon had not yet been able to look at its own mount, and
 * a container could report `healthy` having never observed a live mount at all.
 */
export const HEALTHCHECK_START_PERIOD_CLEARS_BOOTSTRAP_GRACE =
  PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_START_PERIOD_S * 1_000
    > PROJECTIOND_MOUNT_HEALTH.MOUNT_BOOTSTRAP_GRACE_MS;

/**
 * A readiness answer inside its own budget can never be recorded as a healthcheck TIMEOUT, and this is the
 * derived fact that says so. If the probe timeout were the shorter of the two, an endpoint that answered
 * perfectly within its contract would still be counted as a failure, and the container's health would be
 * reporting Docker's impatience rather than the daemon's readiness.
 */
export const HEALTHCHECK_TIMEOUT_CLEARS_READINESS_BUDGET =
  PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_TIMEOUT_S * 1_000
    > PROJECTIOND_MOUNT_OBSERVATION.READYZ_LATENCY_BUDGET_MS;

/**
 * THE DAEMON DECIDES WHAT IS BROKEN; DOCKER ONLY REPEATS IT. Docker's own retry budget must be longer than
 * the daemon's fault hold, or the container's health would flip on Docker's retry count while `/readyz` was
 * still — correctly — reporting `ok` through a transient. The anti-flap policy has to live in ONE place, and
 * this is the check that keeps it there.
 */
export const DAEMON_DECIDES_UNHEALTHY_NOT_DOCKER =
  PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_RETRIES * PROJECTIOND_MOUNT_HEALTH.HEALTHCHECK_INTERVAL_S * 1_000
    > PROJECTIOND_MOUNT_HEALTH.MOUNT_FAULT_HOLD_MS;

/**
 * The fault hold and the bootstrap grace both outlast one whole worst-case sampling window, and the transient
 * the anti-flap arm injects fits strictly inside the hold. Three derivations that are worthless separately:
 * if any one of them stopped holding, an arm would still pass while measuring something else.
 */
export const MOUNT_HEALTH_POLICY_IS_BOUNDED_BY_ITS_SAMPLER =
  PROJECTIOND_MOUNT_HEALTH.MOUNT_FAULT_HOLD_MS > PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_MAX_AGE_MS
  && PROJECTIOND_MOUNT_HEALTH.MOUNT_BOOTSTRAP_GRACE_MS > PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_MAX_AGE_MS
  && PROJECTIOND_MOUNT_HEALTH.MOUNT_RECOVERY_CONFIRM_MS >= PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_INTERVAL_MS
  && PROJECTIOND_MOUNT_HEALTH.ANTI_FLAP_TRANSIENT_MS > PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_INTERVAL_MS
  && PROJECTIOND_MOUNT_HEALTH.ANTI_FLAP_TRANSIENT_MS
    < PROJECTIOND_MOUNT_HEALTH.MOUNT_FAULT_HOLD_MS - PROJECTIOND_MOUNT_OBSERVATION.SAMPLE_MAX_AGE_MS;

/**
 * The Phase 1 amplification budget. These are the numbers the acceptance harness asserts, and they are here
 * rather than only in the plan document so a suite can import them instead of copying them.
 */
export const PROJECTION_PHASE_1_BUDGETS = Object.freeze({
  /**
   * Provider bytes during one synthetic scan, as a multiple of
   * (probe window x SCAN_WINDOWS_PER_ENTRY x entry count).
   */
  MAX_BYTE_MULTIPLIER: 1.2,
  SCAN_WINDOWS_PER_ENTRY: 3,
  /**
   * RANGE requests during one synthetic scan, as a multiple of (entry count x SCAN_WINDOWS_PER_ENTRY).
   *
   * AMENDED IN PHASE 1, AND THE DENOMINATOR IS THE WHOLE POINT. The budget was "1.2 x entry count", which is
   * arithmetically unreachable: a scan that reads three separate windows makes at least three ranged requests
   * per entry, so the gate could never have passed however well the daemon behaved. A budget that cannot be
   * met is worse than no budget, because it gets quietly loosened later by someone who does not know why.
   *
   * This counts ranged GETs against the object endpoint, and nothing else — resolutions are counted
   * separately below, because they are a different request to a different surface.
   */
  MAX_RANGE_REQUEST_MULTIPLIER: 1.2,
  /** ACCESS-RESOLUTION requests during one synthetic scan, as a multiple of entry count. */
  MAX_RESOLUTION_REQUEST_MULTIPLIER: 1.2,
  /** Not "few". Zero. A 429 means the admission limits did not hold. */
  MAX_HTTP_429: 0,
  /** A re-scan of an unchanged library costs no provider request at all: the probe cache already has it. */
  MAX_RESCAN_REQUEST_MULTIPLIER: 0,
  /** Library items added or removed across a daemon kill and recovery. */
  MAX_LIBRARY_CHURN_ITEMS: 0,
} as const);
