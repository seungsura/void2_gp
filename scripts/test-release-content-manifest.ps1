[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
. (Join-Path $PSScriptRoot 'release-content-manifest.ps1')

$Utf8NoBom = New-Object Text.UTF8Encoding($false, $true)
$Utf8Bom = New-Object Text.UTF8Encoding($true, $true)
$Results = New-Object Collections.ArrayList

function Write-FixtureText {
    param([string]$Path,[string]$Text,[switch]$Bom,[switch]$Empty)
    $parent=Split-Path -Parent $Path;if(-not(Test-Path -LiteralPath $parent)){New-Item -ItemType Directory -Path $parent -ErrorAction Stop|Out-Null}
    if($Empty){[IO.File]::WriteAllBytes($Path,[byte[]]@());return}
    if($Bom){$body=$Utf8Bom.GetBytes($Text);$preamble=$Utf8Bom.GetPreamble();$bytes=New-Object byte[] ($preamble.Length+$body.Length);[Array]::Copy($preamble,0,$bytes,0,$preamble.Length);[Array]::Copy($body,0,$bytes,$preamble.Length,$body.Length);[IO.File]::WriteAllBytes($Path,$bytes)}else{[IO.File]::WriteAllBytes($Path,$Utf8NoBom.GetBytes($Text))}
}

function Write-FixtureManifest {
    param($Case,$Manifest)
    Write-FixtureText $Case.ManifestPath ($Manifest|ConvertTo-Json -Depth 8)
}

function New-FixtureCase {
    param([string]$Root,[string]$Name)
    $caseRoot=Join-Path $Root $Name;$content=Join-Path $caseRoot 'release-content';New-Item -ItemType Directory -Path $content -ErrorAction Stop|Out-Null
    $outer=@'
# Outer

{{PORTABLE_SIZE}}
{{PORTABLE_SHA256}}
{{PORTABLE_ENTRIES}}
{{SOURCE_HEAD}}
{{BUILD_DATE_KST}}
'@
    Write-FixtureText (Join-Path $content 'README.md') $outer
    Write-FixtureText (Join-Path $content 'portable\README.md') "# Portable`n"
    Write-FixtureText (Join-Path $content 'portable\release-notes.md') "# {{PRODUCT_VERSION}}`n"
    Write-FixtureText (Join-Path $content 'shared\guide.md') "# Shared guide`n"
    $manifest=[ordered]@{schemaVersion=1;entries=@(
        [ordered]@{source='README.md';outerPath='README.md';materialization='outer-metadata'},
        [ordered]@{source='portable/README.md';portablePath='docs/README.md';materialization='copy'},
        [ordered]@{source='portable/release-notes.md';portablePath='docs/release-notes.md';materialization='product-version'},
        [ordered]@{source='shared/guide.md';outerPath='guides/guide.md';portablePath='docs/guides/guide.md';materialization='copy'}
    )}
    $case=[pscustomobject]@{Root=$caseRoot;ContentRoot=$content;ManifestPath=(Join-Path $content 'manifest.json');Manifest=$manifest}
    Write-FixtureManifest $case $manifest
    $case
}

function Add-Pass { param([string]$Name) [void]$Results.Add($Name) }
function Assert-Throws {
    param([string]$Name,[scriptblock]$Action)
    $threw=$false;try{& $Action}catch{$threw=$true};if(-not $threw){throw "Expected failure did not occur: $Name"};Add-Pass $Name
}

function Invoke-FixturePacker {
    param([string]$NodePath,[string]$PackerPath,[string]$ArtifactRoot,[string]$OutputPath,[string]$ManifestPath)
    $output=& $NodePath $PackerPath $ArtifactRoot $OutputPath $ManifestPath '9.9.9' 2>&1|Out-String
    if($LASTEXITCODE -ne 0){throw "Fixture package-portable.js failed ($LASTEXITCODE): $output"}
}

function Assert-ManifestRejectedByPowerShellAndJavaScript {
    param([string]$Name,$Case,[string]$NodePath,[string]$PackerPath,[string]$ArtifactRoot)
    Assert-Throws "$Name PowerShell" {Get-ReleaseContentManifest $Case.ManifestPath $Case.ContentRoot|Out-Null}
    $outputPath=Join-Path $Case.Root 'should-not-package.zip'
    $oldPreference=$ErrorActionPreference
    $exitCode=$null
    try {
        $ErrorActionPreference='Continue'
        $output=& $NodePath $PackerPath $ArtifactRoot $outputPath $Case.ManifestPath '9.9.9' 2>&1|Out-String
        $exitCode=$LASTEXITCODE
    } finally {
        $ErrorActionPreference=$oldPreference
    }
    if($exitCode -eq 0 -or (Test-Path -LiteralPath $outputPath)){throw "JavaScript packer accepted $Name. Output: $output"}
    Add-Pass "$Name JavaScript"
}

function New-DocsFixtureZip {
    param([string]$Path,$Manifest,[ValidateSet('legacy','exact','partial','extra','mismatch')][string]$Mode)
    $plan=@(Get-ReleaseContentPlan $Manifest Portable -ProductVersion '9.9.9')
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$zip=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create,$false)
    try {
        if($Mode -ne 'legacy'){
            $limit=if($Mode -ceq 'partial'){$plan.Count-1}else{$plan.Count}
            for($index=0;$index -lt $limit;$index++){$entry=$zip.CreateEntry($plan[$index].Path);$output=$entry.Open();try{$bytes=[byte[]]$plan[$index].Bytes;if($Mode -ceq 'mismatch' -and $index -eq 0){$bytes=[byte[]]$Utf8NoBom.GetBytes('changed')};$output.Write($bytes,0,$bytes.Length)}finally{$output.Dispose()}}
            if($Mode -ceq 'extra'){$entry=$zip.CreateEntry('docs/extra.md');$writer=New-Object IO.StreamWriter($entry.Open(),$Utf8NoBom);try{$writer.Write('extra')}finally{$writer.Dispose()}}
        }
    } finally {$zip.Dispose();$stream.Dispose()}
}

function Test-DocsFixtureZip {
    param([string]$Path,$Manifest,[int]$RequiredContract=-1)
    $zip=[IO.Compression.ZipFile]::OpenRead($Path);try{$by=@{};foreach($entry in $zip.Entries){if($by.ContainsKey($entry.FullName)){throw "duplicate $($entry.FullName)"};$by[$entry.FullName]=$entry};Assert-ReleaseContentArchiveDocsContract -EntriesByPath $by -Manifest $Manifest -ProductVersion '9.9.9' -RequiredContract $RequiredContract}finally{$zip.Dispose()}
}

$tempRoot=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('void-release-content-test-'+[guid]::NewGuid().ToString('N'))))
$tempParent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
if(-not $tempRoot.StartsWith($tempParent,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture root escaped the system temporary directory.'}
New-Item -ItemType Directory -Path $tempRoot -ErrorAction Stop|Out-Null

try {
    $production=Get-ReleaseContentManifest -ManifestPath (Join-Path $PSScriptRoot 'release-content\manifest.json') -ContentRoot (Join-Path $PSScriptRoot 'release-content')
    if($production.PortableEntries.Count -ne 7 -or $production.OuterEntries.Count -ne 5){throw 'Production release content manifest does not have the approved 7 portable / 5 outer mapping.'};Add-Pass 'production manifest'
    $productionTokens=@{'{{PORTABLE_SIZE}}'='1 byte';'{{PORTABLE_SHA256}}'=('a'*64);'{{PORTABLE_ENTRIES}}'='1';'{{SOURCE_HEAD}}'=('b'*40);'{{BUILD_DATE_KST}}'='2026-08-06 KST'}
    $productionPlans=@(Get-ReleaseContentPlan $production Portable -ProductVersion '9.9.9')+@(Get-ReleaseContentPlan $production Outer -OuterTokens $productionTokens)
    $productionUserText=(@($productionPlans|ForEach-Object{$Utf8NoBom.GetString([byte[]]$_.Bytes)})) -join "`n"
    $datedInternalRoute='(?i)(?<![a-z0-9])gpt-[a-z0-9._-]*\d{4}-\d{2}-\d{2}(?![a-z0-9])'
    if($productionUserText.Contains('gpt-5.6-luna-2026-07-09') -or $productionUserText -match $datedInternalRoute){throw 'Production user documentation contains a dated internal model route.'};Add-Pass 'production user docs exclude dated internal routes'
    $releaseScriptText=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'release-win32-x64-portable.ps1'));$forwardMarker="if(`$TransactionTag -ceq 'forward'){Assert-PortableArchive `$candidatePath -RequiredDocsContract 1}else{Assert-PortableArchive `$candidatePath}";$argumentMarker="'-RequiredDocsContract',[string]`$requiredDocsContract";if(-not $releaseScriptText.Contains($forwardMarker) -or -not $releaseScriptText.Contains($argumentMarker)){throw 'Forward/recovery prepared-inner docs-contract distinction is missing.'};Add-Pass 'forward 1 recovery detected contract'

    $positive=New-FixtureCase $tempRoot 'positive';$positiveManifest=Get-ReleaseContentManifest $positive.ManifestPath $positive.ContentRoot
    if($positiveManifest.PortableEntries.Count -ne 3 -or $positiveManifest.OuterEntries.Count -ne 2){throw 'Positive fixture mapping count mismatch.'};Add-Pass 'positive manifest'

    $escape=New-FixtureCase $tempRoot 'escape';$escape.Manifest.entries[1].source='../outside.md';Write-FixtureManifest $escape $escape.Manifest;Assert-Throws 'source escape' {Get-ReleaseContentManifest $escape.ManifestPath $escape.ContentRoot|Out-Null}

    $duplicate=New-FixtureCase $tempRoot 'duplicate';Write-FixtureText (Join-Path $duplicate.ContentRoot 'portable\other.md') "other`n";$duplicate.Manifest.entries+=,[ordered]@{source='portable/other.md';portablePath='docs/readme.md';materialization='copy'};Write-FixtureManifest $duplicate $duplicate.Manifest;Assert-Throws 'portable case collision' {Get-ReleaseContentManifest $duplicate.ManifestPath $duplicate.ContentRoot|Out-Null}

    $missing=New-FixtureCase $tempRoot 'missing';[IO.File]::Delete((Join-Path $missing.ContentRoot 'shared\guide.md'));Assert-Throws 'missing source' {Get-ReleaseContentManifest $missing.ManifestPath $missing.ContentRoot|Out-Null}

    $empty=New-FixtureCase $tempRoot 'empty';Write-FixtureText (Join-Path $empty.ContentRoot 'shared\guide.md') '' -Empty;Assert-Throws 'empty source' {Get-ReleaseContentManifest $empty.ManifestPath $empty.ContentRoot|Out-Null}

    $bom=New-FixtureCase $tempRoot 'bom';Write-FixtureText (Join-Path $bom.ContentRoot 'shared\guide.md') "guide`n" -Bom;Assert-Throws 'BOM source' {Get-ReleaseContentManifest $bom.ManifestPath $bom.ContentRoot|Out-Null}

    $placeholder=New-FixtureCase $tempRoot 'placeholder';Write-FixtureText (Join-Path $placeholder.ContentRoot 'shared\guide.md') "{{UNRESOLVED}}`n";Assert-Throws 'unresolved placeholder' {Get-ReleaseContentManifest $placeholder.ManifestPath $placeholder.ContentRoot|Out-Null}

    $materialization=New-FixtureCase $tempRoot 'materialization';$materialization.Manifest.entries[3].materialization='future-mode';Write-FixtureManifest $materialization $materialization.Manifest;Assert-Throws 'unsupported materialization' {Get-ReleaseContentManifest $materialization.ManifestPath $materialization.ContentRoot|Out-Null}

    $legacyZip=Join-Path $positive.Root 'legacy.zip';New-DocsFixtureZip $legacyZip $positiveManifest legacy;$legacy=Test-DocsFixtureZip $legacyZip $positiveManifest;if($legacy.Contract -ne 0){throw 'Legacy fixture did not report docs contract 0.'};Add-Pass 'legacy contract 0 accepted';Assert-Throws 'candidate rejects legacy 0' {Test-DocsFixtureZip $legacyZip $positiveManifest 1|Out-Null}

    $exactZip=Join-Path $positive.Root 'exact.zip';New-DocsFixtureZip $exactZip $positiveManifest exact;$exact=Test-DocsFixtureZip $exactZip $positiveManifest 1;if($exact.Contract -ne 1 -or $exact.Count -ne 3){throw 'Exact fixture did not report docs contract 1.'};Add-Pass 'exact contract 1 accepted'

    $partialZip=Join-Path $positive.Root 'partial.zip';New-DocsFixtureZip $partialZip $positiveManifest partial;Assert-Throws 'partial docs rejected' {Test-DocsFixtureZip $partialZip $positiveManifest|Out-Null}
    $extraZip=Join-Path $positive.Root 'extra.zip';New-DocsFixtureZip $extraZip $positiveManifest extra;Assert-Throws 'unlisted docs rejected' {Test-DocsFixtureZip $extraZip $positiveManifest|Out-Null}
    $mismatchZip=Join-Path $positive.Root 'mismatch.zip';New-DocsFixtureZip $mismatchZip $positiveManifest mismatch;Assert-Throws 'docs byte mismatch rejected' {Test-DocsFixtureZip $mismatchZip $positiveManifest|Out-Null}

    $outerMaterialized=Join-Path $positive.Root 'outer-materialized';New-Item -ItemType Directory -Path $outerMaterialized|Out-Null;$tokens=@{'{{PORTABLE_SIZE}}'='1 byte';'{{PORTABLE_SHA256}}'=('a'*64);'{{PORTABLE_ENTRIES}}'='4';'{{SOURCE_HEAD}}'=('b'*40);'{{BUILD_DATE_KST}}'='2026-08-06 KST'};$outerPlan=@(Write-ReleaseContentOuterFiles $positiveManifest $outerMaterialized $tokens);$portablePlan=@(Get-ReleaseContentPlan $positiveManifest Portable -ProductVersion '9.9.9');$outerShared=[IO.File]::ReadAllBytes((Join-Path $outerMaterialized 'guides\guide.md'));$portableShared=[byte[]](@($portablePlan|Where-Object{$_.Path -ceq 'docs/guides/guide.md'})[0].Bytes);if(-not(Test-ReleaseContentBytesEqual $outerShared $portableShared)){throw 'Shared outer/portable fixture bytes differ.'};Add-Pass 'shared outer portable bytes'

    $artifact=Join-Path $positive.Root 'artifact';New-Item -ItemType Directory -Path (Join-Path $artifact 'data') -Force|Out-Null;Write-FixtureText (Join-Path $artifact 'app.txt') "artifact`n";Write-FixtureText (Join-Path $artifact 'data\argv.json') "generated`n"
    $workspaceRoot=Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot));$node=Join-Path $workspaceRoot '.toolchain\node-v20.18.2-win-x64\node.exe';if(-not(Test-Path -LiteralPath $node -PathType Leaf)){$node=(Get-Command node -ErrorAction Stop).Source};$packer=Join-Path $PSScriptRoot 'package-portable.js'

    $dotAlias=New-FixtureCase $tempRoot 'dot-alias';Write-FixtureText (Join-Path $dotAlias.ContentRoot 'portable\item.md') "item`n";Write-FixtureText (Join-Path $dotAlias.ContentRoot 'portable\item-other.md') "other`n";$dotAlias.Manifest.entries+=,[ordered]@{source='portable/item.md';portablePath='docs/item';materialization='copy'};$dotAlias.Manifest.entries+=,[ordered]@{source='portable/item-other.md';portablePath='docs/item.';materialization='copy'};Write-FixtureManifest $dotAlias $dotAlias.Manifest;Assert-ManifestRejectedByPowerShellAndJavaScript 'item versus item-dot alias' $dotAlias $node $packer $artifact
    $spaceAlias=New-FixtureCase $tempRoot 'space-alias';$spaceAlias.Manifest.entries[1].portablePath='docs/trailing /README.md';Write-FixtureManifest $spaceAlias $spaceAlias.Manifest;Assert-ManifestRejectedByPowerShellAndJavaScript 'trailing-space segment' $spaceAlias $node $packer $artifact
    $reservedAlias=New-FixtureCase $tempRoot 'reserved-alias';$reservedAlias.Manifest.entries[1].portablePath='docs/CON.md';Write-FixtureManifest $reservedAlias $reservedAlias.Manifest;Assert-ManifestRejectedByPowerShellAndJavaScript 'reserved-device segment' $reservedAlias $node $packer $artifact
    $exactRoute=New-FixtureCase $tempRoot 'exact-route';Write-FixtureText (Join-Path $exactRoute.ContentRoot 'shared\guide.md') "gpt-5.6-luna-2026-07-09`n";Assert-ManifestRejectedByPowerShellAndJavaScript 'exact internal route privacy' $exactRoute $node $packer $artifact
    $datedRoute=New-FixtureCase $tempRoot 'dated-route';Write-FixtureText (Join-Path $datedRoute.ContentRoot 'shared\guide.md') "gpt-9.9-internal-2030-01-02`n";Assert-ManifestRejectedByPowerShellAndJavaScript 'dated internal route privacy' $datedRoute $node $packer $artifact

    $packed=Join-Path $positive.Root 'packed-one.zip';$packedAgain=Join-Path $positive.Root 'packed-two.zip';Invoke-FixturePacker $node $packer $artifact $packed $positive.ManifestPath;Start-Sleep -Milliseconds 2200;Invoke-FixturePacker $node $packer $artifact $packedAgain $positive.ManifestPath
    $packedHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $packed).Hash;$packedAgainHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $packedAgain).Hash;$packedBytes=[IO.File]::ReadAllBytes($packed);$packedAgainBytes=[IO.File]::ReadAllBytes($packedAgain);if($packedHash -cne $packedAgainHash -or -not(Test-ReleaseContentBytesEqual $packedBytes $packedAgainBytes)){throw "Two identical packer runs were not byte-identical: $packedHash / $packedAgainHash"};Add-Pass 'two-run deterministic supplemental ZIP bytes'
    if(Test-Path -LiteralPath (Join-Path $artifact 'docs')){throw 'Fixture packer mutated ArtifactRoot with docs.'}
    $packedZip=[IO.Compression.ZipFile]::OpenRead($packed);try{$names=@($packedZip.Entries|ForEach-Object{$_.FullName});if($names -ccontains 'data/argv.json'){throw 'Fixture packer included generated user data.'};$sorted=@($names);[Array]::Sort($sorted,[StringComparer]::Ordinal);if(($names -join "`n") -cne ($sorted -join "`n")){throw 'Fixture packer entry order is not deterministic ordinal order.'};$by=@{};foreach($entry in $packedZip.Entries){$by[$entry.FullName]=$entry};$packedDocs=Assert-ReleaseContentArchiveDocsContract $by $positiveManifest '9.9.9' -RequiredContract 1;if($packedDocs.Count -ne 3){throw 'Fixture packer docs count mismatch.'}}finally{$packedZip.Dispose()};Add-Pass 'direct ZIP supplemental package content'

    [pscustomobject]@{status='passed';tests=$Results.Count;checks=@($Results)}|ConvertTo-Json -Depth 4
} finally {
    if(Test-Path -LiteralPath $tempRoot){$item=Get-Item -LiteralPath $tempRoot -Force;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Refusing to remove a reparse-point fixture root.'};if(-not $item.FullName.StartsWith($tempParent,[StringComparison]::OrdinalIgnoreCase)){throw 'Refusing to remove a fixture outside the system temporary directory.'};[IO.Directory]::Delete($item.FullName,$true)}
}
