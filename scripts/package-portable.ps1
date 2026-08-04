[CmdletBinding()]
param(
    [string]$ArtifactRoot,
    [string]$PackageDirectory
)

$ErrorActionPreference = 'Stop'

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
$ExpectedPortableReadmeLength = 134
$ExpectedPortableReadmeHash = '5109876d2a58f1e06f257c774ffb7286b9845e96b888265ec425944175e8b695'

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

$InvalidArtifactPayloads = @($RuntimePayloadEntries | ForEach-Object {
    $ArtifactPayloadPath = Join-Path $ArtifactRoot $_.RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $ArtifactPayloadPath -PathType Leaf)) {
        "missing: $($_.RelativePath) [$($_.Component)]"
    } elseif ((Get-Item -LiteralPath $ArtifactPayloadPath).Length -eq 0) {
        "zero-length: $($_.RelativePath) [$($_.Component)]"
    }
})
if ($InvalidArtifactPayloads.Count -gt 0) {
    throw "Win32 x64 runtime payload manifest validation failed before ZIP creation:`n - $($InvalidArtifactPayloads -join "`n - ")`nManifest success is a static packaging gate, not runtime launch certification."
}

$Product = Get-Content -Raw -Encoding UTF8 -LiteralPath $ProductPath | ConvertFrom-Json
$Version = [string]$Product.version
if ([string]::IsNullOrWhiteSpace($Version)) {
    throw "Product version is empty: $ProductPath"
}

$OutputName = "Void-$Version-win32-x64-portable.zip"
$OutputPath = Join-Path $PackageDirectory $OutputName
$TemporaryOutputPath = Join-Path $PackageDirectory ".${OutputName}.tmp"
$BackupOutputPath = Join-Path $PackageDirectory ".${OutputName}.backup"
$PackerPath = Join-Path $PSScriptRoot 'package-portable.js'

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

    & $NodePath $PackerPath $ArtifactRoot $TemporaryOutputPath
    if ($LASTEXITCODE -ne 0) {
        throw "Portable ZIP creation failed with exit code $LASTEXITCODE"
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Archive = [IO.Compression.ZipFile]::OpenRead($TemporaryOutputPath)
    try {
        $ArchiveEntries = @($Archive.Entries | ForEach-Object {
            [pscustomobject]@{
                FullName = $_.FullName
                NormalizedArchivePath = ConvertTo-NormalizedArchivePath -Path $_.FullName
                Length = $_.Length
            }
        })
    } finally {
        $Archive.Dispose()
    }

    $RequiredEntries = @('Void.exe', 'data/README.txt', 'resources/app/product.json')
    foreach ($RequiredEntry in $RequiredEntries) {
        $NormalizedRequiredEntry = ConvertTo-NormalizedArchivePath -Path $RequiredEntry
        if ($ArchiveEntries.NormalizedArchivePath -notcontains $NormalizedRequiredEntry) {
            throw "Portable ZIP is missing required entry: $RequiredEntry"
        }
    }

    $InvalidArchivePayloads = @($RuntimePayloadEntries | ForEach-Object {
        $PayloadEntry = $_
        $MatchingArchiveEntry = @($ArchiveEntries | Where-Object {
            $_.NormalizedArchivePath -eq $PayloadEntry.NormalizedArchivePath
        })
        if ($MatchingArchiveEntry.Count -eq 0) {
            "missing: $($PayloadEntry.RelativePath) [$($PayloadEntry.Component)]"
        } elseif ($MatchingArchiveEntry.Count -gt 1) {
            "duplicate: $($PayloadEntry.RelativePath) [$($PayloadEntry.Component)]"
        } elseif ($MatchingArchiveEntry[0].Length -eq 0) {
            "zero-length: $($PayloadEntry.RelativePath) [$($PayloadEntry.Component)]"
        }
    })
    if ($InvalidArchivePayloads.Count -gt 0) {
        throw "Portable ZIP failed Win32 x64 runtime payload manifest validation:`n - $($InvalidArchivePayloads -join "`n - ")`nManifest success is a static packaging gate, not runtime launch certification."
    }

    $GeneratedEntries = @($ArchiveEntries | Where-Object {
        $_.NormalizedArchivePath -eq 'data/argv.json' -or $_.NormalizedArchivePath -like 'data/user-data/*'
    })
    if ($GeneratedEntries.Count -gt 0) {
        throw "Portable ZIP contains generated test data: $($GeneratedEntries.FullName -join ', ')"
    }

    $ValidatedTemporaryLength = (Get-Item -LiteralPath $TemporaryOutputPath).Length
    $ValidatedTemporaryHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $TemporaryOutputPath).Hash.ToLowerInvariant()
    $PreviousOutputLength = $null
    $PreviousOutputHash = $null
    $BackupCreated = $false

    if (Test-Path -LiteralPath $OutputPath -PathType Leaf) {
        $PreviousOutputLength = (Get-Item -LiteralPath $OutputPath).Length
        $PreviousOutputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash.ToLowerInvariant()
        Move-Item -LiteralPath $OutputPath -Destination $BackupOutputPath
        $BackupCreated = $true
    }

    try {
        Move-Item -LiteralPath $TemporaryOutputPath -Destination $OutputPath
        $PublishedOutput = Get-Item -LiteralPath $OutputPath
        $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash.ToLowerInvariant()
        if ($PublishedOutput.Length -ne $ValidatedTemporaryLength -or $Hash -ne $ValidatedTemporaryHash) {
            throw "Published portable ZIP does not match the validated temporary ZIP: expected length=$ValidatedTemporaryLength, SHA-256=$ValidatedTemporaryHash; actual length=$($PublishedOutput.Length), SHA-256=$Hash"
        }
    } catch {
        $PublishFailure = $_
        if (Test-Path -LiteralPath $OutputPath -PathType Leaf) {
            $RollbackCleanupPurpose = if ($BackupCreated) {
                "Rollback removal of the unverified published portable ZIP; preserved backup remains at $BackupOutputPath"
            } else {
                'Rollback removal of the unverified published portable ZIP'
            }
            Remove-UnverifiedPublishedOutputForRollback -CandidatePath $OutputPath -OutputName $OutputName -PackageDirectoryPath $PackageDirectory -FinalOutputPath $OutputPath -CleanupPurpose $RollbackCleanupPurpose
        }
        if ($BackupCreated) {
            try {
                Move-Item -LiteralPath $BackupOutputPath -Destination $OutputPath
                $RestoredOutput = Get-Item -LiteralPath $OutputPath
                $RestoredOutputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash.ToLowerInvariant()
                if ($RestoredOutput.Length -ne $PreviousOutputLength -or $RestoredOutputHash -ne $PreviousOutputHash) {
                    throw "Restored backup does not match the previous portable ZIP: expected length=$PreviousOutputLength, SHA-256=$PreviousOutputHash; actual length=$($RestoredOutput.Length), SHA-256=$RestoredOutputHash"
                }
                $BackupCreated = $false
            } catch {
                throw "Portable ZIP publish failed and backup restoration also failed. Publish error: $($PublishFailure.Exception.Message) Restore error: $($_.Exception.Message) Backup: $BackupOutputPath"
            }
        }
        throw "Portable ZIP publish failed; the previous final ZIP was restored when one existed. $($PublishFailure.Exception.Message)"
    }

    if ($BackupCreated) {
        Remove-ExpectedPackageCleanupFile -CandidatePath $BackupOutputPath -ExpectedLeafName ".${OutputName}.backup" -PackageDirectoryPath $PackageDirectory -FinalOutputPath $OutputPath -CleanupPurpose "Post-publish backup cleanup after validated final ZIP $OutputPath"
        $BackupCreated = $false
    }

    $FinalOutputPath = [IO.Path]::GetFullPath($OutputPath)
    $FinalTemporaryOutputPath = [IO.Path]::GetFullPath($TemporaryOutputPath)
    $FinalBackupOutputPath = [IO.Path]::GetFullPath($BackupOutputPath)
    $OldArchives = @(Get-ChildItem -LiteralPath $PackageDirectory -File | Where-Object {
        $_.Name -cmatch '^Void-.*-win32-x64-portable\.zip$' -and
        -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($_.FullName), $FinalOutputPath) -and
        -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($_.FullName), $FinalTemporaryOutputPath) -and
        -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($_.FullName), $FinalBackupOutputPath)
    })
    try {
        foreach ($OldArchive in $OldArchives) {
            Remove-ExpectedPackageCleanupFile -CandidatePath $OldArchive.FullName -ExpectedLeafPattern '^Void-.*-win32-x64-portable\.zip$' -PackageDirectoryPath $PackageDirectory -FinalOutputPath $OutputPath -CleanupPurpose "Old portable ZIP retention cleanup after validated final ZIP $OutputPath"
        }
    } catch {
        throw "Portable ZIP was published and validated at $OutputPath (SHA-256: $Hash), but old ZIP retention cleanup left duplicate residue. $($_.Exception.Message)"
    }

    Write-Output "Portable package: $OutputPath"
    Write-Output "Entries: $($ArchiveEntries.Count)"
    Write-Output "SHA-256: $Hash"
    Write-Output "Retention: only the newest matching portable ZIP is kept in $PackageDirectory"
    Write-Output "Runtime payload manifest: static packaging validation passed; runtime launch certification is separate"
} finally {
    if (Test-Path -LiteralPath $TemporaryOutputPath) {
        Remove-ExpectedPackageCleanupFile -CandidatePath $TemporaryOutputPath -ExpectedLeafName ".${OutputName}.tmp" -PackageDirectoryPath $PackageDirectory -FinalOutputPath $OutputPath -CleanupPurpose 'Final temporary ZIP cleanup'
    }
}
