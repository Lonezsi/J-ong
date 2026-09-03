# Make J-ong start at boot and be reachable from anywhere.
#
# Run this once, elevated, on the machine that will hold the library.
#
#     powershell -ExecutionPolicy Bypass -File hostsetup\Install-JongHost.ps1
#
# Two pieces:
#   1. A scheduled task that starts the server at boot, bound to localhost.
#   2. Tailscale Funnel, which puts an HTTPS address in front of it.
#
# Nothing here chooses a password. The server prints a one time setup code the first time
# it runs, and the first person to present that code chooses the password. That is the
# whole reason it is safe to switch the funnel on before anyone has signed in.

param(
    [switch]$NoFunnel,
    [int]$Port = 7900
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$TaskName = 'J-ong Server'

function Note($text) { Write-Host "  $text" }

# ── the task ─────────────────────────────────────────────────────────────────
$script = Join-Path $PSScriptRoot 'Start-Jong.ps1'
if (-not (Test-Path $script)) { throw "Start-Jong.ps1 is not next to this file." }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $script) `
    -WorkingDirectory $Root
# Two triggers, and the second one is the point.
#
# At boot alone, a library that stops at three in the afternoon stays stopped until the
# machine is next restarted, which on a host nobody sits at can be weeks. That is what
# "it keeps crashing" looks like from the outside: not a process dying often, but one
# dying once and nothing ever bringing it back.
#
# So there is also a check every few minutes, for ever. Start-Jong.ps1 is written to be
# run this way: on a run where the library answers it exits immediately and says nothing.
$atBoot = New-ScheduledTaskTrigger -AtStartup
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Minutes 3)
$trigger = @($atBoot, $watchdog)
# SYSTEM, because this machine runs with nobody logged in.
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
Note "scheduled task '$TaskName' registered"

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 6
$listening = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($listening) { Note "serving on 127.0.0.1:$Port" }
else { Note "NOT serving yet; check data\host-jong.log" }

# ── the funnel ───────────────────────────────────────────────────────────────
if ($NoFunnel) {
    Note 'funnel skipped; reachable over Tailscale at this machine only'
    return
}

$ts = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $ts) { $ts = 'C:\Program Files\Tailscale\tailscale.exe' } else { $ts = $ts.Source }
if (-not (Test-Path $ts)) {
    Note 'Tailscale is not installed, so there is no public address. Install it and re-run.'
    return
}

Note 'asking Tailscale for a public HTTPS address'
& $ts funnel --bg $Port
& $ts funnel status
