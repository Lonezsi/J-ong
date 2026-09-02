# Start J-ong on a machine nobody is sitting at.
#
# It binds to localhost only. Public access comes from Tailscale Funnel, which terminates
# HTTPS and forwards to this port, so J-ong is never exposed on the local network and
# never has to hold a certificate.
#
# Registered as a scheduled task by Install-JongHost.ps1 and started at boot.

$ErrorActionPreference = 'Stop'

$Root   = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'data'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log    = Join-Path $LogDir 'host-jong.log'

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

$py = Find-Python
if (-not $py) {
    Say 'no Python found; cannot start'
    exit 1
}

# One copy only. If something is already serving the port, this run has nothing to do.
$busy = Get-NetTCPConnection -State Listen -LocalPort 7900 -ErrorAction SilentlyContinue
if ($busy) {
    Say 'port 7900 is already being served; leaving it alone'
    exit 0
}

# Listen on every interface rather than localhost alone.
#
# Two things need to reach it: Tailscale Funnel, which forwards from localhost, and the
# tailnet itself on 100.x, which is how the library is reachable before Funnel has been
# switched on for the tailnet. Binding to one of those would rule out the other.
#
# What makes this safe is the door: the auth module is loaded, so an unauthenticated
# caller from anywhere gets the login page and nothing else, and until a password exists
# even that needs the one time setup code printed below.
$env:JONG_HOST = '0.0.0.0'
$env:JONG_PORT = '7900'

Say ("starting with {0}" -f $py)
$out = Join-Path $LogDir 'host-jong-out.log'
& $py -u (Join-Path $Root 'server.py') *>&1 | Tee-Object -FilePath $out -Append
Say ("server exited with {0}" -f $LASTEXITCODE)
