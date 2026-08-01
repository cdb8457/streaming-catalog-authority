// Package contract embeds the cross-language contract export and exposes it to the daemon's own tests.
//
// THE EXPORT IS THE BOUNDARY. `src/core/projection/*.ts` freezes the deadlines, caps, error mapping and probe
// plan; `npm run ops:projection-contract-export` renders them into contract.generated.json; this package
// embeds that file; and `contract_test.go` refuses any Go constant that disagrees with it. The TypeScript
// suite refuses a stale file from the other side. Neither language can drift without a gate failing.
package contract

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed contract.generated.json
var raw []byte

// Raw exposes the embedded bytes so a test can prove the file is the one the control plane rendered.
func Raw() []byte { return raw }

type Limits struct {
	MaxArtifactBytes    int64 `json:"MAX_ARTIFACT_BYTES"`
	MaxEntries          int64 `json:"MAX_ENTRIES"`
	MaxSourcesPerEntry  int   `json:"MAX_SOURCES_PER_ENTRY"`
	MaxPathBytes        int   `json:"MAX_PATH_BYTES"`
	MaxPathSegmentBytes int   `json:"MAX_PATH_SEGMENT_BYTES"`
	MaxSizeBytes        int64 `json:"MAX_SIZE_BYTES"`
	MaxLocatorValueLen  int   `json:"MAX_LOCATOR_VALUE_LENGTH"`
	MaxProbesPerSource  int   `json:"MAX_PROBES_PER_SOURCE"`
	MaxReportedProblems int   `json:"MAX_REPORTED_PROBLEMS"`
}

type ProbePlan struct {
	WindowBytes           int64    `json:"WINDOW_BYTES"`
	Offsets               []string `json:"OFFSETS"`
	SingleProbeBelowBytes int64    `json:"SINGLE_PROBE_BELOW_BYTES"`
}

type ShrinkGuard struct {
	MaxDeletionsAbsolute int     `json:"MAX_DELETIONS_ABSOLUTE"`
	MaxDeletionsFraction float64 `json:"MAX_DELETIONS_FRACTION"`
}

type ManifestContract struct {
	Format            string      `json:"format"`
	Version           int         `json:"version"`
	Limits            Limits      `json:"limits"`
	ProbePlan         ProbePlan   `json:"probePlan"`
	ShrinkGuard       ShrinkGuard `json:"shrinkGuard"`
	VisibilityStates  []string    `json:"visibilityStates"`
	SourceKinds       []string    `json:"sourceKinds"`
	DegradedReasons   []string    `json:"degradedReasons"`
	GenerationIntents []string    `json:"generationIntents"`
}

type ReadPolicy struct {
	ReadDeadlineMs            int64 `json:"READ_DEADLINE_MS"`
	ConnectDeadlineMs         int64 `json:"CONNECT_DEADLINE_MS"`
	FirstByteDeadlineMs       int64 `json:"FIRST_BYTE_DEADLINE_MS"`
	BodyIdleDeadlineMs        int64 `json:"BODY_IDLE_DEADLINE_MS"`
	MaxAttemptsPerRead        int   `json:"MAX_ATTEMPTS_PER_READ"`
	MaxAccessRefreshesPerRead int   `json:"MAX_ACCESS_REFRESHES_PER_READ"`
	BackoffInitialMs          int64 `json:"BACKOFF_INITIAL_MS"`
	BackoffMaxMs              int64 `json:"BACKOFF_MAX_MS"`
	BackoffMultiplier         int   `json:"BACKOFF_MULTIPLIER"`
	MaxHonouredRetryAfterMs   int64 `json:"MAX_HONOURED_RETRY_AFTER_MS"`
	ChunkBytes                int64 `json:"CHUNK_BYTES"`
}

type AccessResolution struct {
	SourceSelectionOwner               string   `json:"SOURCE_SELECTION_OWNER"`
	DaemonScope                        string   `json:"DAEMON_SCOPE"`
	LeaseStorage                       string   `json:"LEASE_STORAGE"`
	LeaseNeverIn                       []string `json:"LEASE_NEVER_IN"`
	CredentialSource                   string   `json:"CREDENTIAL_SOURCE"`
	MaxRefreshesPerSourcePerCooldown   int      `json:"MAX_REFRESHES_PER_SOURCE_PER_COOLDOWN"`
	RefreshCooldownMs                  int64    `json:"REFRESH_COOLDOWN_MS"`
	SingleFlight                       bool     `json:"SINGLE_FLIGHT"`
	ResolutionDeadlineMs               int64    `json:"RESOLUTION_DEADLINE_MS"`
	InsideAbsoluteReadDeadline         bool     `json:"INSIDE_ABSOLUTE_READ_DEADLINE"`
	ResolvedURLHostMustBeInAllowlist   bool     `json:"RESOLVED_URL_HOST_MUST_BE_IN_ENDPOINT_ALLOWLIST"`
	ResolvedURLRedirectsFollowed       bool     `json:"RESOLVED_URL_REDIRECTS_FOLLOWED"`
	ResolvedURLTLSVerificationRequired bool     `json:"RESOLVED_URL_TLS_VERIFICATION_REQUIRED"`
	PinnedAcrossRefresh                []string `json:"PINNED_ACROSS_REFRESH"`
	PostRefreshResponseRules           string   `json:"POST_REFRESH_RESPONSE_RULES"`
	OnRefreshFailure                   string   `json:"ON_REFRESH_FAILURE"`
	RefreshMayTriggerRefresh           bool     `json:"REFRESH_MAY_TRIGGER_REFRESH"`
}

type AdmissionLimits struct {
	GlobalMaxInflight      int   `json:"GLOBAL_MAX_INFLIGHT_SOURCE_REQUESTS"`
	PerEndpointMaxInflight int   `json:"PER_ENDPOINT_MAX_INFLIGHT_REQUESTS"`
	PerEndpointMaxConns    int   `json:"PER_ENDPOINT_MAX_CONNECTIONS"`
	MaxQueueWaitMs         int64 `json:"MAX_QUEUE_WAIT_MS"`
	CrossOpenSingleFlight  bool  `json:"CROSS_OPEN_SINGLE_FLIGHT"`
}

type CircuitBreaker struct {
	FailureThreshold                     int    `json:"FAILURE_THRESHOLD"`
	FailureWindowMs                      int64  `json:"FAILURE_WINDOW_MS"`
	OpenCooldownMs                       int64  `json:"OPEN_COOLDOWN_MS"`
	HalfOpenProbes                       int    `json:"HALF_OPEN_PROBES"`
	WhileOpen                            string `json:"WHILE_OPEN"`
	SuccessfulAccessRefreshCountsFailure bool   `json:"SUCCESSFUL_ACCESS_REFRESH_COUNTS_AS_FAILURE"`
	FailedAccessResolutionCountsFailure  bool   `json:"FAILED_ACCESS_RESOLUTION_COUNTS_AS_FAILURE"`
}

type ProbeCachePolicy struct {
	Persistent      bool   `json:"PERSISTENT"`
	BytesPerVersion int64  `json:"BYTES_PER_VERSION"`
	MaxTotalBytes   int64  `json:"MAX_TOTAL_BYTES"`
	Key             string `json:"KEY"`
	Eviction        string `json:"EVICTION"`
}

type PlaybackCachePolicy struct {
	Persistent        bool   `json:"PERSISTENT"`
	MaxTotalBytes     int64  `json:"MAX_TOTAL_BYTES"`
	MaxBytesPerHandle int64  `json:"MAX_BYTES_PER_OPEN_HANDLE"`
	Eviction          string `json:"EVICTION"`
}

type ReadaheadPolicy struct {
	SuppressedWithinBytes  int64 `json:"SUPPRESSED_WITHIN_BYTES"`
	SequentialTriggerReads int   `json:"SEQUENTIAL_TRIGGER_READS"`
	MaxReadaheadChunks     int   `json:"MAX_READAHEAD_CHUNKS"`
	CancelOnNonSequential  bool  `json:"CANCEL_ON_NON_SEQUENTIAL"`
	ActiveStreamPinning    bool  `json:"ACTIVE_STREAM_PINNING"`
}

type HandleBinding struct {
	BindsTo                []string `json:"BINDS_TO"`
	SurvivesManifestSwap   bool     `json:"SURVIVES_MANIFEST_SWAP"`
	PriorGenerationReclaim string   `json:"PRIOR_GENERATION_RECLAIM"`
	MidHandleFailover      string   `json:"MID_HANDLE_FAILOVER"`
	AccessRefreshRebinds   bool     `json:"ACCESS_REFRESH_REBINDS_HANDLE"`
}

// Phase1Budgets: every multiplier names its denominator, because "1.2x" of an unnamed quantity is not a
// budget, it is a number that gets loosened later by somebody who does not know what it counted.
type Phase1Budgets struct {
	// MaxByteMultiplier is against (probe window x scan windows x entries).
	MaxByteMultiplier float64 `json:"MAX_BYTE_MULTIPLIER"`
	// ScanWindowsPerEntry is how many fixed windows a synthetic scan reads per entry.
	ScanWindowsPerEntry int `json:"SCAN_WINDOWS_PER_ENTRY"`
	// MaxRangeRequestMultiplier is against (entries x scan windows). Ranged GETs only.
	MaxRangeRequestMultiplier float64 `json:"MAX_RANGE_REQUEST_MULTIPLIER"`
	// MaxResolutionRequestMultiplier is against entries. Access resolutions only.
	MaxResolutionRequestMultiplier float64 `json:"MAX_RESOLUTION_REQUEST_MULTIPLIER"`
	MaxHTTP429                     int     `json:"MAX_HTTP_429"`
	MaxRescanRequestMultiplier     float64 `json:"MAX_RESCAN_REQUEST_MULTIPLIER"`
	MaxLibraryChurnItems           int     `json:"MAX_LIBRARY_CHURN_ITEMS"`
}

type RetryClasses struct {
	Retryable          []string `json:"retryable"`
	AccessRefreshRetry []string `json:"access-refresh-then-retry"`
	Terminal           []string `json:"terminal"`
}

type RuntimeContract struct {
	ContractVersion  int               `json:"contractVersion"`
	Operations       map[string]string `json:"operations"`
	ErrorMap         map[string]string `json:"errorMap"`
	ReadPolicy       ReadPolicy        `json:"readPolicy"`
	RetryClasses     RetryClasses      `json:"retryClasses"`
	AccessResolution AccessResolution  `json:"accessResolution"`
	RangeRules       map[string]any    `json:"rangeRules"`
	AdmissionLimits  AdmissionLimits   `json:"admissionLimits"`
	CircuitBreaker   CircuitBreaker    `json:"circuitBreaker"`
	CachePolicy      struct {
		ProbePrefix ProbeCachePolicy    `json:"probePrefix"`
		Playback    PlaybackCachePolicy `json:"playback"`
	} `json:"cachePolicy"`
	ReadaheadPolicy ReadaheadPolicy `json:"readaheadPolicy"`
	HandleBinding   HandleBinding   `json:"handleBinding"`
	Phase1Budgets   Phase1Budgets   `json:"phase1Budgets"`
}

type Export struct {
	Format   string           `json:"format"`
	Version  int              `json:"version"`
	Manifest ManifestContract `json:"manifest"`
	Runtime  RuntimeContract  `json:"runtime"`
}

var loaded *Export

// Load decodes the embedded export. It panics on a malformed one, because a daemon that cannot read its own
// contract has nothing to enforce.
func Load() *Export {
	if loaded != nil {
		return loaded
	}
	var export Export
	if err := json.Unmarshal(raw, &export); err != nil {
		panic(fmt.Sprintf("embedded projection contract export is unreadable: %v", err))
	}
	loaded = &export
	return loaded
}
