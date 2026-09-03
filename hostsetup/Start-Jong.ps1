# Start J-ong on a machine nobody is sitting at, and keep it started.
#
# Run this on a repeating schedule. It is both the launcher and the watchdog: on a run
# where the library is already answering it does nothing and exits, and on a run where it
# is not, it starts one.
#
# Answering is the test, not "a process exists" and not "a port is held". A wedged server
# holds its port perfectly well while serving nobody, and that is indistinguishable from
# a crash to the person trying to open the page. So the check is an actual request.
#
# It binds to every interface. Two things need to reach it: Tailscale Funnel, which
# forwards from localhost, and the tailnet on 100.x. What makes that safe is the door:
# the auth module is loaded, so an unauthenticated caller from anywhere gets the login
# page and nothing else.

$ErrorActionPreference = 'Stop'

$Root   = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'data'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log    = Join-Path $LogDir 'host-jong.log'
$Port   = 7900

function Say($text) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
    Add-Content -Path $Log -Value $line -Encoding utf8
}

# Python, found the same way whether or not this account has it on PATH. SYSTEM has no
# profile of its own, so the interpreter has to be looked for in the profiles that do.
function Find-Python {
    $candidates = @()
    $onPath = (Get-Command python.exe -ErrorAction SilentlyContinue)
    if ($onPath) { $candidates += $onPath.Source }
    $candidates += Get-ChildItem 'C:\Users\*\AppData\Local\Programs\Python\Python3*\python.exe' `
                        -ErrorAction SilentlyContinue | ForEach-Object FullName
    $candidates += @('C:\Python313\python.exe', 'C:\Python312\python.exe',
                     'C:\Program Files\Python313\python.exe')
    foreach ($c in $candidates) {
        # WindowsApps holds an execution alias that opens the Store instead of running
        # Python, so a path that merely exists is not enough.
        if ($c -and (Test-Path $c) -and ($c -notlike '*WindowsApps*')) { return $c }
    }
    return $null
}

# Is the library actually serving. Two tries, because a request landing in the half
# second while the process is still binding is not a fault worth acting on.
function Test-Serving {
    foreach ($attempt in 1..2) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" `
                                   -UseBasicParsing -TimeoutSec 6
            if ($r.StatusCode -eq 200) { return $true }
        } catch { }
        if ($attempt -lt 2) { Start-Sleep -Seconds 3 }
    }
    return $false
}

function Get-JongProcesses {
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*server.py*' -and
                       $_.CommandLine -like '*J-ong*' }
}

if (Test-Serving) { exit 0 }        # the common case: nothing to do, say nothing

$py = Find-Python
if (-not $py) {
    Say 'no Python found; cannot start'
    exit 1
}

# Not answering. If something is nevertheless sitting on the port, it is wedged or it is
# a half dead copy, and leaving it there means the watchdog can never get the library
# back: the new process would fail to bind and exit, forever.
$stale = Get-JongProcesses
if ($stale) {
    Say ("not answering but {0} process(es) present; stopping them" -f @($stale).Count)
    foreach ($p in $stale) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
    }
    Start-Sleep -Seconds 3
}

$env:JONG_HOST = '0.0.0.0'
$env:JONG_PORT = "$Port"

Say ("starting with {0}" -f $py)

# Straight to a file rather than through Tee-Object.
#
# Piping put a PowerShell process between the server and its log. Anything that upset the
# pipe took the server with it, and there is nobody sitting at this machine to notice.
# A redirect has nothing in the middle.
$out = Join-Path $LogDir 'host-jong-out.log'
& $py -u (Join-Path $Root 'server.py') *>> $out
Say ("server exited with {0}" -f $LASTEXITCODE)
