$ErrorActionPreference='Stop'
$releaseScript=Join-Path $PSScriptRoot 'release-win32-x64-portable.ps1'
$text=[IO.File]::ReadAllText($releaseScript)
function Get-Keys([string]$block){@([regex]::Matches($block,"'(?<name>focused-[^']+)'\s*=")|ForEach-Object{$_.Groups['name'].Value})}
$focusedBlock=[regex]::Match($text,'(?s)\$focused=\[ordered\]@\{(?<body>.*?)\n\s*\}').Groups['body'].Value
$expectedBlock=[regex]::Match($text,'(?s)\$focusedExpectedPassCounts=\[ordered\]@\{(?<body>.*?)\};Assert-FocusedCommandsHaveExactPassCounts').Groups['body'].Value
if(!$focusedBlock -or !$expectedBlock){throw 'Unable to locate focused command or expected-count map.'}
$commands=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach($name in Get-Keys $focusedBlock){$null=$commands.Add($name)}
foreach($match in [regex]::Matches($text,"name='(?<name>focused-[^']+)';file='npm';args=@\('run','(?<runner>test-node|test-browser-no-install)'")){$null=$commands.Add($match.Groups['name'].Value)}
$expected=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach($name in Get-Keys $expectedBlock){$null=$expected.Add($name)}
$missing=@($commands|Where-Object{-not $expected.Contains($_)})
$orphaned=@($expected|Where-Object{-not $commands.Contains($_)})
if($missing.Count -or $orphaned.Count){throw "Focused pass-count map mismatch. Missing=$($missing -join ','); orphaned=$($orphaned -join ',')"}
Write-Host "Focused pass-count map covers $($commands.Count) focused npm test commands."
