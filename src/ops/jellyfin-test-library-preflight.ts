import { createHash } from 'node:crypto';

export const EXPECTED_TEST_LIBRARY_NAME = 'Catalog Authority Test';
export const EXPECTED_TEST_LIBRARY_CONTAINER_PATH = '/media/catalog-authority-test-library';
export const EXPECTED_TEST_LIBRARY_HOST_PATH = '/mnt/user/media/catalog-authority-test-library';

export interface JellyfinVirtualFolder {
  readonly Name?: unknown;
  readonly Locations?: unknown;
}

export interface JellyfinTestLibraryPreflightReport {
  readonly report: 'phase-226-jellyfin-test-library-preflight';
  readonly ok: boolean;
  readonly redactionSafe: true;
  readonly expected: {
    readonly libraryName: typeof EXPECTED_TEST_LIBRARY_NAME;
    readonly containerPath: typeof EXPECTED_TEST_LIBRARY_CONTAINER_PATH;
    readonly hostPath: typeof EXPECTED_TEST_LIBRARY_HOST_PATH;
  };
  readonly checks: readonly JellyfinTestLibraryPreflightCheck[];
  readonly library: {
    readonly found: boolean;
    readonly locationDigest?: string;
    readonly itemCount?: number;
  };
  readonly forbidden: readonly [
    'jellyfin-write-api',
    'provider-live-mode',
    'downloading',
    'scraping',
    'playback',
    'gelato-path',
    'real-library-path',
  ];
}

export interface JellyfinTestLibraryPreflightCheck {
  readonly name:
    | 'host-folder'
    | 'container-mount'
    | 'virtual-folder'
    | 'not-gelato'
    | 'empty-or-test-only';
  readonly ok: boolean;
  readonly detail: string;
}

const FORBIDDEN: JellyfinTestLibraryPreflightReport['forbidden'] = [
  'jellyfin-write-api',
  'provider-live-mode',
  'downloading',
  'scraping',
  'playback',
  'gelato-path',
  'real-library-path',
];

export function buildJellyfinTestLibraryPreflight(input: {
  readonly hostFolderExists: boolean;
  readonly mountDestinations: readonly string[];
  readonly virtualFolders: readonly JellyfinVirtualFolder[];
  readonly itemCount?: number;
}): JellyfinTestLibraryPreflightReport {
  const checks: JellyfinTestLibraryPreflightCheck[] = [];
  checks.push({
    name: 'host-folder',
    ok: input.hostFolderExists,
    detail: input.hostFolderExists ? 'expected host folder exists' : 'expected host folder is missing',
  });
  const mounted = input.mountDestinations.includes(EXPECTED_TEST_LIBRARY_CONTAINER_PATH);
  checks.push({
    name: 'container-mount',
    ok: mounted,
    detail: mounted ? 'expected test-library container mount is present' : 'expected test-library container mount is missing',
  });
  const folder = findExpectedVirtualFolder(input.virtualFolders);
  checks.push({
    name: 'virtual-folder',
    ok: folder !== undefined,
    detail: folder ? 'expected Jellyfin virtual folder is configured' : 'expected Jellyfin virtual folder is missing',
  });
  const locations = folder ? stringLocations(folder) : [];
  const pointsAtGelato = locations.some((location) => location.toLowerCase().includes('/gelato/'));
  checks.push({
    name: 'not-gelato',
    ok: folder !== undefined && !pointsAtGelato && locations.includes(EXPECTED_TEST_LIBRARY_CONTAINER_PATH),
    detail: folder === undefined
      ? 'cannot prove test library is separate before virtual folder exists'
      : pointsAtGelato
        ? 'test library points at a Gelato path'
        : locations.includes(EXPECTED_TEST_LIBRARY_CONTAINER_PATH)
          ? 'test library points at the expected isolated path'
          : 'test library does not point at the expected isolated path',
  });
  checks.push({
    name: 'empty-or-test-only',
    ok: input.itemCount === undefined || input.itemCount === 0,
    detail: input.itemCount === undefined ? 'item count not supplied' : `${input.itemCount} item(s) currently visible in test library`,
  });
  return {
    report: 'phase-226-jellyfin-test-library-preflight',
    ok: checks.every((check) => check.ok),
    redactionSafe: true,
    expected: {
      libraryName: EXPECTED_TEST_LIBRARY_NAME,
      containerPath: EXPECTED_TEST_LIBRARY_CONTAINER_PATH,
      hostPath: EXPECTED_TEST_LIBRARY_HOST_PATH,
    },
    checks,
    library: {
      found: folder !== undefined,
      ...(locations[0] ? { locationDigest: digestLocation(locations[0]) } : {}),
      ...(input.itemCount !== undefined ? { itemCount: input.itemCount } : {}),
    },
    forbidden: FORBIDDEN,
  };
}

function findExpectedVirtualFolder(folders: readonly JellyfinVirtualFolder[]): JellyfinVirtualFolder | undefined {
  return folders.find((folder) => folder.Name === EXPECTED_TEST_LIBRARY_NAME);
}

function stringLocations(folder: JellyfinVirtualFolder): string[] {
  return Array.isArray(folder.Locations)
    ? folder.Locations.filter((location): location is string => typeof location === 'string')
    : [];
}

function digestLocation(value: string): string {
  return createHash('sha256').update(`phase-226-test-library-location:${value}`).digest('hex').slice(0, 16);
}

