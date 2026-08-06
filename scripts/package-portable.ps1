[CmdletBinding()]
param(
    [string]$ArtifactRoot,
    [string]$PackageDirectory,
    [string]$PreparedArchivePath,
    [string]$PreparedArchiveRoot,
    [int]$RequiredDocsContract = -1
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-content-manifest.ps1')

function ConvertTo-NormalizedArchivePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $NormalizedPath = $Path.Trim().Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($NormalizedPath) -or
        $NormalizedPath.StartsWith('/') -or
        $NormalizedPath -match '^[A-Za-z]:' -or
        $NormalizedPath.Contains('//') -or
        $NormalizedPath.Split('/') -contains '..' -or
        $NormalizedPath.Split('/') -contains '.') {
        throw "Runtime payload manifest contains an invalid artifact-relative path: $Path"
    }

    return $NormalizedPath.ToLowerInvariant()
}

function Test-IsTransientFileLockException {
    param(
        [Parameter(Mandatory = $true)]
        [System.Exception]$Exception
    )

    if ($Exception -isnot [IO.IOException] -and
        $Exception -isnot [UnauthorizedAccessException]) {
        return $false
    }

    # Win32 ERROR_SHARING_VIOLATION (32) and ERROR_LOCK_VIOLATION (33), including
    # their HRESULT-wrapped forms (0x80070020 / 0x80070021).
    $Win32Error = $Exception.HResult -band 0xffff
    return $Win32Error -eq 32 -or $Win32Error -eq 33
}

function Remove-PackageFileWithBoundedRetry {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CandidatePath,

        [Parameter(Mandatory = $true)]
        [string]$CleanupPurpose
    )

    # Five attempts with 200 ms, 400 ms, 600 ms, and 800 ms waits (2 seconds total)
    # tolerate a short-lived scanner/indexer lock without hiding non-lock failures.
    $MaximumAttempts = 5
    for ($Attempt = 1; $Attempt -le $MaximumAttempts; $Attempt++) {
        if (-not (Test-Path -LiteralPath $CandidatePath)) {
            return
        }

        try {
            Remove-Item -LiteralPath $CandidatePath -Force -ErrorAction Stop
            return
        } catch {
            if (-not (Test-IsTransientFileLockException -Exception $_.Exception)) {
                throw
            }
            if ($Attempt -eq $MaximumAttempts) {
                throw "$CleanupPurpose failed after $MaximumAttempts attempts due to a sharing/lock violation; the exact candidate remains: $CandidatePath"
            }

            # Release any managed archive/hash handles before retrying a locked file.
            Write-Output "$CleanupPurpose retry $Attempt of $MaximumAttempts after sharing/lock violation; waiting $($Attempt * 200) ms: $CandidatePath"
            [GC]::Collect()
            [GC]::WaitForPendingFinalizers()
            [GC]::Collect()
            Start-Sleep -Milliseconds (200 * $Attempt)
        }
    }
}

function Remove-ExpectedPackageCleanupFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CandidatePath,

        [string]$ExpectedLeafName,

        [string]$ExpectedLeafPattern,

        [Parameter(Mandatory = $true)]
        [string]$PackageDirectoryPath,

        [Parameter(Mandatory = $true)]
        [string]$FinalOutputPath,

        [Parameter(Mandatory = $true)]
        [string]$CleanupPurpose
    )

    if (([string]::IsNullOrWhiteSpace($ExpectedLeafName) -and [string]::IsNullOrWhiteSpace($ExpectedLeafPattern)) -or
        (-not [string]::IsNullOrWhiteSpace($ExpectedLeafName) -and -not [string]::IsNullOrWhiteSpace($ExpectedLeafPattern))) {
        throw 'Portable package cleanup requires exactly one expected leaf name or leaf pattern.'
    }

    $ResolvedPackageDirectory = [IO.Path]::GetFullPath($PackageDirectoryPath).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $ResolvedCandidatePath = [IO.Path]::GetFullPath($CandidatePath)
    $ResolvedFinalOutputPath = [IO.Path]::GetFullPath($FinalOutputPath)
    $CandidateParent = Split-Path -Parent $ResolvedCandidatePath
    $CandidateLeaf = Split-Path -Leaf $ResolvedCandidatePath

    $ExpectedLeafMatches = if (-not [string]::IsNullOrWhiteSpace($ExpectedLeafName)) {
        [StringComparer]::Ordinal.Equals($CandidateLeaf, $ExpectedLeafName)
    } else {
        $CandidateLeaf -cmatch $ExpectedLeafPattern
    }

    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($CandidateParent, $ResolvedPackageDirectory) -or
        -not $ExpectedLeafMatches -or
        [StringComparer]::OrdinalIgnoreCase.Equals($ResolvedCandidatePath, $ResolvedFinalOutputPath)) {
        throw "Refusing $CleanupPurpose for an unexpected portable package file: $ResolvedCandidatePath"
    }

    Remove-PackageFileWithBoundedRetry -CandidatePath $ResolvedCandidatePath -CleanupPurpose $CleanupPurpose
}

function Remove-UnverifiedPublishedOutputForRollback {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CandidatePath,

        [Parameter(Mandatory = $true)]
        [string]$OutputName,

        [Parameter(Mandatory = $true)]
        [string]$PackageDirectoryPath,

        [Parameter(Mandatory = $true)]
        [string]$FinalOutputPath,

        [Parameter(Mandatory = $true)]
        [string]$CleanupPurpose
    )

    $ResolvedPackageDirectory = [IO.Path]::GetFullPath($PackageDirectoryPath).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $ResolvedCandidatePath = [IO.Path]::GetFullPath($CandidatePath)
    $ResolvedFinalOutputPath = [IO.Path]::GetFullPath($FinalOutputPath)
    $CandidateParent = Split-Path -Parent $ResolvedCandidatePath
    $CandidateLeaf = Split-Path -Leaf $ResolvedCandidatePath
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($CandidateParent, $ResolvedPackageDirectory) -or
        -not [StringComparer]::Ordinal.Equals($CandidateLeaf, $OutputName) -or
        -not [StringComparer]::OrdinalIgnoreCase.Equals($ResolvedCandidatePath, $ResolvedFinalOutputPath)) {
        throw "Refusing rollback removal for an unexpected portable package final ZIP: $ResolvedCandidatePath"
    }

    Remove-PackageFileWithBoundedRetry -CandidatePath $ResolvedCandidatePath -CleanupPurpose $CleanupPurpose
}

function Move-PackageFileWithBoundedRetry {
    param([Parameter(Mandatory = $true)][string]$SourcePath, [Parameter(Mandatory = $true)][string]$DestinationPath, [Parameter(Mandatory = $true)][string]$Purpose)
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try { Move-Item -LiteralPath $SourcePath -Destination $DestinationPath -ErrorAction Stop; return } catch {
            if (-not (Test-IsTransientFileLockException -Exception $_.Exception) -or $attempt -eq 5) { throw "$Purpose failed: $($_.Exception.Message)" }
            Write-Output "$Purpose retry $attempt of 5 after sharing/lock violation"
            [GC]::Collect(); [GC]::WaitForPendingFinalizers(); Start-Sleep -Milliseconds (200 * $attempt)
        }
    }
}

function Get-PeMachineFromArchiveEntry {
    param([Parameter(Mandatory = $true)][IO.Compression.ZipArchiveEntry]$Entry)
    $stream = $Entry.Open()
    $memory = New-Object IO.MemoryStream
    try { $stream.CopyTo($memory) } finally { $stream.Dispose() }
    $memory.Position = 0
    $reader = New-Object IO.BinaryReader($memory)
    try {
        if ($reader.ReadUInt16() -ne 0x5a4d) { throw "Runtime payload is not a PE file: $($Entry.FullName)" }
        $memory.Position = 0x3c
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0 -or $peOffset -gt ($Entry.Length - 6)) { throw "Runtime payload has an invalid PE offset: $($Entry.FullName)" }
        $memory.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw "Runtime payload has no PE signature: $($Entry.FullName)" }
        return $reader.ReadUInt16()
    } finally { $reader.Dispose(); $memory.Dispose() }
}

function Get-PeMachineFromFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::OpenRead($Path); $reader = New-Object IO.BinaryReader($stream)
    try { if ($reader.ReadUInt16() -ne 0x5a4d) { throw "Runtime payload is not a PE file: $Path" }; $stream.Position = 0x3c; $offset = $reader.ReadInt32(); if ($offset -lt 0 -or $offset -gt ($stream.Length - 6)) { throw "Runtime payload has an invalid PE offset: $Path" }; $stream.Position = $offset; if ($reader.ReadUInt32() -ne 0x00004550) { throw "Runtime payload has no PE signature: $Path" }; return $reader.ReadUInt16() } finally { $reader.Dispose(); $stream.Dispose() }
}

function Assert-PortableArchive {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][object[]]$PayloadEntries,
        [Parameter(Mandatory = $true)]$ContentManifest,
        [int]$RequiredContract = -1
    )
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $byPath = @{}
        $entries = @($archive.Entries | ForEach-Object {
            $canonicalPath = $_.FullName
            $normalizedPath = ConvertTo-NormalizedArchivePath -Path $canonicalPath
            if ($canonicalPath.IndexOf([char]92) -ge 0 -or $canonicalPath -cne $canonicalPath.Trim('/') -or $canonicalPath.ToLowerInvariant() -cne $normalizedPath) {
                throw "Portable ZIP contains a non-canonical entry path: $canonicalPath"
            }
            if ($byPath.ContainsKey($canonicalPath)) { throw "Portable ZIP contains a duplicate or case-colliding path: $canonicalPath" }
            $byPath[$canonicalPath] = $_
            [pscustomobject]@{ Entry = $_; FullName = $canonicalPath; NormalizedArchivePath = $normalizedPath; Length = $_.Length }
        })
        foreach ($required in @('Void.exe', 'data/README.txt', 'resources/app/product.json')) {
            if ($entries.NormalizedArchivePath -notcontains (ConvertTo-NormalizedArchivePath -Path $required)) { throw "Portable ZIP is missing required entry: $required" }
        }
        if (@($entries | Where-Object { $_.NormalizedArchivePath -eq 'data/argv.json' -or $_.NormalizedArchivePath -like 'data/user-data/*' }).Count -gt 0) { throw 'Portable ZIP contains generated test data.' }
        foreach ($payload in $PayloadEntries) {
            $matches = @($entries | Where-Object { $_.NormalizedArchivePath -eq $payload.NormalizedArchivePath })
            if ($matches.Count -ne 1 -or $matches[0].Length -le 0) { throw "Portable ZIP failed runtime payload gate: $($payload.RelativePath) [$($payload.Component)]" }
            # All manifest payloads are native Windows binaries and must be x64, not merely nonzero.
            if ((Get-PeMachineFromArchiveEntry -Entry $matches[0].Entry) -ne 0x8664) { throw "Runtime payload is not x64: $($payload.RelativePath) [$($payload.Component)]" }
        }
        $productEntry = $byPath['resources/app/product.json']
        $reader = New-Object IO.StreamReader($productEntry.Open(), [Text.UTF8Encoding]::new($false, $true), $true)
        try { $productVersion = [string](($reader.ReadToEnd() | ConvertFrom-Json).version) } finally { $reader.Dispose() }
        if ([string]::IsNullOrWhiteSpace($productVersion)) { throw 'Portable ZIP product version is empty.' }
        $docs = Assert-ReleaseContentArchiveDocsContract -EntriesByPath $byPath -Manifest $ContentManifest -ProductVersion $productVersion -RequiredContract $RequiredContract
        [pscustomobject]@{ Entries = $entries; DocsContract = $docs.Contract; DocsCount = $docs.Count; Docs = @($docs.Entries); Version = $productVersion }
    } finally { $archive.Dispose() }
}

function Get-PortableProductVersion {
    param([Parameter(Mandatory = $true)][string]$ArchivePath)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $entry = @($archive.Entries | Where-Object { (ConvertTo-NormalizedArchivePath -Path $_.FullName) -eq 'resources/app/product.json' })
        if ($entry.Count -ne 1) { throw "Prepared archive must contain exactly one resources/app/product.json: $ArchivePath" }
        $reader = New-Object IO.StreamReader($entry[0].Open(), [Text.UTF8Encoding]::new($false), $true)
        try { return [string]((ConvertFrom-Json $reader.ReadToEnd()).version) } finally { $reader.Dispose() }
    } finally { $archive.Dispose() }
}

function Publish-PortableArchive {
    param(
        [Parameter(Mandatory = $true)][string]$TemporaryPath,
        [Parameter(Mandatory = $true)][string]$OutputPath,
        [Parameter(Mandatory = $true)][string]$BackupPath,
        [Parameter(Mandatory = $true)][string]$OutputName,
        [Parameter(Mandatory = $true)][object[]]$PayloadEntries,
        [Parameter(Mandatory = $true)]$ContentManifest,
        [int]$CandidateRequiredDocsContract = 1
    )
    # This is the sole final/backup transaction for generated and prepared candidates.
    if ((Test-Path -LiteralPath $OutputPath -PathType Leaf) -and (Test-Path -LiteralPath $BackupPath -PathType Leaf)) { throw "Ambiguous portable ZIP publish state: both final and backup exist. Final: $OutputPath Backup: $BackupPath" }
    $expectedLength = (Get-Item -LiteralPath $TemporaryPath).Length
    $expectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $TemporaryPath).Hash.ToLowerInvariant()
    $null = Assert-PortableArchive -ArchivePath $TemporaryPath -PayloadEntries $PayloadEntries -ContentManifest $ContentManifest -RequiredContract $CandidateRequiredDocsContract
    $previousLength = $null; $previousHash = $null; $backupCreated = $false
    $previousDocsContract = -1
    if (Test-Path -LiteralPath $OutputPath -PathType Leaf) {
        $previousLength = (Get-Item -LiteralPath $OutputPath).Length
        $previousHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash.ToLowerInvariant()
        $previousValidation = Assert-PortableArchive -ArchivePath $OutputPath -PayloadEntries $PayloadEntries -ContentManifest $ContentManifest
        $previousDocsContract = $previousValidation.DocsContract
        Move-PackageFileWithBoundedRetry -SourcePath $OutputPath -DestinationPath $BackupPath -Purpose 'Preserve validated portable ZIP backup'
        $backupCreated = $true
    }
    try {
        Move-PackageFileWithBoundedRetry -SourcePath $TemporaryPath -DestinationPath $OutputPath -Purpose 'Publish validated portable ZIP'
        if ((Get-Item -LiteralPath $OutputPath).Length -ne $expectedLength -or (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Published portable ZIP hash or length differs from its validated candidate.' }
        $publishedValidation = Assert-PortableArchive -ArchivePath $OutputPath -PayloadEntries $PayloadEntries -ContentManifest $ContentManifest -RequiredContract $CandidateRequiredDocsContract
    } catch {
        $failure = $_
        if (Test-Path -LiteralPath $OutputPath -PathType Leaf) {
            try { Remove-UnverifiedPublishedOutputForRollback -CandidatePath $OutputPath -OutputName $OutputName -PackageDirectoryPath (Split-Path -Parent $OutputPath) -FinalOutputPath $OutputPath -CleanupPurpose 'Rollback removal of unverified portable ZIP' }
            catch { throw "Portable publish rollback cannot remove the unverified final; refusing to overwrite either artifact. Final: $OutputPath Backup: $BackupPath FinalHash=$((Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash) BackupHash=$((if (Test-Path -LiteralPath $BackupPath) { (Get-FileHash -Algorithm SHA256 -LiteralPath $BackupPath).Hash } else { 'absent' })) Error=$($_.Exception.Message)" }
        }
        if ($backupCreated) {
            try {
                Move-PackageFileWithBoundedRetry -SourcePath $BackupPath -DestinationPath $OutputPath -Purpose 'Restore validated portable ZIP backup'
                if ((Get-Item -LiteralPath $OutputPath).Length -ne $previousLength -or (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash.ToLowerInvariant() -ne $previousHash) { throw 'Restored backup hash or length differs from the preserved final.' }
                $null = Assert-PortableArchive -ArchivePath $OutputPath -PayloadEntries $PayloadEntries -ContentManifest $ContentManifest -RequiredContract $previousDocsContract
                $backupCreated = $false
            } catch { throw "Portable publish failed and backup restoration failed. Publish: $($failure.Exception.Message) Restore: $($_.Exception.Message)" }
        }
        throw "Portable publish failed; prior final was restored when present. $($failure.Exception.Message)"
    }
    if ($backupCreated) { Remove-ExpectedPackageCleanupFile -CandidatePath $BackupPath -ExpectedLeafName ".${OutputName}.backup" -PackageDirectoryPath (Split-Path -Parent $OutputPath) -FinalOutputPath $OutputPath -CleanupPurpose 'Post-publish validated backup cleanup' }
    return [pscustomobject]@{ Hash = $expectedHash; Length = $expectedLength; Entries = $publishedValidation.Entries; DocsContract = $publishedValidation.DocsContract; DocsCount = $publishedValidation.DocsCount; Docs = @($publishedValidation.Docs) }
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SourceParent = Split-Path -Parent $ProjectRoot

if ([string]::IsNullOrWhiteSpace($ArtifactRoot)) {
    $ArtifactRoot = Join-Path $SourceParent 'VSCode-win32-x64'
}

if ([string]::IsNullOrWhiteSpace($PackageDirectory)) {
    $PackageDirectory = $SourceParent
}

$ArtifactRoot = [IO.Path]::GetFullPath($ArtifactRoot)
$PackageDirectory = [IO.Path]::GetFullPath($PackageDirectory)
$ProductPath = Join-Path $ArtifactRoot 'resources\app\product.json'
$ExecutablePath = Join-Path $ArtifactRoot 'Void.exe'
$PortableReadmePath = Join-Path $ArtifactRoot 'data\README.txt'
$PortableReadmeTemplatePath = Join-Path $PSScriptRoot 'portable-data-readme.txt'
$RuntimePayloadManifestPath = Join-Path $PSScriptRoot 'win32-x64-runtime-payload-manifest.json'
$ReleaseContentManifestPath = Join-Path $PSScriptRoot 'release-content\manifest.json'
$ReleaseContentRoot = Join-Path $PSScriptRoot 'release-content'
$ExpectedPortableReadmeLength = 134
$ExpectedPortableReadmeHash = '5109876d2a58f1e06f257c774ffb7286b9845e96b888265ec425944175e8b695'
$ReleaseContentManifest = Get-ReleaseContentManifest -ManifestPath $ReleaseContentManifestPath -ContentRoot $ReleaseContentRoot
if ($RequiredDocsContract -notin @(-1, 0, 1)) { throw 'RequiredDocsContract must be -1, 0, or 1.' }
$IsPreparedMode = -not [string]::IsNullOrWhiteSpace($PreparedArchivePath)
if (-not $IsPreparedMode -and -not [string]::IsNullOrWhiteSpace($PreparedArchiveRoot)) { throw 'PreparedArchiveRoot requires PreparedArchivePath.' }
if ($IsPreparedMode) {
    $PreparedArchivePath = [IO.Path]::GetFullPath($PreparedArchivePath)
    $PreparedArchiveRoot = [IO.Path]::GetFullPath($PreparedArchiveRoot)
    if (-not (Test-Path -LiteralPath $PreparedArchiveRoot -PathType Container) -or (Get-Item -LiteralPath $PreparedArchiveRoot).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or (Get-Item -LiteralPath $PreparedArchivePath).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'Prepared archive root and candidate must exist and must not be reparse points.' }
    if ([StringComparer]::OrdinalIgnoreCase.Equals($PreparedArchiveRoot, $PackageDirectory) -or -not [StringComparer]::OrdinalIgnoreCase.Equals((Split-Path -Parent $PreparedArchivePath), $PreparedArchiveRoot)) { throw 'Prepared archive must be an immediate child of a distinct PreparedArchiveRoot.' }
}

if (-not $IsPreparedMode) {
if (-not (Test-Path -LiteralPath $ArtifactRoot -PathType Container)) { throw "Artifact root was not found: $ArtifactRoot" }
$null = Assert-ReleaseContentNoArtifactCollisions -Manifest $ReleaseContentManifest -ArtifactRoot $ArtifactRoot
if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    throw "Void.exe was not found: $ExecutablePath"
}

if (-not (Test-Path -LiteralPath $ProductPath -PathType Leaf)) {
    throw "Product metadata was not found: $ProductPath"
}

if (-not (Test-Path -LiteralPath $PortableReadmeTemplatePath -PathType Leaf) -or
    (Get-Item -LiteralPath $PortableReadmeTemplatePath).Length -eq 0) {
    throw "Portable data README template was not found or is empty: $PortableReadmeTemplatePath"
}

$PortableDataPath = Split-Path -Parent $PortableReadmePath
if (Test-Path -LiteralPath $PortableDataPath -PathType Leaf) {
    throw "Portable data path is a file, not a directory: $PortableDataPath"
}
if (-not (Test-Path -LiteralPath $PortableDataPath -PathType Container)) {
    New-Item -ItemType Directory -Path $PortableDataPath | Out-Null
}

$PortableReadmeContent = Get-Content -Raw -Encoding UTF8 -LiteralPath $PortableReadmeTemplatePath
$NormalizedPortableReadmeContent = $PortableReadmeContent.Replace("`r`n", "`n").Replace("`r", "`n")
$Utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
$PortableReadmeBytes = $Utf8WithoutBom.GetBytes($NormalizedPortableReadmeContent)
$PortableReadmeHasher = [Security.Cryptography.SHA256]::Create()
try {
    $NormalizedPortableReadmeHash = (($PortableReadmeHasher.ComputeHash($PortableReadmeBytes) | ForEach-Object { $_.ToString('x2') }) -join '')
} finally {
    $PortableReadmeHasher.Dispose()
}
if ($PortableReadmeBytes.Length -ne $ExpectedPortableReadmeLength -or
    $NormalizedPortableReadmeHash -ne $ExpectedPortableReadmeHash) {
    throw "Normalized portable data README template does not match the expected deterministic bytes: length=$($PortableReadmeBytes.Length), SHA-256=$NormalizedPortableReadmeHash"
}

[IO.File]::WriteAllBytes($PortableReadmePath, $PortableReadmeBytes)
$WrittenPortableReadme = Get-Item -LiteralPath $PortableReadmePath
$WrittenPortableReadmeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PortableReadmePath).Hash.ToLowerInvariant()
if ($WrittenPortableReadme.Length -ne $ExpectedPortableReadmeLength -or
    $WrittenPortableReadmeHash -ne $ExpectedPortableReadmeHash) {
    throw "Portable data README write verification failed: length=$($WrittenPortableReadme.Length), SHA-256=$WrittenPortableReadmeHash, path=$PortableReadmePath"
}
}

if (-not (Test-Path -LiteralPath $RuntimePayloadManifestPath -PathType Leaf)) {
    throw "Win32 x64 runtime payload manifest was not found: $RuntimePayloadManifestPath"
}

$RuntimePayloadManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $RuntimePayloadManifestPath | ConvertFrom-Json
if ($RuntimePayloadManifest.schemaVersion -ne 1 -or
    $RuntimePayloadManifest.target.platform -ne 'win32' -or
    $RuntimePayloadManifest.target.architecture -ne 'x64') {
    throw "Win32 x64 runtime payload manifest has an unsupported schema or target: $RuntimePayloadManifestPath"
}

$RuntimePayloadEntries = @($RuntimePayloadManifest.entries | ForEach-Object {
    $Component = [string]$_.component
    $RelativePath = [string]$_.path
    if ([string]::IsNullOrWhiteSpace($Component)) {
        throw "Runtime payload manifest contains an entry with an empty component: $RuntimePayloadManifestPath"
    }

    $NormalizedArchivePath = ConvertTo-NormalizedArchivePath -Path $RelativePath
    if (-not $NormalizedArchivePath.StartsWith('resources/app/')) {
        throw "Runtime payload manifest path must be relative to ArtifactRoot and include the resources/app prefix: $RelativePath"
    }

    [pscustomobject]@{
        Component = $Component
        RelativePath = $RelativePath
        NormalizedArchivePath = $NormalizedArchivePath
    }
})
if ($RuntimePayloadEntries.Count -eq 0) {
    throw "Win32 x64 runtime payload manifest contains no entries: $RuntimePayloadManifestPath"
}

$DuplicatePayloadPaths = @($RuntimePayloadEntries | Group-Object -Property NormalizedArchivePath | Where-Object { $_.Count -gt 1 })
if ($DuplicatePayloadPaths.Count -gt 0) {
    throw "Win32 x64 runtime payload manifest contains duplicate paths: $($DuplicatePayloadPaths.Name -join ', ')"
}

$InvalidArtifactPayloads = if (-not $IsPreparedMode) { @($RuntimePayloadEntries | ForEach-Object {
    $ArtifactPayloadPath = Join-Path $ArtifactRoot $_.RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $ArtifactPayloadPath -PathType Leaf)) {
        "missing: $($_.RelativePath) [$($_.Component)]"
    } elseif ((Get-Item -LiteralPath $ArtifactPayloadPath).Length -eq 0) {
        "zero-length: $($_.RelativePath) [$($_.Component)]"
    } elseif ((Get-PeMachineFromFile -Path $ArtifactPayloadPath) -ne 0x8664) {
        "not-x64: $($_.RelativePath) [$($_.Component)]"
    }
}) } else { @() }
if ($InvalidArtifactPayloads.Count -gt 0) {
    throw "Win32 x64 runtime payload manifest validation failed before ZIP creation:`n - $($InvalidArtifactPayloads -join "`n - ")`nManifest success is a static packaging gate, not runtime launch certification."
}

$Version = if ($IsPreparedMode) { Get-PortableProductVersion -ArchivePath $PreparedArchivePath } else { [string]((Get-Content -Raw -Encoding UTF8 -LiteralPath $ProductPath | ConvertFrom-Json).version) }
if ([string]::IsNullOrWhiteSpace($Version)) {
    throw "Product version is empty: $ProductPath"
}

$OutputName = "Void-$Version-win32-x64-portable.zip"
$OutputPath = Join-Path $PackageDirectory $OutputName
$TemporaryOutputPath = Join-Path $PackageDirectory ".${OutputName}.tmp"
$BackupOutputPath = Join-Path $PackageDirectory ".${OutputName}.backup"
$PackerPath = Join-Path $PSScriptRoot 'package-portable.js'
if ($IsPreparedMode -and (-not [StringComparer]::Ordinal.Equals((Split-Path -Leaf $PreparedArchivePath), $OutputName))) { throw "Prepared archive leaf must be exactly $OutputName" }

$WorkspaceRoot = Split-Path -Parent $SourceParent
$LocalNodePath = Join-Path $WorkspaceRoot '.toolchain\node-v20.18.2-win-x64\node.exe'
if (Test-Path -LiteralPath $LocalNodePath -PathType Leaf) {
    $NodePath = $LocalNodePath
} else {
    $NodeCommand = Get-Command node -ErrorAction Stop
    $NodePath = $NodeCommand.Source
}

try {
    if (Test-Path -LiteralPath $TemporaryOutputPath) {
        Remove-ExpectedPackageCleanupFile -CandidatePath $TemporaryOutputPath -ExpectedLeafName ".${OutputName}.tmp" -PackageDirectoryPath $PackageDirectory -FinalOutputPath $OutputPath -CleanupPurpose 'Pre-package temporary ZIP cleanup'
    }

    if (Test-Path -LiteralPath $BackupOutputPath) {
        if (Test-Path -LiteralPath $OutputPath -PathType Leaf) {
            throw "Ambiguous portable ZIP publish state: both the final ZIP and preserved backup exist. The final ZIP may be unverified from a failed rollback. No files were deleted; verify both hashes and resolve manually before packaging. Final: $OutputPath Backup: $BackupOutputPath"
        }
        throw "A preserved portable ZIP publish backup exists without a final ZIP; no files were deleted. Resolve it manually before packaging: $BackupOutputPath"
    }

    if ([string]::IsNullOrWhiteSpace($PreparedArchivePath)) {
        & $NodePath $PackerPath $ArtifactRoot $TemporaryOutputPath $ReleaseContentManifestPath $Version
        if ($LASTEXITCODE -ne 0) { throw "Portable ZIP creation failed with exit code $LASTEXITCODE" }
    } else {
        $PreparedArchivePath = [IO.Path]::GetFullPath($PreparedArchivePath)
        if (-not (Test-Path -LiteralPath $PreparedArchivePath -PathType Leaf) -or
            -not [StringComparer]::Ordinal.Equals((Split-Path -Leaf $PreparedArchivePath), $OutputName) -or
            [StringComparer]::OrdinalIgnoreCase.Equals($PreparedArchivePath, $OutputPath) -or
            [StringComparer]::OrdinalIgnoreCase.Equals($PreparedArchivePath, $TemporaryOutputPath) -or
            [StringComparer]::OrdinalIgnoreCase.Equals($PreparedArchivePath, $BackupOutputPath)) { throw "Prepared archive must be an existing external file named $OutputName" }
        $null = Assert-PortableArchive -ArchivePath $PreparedArchivePath -PayloadEntries $RuntimePayloadEntries -ContentManifest $ReleaseContentManifest -RequiredContract $RequiredDocsContract
        $PreparedLength = (Get-Item -LiteralPath $PreparedArchivePath).Length
        $PreparedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PreparedArchivePath).Hash.ToLowerInvariant()
        [IO.File]::Copy($PreparedArchivePath, $TemporaryOutputPath, $false)
        if ((Get-Item -LiteralPath $TemporaryOutputPath).Length -ne $PreparedLength -or (Get-FileHash -Algorithm SHA256 -LiteralPath $TemporaryOutputPath).Hash.ToLowerInvariant() -ne $PreparedHash) { throw 'Prepared archive copy does not match the validated input.' }
    }
    $CandidateRequiredDocsContract = if ($IsPreparedMode) { $RequiredDocsContract } else { 1 }
    $null = Assert-PortableArchive -ArchivePath $TemporaryOutputPath -PayloadEntries $RuntimePayloadEntries -ContentManifest $ReleaseContentManifest -RequiredContract $CandidateRequiredDocsContract

    $Published = Publish-PortableArchive -TemporaryPath $TemporaryOutputPath -OutputPath $OutputPath -BackupPath $BackupOutputPath -OutputName $OutputName -PayloadEntries $RuntimePayloadEntries -ContentManifest $ReleaseContentManifest -CandidateRequiredDocsContract $CandidateRequiredDocsContract
    $Hash = $Published.Hash
    $ArchiveEntries = $Published.Entries

    $FinalOutputPath = [IO.Path]::GetFullPath($OutputPath)
    $FinalTemporaryOutputPath = [IO.Path]::GetFullPath($TemporaryOutputPath)
    $FinalBackupOutputPath = [IO.Path]::GetFullPath($BackupOutputPath)
    $OldArchives = @(Get-ChildItem -LiteralPath $PackageDirectory -File | Where-Object {
        $_.Name -cmatch '^Void-.*-win32-x64-portable(?:-clean)?\.zip$' -and
        -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($_.FullName), $FinalOutputPath) -and
        -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($_.FullName), $FinalTemporaryOutputPath) -and
        -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($_.FullName), $FinalBackupOutputPath)
    })
    try {
        foreach ($OldArchive in $OldArchives) {
            Remove-ExpectedPackageCleanupFile -CandidatePath $OldArchive.FullName -ExpectedLeafPattern '^Void-.*-win32-x64-portable(?:-clean)?\.zip$' -PackageDirectoryPath $PackageDirectory -FinalOutputPath $OutputPath -CleanupPurpose "Old portable ZIP retention cleanup after validated final ZIP $OutputPath"
        }
    } catch {
        throw "Portable ZIP was published and validated at $OutputPath (SHA-256: $Hash), but old ZIP retention cleanup left duplicate residue. $($_.Exception.Message)"
    }

    Write-Output "Portable package: $OutputPath"
    Write-Output "Entries: $($ArchiveEntries.Count)"
    Write-Output "Portable docs contract: $($Published.DocsContract) ($($Published.DocsCount) manifest entries)"
    Write-Output "SHA-256: $Hash"
    Write-Output "Retention: only the newest matching portable ZIP is kept in $PackageDirectory"
    Write-Output "Runtime payload manifest: static packaging validation passed; runtime launch certification is separate"
} finally {
    if (Test-Path -LiteralPath $TemporaryOutputPath) {
        Remove-ExpectedPackageCleanupFile -CandidatePath $TemporaryOutputPath -ExpectedLeafName ".${OutputName}.tmp" -PackageDirectoryPath $PackageDirectory -FinalOutputPath $OutputPath -CleanupPurpose 'Final temporary ZIP cleanup'
    }
}
