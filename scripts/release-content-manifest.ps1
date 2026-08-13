function Get-ReleaseContentStrictUtf8Data {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Release content file is missing or is not a regular file: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Release content reparse points are forbidden: $Path"
    }
    $bytes = [IO.File]::ReadAllBytes($item.FullName)
    if ($bytes.Length -eq 0) {
        throw "Release content file is empty: $Path"
    }
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
        throw "Release content must be UTF-8 without BOM: $Path"
    }
    $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
    try {
        $text = $strictUtf8.GetString($bytes)
    } catch {
        throw "Release content is not strict UTF-8: $Path"
    }
    [pscustomobject]@{ Path = $item.FullName; Bytes = $bytes; Text = $text }
}

function Assert-ReleaseContentWindowsSafePathSegments {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    foreach ($segment in $Path.Split('/')) {
        $dotIndex = $segment.IndexOf('.')
        $deviceBaseName = if ($dotIndex -ge 0) { $segment.Substring(0, $dotIndex) } else { $segment }
        if ($segment -eq '' -or
            $segment.EndsWith('.') -or
            $segment.EndsWith(' ') -or
            [regex]::IsMatch($segment, '[\x00-\x1f<>:"/\\|?*]') -or
            $deviceBaseName -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') {
            throw "Release content $Purpose path contains a Windows-unsafe segment: $Path"
        }
    }
}

function ConvertTo-ReleaseContentCanonicalPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    if ([string]::IsNullOrWhiteSpace($Path) -or
        $Path -cne $Path.Trim() -or
        $Path.IndexOf([char]92) -ge 0 -or
        $Path.StartsWith('/') -or
        $Path -match '^[A-Za-z]:' -or
        $Path.Contains(':') -or
        $Path.EndsWith('/')) {
        throw "Release content $Purpose path is not canonical: $Path"
    }
    $segments = @($Path.Split('/'))
    if ($segments.Count -eq 0 -or @($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) {
        throw "Release content $Purpose path is unsafe: $Path"
    }
    Assert-ReleaseContentWindowsSafePathSegments -Path $Path -Purpose $Purpose
    $Path
}

function Assert-ReleaseContentObjectProperties {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Allowed,
        [Parameter(Mandatory = $true)][string[]]$Required,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    $names = @($Value.PSObject.Properties.Name)
    $unknown = @($names | Where-Object { $Allowed -cnotcontains $_ })
    $missing = @($Required | Where-Object { $names -cnotcontains $_ })
    if ($unknown.Count -gt 0 -or $missing.Count -gt 0) {
        throw "Release content $Purpose has unknown or missing properties. Unknown=[$($unknown -join ', ')] Missing=[$($missing -join ', ')]"
    }
}

function Resolve-ReleaseContentSourceFile {
    param(
        [Parameter(Mandatory = $true)][string]$ContentRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $root = [IO.Path]::GetFullPath($ContentRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        throw "Release content root is missing: $root"
    }
    $rootItem = Get-Item -LiteralPath $root -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Release content root cannot be a reparse point: $root"
    }

    $candidate = [IO.Path]::GetFullPath((Join-Path $root ($RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar))))
    $prefix = $root + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Release content source escapes its root: $RelativePath"
    }

    $current = $root
    foreach ($segment in $RelativePath.Split('/')) {
        $current = Join-Path $current $segment
        if (-not (Test-Path -LiteralPath $current)) {
            throw "Release content source is missing: $RelativePath"
        }
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Release content source path contains a reparse point: $RelativePath"
        }
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf) -or (Get-Item -LiteralPath $candidate).PSIsContainer) {
        throw "Release content source is not a regular file: $RelativePath"
    }
    $candidate
}

function Get-ReleaseContentManifest {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$ContentRoot
    )

    $manifestData = Get-ReleaseContentStrictUtf8Data $ManifestPath
    try {
        $raw = $manifestData.Text | ConvertFrom-Json
    } catch {
        throw "Release content manifest is not strict JSON: $ManifestPath"
    }
    Assert-ReleaseContentObjectProperties $raw @('schemaVersion', 'entries') @('schemaVersion', 'entries') 'manifest root'
    if ([int]$raw.schemaVersion -ne 1) {
        throw "Unsupported release content manifest schema: $($raw.schemaVersion)"
    }

    $rawEntries = @($raw.entries)
    if ($rawEntries.Count -eq 0) {
        throw 'Release content manifest has no entries.'
    }
    $seenSources = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $seenOuter = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $seenPortable = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $entries = New-Object Collections.ArrayList
    $outerMetadataCount = 0
    $productVersionCount = 0

    foreach ($rawEntry in $rawEntries) {
        Assert-ReleaseContentObjectProperties $rawEntry @('source', 'outerPath', 'portablePath', 'materialization') @('source', 'materialization') 'manifest entry'
        $source = ConvertTo-ReleaseContentCanonicalPath ([string]$rawEntry.source) 'source'
        $outerPath = if ($rawEntry.PSObject.Properties.Name -ccontains 'outerPath') { ConvertTo-ReleaseContentCanonicalPath ([string]$rawEntry.outerPath) 'outer' } else { $null }
        $portablePath = if ($rawEntry.PSObject.Properties.Name -ccontains 'portablePath') { ConvertTo-ReleaseContentCanonicalPath ([string]$rawEntry.portablePath) 'portable' } else { $null }
        $materialization = [string]$rawEntry.materialization

        if ($null -eq $outerPath -and $null -eq $portablePath) {
            throw "Release content entry has no destination: $source"
        }
        if ($materialization -cnotin @('copy', 'outer-metadata', 'product-version')) {
            throw "Release content entry has unsupported materialization '$materialization': $source"
        }
        if (-not $seenSources.Add($source)) {
            throw "Release content manifest has a duplicate source path: $source"
        }
        if ($null -ne $outerPath -and -not $seenOuter.Add($outerPath)) {
            throw "Release content manifest has a duplicate or case-colliding outer path: $outerPath"
        }
        if ($null -ne $portablePath) {
            if (-not $portablePath.StartsWith('docs/', [StringComparison]::Ordinal) -or $portablePath -ceq 'docs/') {
                throw "Portable release content must use canonical docs/ paths: $portablePath"
            }
            if (-not $seenPortable.Add($portablePath)) {
                throw "Release content manifest has a duplicate or case-colliding portable path: $portablePath"
            }
        }

        if ($materialization -ceq 'outer-metadata') {
            $outerMetadataCount++
            if ($outerPath -cne 'README.md' -or $null -ne $portablePath) {
                throw 'outer-metadata is restricted to the outer-only README.md entry.'
            }
        }
        if ($materialization -ceq 'product-version') {
            $productVersionCount++
            if ($null -ne $outerPath -or $null -eq $portablePath) {
                throw 'product-version is restricted to portable-only content.'
            }
        }

        $sourcePath = Resolve-ReleaseContentSourceFile $ContentRoot $source
        $data = Get-ReleaseContentStrictUtf8Data $sourcePath
        $datedInternalRoute = '(?i)(?<![a-z0-9])gpt-[a-z0-9._-]*\d{4}-\d{2}-\d{2}(?![a-z0-9])'
        if ($data.Text.Contains('gpt-5.6-luna-2026-07-09') -or $data.Text -match $datedInternalRoute) {
            throw "Release content contains a dated internal model route: $source"
        }
        $placeholders = @([regex]::Matches($data.Text, '\{\{[^{}\r\n]+\}\}') | ForEach-Object { $_.Value })
        if ($materialization -ceq 'copy' -and $placeholders.Count -ne 0) {
            throw "Copy release content has an unresolved placeholder: $source"
        }
        if ($materialization -ceq 'outer-metadata') {
            $approved = @('{{PORTABLE_SIZE}}', '{{PORTABLE_SHA256}}', '{{PORTABLE_ENTRIES}}', '{{SOURCE_HEAD}}', '{{BUILD_DATE_KST}}')
            if ($placeholders.Count -ne $approved.Count) {
                throw 'Outer README placeholders must be exactly the approved five once each.'
            }
            foreach ($token in $approved) {
                if (@($placeholders | Where-Object { $_ -ceq $token }).Count -ne 1) {
                    throw 'Outer README placeholders must be exactly the approved five once each.'
                }
            }
        }
        if ($materialization -ceq 'product-version' -and ($placeholders.Count -ne 1 -or $placeholders[0] -cne '{{PRODUCT_VERSION}}')) {
            throw "product-version content must contain exactly one {{PRODUCT_VERSION}} placeholder: $source"
        }

        if ($null -ne $portablePath) {
            $forbiddenPortable = '(?i)([A-Z]:\\|\bapi[ _-]?key\b|\bcustom headers?\b|\b(?:task|thread)[ _-]?ids?\b|\bcorporate host\b|\bspec[\\/])'
            $internalKoreanMarker = ([string][char]0xc0ac) + [char]0xb0b4
            if ($data.Text -match $forbiddenPortable -or $data.Text.Contains($internalKoreanMarker)) {
                throw "Portable release content contains forbidden internal or sensitive text: $source"
            }
        }

        [void]$entries.Add([pscustomobject]@{
            Source = $source
            SourcePath = $sourcePath
            SourceBytes = [byte[]]$data.Bytes
            SourceText = $data.Text
            OuterPath = $outerPath
            PortablePath = $portablePath
            Materialization = $materialization
        })
    }

    if ($outerMetadataCount -ne 1) {
        throw "Release content manifest must have exactly one outer-metadata entry, got $outerMetadataCount."
    }
    if ($productVersionCount -ne 1) {
        throw "Release content manifest must have exactly one product-version entry, got $productVersionCount."
    }
    [pscustomobject]@{
        SchemaVersion = 1
        ManifestPath = $manifestData.Path
        ContentRoot = [IO.Path]::GetFullPath($ContentRoot)
        Entries = @($entries)
        OuterEntries = @($entries | Where-Object { $null -ne $_.OuterPath })
        PortableEntries = @($entries | Where-Object { $null -ne $_.PortablePath })
    }
}

function Get-ReleaseContent8ad348eContractSnapshot {
    $entries = @(
        [pscustomobject]@{ Source = 'README.md'; OuterPath = 'README.md'; PortablePath = $null; Materialization = 'outer-metadata' }
        [pscustomobject]@{ Source = 'portable/README.md'; OuterPath = $null; PortablePath = 'docs/README.md'; Materialization = 'copy' }
        [pscustomobject]@{ Source = 'portable/getting-started.md'; OuterPath = $null; PortablePath = 'docs/getting-started.md'; Materialization = 'copy' }
        [pscustomobject]@{ Source = 'portable/release-notes.md'; OuterPath = $null; PortablePath = 'docs/release-notes.md'; Materialization = 'product-version' }
        [pscustomobject]@{ Source = 'guides/write-tool-guide.md'; OuterPath = 'guides/write-tool-guide.md'; PortablePath = 'docs/guides/write-tool-guide.md'; Materialization = 'copy' }
        [pscustomobject]@{ Source = 'guides/read-tool-guide.md'; OuterPath = 'guides/read-tool-guide.md'; PortablePath = 'docs/guides/read-tool-guide.md'; Materialization = 'copy' }
        [pscustomobject]@{ Source = 'prompts/write-tool-test-prompts.md'; OuterPath = 'prompts/write-tool-test-prompts.md'; PortablePath = 'docs/prompts/write-tool-test-prompts.md'; Materialization = 'copy' }
        [pscustomobject]@{ Source = 'prompts/read-tool-test-prompts.md'; OuterPath = 'prompts/read-tool-test-prompts.md'; PortablePath = 'docs/prompts/read-tool-test-prompts.md'; Materialization = 'copy' }
    )
    [pscustomobject]@{
        Layout = '8ad348e'
        Entries = @($entries)
        OuterEntries = @($entries | Where-Object { $null -ne $_.OuterPath })
        PortableEntries = @($entries | Where-Object { $null -ne $_.PortablePath })
    }
}

function Get-ReleaseContentMaterializedBytes {
    param(
        [Parameter(Mandatory = $true)]$Entry,
        [hashtable]$OuterTokens,
        [string]$ProductVersion
    )

    if ($Entry.Materialization -ceq 'copy') {
        return ,([byte[]]$Entry.SourceBytes.Clone())
    }
    $text = [string]$Entry.SourceText
    if ($Entry.Materialization -ceq 'outer-metadata') {
        $approved = @('{{PORTABLE_SIZE}}', '{{PORTABLE_SHA256}}', '{{PORTABLE_ENTRIES}}', '{{SOURCE_HEAD}}', '{{BUILD_DATE_KST}}')
        if ($null -eq $OuterTokens) {
            throw 'Outer metadata tokens are required.'
        }
        foreach ($token in $approved) {
            if (-not $OuterTokens.ContainsKey($token) -or [string]::IsNullOrWhiteSpace([string]$OuterTokens[$token])) {
                throw "Outer metadata token is missing: $token"
            }
            $text = $text.Replace($token, [string]$OuterTokens[$token])
        }
    } elseif ($Entry.Materialization -ceq 'product-version') {
        if ([string]::IsNullOrWhiteSpace($ProductVersion)) {
            throw 'Product version is required for portable release content.'
        }
        $text = $text.Replace('{{PRODUCT_VERSION}}', $ProductVersion)
    } else {
        throw "Unsupported release content materialization: $($Entry.Materialization)"
    }
    if ($text -match '\{\{[^{}\r\n]+\}\}') {
        throw "Release content has an unresolved placeholder after materialization: $($Entry.Source)"
    }
    $utf8 = New-Object Text.UTF8Encoding($false, $true)
    $bytes = $utf8.GetBytes($text)
    if ($bytes.Length -eq 0) {
        throw "Materialized release content is empty: $($Entry.Source)"
    }
    return ,$bytes
}

function Get-ReleaseContentBytesSha256 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
        $sha.Dispose()
    }
}

function Get-ReleaseContentPlan {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][ValidateSet('Outer', 'Portable')][string]$Target,
        [hashtable]$OuterTokens,
        [string]$ProductVersion
    )

    $selected = if ($Target -ceq 'Outer') { @($Manifest.OuterEntries) } else { @($Manifest.PortableEntries) }
    @($selected | ForEach-Object {
        $bytes = [byte[]](Get-ReleaseContentMaterializedBytes $_ -OuterTokens $OuterTokens -ProductVersion $ProductVersion)
        [pscustomobject]@{
            Path = if ($Target -ceq 'Outer') { $_.OuterPath } else { $_.PortablePath }
            Source = $_.Source
            Materialization = $_.Materialization
            Bytes = $bytes
            Length = $bytes.Length
            Sha256 = Get-ReleaseContentBytesSha256 $bytes
        }
    })
}

function Read-ReleaseContentZipEntryBytes {
    param([Parameter(Mandatory = $true)]$Entry)
    $input = $Entry.Open()
    $memory = New-Object IO.MemoryStream
    try {
        $input.CopyTo($memory)
        [byte[]]$memory.ToArray()
    } finally {
        $memory.Dispose()
        $input.Dispose()
    }
}

function Assert-ReleaseContentStrictUtf8Bytes {
    param(
        [Parameter(Mandatory = $true)][byte[]]$Bytes,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    if ($Bytes.Length -eq 0) {
        throw "Release content $Purpose is empty."
    }
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 239 -and $Bytes[1] -eq 187 -and $Bytes[2] -eq 191) {
        throw "Release content $Purpose must be UTF-8 without BOM."
    }
    $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
    try {
        [void]$strictUtf8.GetString($Bytes)
    } catch {
        throw "Release content $Purpose is not strict UTF-8."
    }
}

function Test-ReleaseContentBytesEqual {
    param([Parameter(Mandatory = $true)][byte[]]$Left, [Parameter(Mandatory = $true)][byte[]]$Right)
    if ($Left.Length -ne $Right.Length) { return $false }
    for ($index = 0; $index -lt $Left.Length; $index++) {
        if ($Left[$index] -ne $Right[$index]) { return $false }
    }
    $true
}

function Assert-ReleaseContentSharedArchiveBytes {
    param(
        [Parameter(Mandatory = $true)]$Entry,
        [Parameter(Mandatory = $true)][byte[]]$OuterBytes,
        [Parameter(Mandatory = $true)]$PortableRecord,
        [switch]$HistoricalArchive
    )

    if ($null -eq $PortableRecord -or [long]$PortableRecord.Length -le 0 -or [string]::IsNullOrWhiteSpace([string]$PortableRecord.Sha256)) {
        throw "Portable docs metadata is missing shared content: $($Entry.PortablePath)"
    }
    $outerHash = Get-ReleaseContentBytesSha256 $OuterBytes
    if ($HistoricalArchive) {
        if ([long]$OuterBytes.Length -ne [long]$PortableRecord.Length -or $outerHash -cne [string]$PortableRecord.Sha256) {
            throw "Historical outer and portable shared content bytes differ: $($Entry.Source)"
        }
        return
    }

    $sourceBytes = [byte[]]$Entry.SourceBytes
    $sourceHash = Get-ReleaseContentBytesSha256 $sourceBytes
    if ($outerHash -cne $sourceHash -or
        [string]$PortableRecord.Sha256 -cne $sourceHash -or
        [long]$PortableRecord.Length -ne [long]$sourceBytes.Length -or
        -not (Test-ReleaseContentBytesEqual $OuterBytes $sourceBytes)) {
        throw "Outer and portable shared content bytes differ: $($Entry.Source)"
    }
}

function Assert-ReleaseContentArchiveDocsContract {
    param(
        [Parameter(Mandatory = $true)]$EntriesByPath,
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$ProductVersion,
        [int[]]$AllowedContracts = @(0, 1),
        [int]$RequiredContract = -1,
        [ValidateSet('current', '8ad348e')][string]$RequiredLayout,
        [switch]$HistoricalArchive
    )

    $actualDocs = @($EntriesByPath.Keys | Where-Object { $_ -ceq 'docs' -or $_.StartsWith('docs/', [StringComparison]::OrdinalIgnoreCase) })
    $contract = if ($actualDocs.Count -eq 0) { 0 } else { 1 }
    if ($AllowedContracts -notcontains $contract -or ($RequiredContract -ge 0 -and $contract -ne $RequiredContract)) {
        throw "Portable docs contract $contract is not allowed; required=$RequiredContract allowed=[$($AllowedContracts -join ',')]."
    }
    if ($contract -eq 0) {
        if (-not $HistoricalArchive -or -not [string]::IsNullOrWhiteSpace($RequiredLayout)) {
            throw 'Portable docs contract 0 is allowed only for a historical archive without a docs layout requirement.'
        }
        return [pscustomobject]@{ Contract = 0; Layout = $null; Count = 0; Entries = @() }
    }

    $currentExpected = @(Get-ReleaseContentPlan $Manifest Portable -ProductVersion $ProductVersion)
    $historicalSnapshot = Get-ReleaseContent8ad348eContractSnapshot
    $historicalExpected = @($historicalSnapshot.PortableEntries | ForEach-Object {
        [pscustomobject]@{ Path = $_.PortablePath; Source = $_.Source; Materialization = $_.Materialization }
    })
    $matchesExactPaths = {
        param([object[]]$Expected)
        $paths = @($Expected | ForEach-Object { $_.Path })
        $actualDocs.Count -eq $paths.Count -and
            @($paths | Where-Object { $actualDocs -cnotcontains $_ }).Count -eq 0 -and
            @($actualDocs | Where-Object { $paths -cnotcontains $_ }).Count -eq 0
    }
    $layout = if (& $matchesExactPaths $currentExpected) {
        'current'
    } elseif ($HistoricalArchive -and (& $matchesExactPaths $historicalExpected)) {
        '8ad348e'
    } else {
        $expectedForError = if ($HistoricalArchive) { @($currentExpected) + @($historicalExpected) } else { @($currentExpected) }
        $knownPaths = @($expectedForError | ForEach-Object { $_.Path } | Select-Object -Unique)
        $missing = @($knownPaths | Where-Object { $actualDocs -cnotcontains $_ })
        $extra = @($actualDocs | Where-Object { $knownPaths -cnotcontains $_ })
        throw "Portable docs contract is partial, unlisted, or not an exact allowed layout. Missing=[$($missing -join ', ')] Extra=[$($extra -join ', ')]"
    }
    if (-not $HistoricalArchive -and $layout -cne 'current') {
        throw "Current portable docs validation requires the current layout, got $layout."
    }
    if (-not [string]::IsNullOrWhiteSpace($RequiredLayout) -and $layout -cne $RequiredLayout) {
        throw "Portable docs layout $layout does not match required layout $RequiredLayout."
    }
    $expected = if ($layout -ceq 'current') { $currentExpected } else { $historicalExpected }
    $expectedPaths = @($expected | ForEach-Object { $_.Path })
    $missing = @($expectedPaths | Where-Object { $actualDocs -cnotcontains $_ })
    $extra = @($actualDocs | Where-Object { $expectedPaths -cnotcontains $_ })
    if ($missing.Count -gt 0 -or $extra.Count -gt 0 -or $actualDocs.Count -ne $expected.Count) {
        throw "Portable docs contract is partial or has unlisted files. Missing=[$($missing -join ', ')] Extra=[$($extra -join ', ')]"
    }

    $verified = New-Object Collections.ArrayList
    foreach ($item in $expected) {
        $canonicalPath = ConvertTo-ReleaseContentCanonicalPath $item.Path 'archive'
        if ($canonicalPath -cne $item.Path) {
            throw "Portable docs entry path is not canonical: $($item.Path)"
        }
        $entry = $EntriesByPath[$item.Path]
        if ($null -eq $entry -or $entry.Length -le 0) {
            throw "Portable docs entry is missing or empty: $($item.Path)"
        }
        $actualBytes = [byte[]](Read-ReleaseContentZipEntryBytes $entry)
        Assert-ReleaseContentStrictUtf8Bytes $actualBytes "archive entry $($item.Path)"
        $actualHash = Get-ReleaseContentBytesSha256 $actualBytes
        if (-not $HistoricalArchive -and ($actualHash -cne $item.Sha256 -or -not (Test-ReleaseContentBytesEqual $actualBytes $item.Bytes))) {
            throw "Portable docs entry bytes or SHA-256 differ from the manifest source: $($item.Path)"
        }
        [void]$verified.Add([pscustomobject]@{ Path = $item.Path; Length = $actualBytes.Length; Sha256 = $actualHash; Source = $item.Source })
    }
    [pscustomobject]@{ Contract = 1; Layout = $layout; Count = $verified.Count; Entries = @($verified) }
}

function Assert-ReleaseContentNoArtifactCollisions {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$ArtifactRoot
    )

    $root = [IO.Path]::GetFullPath($ArtifactRoot)
    $files = @(Get-ChildItem -LiteralPath $root -File -Recurse -Force)
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($root.TrimEnd([IO.Path]::DirectorySeparatorChar).Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Replace([char]92, [char]47)
        if ($relative -ceq 'docs' -or $relative.StartsWith('docs/', [StringComparison]::OrdinalIgnoreCase)) {
            throw "ArtifactRoot already contains a portable docs path that would collide with manifest supplemental content: $relative"
        }
    }
    $true
}

function Write-ReleaseContentOuterFiles {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$DestinationRoot,
        [Parameter(Mandatory = $true)][hashtable]$OuterTokens
    )

    $root = [IO.Path]::GetFullPath($DestinationRoot)
    $plan = @(Get-ReleaseContentPlan $Manifest Outer -OuterTokens $OuterTokens)
    foreach ($item in $plan) {
        $destination = [IO.Path]::GetFullPath((Join-Path $root ($item.Path.Replace('/', [IO.Path]::DirectorySeparatorChar))))
        $prefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $destination.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Materialized outer path escapes its root: $($item.Path)"
        }
        $parent = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -ErrorAction Stop | Out-Null
        }
        if (Test-Path -LiteralPath $destination) {
            throw "Materialized outer path already exists: $destination"
        }
        [IO.File]::WriteAllBytes($destination, [byte[]]$item.Bytes)
    }
    $plan
}
