<#
.SYNOPSIS
    Stremio4Manga installer for Windows.

.DESCRIPTION
    Checks Node, builds the server and the UI, writes server\config.json,
    creates the first account and registers the tray to start at logon.

    Unlike install.sh this does NOT copy the tree anywhere. Windows has no
    /opt, the tray reads the config from the checkout, and a second copy of a
    repository that gets `git pull`ed is a way to spend an afternoon wondering
    why an edit did nothing. Everything runs where you cloned it.

    Safe to re-run: the config, the data and the accounts are left alone, only
    the build and the scheduled task are refreshed.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -Origin https://manga.example.com -Admin mitsu

.NOTES
    Needs Node 22 or newer: the database is node:sqlite, which does not exist
    before 22. No native modules, so no build tools are required.
#>

# ---------------------------------------------------------------------------
# This file, and every .ps1 under deploy\windows, is deliberately pure ASCII.
#
# Windows PowerShell 5.1 - which is what a double-clicked .ps1 still runs on -
# reads a BOM-less file as the system ANSI code page, not as UTF-8. A UTF-8 em
# dash then arrives as three cp1252 characters, the last of which is U+201D,
# and PowerShell accepts U+201D as a closing double quote. The result is a
# parse error pointing at an innocent word several characters later.
#
# Two ways out: a UTF-8 BOM, or no characters above 0x7F. This takes the
# second, so the file is identical however it is opened, checked out or piped.
# If you add an accented word or a nice dash here, the script stops parsing.
# ---------------------------------------------------------------------------

[CmdletBinding()]
param(
    # The URL people will type. Asked for if omitted. Every CSRF check compares
    # against it, and its scheme decides whether the session cookie is Secure.
    [string] $Origin = '',

    # Listen address and port. Loopback by default: put a reverse proxy in
    # front rather than exposing this directly.
    [string] $ListenHost = '127.0.0.1',
    [int]    $Port = 8080,

    # Force trustProxy. Neither switch: derived from -Origin (a loopback host
    # means nothing is in front). See the note where the config is written.
    [switch] $Proxy,
    [switch] $NoProxy,

    # Optional, external FlareSolverr, e.g. http://127.0.0.1:8191
    [string] $FlareSolverr = '',

    # Create this account at the end. The password is typed at a hidden prompt
    # inside the CLI - there is deliberately no parameter that takes one.
    [string] $Admin = '',

    # Skip the scheduled task; start the tray by hand with
    # deploy\windows\start-server.cmd instead.
    [switch] $NoAutoStart,

    # Never prompt. Requires -Origin. Skips account creation.
    [switch] $NonInteractive
)

$ErrorActionPreference = 'Stop'

$Repo      = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ServerDir = Join-Path $Repo 'server'
$ConfigFile = Join-Path $ServerDir 'config.json'
$MainJs    = Join-Path $ServerDir 'dist\main.js'
$CliJs     = Join-Path $ServerDir 'dist\cli.js'
$VbsFile   = Join-Path $Repo 'deploy\windows\start-server.vbs'
$TaskName  = 'Stremio4Manga'
$MinNodeMajor = 22

$Interactive = -not $NonInteractive

# ------------------------------------------------------------------ output --

function Write-Step([string] $Text) {
    Write-Host ''
    Write-Host '==> ' -ForegroundColor Green -NoNewline
    Write-Host $Text -ForegroundColor White
}
function Write-Info([string] $Text) { Write-Host "    $Text" }
function Write-Note([string] $Text) { Write-Host "    $Text" -ForegroundColor DarkGray }
function Write-Warn([string] $Text) { Write-Host " warning: $Text" -ForegroundColor Yellow }

# Every failure names what failed and what to do next. An installer that stops
# with a raw .NET exception has told the person nothing they can act on.
function Stop-Install {
    param([string] $Message, [string[]] $Detail = @())
    Write-Host ''
    Write-Host "error: $Message" -ForegroundColor Red
    foreach ($line in $Detail) { Write-Host "       $line" }
    exit 1
}

# Native commands do not throw, so $LASTEXITCODE is the only signal there is.
function Invoke-Checked {
    param([string] $File, [string[]] $Arguments, [string] $What, [string[]] $Detail = @())
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { Stop-Install "$What failed (exit $LASTEXITCODE)." $Detail }
}

# ------------------------------------------------------------- 0. the machine --

Write-Step 'Checking the machine'

if (-not (Test-Path (Join-Path $Repo 'package.json'))) {
    Stop-Install "No package.json next to this script." @(
        'Run install.ps1 from the root of the checkout, not from a copy of the file.'
    )
}

$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    # nvm-windows and the zip build are both common and neither always lands on
    # PATH for the shell that happens to be open.
    foreach ($candidate in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )) {
        if (Test-Path $candidate) { $nodeCmd = Get-Command $candidate; break }
    }
}
if (-not $nodeCmd) {
    Stop-Install 'Node is not installed, or not on this shell''s PATH.' @(
        "Stremio4Manga needs Node $MinNodeMajor or newer - the database is node:sqlite,",
        'which does not exist before 22. There are no native modules, so the plain',
        'installer is enough; no build tools, no Visual Studio.',
        '',
        '  https://nodejs.org/en/download   (LTS, Windows Installer)',
        '  winget install OpenJS.NodeJS.LTS',
        '',
        'Open a NEW terminal afterwards: PATH changes do not reach one already open.'
    )
}
$NodeBin = $nodeCmd.Source

$nodeVersion = & $NodeBin -v
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt $MinNodeMajor) {
    Stop-Install "Node $nodeVersion is too old - $MinNodeMajor or newer is required." @(
        'The server opens its database with node:sqlite, added in Node 22. There is',
        'no fallback and no native module to build instead; it simply will not start.',
        'Upgrade Node and run this again.'
    )
}

# npm ships as npm.cmd. Newer Node also drops an npm.ps1 that Get-Command
# prefers, and running that through the call operator skips the shim that sets
# up the node path - so ask for the .cmd by name.
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    $candidate = Join-Path (Split-Path -Parent $NodeBin) 'npm.cmd'
    if (Test-Path $candidate) { $npmCmd = Get-Command $candidate }
}
if (-not $npmCmd) {
    Stop-Install 'npm was not found next to node.' @(
        'The Node installer ships it. If Node came from a zip, add its folder to PATH.'
    )
}
$NpmBin = $npmCmd.Source

Write-Info "node $nodeVersion at $NodeBin"
Write-Info "npm  at $NpmBin"
Write-Info "repo $Repo"

# --------------------------------------------------------------- 1. build --

Write-Step 'Installing dependencies and building'

Write-Note 'npm ci installs devDependencies on purpose: esbuild bundles the server'
Write-Note 'and vite builds the UI, and both are devDependencies.'

Push-Location $Repo
try {
    $env:npm_config_update_notifier = 'false'
    $env:npm_config_fund = 'false'
    $env:npm_config_audit = 'false'

    Invoke-Checked $NpmBin @('ci', '--no-audit', '--no-fund') 'npm ci' @(
        'There are no native modules here, so this is almost always the network or',
        'a package-lock.json that does not match package.json.',
        "Re-run it by hand to see the full output:  cd `"$Repo`"; npm ci"
    )

    Invoke-Checked $NpmBin @('run', 'build') 'npm run build' @(
        'This builds server\dist (esbuild) and web\dist (tsc + vite).',
        "Re-run it by hand to see which of the two:  cd `"$Repo`"; npm run build"
    )
} finally {
    Pop-Location
}

if (-not (Test-Path $MainJs)) {
    Stop-Install "The build reported success but $MainJs is missing." @(
        "Run 'npm run build -w server' in $Repo and read the output."
    )
}
if (-not (Test-Path (Join-Path $Repo 'web\dist\index.html'))) {
    Stop-Install "The build reported success but web\dist\index.html is missing." @(
        "Run 'npm run build -w web' in $Repo and read the output."
    )
}
Write-Info 'server\dist and web\dist built'

# -------------------------------------------------------------- 2. config --

Write-Step "Config: $ConfigFile"

if (Test-Path $ConfigFile) {
    Write-Info 'already exists - left exactly as it is'
    Write-Note 'delete it and re-run this script to regenerate, or edit it by hand'
    try {
        $existing = Get-Content -Raw -Encoding UTF8 $ConfigFile | ConvertFrom-Json
        if ($existing.publicOrigin) { $Origin = [string]$existing.publicOrigin }
        if ($existing.listen -and $existing.listen.port) { $Port = [int]$existing.listen.port }
    } catch {
        Write-Warn "config.json is not valid JSON: $($_.Exception.Message)"
        Write-Warn 'The server will refuse to start until that is fixed.'
    }
} else {
    if (-not $Origin) {
        if ($NonInteractive) {
            Stop-Install 'No -Origin, and this is a non-interactive run.' @(
                'publicOrigin is the URL people type. It is not optional: every CSRF',
                'check compares against it, and its scheme decides whether the session',
                'cookie is Secure.',
                '',
                '  .\install.ps1 -Origin https://manga.example.com',
                "  .\install.ps1 -Origin http://localhost:$Port      (just this machine)"
            )
        }
        Write-Host ''
        Write-Host '    The URL people will type. On a machine that only serves itself,'
        Write-Host "    http://localhost:$Port is the right answer."
        Write-Host '    Press Enter to accept it.'
        Write-Host ''
        $Origin = Read-Host '    publicOrigin'
        if (-not $Origin) { $Origin = "http://localhost:$Port" }
    }

    # Validated with the same URL parser the server uses, so a typo is caught
    # now rather than at the first start.
    $originHost = $null
    try {
        $parsed = [Uri] $Origin
        if ($parsed.Scheme -ne 'http' -and $parsed.Scheme -ne 'https') { throw 'scheme' }
        $originHost = $parsed.Host
    } catch {
        Stop-Install "publicOrigin is not a usable URL: $Origin" @(
            'It needs a scheme and a host, e.g. https://manga.example.com'
        )
    }

    # trustProxy, when neither -Proxy nor -NoProxy said so.
    #
    # There is no safe default for this key, only a correct one and a broken
    # one, and which is which depends on something the server cannot see:
    # whether anything rewrites X-Forwarded-For before it arrives. The origin is
    # the best evidence available at install time - a loopback host is somebody
    # running this on their own machine with nothing in front; a real hostname
    # means a proxy is terminating TLS for it.
    if ($Proxy -and $NoProxy) { Stop-Install 'Pass -Proxy or -NoProxy, not both.' }
    if ($Proxy)        { $trustProxy = $true;  $trustReason = 'you asked for it' }
    elseif ($NoProxy)  { $trustProxy = $false; $trustReason = 'you asked for it' }
    else {
        $loopback = @('localhost', '127.0.0.1', '::1')
        $trustProxy = -not ($loopback -contains $originHost)
        $trustReason = 'derived from publicOrigin'
    }

    # Only the keys that are genuinely deployment decisions are written.
    # Anything left out keeps the default in server\src\config.ts, and a default
    # restated in a file is indistinguishable from a deliberate override - only
    # one of the two is still correct after the code changes. `secureCookies` in
    # particular is derived from the scheme of publicOrigin and must not be
    # pinned. `dataDir` is left out too: the default,
    # %LOCALAPPDATA%\Stremio4Manga, is already the right place on Windows.
    #
    # [ordered] so the file reads in the order a person would write it;
    # ConvertTo-Json on a plain hashtable shuffles the keys.
    $config = [ordered] @{
        publicOrigin = $Origin
        listen       = [ordered] @{ host = $ListenHost; port = $Port }
        trustProxy   = [bool] $trustProxy
    }
    if ($FlareSolverr) {
        $config.flaresolverr = [ordered] @{ url = $FlareSolverr; timeoutMs = 60000 }
    }
    $json = ($config | ConvertTo-Json -Depth 5) + "`n"

    # WriteAllText with an explicit BOM-less UTF8Encoding, and not Set-Content or
    # Out-File. Windows PowerShell 5.1 writes UTF-8 WITH a byte order mark, and
    # Node reads the file with readFileSync(..., 'utf8'), which keeps that mark
    # as a character - so JSON.parse fails on the very first byte, on a file that
    # looks perfectly correct in every editor.
    #
    # This is also why the JSON is built here rather than shelled out to `node
    # -e`: PowerShell 5.1 does not escape double quotes when it hands an argument
    # to a native command, so a script containing any would arrive mangled.
    [System.IO.File]::WriteAllText(
        $ConfigFile, $json, (New-Object System.Text.UTF8Encoding($false)))

    Write-Info "written - publicOrigin $Origin, listen ${ListenHost}:$Port"
    if ($FlareSolverr) { Write-Info "flaresolverr $FlareSolverr" }
    if ($trustProxy) {
        Write-Info "trustProxy: true ($trustReason)"
        Write-Note 'Right behind a reverse proxy. With NOTHING in front this is wrong -'
        Write-Note 'X-Forwarded-For is then client-supplied and the login lockout becomes'
        Write-Note 'decoration. Set trustProxy to false in config.json and restart.'
    } else {
        Write-Info "trustProxy: false ($trustReason)"
        Write-Note 'Right with nothing in front. The day a reverse proxy goes there, set'
        Write-Note 'it back to true, or the limiter buckets everyone as one client and'
        Write-Note 'eight failed sign-ins lock everybody out.'
    }
}

# ------------------------------------------------------------ 3. accounts --

Write-Step 'Accounts'

# No stderr redirection here on purpose. PowerShell 5.1 wraps a native
# command's redirected stderr in ErrorRecords and flips $? even on a clean exit,
# so `2>$null` would turn a working command into an apparent failure. If the CLI
# has something to say - a broken config, most likely - let it reach the screen.
#
# A first run has no database yet, and `users list` creating an empty one is
# harmless on Windows; on Linux it would land root-owned, which is why install.sh
# runs the same command as the service account instead.
$accountCount = 0
try {
    $listing = & $NodeBin $CliJs users list
    if ($LASTEXITCODE -eq 0 -and $listing) {
        $accountCount = @($listing | Where-Object {
            $_ -and $_ -notmatch '^username' -and $_ -notmatch '^No accounts'
        }).Count
    }
} catch {
    $accountCount = 0
}

if ($accountCount -gt 0) {
    Write-Info "$accountCount already exist - none created"
} elseif ($NonInteractive) {
    Write-Info 'none yet, and this run cannot prompt for a password'
    Write-Note 'There is no registration page and no first-run claim, by decision: the'
    Write-Note 'only thing an anonymous request can do is fail to sign in. Create the'
    Write-Note 'first account yourself:'
    Write-Note ''
    Write-Note "  node `"$CliJs`" users add NAME"
} else {
    if (-not $Admin) {
        Write-Host ''
        Write-Host '    There is no registration page: accounts are created here and'
        Write-Host '    nowhere else. Enter a username for the first one, or press Enter'
        Write-Host '    to skip and do it later.'
        Write-Host ''
        $Admin = Read-Host '    username'
    }

    if ($Admin) {
        # The CLI does the asking. The password is typed at a hidden prompt
        # inside that process and hashed before anything is written, so it never
        # reaches argv, the process list, this script's environment or the
        # PSReadLine history - which is why there is no -Password parameter.
        & $NodeBin $CliJs users add $Admin
        if ($LASTEXITCODE -eq 0) {
            Write-Info "created `"$Admin`" - no restart needed, sign-in works immediately"
        } else {
            Write-Warn "Creating `"$Admin`" did not finish. Nothing was written."
            Write-Warn "Try again with: node `"$CliJs`" users add $Admin"
        }
    } else {
        Write-Info 'skipped'
    }
}

# ----------------------------------------------------------- 4. autostart --

if ($NoAutoStart) {
    Write-Step 'Start at logon'
    Write-Info 'skipped (-NoAutoStart)'
    Write-Note "Start it by hand with: $Repo\deploy\windows\start-server.cmd"
} else {
    Write-Step "Start at logon: scheduled task `"$TaskName`""

    if (-not (Test-Path $VbsFile)) {
        Stop-Install "Missing $VbsFile." @('The deploy\windows directory is incomplete.')
    }

    # The task points at the .vbs, not at the .ps1 and not at node.
    #
    #   .vbs   wscript is the only host that starts a process with NO window at
    #          all. powershell -WindowStyle Hidden still creates the console and
    #          it flashes - every single logon, for ever.
    #   tray   the tray owns the node process: it restarts it, it stops it on
    #          Exit, and it refuses to take a port held by something that is not
    #          this server. A task pointed straight at node would have none of
    #          that.
    #
    # The /TR quoting is the documented schtasks form - the inner path is quoted
    # with backslash-escaped quotes inside the outer pair. Start-Process is used
    # rather than a direct call because it joins ArgumentList verbatim, whereas
    # PowerShell 5.1's own native-command quoting mangles embedded quotes.
    $taskRun = '"wscript.exe \"' + $VbsFile + '\""'
    $schtasks = Start-Process -FilePath 'schtasks.exe' -NoNewWindow -Wait -PassThru `
        -ArgumentList @('/Create', '/F', '/TN', "`"$TaskName`"", '/SC', 'ONLOGON', '/TR', $taskRun)

    if ($schtasks.ExitCode -ne 0) {
        Write-Warn "schtasks returned $($schtasks.ExitCode); the task was not created."
        Write-Warn 'Create it by hand, or start the tray with deploy\windows\start-server.cmd.'
    } else {
        Write-Info 'created - runs at logon, no elevation needed'
        Write-Note 'Remove it with: schtasks /Delete /TN "Stremio4Manga" /F'
    }

    # Start it now too, so the install ends with a server that is actually up.
    Write-Info 'starting the tray now'
    Start-Process -FilePath 'wscript.exe' -ArgumentList @("`"$VbsFile`"")
}

# -------------------------------------------------------------- 5. summary --

$dataDir = Join-Path $env:LOCALAPPDATA 'Stremio4Manga'
try {
    $cfg = Get-Content -Raw -Encoding UTF8 $ConfigFile | ConvertFrom-Json
    if ($cfg.dataDir) {
        $dataDir = if ([System.IO.Path]::IsPathRooted($cfg.dataDir)) { [string]$cfg.dataDir }
                   else { Join-Path $ServerDir ([string]$cfg.dataDir) }
    }
} catch {}

Write-Host ''
Write-Host '==> ' -ForegroundColor Green -NoNewline
Write-Host 'Done.' -ForegroundColor White
Write-Host ''
Write-Host "  URL              $Origin"
Write-Host "  Listening on     http://${ListenHost}:$Port"
Write-Host "  Repo             $Repo"
Write-Host "  Config           $ConfigFile"
Write-Host "  Data             $dataDir"
Write-Host '                     stremio4manga.db   the library, accounts and sessions'
Write-Host '                     downloads\         chapters kept for offline reading'
Write-Host '                     backups\           the automated backup schedule'
Write-Host '                     cache\, thumbnails\'
Write-Host '                     stremio4manga.log  rotated at 5 MB, three kept'
Write-Host ''
Write-Host '  Tray             right-click the icon by the clock: open, log, accounts,'
Write-Host '                   restart, exit. Double-click opens the app.'
Write-Host "  Start / stop     $Repo\deploy\windows\start-server.cmd"
Write-Host "                   $Repo\deploy\windows\stop-server.cmd"
Write-Host "  Health           curl http://127.0.0.1:$Port/gateway/health"
Write-Host ''
Write-Host "  Accounts         node `"$CliJs`" users add NAME"
Write-Host "                   node `"$CliJs`" users passwd NAME"
Write-Host "                   node `"$CliJs`" users list"
Write-Host "                   node `"$CliJs`" users remove NAME --yes"
Write-Host ''
Write-Host '  On Windows Server, ONLOGON is the wrong trigger. The tray icon lives in'
Write-Host '  an interactive session, so with nobody signed in there is no tray and no'
Write-Host '  server. From an ELEVATED prompt, replace the task with one that runs'
Write-Host '  before anyone logs in:'
Write-Host ''
Write-Host "    schtasks /Create /F /TN `"$TaskName`" /SC ONSTART /RU SYSTEM ^"
Write-Host "      /TR `"wscript.exe \`"$VbsFile\`"`""
Write-Host ''
Write-Host '  As SYSTEM there is no tray and %LOCALAPPDATA% is'
Write-Host '  C:\Windows\System32\config\systemprofile\AppData\Local - so set an'
Write-Host '  explicit "dataDir" in config.json first, or the library ends up somewhere'
Write-Host '  nobody thinks to look. On a real Linux server, install.sh and systemd are'
Write-Host '  the better answer to the same problem.'
Write-Host ''
