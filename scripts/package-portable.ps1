[CmdletBinding()]
param(
    [string]$ArtifactRoot,
    [string]$PackageDirectory
)

$ErrorActionPreference = 'Stop'

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

if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    throw "Void.exe was not found: $ExecutablePath"
}

if (-not (Test-Path -LiteralPath $ProductPath -PathType Leaf)) {
    throw "Product metadata was not found: $ProductPath"
}

if (-not (Test-Path -LiteralPath $PortableReadmePath -PathType Leaf)) {
    throw "Portable data README was not found: $PortableReadmePath"
}

$Product = Get-Content -Raw -Encoding UTF8 -LiteralPath $ProductPath | ConvertFrom-Json
$Version = [string]$Product.version
if ([string]::IsNullOrWhiteSpace($Version)) {
    throw "Product version is empty: $ProductPath"
}

$OutputName = "Void-$Version-win32-x64-portable.zip"
$OutputPath = Join-Path $PackageDirectory $OutputName
$TemporaryOutputPath = Join-Path $PackageDirectory ".${OutputName}.tmp"
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
        Remove-Item -LiteralPath $TemporaryOutputPath -Force
    }

    & $NodePath $PackerPath $ArtifactRoot $TemporaryOutputPath
    if ($LASTEXITCODE -ne 0) {
        throw "Portable ZIP creation failed with exit code $LASTEXITCODE"
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Archive = [IO.Compression.ZipFile]::OpenRead($TemporaryOutputPath)
    try {
        $EntryNames = @($Archive.Entries | ForEach-Object { $_.FullName })
    } finally {
        $Archive.Dispose()
    }

    $RequiredEntries = @('Void.exe', 'data/README.txt', 'resources/app/product.json')
    foreach ($RequiredEntry in $RequiredEntries) {
        if ($EntryNames -notcontains $RequiredEntry) {
            throw "Portable ZIP is missing required entry: $RequiredEntry"
        }
    }

    $GeneratedEntries = @($EntryNames | Where-Object {
        $_ -eq 'data/argv.json' -or $_ -like 'data/user-data/*'
    })
    if ($GeneratedEntries.Count -gt 0) {
        throw "Portable ZIP contains generated test data: $($GeneratedEntries -join ', ')"
    }

    $OldArchives = @(Get-ChildItem -LiteralPath $PackageDirectory -File | Where-Object {
        $_.Name -match '^Void-.*-win32-x64-portable(?:-clean)?\.zip$'
    })
    foreach ($OldArchive in $OldArchives) {
        Remove-Item -LiteralPath $OldArchive.FullName -Force
    }

    Move-Item -LiteralPath $TemporaryOutputPath -Destination $OutputPath -Force
    $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash.ToLowerInvariant()

    Write-Output "Portable package: $OutputPath"
    Write-Output "Entries: $($EntryNames.Count)"
    Write-Output "SHA-256: $Hash"
    Write-Output "Retention: only the newest matching portable ZIP is kept in $PackageDirectory"
} finally {
    if (Test-Path -LiteralPath $TemporaryOutputPath) {
        Remove-Item -LiteralPath $TemporaryOutputPath -Force
    }
}
