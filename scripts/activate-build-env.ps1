# Activate the reproducible Windows build toolchain for this checkout.
# Usage from PowerShell:
#   . .\scripts\activate-build-env.ps1

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$toolRoot = $null
$cursor = $repoRoot
for ($i = 0; $i -lt 5 -and $cursor; $i++) {
	$candidate = Join-Path $cursor '.toolchain'
	if (Test-Path (Join-Path $candidate 'node-v20.18.2-win-x64\node.exe')) {
		$toolRoot = $candidate
		break
	}
	$parent = Split-Path -Parent $cursor
	if ($parent -eq $cursor) {
		break
	}
	$cursor = $parent
}

if (-not $toolRoot) {
	throw 'Project toolchain directory was not found. Expected .toolchain/node-v20.18.2-win-x64/node.exe above the repository.'
}

$nodeRoot = Join-Path $toolRoot 'node-v20.18.2-win-x64'
$pythonRoot = Get-ChildItem $toolRoot -Directory -Filter 'python-3.10.*' |
	Where-Object { Test-Path (Join-Path $_.FullName 'python.exe') } |
	Sort-Object Name -Descending |
	Select-Object -First 1 -ExpandProperty FullName

if (-not $pythonRoot) {
	throw 'Project Python 3.10 toolchain was not found below .toolchain.'
}

$pathEntries = @(
	$nodeRoot,
	$pythonRoot,
	(Join-Path $pythonRoot 'Scripts'),
	(Join-Path $env:USERPROFILE '.cargo\bin')
)
$env:Path = (($pathEntries + ($env:Path -split ';')) | Where-Object { $_ } | Select-Object -Unique) -join ';'
$env:npm_config_python = Join-Path $pythonRoot 'python.exe'
$env:npm_config_msvs_version = '2022'
$env:npm_config_arch = 'x64'
$env:npm_config_target_arch = 'x64'
$env:npm_config_foreground_scripts = 'true'

$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) {
	throw 'Visual Studio Installer (vswhere.exe) was not found.'
}

$vsPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1).Trim()
if (-not $vsPath) {
	throw 'A complete Visual Studio installation with the C++ workload was not found.'
}

$vsDevCmd = Join-Path $vsPath 'Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path $vsDevCmd)) {
	throw "VsDevCmd.bat was not found under $vsPath."
}

$vsCommand = '"' + $vsDevCmd + '" -arch=x64 -host_arch=x64 && set'
$vsEnvironment = & cmd.exe /d /s /c $vsCommand
foreach ($line in $vsEnvironment) {
	if ($line -match '^([^=]+)=(.*)$') {
		Set-Item -Path ("Env:{0}" -f $matches[1]) -Value $matches[2]
	}
}

Set-Location $repoRoot
Write-Host "Build environment active: $repoRoot"
node --version
npm --version
python --version
rustc --version
msbuild -version
