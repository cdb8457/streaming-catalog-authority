/**
 * Phase 31 - TorBox adapter boundary research contract.
 *
 * Static metadata only: no SDK import, no network client, no env reads, no provider behavior.
 */

export type TorBoxPhase31CapabilityStatus = 'phase-31-allowed' | 'future-gated' | 'forbidden';

export interface TorBoxPhase31Capability {
  readonly id: string;
  readonly officialGroup: 'torrents' | 'web-downloads-debrid' | 'usenet' | 'general-status' | 'hosters';
  readonly officialSurface: string;
  readonly status: TorBoxPhase31CapabilityStatus;
  readonly phase31Use: string;
  readonly boundaryReason: string;
}

export const TORBOX_BOUNDARY_CONTRACT = {
  phase: 31,
  name: 'torbox-adapter-boundary-research',
  officialBaseUrl: 'https://api.torbox.app',
  officialSources: [
    'https://api-docs.torbox.app/',
    'https://github.com/TorBox-App/torbox-sdk-js',
    'https://github.com/TorBox-App/torbox-sdk-js/blob/main/documentation/services/TorrentsService.md',
    'https://github.com/TorBox-App/torbox-sdk-js/blob/main/documentation/services/WebDownloadsDebridService.md',
    'https://github.com/TorBox-App/torbox-sdk-js/blob/main/documentation/services/UsenetService.md',
    'https://github.com/TorBox-App/torbox-sdk-js/blob/main/documentation/services/GeneralService.md',
  ],
  sdk: {
    packageName: '@torbox/torbox-api',
    language: 'TypeScript',
    status: 'documented-only-not-installed',
    tokenAuth: 'future secret indirection only; no Phase 31 env reads',
    timeout: 'future client must set bounded per-request timeout',
  },
  capabilities: [
    {
      id: 'torrent-cache-check',
      officialGroup: 'torrents',
      officialSurface: 'TorrentsService.getTorrentCachedAvailability',
      status: 'phase-31-allowed',
      phase31Use: 'Static contract expectation for future advisory cache lookup by one infohash/hash digest.',
      boundaryReason: 'Read-only cache availability can fit AdapterRefView when scoped to one ref.',
    },
    {
      id: 'webdl-cache-check',
      officialGroup: 'web-downloads-debrid',
      officialSurface: 'WebDownloadsDebridService.getWebDownloadCachedAvailability',
      status: 'phase-31-allowed',
      phase31Use: 'Static contract expectation for future advisory cache lookup by one link-derived digest.',
      boundaryReason: 'Read-only cache availability can fit AdapterRefView when raw links and titles do not cross.',
    },
    {
      id: 'usenet-cache-check',
      officialGroup: 'usenet',
      officialSurface: 'UsenetService.getUsenetCachedAvailability',
      status: 'phase-31-allowed',
      phase31Use: 'Static contract expectation for future advisory cache lookup by one NZB/hash digest.',
      boundaryReason: 'Read-only cache availability can fit AdapterRefView when scoped to one digest.',
    },
    {
      id: 'hoster-list',
      officialGroup: 'hosters',
      officialSurface: 'WebDownloadsDebridService.getHosterList',
      status: 'phase-31-allowed',
      phase31Use: 'Static contract expectation for future advisory hoster capability discovery.',
      boundaryReason: 'Hoster status is service metadata, not catalog identity or user item state.',
    },
    {
      id: 'status-check',
      officialGroup: 'general-status',
      officialSurface: 'GeneralService.getUpStatus',
      status: 'phase-31-allowed',
      phase31Use: 'Static contract expectation for future service health/status observation.',
      boundaryReason: 'Service status is provider metadata and must remain advisory.',
    },
    {
      id: 'create-download',
      officialGroup: 'torrents',
      officialSurface: 'createTorrent/createWebDownload/createUsenetDownload',
      status: 'future-gated',
      phase31Use: 'Not callable in Phase 31.',
      boundaryReason: 'Creates provider-side state and may initiate download workflows.',
    },
    {
      id: 'request-download-link',
      officialGroup: 'torrents',
      officialSurface: 'requestDownloadLink/requestDownloadLink2/requestDownloadLink3',
      status: 'future-gated',
      phase31Use: 'Not callable in Phase 31.',
      boundaryReason: 'Produces metered download/CDN/permalink URLs and may expose token-bearing URLs.',
    },
  ] satisfies readonly TorBoxPhase31Capability[],
  allowedDataCrossing: {
    inbound: ['opaque itemId', 'exactly one scoped provider ref'],
    scopedRefExamples: ['infohash', 'hash digest', 'link-derived digest', 'NZB-derived digest'],
    outbound: ['advisory availability/status', 'redaction-safe diagnostics', 'future opaque handle only after gate'],
    maxProviderRefsPerCall: 1,
  },
  forbiddenDataCrossing: [
    'title',
    'year',
    'externalIds',
    'metadata',
    'raw catalog identity',
    'raw provider ref fanout',
    'media titles',
    'Plex ids',
    'Jellyfin ids',
    'download URLs',
    'CDN URLs',
    'permalink URLs',
  ],
  forbiddenPhase31Operations: [
    'create torrent',
    'create web download',
    'create usenet download',
    'request download link',
    'retrieve user list',
    'retrieve user data',
    'control item',
    'delete item',
    'export torrent data',
    'store CDN URL',
    'store permalink URL',
    'put token in URL',
    'live network',
    'database write',
    'Docker invocation',
    'environment secret read',
    'provider mode',
  ],
  credentialRules: [
    'Future token must be provided by secret indirection, not checked into config.',
    'Phase 31 must not read environment variables or secret files.',
    'Token must not appear in URLs, logs, evidence, thrown messages, or persisted outputs.',
    'Prefer Authorization Bearer/header auth where the official surface permits it.',
    'Any unavoidable official token-query surface requires a separate future security gate.',
  ],
  outputRules: [
    'Outputs are advisory only.',
    'No event-log, projection, or catalog DB writes.',
    'No persisted provider payloads.',
    'Only redaction-safe status, counts, booleans, and opaque handles after a future gate.',
  ],
  futureRequirements: [
    'Bounded per-request timeout.',
    'Rate-limit aware backoff with jitter.',
    'Fail closed on auth, quota, network, parse, and ambiguous availability errors.',
    'No automatic retries for mutating operations without an outbox/idempotency design.',
    'Local fake TorBox adapter contract before any real client.',
    'Gated real client later, reviewed separately, with live smoke outside CI.',
  ],
  explicitNonGoals: [
    'No @torbox/torbox-api dependency.',
    'No live TorBox integration.',
    'No Real-Debrid integration.',
    'No downloading.',
    'No playback.',
    'No scraping.',
    'No Plex or Jellyfin workflow.',
    'No HTTP service or UI.',
  ],
} as const;
