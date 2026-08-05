[CmdletBinding()]
param(
	[switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ManifestPath = Join-Path $PSScriptRoot 'win32-x64-runtime-payload-manifest.json'
$ExpectedNodeVersion = 'v20.18.2'
$ExpectedElectronTarget = '34.3.2'
$ExpectedToolset = '14.44.35207'

function Get-NonEmptyCommandOutput {
	param([Parameter(Mandatory = $true)][string]$Command, [string[]]$Arguments = @())
	$result = & $Command @Arguments
	if ($LASTEXITCODE -ne 0) {
		throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')"
	}
	return (($result | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ }) -join "`n").Trim()
}

function Assert-Environment {
	if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This script supports Windows only.' }
	if ([Environment]::Is64BitOperatingSystem -ne $true -or [Environment]::Is64BitProcess -ne $true) {
		throw 'This script requires a 64-bit Windows OS and a 64-bit PowerShell process.'
	}

	$nodeVersion = Get-NonEmptyCommandOutput 'node' @('--version')
	if ($nodeVersion -ne $ExpectedNodeVersion) {
		throw "Activated Node must be $ExpectedNodeVersion; found $nodeVersion. Dot-source scripts/activate-build-env.ps1 first."
	}
	foreach ($setting in @(
		@('target', $ExpectedElectronTarget),
		@('runtime', 'electron'),
		@('arch', 'x64')
	)) {
		$value = Get-NonEmptyCommandOutput 'npm' @('config', 'get', $setting[0])
		if ($value -ne $setting[1]) {
			throw "npm config $($setting[0]) must be '$($setting[1])'; found '$value'."
		}
	}

	if ([string]::IsNullOrWhiteSpace($env:VCToolsInstallDir)) {
		throw 'VCToolsInstallDir is unset. Activate the VS build environment before invoking this script.'
	}
	$vcTools = [IO.Path]::GetFullPath($env:VCToolsInstallDir)
	if ((Split-Path -Leaf ($vcTools.TrimEnd('\'))) -ne $ExpectedToolset) {
		throw "Activated MSVC toolset must be $ExpectedToolset; VCToolsInstallDir is $vcTools."
	}
	$spectrePath = Join-Path $vcTools 'lib\spectre\x64'
	if (-not (Test-Path -LiteralPath $spectrePath -PathType Container)) {
		throw "Required MSVC Spectre libraries are missing: $spectrePath. Install Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre; this script never patches SpectreMitigation."
	}
	$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
	if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
		throw 'vswhere.exe is required to verify the installed Spectre component.'
	}
	$componentInstall = & $vswhere -latest -products '*' -requires 'Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre' -property installationPath
	if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($componentInstall -join ''))) {
		throw 'Visual Studio reports that Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre is not installed.'
	}
}

function Get-SourceManifestEntries {
	if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
		throw "Runtime payload manifest was not found: $ManifestPath"
	}
	$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
	if ($manifest.schemaVersion -ne 1 -or $manifest.target.platform -ne 'win32' -or $manifest.target.architecture -ne 'x64') {
		throw "Unsupported runtime payload manifest: $ManifestPath"
	}
	$manifestEntries = @($manifest.entries)
	if ($manifestEntries.Count -eq 0) {
		throw "Runtime payload manifest has no entries: $ManifestPath"
	}

	$nodeModulesPrefix = @('resources', 'app', 'node_modules')
	$nodeModulesRoot = [IO.Path]::GetFullPath((Join-Path $SourceRoot 'node_modules'))
	$nodeModulesRootPrefix = $nodeModulesRoot.TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
	$extensionMappings = @{
		'resources/app/extensions/microsoft-authentication/dist/msal-node-runtime.node' = 'extensions\microsoft-authentication\node_modules\@azure\msal-node-runtime\dist\msal-node-runtime.node'
		'resources/app/extensions/microsoft-authentication/dist/msalruntime.dll' = 'extensions\microsoft-authentication\node_modules\@azure\msal-node-runtime\dist\msalruntime.dll'
	}
	$seenPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
	$entries = @()
	foreach ($entry in $manifestEntries) {
		$component = [string]$entry.component
		$rawPath = [string]$entry.path
		if ([string]::IsNullOrWhiteSpace($component)) {
			throw 'Runtime payload manifest contains an entry with an empty component.'
		}
		if ([string]::IsNullOrWhiteSpace($rawPath)) {
			throw "Runtime payload manifest contains an empty path for component '$component'."
		}
		if ([IO.Path]::IsPathRooted($rawPath) -or $rawPath -match '^[A-Za-z]:' -or $rawPath -match '^[\\/]{1,2}') {
			throw "Runtime payload manifest path must be relative: $rawPath"
		}
		$segments = @($rawPath -split '[\\/]')
		if ($segments.Count -eq 0 -or @($segments | Where-Object {
			[string]::IsNullOrWhiteSpace($_) -or $_ -ne $_.Trim() -or $_ -eq '.' -or $_ -eq '..' -or
			$_.EndsWith('.', [StringComparison]::Ordinal) -or $_.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0
		}).Count -gt 0) {
			throw "Runtime payload manifest contains an unsafe path segment: $rawPath"
		}
		$normalizedManifestPath = $segments -join '/'
		if (-not $seenPaths.Add($normalizedManifestPath)) {
			throw "Runtime payload manifest contains a duplicate path: $normalizedManifestPath"
		}

		$sourcePath = $null
		if ($extensionMappings.ContainsKey($normalizedManifestPath)) {
			$sourcePath = [IO.Path]::GetFullPath((Join-Path $SourceRoot $extensionMappings[$normalizedManifestPath]))
			Write-Host "Mapped extension payload to source dependency: $component ($sourcePath)"
		} elseif ($segments.Count -gt $nodeModulesPrefix.Count -and
			$segments[0] -eq $nodeModulesPrefix[0] -and
			$segments[1] -eq $nodeModulesPrefix[1] -and
			$segments[2] -eq $nodeModulesPrefix[2]) {
			$firstRelativeSegment = $nodeModulesPrefix.Count
			$relativeSegments = @($segments[$firstRelativeSegment..($segments.Count - 1)])
			$relativePath = $relativeSegments -join [IO.Path]::DirectorySeparatorChar
			$sourcePath = [IO.Path]::GetFullPath((Join-Path $nodeModulesRoot $relativePath))
			if (-not $sourcePath.StartsWith($nodeModulesRootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
				throw "Mapped native payload escapes source node_modules: $normalizedManifestPath -> $sourcePath"
			}
		} else {
			throw "Manifest entry has no approved source payload mapping: $normalizedManifestPath"
		}
		$entries += [pscustomobject]@{
			Component = $component
			ManifestPath = $normalizedManifestPath
			SourcePath = $sourcePath
		}
	}
	if ($entries.Count -eq 0) {
		throw "Runtime payload manifest produced no source validation entries: $ManifestPath"
	}
	return $entries
}

function Assert-SourcePayloads {
	param([Parameter(Mandatory = $true)][object[]]$Entries)
	$problems = [Collections.Generic.List[string]]::new()
	foreach ($entry in $Entries) {
		$path = $entry.SourcePath
		if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
			$problems.Add("missing [$($entry.Component)]: $path")
		} elseif ((Get-Item -LiteralPath $path).Length -le 0) {
			$problems.Add("zero-size [$($entry.Component)]: $path")
		}
	}
	if ($problems.Count -gt 0) {
		throw "Native runtime payload validation failed:`n$($problems -join "`n")"
	}
	Write-Host "Validated $($Entries.Count) source runtime payloads from $ManifestPath"
}

function Invoke-GypRebuild {
	param(
		[Parameter(Mandatory = $true)][string]$Package,
		[Parameter(Mandatory = $true)][string]$NodeGyp
	)
	$packagePath = Join-Path $SourceRoot (Join-Path 'node_modules' $Package)
	if (-not (Test-Path -LiteralPath (Join-Path $packagePath 'binding.gyp') -PathType Leaf)) {
		throw "binding.gyp was not found for ${Package}: $packagePath"
	}
	Push-Location -LiteralPath $packagePath
	try {
		Write-Host "Rebuilding $Package against Electron $ExpectedElectronTarget (x64)..."
		& $NodeGyp rebuild "--target=$ExpectedElectronTarget" '--runtime=electron' '--dist-url=https://electronjs.org/headers' '--arch=x64'
		if ($LASTEXITCODE -ne 0) { throw "node-gyp rebuild failed for $Package with exit code $LASTEXITCODE" }
	} finally {
		Pop-Location
	}
}

Push-Location -LiteralPath $SourceRoot
try {
	Assert-Environment
	$sourceEntries = @(Get-SourceManifestEntries)

	if ($ValidateOnly) {
		Assert-SourcePayloads -Entries $sourceEntries
	} else {
		$gypDirectory = Join-Path $SourceRoot 'build\npm\gyp'
		if (-not (Test-Path -LiteralPath (Join-Path $gypDirectory 'package-lock.json') -PathType Leaf)) {
			throw "Locked node-gyp helper manifest was not found: $gypDirectory"
		}
		Write-Host 'Network dependency: bootstrapping the locked build/npm/gyp helper with npm ci --ignore-scripts.'
		& npm --prefix $gypDirectory ci --ignore-scripts
		if ($LASTEXITCODE -ne 0) { throw "Locked node-gyp helper bootstrap failed with exit code $LASTEXITCODE" }
		$nodeGyp = Join-Path $gypDirectory 'node_modules\.bin\node-gyp.cmd'
		if (-not (Test-Path -LiteralPath $nodeGyp -PathType Leaf)) { throw "Locked node-gyp helper was not installed: $nodeGyp" }

		# npm ci --ignore-scripts suppresses these manifest payload producers' default binding.gyp/install hooks, so rebuild them explicitly.
		$gypPackages = @(
			'@vscode/policy-watcher', '@vscode/windows-registry', 'native-is-elevated',
			'native-keymap', 'native-watchdog', 'kerberos', 'windows-foreground-love',
			'@vscode/windows-ca-certs', '@vscode/sqlite3', '@vscode/spdlog', '@vscode/windows-mutex',
			'node-pty', '@vscode/deviceid', '@parcel/watcher'
		)
		foreach ($package in $gypPackages) { Invoke-GypRebuild -Package $package -NodeGyp $nodeGyp }

		$nodePtyRoot = Join-Path $SourceRoot 'node_modules\node-pty'
		$conPtyVersions = @(Get-ChildItem -LiteralPath (Join-Path $nodePtyRoot 'third_party\conpty') -Directory | Sort-Object Name)
		if ($conPtyVersions.Count -ne 1) { throw "Expected exactly one node-pty ConPTY version directory; found $($conPtyVersions.Count)." }
		$conPtySource = Join-Path $conPtyVersions[0].FullName 'win10-x64'
		$conPtyDestination = Join-Path $nodePtyRoot 'build\Release\conpty'
		foreach ($name in @('conpty.dll', 'OpenConsole.exe')) {
			$source = Join-Path $conPtySource $name
			if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "node-pty ConPTY source is missing: $source" }
		}
		New-Item -ItemType Directory -Path $conPtyDestination -Force | Out-Null
		foreach ($name in @('conpty.dll', 'OpenConsole.exe')) {
			Copy-Item -LiteralPath (Join-Path $conPtySource $name) -Destination (Join-Path $conPtyDestination $name) -Force
		}

		$ripgrepRoot = Join-Path $SourceRoot 'node_modules\@vscode\ripgrep'
		Write-Host 'Network dependency: @vscode/ripgrep postinstall downloads the pinned ripgrep binary.'
		& npm --prefix $ripgrepRoot run postinstall
		if ($LASTEXITCODE -ne 0) { throw "@vscode/ripgrep postinstall failed with exit code $LASTEXITCODE" }

		Assert-SourcePayloads -Entries $sourceEntries
	}
} finally {
	Pop-Location
}
