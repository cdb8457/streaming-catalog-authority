# Catalog Authority - one-command setup for the ordinary-computer runtime stack (Windows / PowerShell).
#
# In this repository, where the runtime stack is one of several compose files and must be named:
#   powershell -ExecutionPolicy Bypass -File .\deploy\local-runtime-setup.ps1
#   docker compose -f docker-compose.runtime.yml up -d
#   open http://127.0.0.1:8099/
#
# In the release bundle, where it is the only one:
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#   docker compose up -d
#
# This is the native Windows twin of deploy/local-runtime-setup.sh, for a machine running Docker Desktop
# without a Bash shell. It does the same things in the same order and produces byte-identical secret files:
# LF-terminated, no BOM, so Docker hands the container exactly the value written here.
#
# WITH ONE DELIBERATE DIFFERENCE, AND IT IS A REFUSAL. `custodian_root_key` — the root wrapping key of the
# sidecar-managed KEK ring — is NOT created here. It must be owned by the sidecar's runtime user and readable
# by nobody else, and that is a POSIX guarantee this platform cannot make or check. The Bash twin creates it
# through deploy/write-custody-secret.mjs, which establishes exactly that on a file descriptor and refuses to
# create anything at all on a host that cannot. Writing one here anyway would produce a real root key with an
# unverifiable ACL that every custody check in this project would then read as established custody. The stack
# this script installs runs static KEK custody and never reads a root wrapping key, so nothing here needs one.
#
# It creates .\secrets\ (random values, never printed except the operator token you need to log in) and an
# empty .\promotion-records\ folder for the Phase 231-240 chain artifacts. It is safe to re-run: existing
# secrets are kept, never regenerated, so a re-run cannot lock you out of a running stack.
#
# It touches nothing outside this repository directory. It performs no promotion, no approval, no execution,
# no archival and no deletion; it contacts no media server, no provider and no library; it starts nothing.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This script ships twice: here under deploy\, and at the root of the release bundle, where there is no
# deploy\ directory to step out of. Both must land in the folder that holds the Compose file.
$InRepository = (Split-Path -Leaf $PSScriptRoot) -eq 'deploy'
$RepoRoot = if ($InRepository) { Split-Path -Parent $PSScriptRoot } else { $PSScriptRoot }
# The repository holds several compose files, so the runtime one has to be named; the bundle holds exactly
# one, and `docker compose` finds it by itself.
$ComposeArgs = if ($InRepository) { '-f docker-compose.runtime.yml ' } else { '' }
$SecretsDir = Join-Path $RepoRoot 'secrets'
$RecordsSetting = if ($env:PROMOTION_RECORDS_HOST_DIR) { $env:PROMOTION_RECORDS_HOST_DIR } else { './promotion-records' }
$RecordsDir = if ([System.IO.Path]::IsPathRooted($RecordsSetting)) { $RecordsSetting } else { Join-Path $RepoRoot $RecordsSetting }
# Phase 259. Where you put catalog snapshots to import. Mounted READ-ONLY into the container.
$ImportSetting = if ($env:CATALOG_IMPORT_HOST_DIR) { $env:CATALOG_IMPORT_HOST_DIR } else { './import' }
$ImportDir = if ([System.IO.Path]::IsPathRooted($ImportSetting)) { $ImportSetting } else { Join-Path $RepoRoot $ImportSetting }

# LF endings and no byte-order mark: a secret file is read verbatim, and a stray BOM would become part of a
# password or token.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function New-RandomSecret {
    # 32 cryptographically random bytes, base64 - the same shape the Bash script produces.
    $bytes = New-Object 'byte[]' 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [System.Convert]::ToBase64String($bytes)
}

function New-RandomAlphanumericSecret {
    param([int] $Length = 32)
    # Base64 with the non-alphanumeric characters removed, so the value survives being embedded in a
    # postgresql:// URL without escaping. Drawn from the same CSPRNG, and topped up rather than truncated
    # short if a draw happens to lose too many characters.
    $value = ''
    while ($value.Length -lt $Length) { $value += ((New-RandomSecret) -replace '[^A-Za-z0-9]', '') }
    return $value.Substring(0, $Length)
}

function Set-OwnerOnlyAcl {
    param([string] $Path)
    # Best effort, exactly like the Bash script's `chmod ... || true`: a restrictive ACL is worth having and
    # never worth failing the setup over.
    try {
        $acl = Get-Acl -Path $Path
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.Access)) { [void] $acl.RemoveAccessRule($rule) }
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $inheritance = if (Test-Path -Path $Path -PathType Container) { 'ContainerInherit, ObjectInherit' } else { 'None' }
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $identity, 'FullControl', $inheritance, 'None', 'Allow')))
        Set-Acl -Path $Path -AclObject $acl
    } catch {
        # Not Windows, or a filesystem without ACLs. The stack still runs.
    }
}

function Write-SecretIfAbsent {
    param([string] $Name, [string] $Value)
    $path = Join-Path $SecretsDir $Name
    if (Test-Path -Path $path -PathType Leaf) {
        Write-Host "  kept      ./secrets/$Name (already exists)"
        return
    }
    [System.IO.File]::WriteAllText($path, $Value + "`n", $Utf8NoBom)
    Set-OwnerOnlyAcl -Path $path
    Write-Host "  created   ./secrets/$Name"
}

function Deny-CustodySecret {
    # PHASE 329. THE ROOT WRAPPING KEY IS NOT CREATED ON THIS PLATFORM, AND THIS IS THE WHOLE REASON.
    #
    # THE DEFECT THIS CLOSES. This script used to create `custodian_root_key` with `Write-SecretIfAbsent`,
    # like an operator token: 32 random bytes, written through the generic writer, followed by a BEST-EFFORT
    # ACL whose `catch {}` swallows every failure. Its Bash twin does the opposite, deliberately and loudly.
    # There, custody goes through `deploy/write-custody-secret.mjs`, which opens the name once with
    # O_CREAT|O_EXCL|O_NOFOLLOW, sets the mode and the owner ON THE DESCRIPTOR, reads the bytes back from that
    # same descriptor, and REFUSES — creating nothing — on any host that cannot establish all of it. Windows
    # is named in that helper as such a host, in as many words: "this platform has no file ownership model, so
    # a root wrapping key cannot be created here owned by the sidecar runtime user and readable by nobody
    # else. NOTHING WAS CREATED."
    #
    # So the same installation step was a refusal on one platform and a silent success on the other, and the
    # silent one produced the more dangerous artefact: a file named `custodian_root_key`, holding a real key,
    # carrying no owner the sidecar could be checked against and no mode any reader could verify. Every part
    # of this project that looks at custody — the backup component check, the classifier that decides whether
    # an installation is legacy or migrated, the operator's own reading of a `secrets/` listing — would take
    # its presence as an installation that HAS a root wrapping key under the custody rules. It had a file.
    #
    # THE REFUSAL IS THIS ONE SECRET, NOT THE WHOLE SETUP. The stack this script installs is
    # `docker-compose.runtime.yml`, which runs STATIC KEK custody and has no custodian sidecar in it at all;
    # nothing here consumes a root wrapping key. Failing the entire Windows setup over a key its own stack
    # never reads would take away a supported configuration to fix a file that should not have been written.
    # So this names what it did not do and why, and the rest of the setup proceeds unchanged.
    param([string] $Name)
    $path = Join-Path $SecretsDir $Name
    if (Test-Path -Path $path -PathType Leaf) {
        # AND AN EXISTING ONE IS NAMED, NOT BLESSED AND NOT DELETED. A key written by an earlier version of
        # this script is already on disk with whatever ACL that run happened to leave; this cannot verify it
        # and will not pretend to. Removing it is not this script's decision either — it may be the only copy
        # of a key sealing a ring somewhere else.
        Write-Host "  UNVERIFIED ./secrets/$Name (present, but this platform cannot establish or check its ownership)"
        Write-Host "             It was written by an older version of this script. Treat it as compromised:"
        Write-Host "             it has never been proven readable only by the sidecar's runtime user."
        return
    }
    Write-Host "  refused   ./secrets/$Name (NOT created)"
    Write-Host "            This platform has no file ownership model, so a root wrapping key cannot be"
    Write-Host "            created here owned by the sidecar runtime user and readable by nobody else."
    Write-Host "            NOTHING WAS CREATED. The stack this script installs uses static KEK custody and"
    Write-Host "            does not read one. Managed-ring custody is established on the POSIX host that"
    Write-Host "            will actually run the sidecar, by deploy/local-runtime-setup.sh."
}

Write-Host 'Catalog Authority local runtime setup'
Write-Host ''

if (-not (Test-Path -Path $SecretsDir -PathType Container)) { [void] (New-Item -ItemType Directory -Path $SecretsDir) }
Set-OwnerOnlyAcl -Path $SecretsDir

Write-SecretIfAbsent -Name 'postgres_password' -Value (New-RandomAlphanumericSecret -Length 32)
# Read back whatever is on disk, so the URLs match a password kept from an earlier run.
$PgPassword = ([System.IO.File]::ReadAllText((Join-Path $SecretsDir 'postgres_password'))).Trim()

# The RUNTIME role's own credential. Phase 253: both URLs used to be the postgres superuser, which made
# `ops:doctor` report runtime-least-privileged FAIL — correctly — on every ordinary install. `ops:bootstrap`
# reads this file and makes the database agree with it, so the app connects as the least-privileged `app`
# role that migrations.sql has always created. A re-run KEEPS an existing database_url; moving an existing
# install onto the least-privileged role is a deliberate, documented step.
Write-SecretIfAbsent -Name 'app_password' -Value (New-RandomAlphanumericSecret -Length 32)
$AppPassword = ([System.IO.File]::ReadAllText((Join-Path $SecretsDir 'app_password'))).Trim()

Write-SecretIfAbsent -Name 'admin_database_url' -Value "postgresql://postgres:$PgPassword@postgres:5432/catalog"
Write-SecretIfAbsent -Name 'database_url' -Value "postgresql://app:$AppPassword@postgres:5432/catalog"
Write-SecretIfAbsent -Name 'completion_secret' -Value (New-RandomSecret)
Write-SecretIfAbsent -Name 'custodian_kek' -Value (New-RandomSecret)
# PHASE 282, CORRECTED IN PHASE 329. The ROOT WRAPPING KEY for the sidecar-managed KEK ring is created by
# the POSIX setup script only, through a helper that can prove the file's owner and mode. This platform
# cannot, so it refuses rather than writing an unprotected one. See Deny-CustodySecret above.
Deny-CustodySecret -Name 'custodian_root_key'
Write-SecretIfAbsent -Name 'operator_ui_token' -Value (New-RandomSecret)

if (-not (Test-Path -Path $RecordsDir -PathType Container)) { [void] (New-Item -ItemType Directory -Path $RecordsDir) }
Write-Host "  ready     $RecordsSetting (mounted read-only into the container)"
if (-not (Test-Path -Path $ImportDir -PathType Container)) { [void] (New-Item -ItemType Directory -Path $ImportDir) }
Write-Host "  ready     $ImportSetting (catalog snapshots, mounted read-only into the container)"

Write-Host ''
Write-Host 'Next:'
Write-Host "  docker compose ${ComposeArgs}up -d"
Write-Host '  open http://127.0.0.1:8099/'
Write-Host ''
Write-Host "Your operator token (paste it into the UI's Operator token box):"
Write-Host ''
Write-Host (([System.IO.File]::ReadAllText((Join-Path $SecretsDir 'operator_ui_token'))).Trim())
Write-Host ''
Write-Host "Put your Phase 231-240 chain artifacts in $RecordsSetting to see them in the"
Write-Host 'Promotion Record Chain panel. The container reads that folder and can never write to it.'
Write-Host ''
Write-Host "To fill the catalog, put a snapshot file in $ImportSetting and preview it:"
Write-Host "  docker compose ${ComposeArgs}run --rm app npm run ops:catalog-import -- --file your-snapshot.json"
Write-Host 'Add --apply to commit it, then open the Catalog panel in the UI.'
Write-Host ''
Write-Host "Stop with:  docker compose ${ComposeArgs}down"
