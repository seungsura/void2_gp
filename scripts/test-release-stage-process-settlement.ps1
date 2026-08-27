$ErrorActionPreference='Stop'
$releaseScript=Join-Path $PSScriptRoot 'release-win32-x64-portable.ps1'
$DirectorySeparatorChar=[IO.Path]::DirectorySeparatorChar
$tokens=$null;$parseErrors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($releaseScript,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count -ne 0){throw "release script parser errors: $($parseErrors.Message -join '; ')"}
if($ast.ParamBlock.Parameters.Count -ne 0){throw 'Canonical release entrypoint must remain no-option.'}
$definitions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$true))
$functionNames=@('Test-ExactStageReferencePath','Test-ExactStageReferenceCommandLine','Test-ProcessReferencesExactStage','Get-ExactStageReferenceProcesses','Get-ExactStageReferenceProcessByPid','Invoke-ExactStageReferenceProcessSettlement')
$functionSource=foreach($name in $functionNames){$matches=@($definitions|Where-Object{$_.Name -ceq $name});if($matches.Count -ne 1){throw "Expected one release helper named $name, got $($matches.Count)."};$matches[0].Extent.Text}
. ([scriptblock]::Create(($functionSource -join "`n")))

function Assert-Equal {
    param($Actual,$Expected,[string]$Name)
    if(($Actual -join ',') -cne ($Expected -join ',')){throw "$Name expected [$($Expected -join ',')] but got [$($Actual -join ',')]"}
}
function Assert-Throws {
    param([string]$Name,[scriptblock]$Action)
    try {& $Action}catch{return}
    throw "$Name did not throw."
}
function New-ProcessRecord {
    param([int]$ProcessId,[string]$Path,[string]$CommandLine='')
    [pscustomobject]@{pid=$ProcessId;parent=1;path=$Path;cmd=$CommandLine}
}

$stage='C:\release\.void-release-win32-x64-exact'
$sibling='C:\release\.void-release-win32-x64-exact-sibling'
$records=@(
    (New-ProcessRecord 11 "$stage\Void.exe"),
    (New-ProcessRecord 12 "$stage\resources\app\OpenConsole.exe"),
    (New-ProcessRecord 13 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' "powershell.exe -File `"$stage\resources\app\shellIntegration.ps1`""),
    (New-ProcessRecord 14 'C:\other\Void.exe'),
    (New-ProcessRecord 15 "$sibling\OpenConsole.exe"),
    (New-ProcessRecord 16 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' "powershell.exe -File `"$sibling\resources\app\shellIntegration.ps1`"")
)
$selected=@(Get-ExactStageReferenceProcesses $stage { $records })
Assert-Equal @($selected.pid|Sort-Object) @(11,12,13) 'exact stage selector'
if(Test-ExactStageReferenceCommandLine $stage "powershell.exe -File `"${stage}X\shellIntegration.ps1`""){throw 'prefix stage command line was selected.'}

$clean=Invoke-ExactStageReferenceProcessSettlement -Stage $stage -GetProcessSnapshot { @((New-ProcessRecord 20 'C:\other\Void.exe')) } -RequestGracefulStop { param($processId) throw 'unexpected graceful stop' } -ForceStop { param($processId) throw 'unexpected force stop' } -GracefulWaitMilliseconds 0
Assert-Equal @($clean.initialPids) @() 'clean initial'
Assert-Equal @($clean.forceAttemptedPids) @() 'clean force'

$global:ReleaseStageSettlementTestReads=0
$pidChanged=Invoke-ExactStageReferenceProcessSettlement -Stage $stage -GetProcessSnapshot {
    $global:ReleaseStageSettlementTestReads++
    if($global:ReleaseStageSettlementTestReads -eq 1){@((New-ProcessRecord 30 "$stage\Void.exe"))}else{@((New-ProcessRecord 30 'C:\other\Void.exe'))}
} -RequestGracefulStop { param($processId) throw 'PID changed before graceful action' } -ForceStop { param($processId) throw 'PID changed before force action' } -GracefulWaitMilliseconds 0
Assert-Equal @($pidChanged.initialPids) @(30) 'changed PID initial'
Assert-Equal @($pidChanged.forceAttemptedPids) @() 'changed PID force exclusion'

$global:ReleaseStageSettlementTestState=@((New-ProcessRecord 41 "$stage\Void.exe"),(New-ProcessRecord 42 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' "powershell.exe -File `"$stage\resources\app\shellIntegration.ps1`""))
$global:ReleaseStageSettlementTestGraceful=@();$global:ReleaseStageSettlementTestForced=@()
$settled=Invoke-ExactStageReferenceProcessSettlement -Stage $stage -GetProcessSnapshot { @($global:ReleaseStageSettlementTestState) } -RequestGracefulStop {
    param($processId)
    $global:ReleaseStageSettlementTestGraceful+=,$processId
    if($processId -eq 41){$global:ReleaseStageSettlementTestState=@($global:ReleaseStageSettlementTestState|Where-Object{$_.pid -ne $processId})}
} -ForceStop {
    param($processId)
    $global:ReleaseStageSettlementTestForced+=,$processId
    $global:ReleaseStageSettlementTestState=@($global:ReleaseStageSettlementTestState|Where-Object{$_.pid -ne $processId})
} -GracefulWaitMilliseconds 0
Assert-Equal @($global:ReleaseStageSettlementTestGraceful|Sort-Object) @(41,42) 'graceful exact references'
Assert-Equal @($global:ReleaseStageSettlementTestForced) @(42) 'bounded force exact survivor'
Assert-Equal @($settled.survivorPids) @() 'settled survivors'

$global:ReleaseStageSettlementTestState=@((New-ProcessRecord 51 "$stage\resources\app\OpenConsole.exe"))
$global:ReleaseStageSettlementTestForced=@()
Assert-Throws 'survivor fails closed' {
    Invoke-ExactStageReferenceProcessSettlement -Stage $stage -GetProcessSnapshot { @($global:ReleaseStageSettlementTestState) } -RequestGracefulStop { param($processId) } -ForceStop { param($processId) $global:ReleaseStageSettlementTestForced+=,$processId } -GracefulWaitMilliseconds 0 | Out-Null
}
Assert-Equal @($global:ReleaseStageSettlementTestForced) @(51) 'survivor force attempt'

Write-Host 'Release stage process settlement tests passed: exact selector, clean path, PID recheck, bounded force, fail-closed survivor.'
