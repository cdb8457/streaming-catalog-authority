# Catalog Authority - one-command setup for the ordinary-computer runtime stack (Windows / PowerShell).
#
#   powershell -ExecutionPolicy Bypass -File .\deploy\local-runtime-setup.ps1
#   docker compose -f docker-compose.runtime.yml up -d
#   open http://127.0.0.1:8099/
#
# This is the native Windows twin of deploy/local-runtime-setup.sh, for a machine running Docker Desktop
# without a Bash shell. It does the same things in the same order and produces byte-identical secret files:
# LF-terminated, no BOM, so Docker hands the container exactly the value written here.
#
# It creates .\secrets\ (random values, never printed except the operator token you need to log in) and an
# empty .\promotion-records\ folder for the Phase 231-240 chain artifacts. It is safe to re-run: existing
# secrets are kept, never regenerated, so a re-run cannot lock you out of a running stack.
#
# It touches nothing outside this repository directory. It performs no promotion, no approval, no execution,
# no archival and no deletion; it contacts no media server, no provider and no library; it starts nothing.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SecretsDir = Join-Path $RepoRoot 'secrets'
$RecordsSetting = if ($env:PROMOTION_RECORDS_HOST_DIR) { $env:PROMOTION_RECORDS_HOST_DIR } else { './promotion-records' }
$RecordsDir = if ([System.IO.Path]::IsPathRooted($RecordsSetting)) { $RecordsSetting } else { Join-Path $RepoRoot $RecordsSetting }

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

Write-Host 'Catalog Authority local runtime setup'
Write-Host ''

if (-not (Test-Path -Path $SecretsDir -PathType Container)) { [void] (New-Item -ItemType Directory -Path $SecretsDir) }
Set-OwnerOnlyAcl -Path $SecretsDir

Write-SecretIfAbsent -Name 'postgres_password' -Value (New-RandomAlphanumericSecret -Length 32)
# Read back whatever is on disk, so the URLs match a password kept from an earlier run.
$PgPassword = ([System.IO.File]::ReadAllText((Join-Path $SecretsDir 'postgres_password'))).Trim()

Write-SecretIfAbsent -Name 'admin_database_url' -Value "postgresql://postgres:$PgPassword@postgres:5432/catalog"
Write-SecretIfAbsent -Name 'database_url' -Value "postgresql://postgres:$PgPassword@postgres:5432/catalog"
Write-SecretIfAbsent -Name 'completion_secret' -Value (New-RandomSecret)
Write-SecretIfAbsent -Name 'custodian_kek' -Value (New-RandomSecret)
Write-SecretIfAbsent -Name 'operator_ui_token' -Value (New-RandomSecret)

if (-not (Test-Path -Path $RecordsDir -PathType Container)) { [void] (New-Item -ItemType Directory -Path $RecordsDir) }
Write-Host "  ready     $RecordsSetting (mounted read-only into the container)"

Write-Host ''
Write-Host 'Next:'
Write-Host '  docker compose -f docker-compose.runtime.yml up -d'
Write-Host '  open http://127.0.0.1:8099/'
Write-Host ''
Write-Host "Your operator token (paste it into the UI's Operator token box):"
Write-Host ''
Write-Host (([System.IO.File]::ReadAllText((Join-Path $SecretsDir 'operator_ui_token'))).Trim())
Write-Host ''
Write-Host "Put your Phase 231-240 chain artifacts in $RecordsSetting to see them in the"
Write-Host 'Promotion Record Chain panel. The container reads that folder and can never write to it.'
Write-Host ''
Write-Host 'Stop with:  docker compose -f docker-compose.runtime.yml down'
