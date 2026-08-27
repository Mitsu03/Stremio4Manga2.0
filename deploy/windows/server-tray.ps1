# ==========================================================================
#  server-tray.ps1 - arranca o servidor destacado (node sem consola visivel) e
#  poe um icone na bandeja do sistema, ao lado do relogio, para o abrir, ver o
#  log, ver as contas, reiniciar e - em "Sair" - parar mesmo.
#
#  Nao correr isto com duplo-clique: usa o start-server.cmd ou o
#  start-server.vbs, que o lancam sem janela nenhuma.
#
#  Este e o descendente do gateway-tray.ps1 da versao anterior, muito mais
#  curto porque nao ha nada para contar nem para matar por ordem: e um so
#  processo node, uma so porta, uma so base de dados. Ficaram as duas coisas
#  que continuam a ser armadilhas reais - a tomada da porta e a deteccao de
#  quem a tem.
# ==========================================================================
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repo = (Resolve-Path (Join-Path $here '..\..')).Path

$mainJs     = Join-Path $repo 'server\dist\main.js'
$cliJs      = Join-Path $repo 'server\dist\cli.js'
$serverDir  = Join-Path $repo 'server'
$configFile = Join-Path $serverDir 'config.json'
$iconFile   = Join-Path $repo 'web\public\favicon.ico'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- config ----------------------------------------------------------------

# O tray le o mesmo ficheiro que o servidor le, para nao haver uma segunda
# copia da porta a envelhecer sozinha. Sem config nao ha nada a arrancar.
if (-not (Test-Path $configFile)) {
    [System.Windows.Forms.MessageBox]::Show(
        "Nao ha config.json em $serverDir.`nCopia o config.example.json e preenche o publicOrigin.",
        'Stremio4Manga', 'OK', 'Error') | Out-Null
    exit 1
}

try {
    $config = Get-Content -Raw -Encoding UTF8 $configFile | ConvertFrom-Json
} catch {
    [System.Windows.Forms.MessageBox]::Show(
        "config.json nao e JSON valido:`n$($_.Exception.Message)",
        'Stremio4Manga', 'OK', 'Error') | Out-Null
    exit 1
}

$port = 8080
if ($config.listen -and $config.listen.port) { $port = [int]$config.listen.port }

# O health check fala sempre com o loopback, e nao com o listen.host: o
# publicOrigin pode ser o dominio publico, que daqui de dentro passa pelo proxy
# - ou nem sequer resolve. E o 127.0.0.1 responde mesmo quando o listen.host e
# 0.0.0.0.
$localUrl = "http://127.0.0.1:$port"
$openUrl  = if ($config.publicOrigin) { [string]$config.publicOrigin } else { $localUrl }

# Os defaults estao em server/src/config.ts: sem dataDir no config, e
# %LOCALAPPDATA%\Stremio4Manga. Um caminho relativo resolve contra a pasta do
# proprio config, que e server/.
$dataDir = Join-Path $env:LOCALAPPDATA 'Stremio4Manga'
if ($config.dataDir) {
    $dataDir = if ([System.IO.Path]::IsPathRooted($config.dataDir)) { [string]$config.dataDir }
               else { Join-Path $serverDir ([string]$config.dataDir) }
}

$logFile = Join-Path $dataDir 'stremio4manga.log'
if ($config.logging -and $config.logging.file) {
    $logFile = if ([System.IO.Path]::IsPathRooted($config.logging.file)) { [string]$config.logging.file }
               else { Join-Path $serverDir ([string]$config.logging.file) }
}

# O servidor ja escreve e roda o seu proprio log. Estes dois apanham o que
# morre antes disso - um erro de arranque do Node, um config invalido, um
# `node:sqlite` que nao existe porque a versao e antiga - que nunca chega a
# passar pelo logger.
$outFile = Join-Path $dataDir 'server.out.log'
$errFile = Join-Path $dataDir 'server.err.log'

# --- helpers ---------------------------------------------------------------

function Find-Node {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Get-PortHolder {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if (-not $conn) { return $null }
    return Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue
}

function Clear-Port {
    # Um servidor ja a correr (arrancado a mao numa consola) segura a porta e o
    # nosso morre no bind. O Node reporta um bind falhado como um evento
    # 'error'; sem alguem a apanha-lo o processo sai sem dizer porque, e o
    # sintoma que chega ao utilizador e "terminou inesperadamente".
    #
    # Toma-se o lugar dele - mas so se for mesmo o nosso servidor. Matar as
    # cegas quem tem a porta 8080 e como se derruba o servidor de outra pessoa
    # sem nunca se saber que existia.
    $holder = Get-PortHolder
    if (-not $holder) { return $true }

    # Comparacao pelo caminho completo do main.js, normalizado dos dois lados:
    # "node.exe qualquer-coisa\main.js" e demasiado comum para servir de prova.
    $cmdline = ''
    if ($holder.CommandLine) { $cmdline = ($holder.CommandLine -replace '\\', '/').ToLowerInvariant() }
    $wanted = ($mainJs -replace '\\', '/').ToLowerInvariant()

    if ($holder.Name -ne 'node.exe' -or -not $cmdline.Contains($wanted)) {
        Show-Error "A porta $port esta ocupada por $($holder.Name) (PID $($holder.ProcessId)), que nao e este servidor. Nao foi tocado."
        return $false
    }

    Stop-Process -Id $holder.ProcessId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    return $true
}

function Start-Server {
    if (-not (Test-Path $mainJs)) {
        Show-Error "Nao ha server\dist\main.js. Corre 'npm run build' na raiz do repositorio."
        return $false
    }
    if (-not (Clear-Port)) { return $false }
    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }

    # -WindowStyle Hidden porque o node.exe nao tem um "nodew.exe": a consola e
    # criada na mesma, apenas nunca chega a aparecer.
    $script:proc = Start-Process -FilePath $script:node `
        -ArgumentList @($mainJs) `
        -WorkingDirectory $repo `
        -RedirectStandardOutput $outFile `
        -RedirectStandardError $errFile `
        -WindowStyle Hidden -PassThru

    $script:ready = $false
    Set-Tip 'Stremio4Manga - a arrancar...'
    $script:timer.Start()
    return $true
}

function Stop-Server {
    $script:timer.Stop()

    # Um so processo, sem filhos: nao ha ordem nenhuma a respeitar aqui. O
    # gateway antigo tinha de matar as JVMs primeiro; isto e uma linha.
    if ($script:proc -and -not $script:proc.HasExited) {
        Stop-Process -Id $script:proc.Id -Force -ErrorAction SilentlyContinue
    }

    $script:proc = $null
    $script:ready = $false
}

function Test-ServerUp {
    try {
        $resp = Invoke-WebRequest -Uri "$localUrl/gateway/health" -UseBasicParsing -TimeoutSec 3
        return ($resp.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Set-Tip([string]$text) {
    # O tooltip do NotifyIcon corta acima de 63 caracteres.
    if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
    $script:tray.Text = $text
}

function Show-Balloon([string]$title, [string]$text, $icon) {
    $script:tray.BalloonTipTitle = $title
    $script:tray.BalloonTipText = $text
    $script:tray.BalloonTipIcon = $icon
    $script:tray.ShowBalloonTip(4000)
}

function Show-Error([string]$text) {
    Show-Balloon 'Stremio4Manga' $text ([System.Windows.Forms.ToolTipIcon]::Error)
}

# --- estado ----------------------------------------------------------------

$script:node = Find-Node
if (-not $script:node) {
    [System.Windows.Forms.MessageBox]::Show(
        "Node nao encontrado (nem no PATH nem nas pastas habituais).`nEste servidor precisa de Node 22 ou mais recente - a base de dados e o node:sqlite, que nao existe antes disso.",
        'Stremio4Manga', 'OK', 'Error') | Out-Null
    exit 1
}

$script:proc  = $null
$script:ready = $false

# --- icone na bandeja ------------------------------------------------------

$script:tray = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path $iconFile) {
    $script:tray.Icon = New-Object System.Drawing.Icon($iconFile, 16, 16)
} else {
    $script:tray.Icon = [System.Drawing.SystemIcons]::Application
}
$script:tray.Text = 'Stremio4Manga'
$script:tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$itemOpen = $menu.Items.Add('Abrir Stremio4Manga')
$itemOpen.Font = New-Object System.Drawing.Font($menu.Font, [System.Drawing.FontStyle]::Bold)
$itemOpen.Add_Click({ Start-Process $openUrl })

$itemLog = $menu.Items.Add('Ver log')
$itemLog.Add_Click({
    if (Test-Path $logFile) { Start-Process notepad.exe $logFile }
    elseif (Test-Path $errFile) { Start-Process notepad.exe $errFile }
    else { Show-Error "Ainda nao ha log em $logFile." }
})

$itemUsers = $menu.Items.Add('Ver contas')
$itemUsers.Add_Click({
    # -NoExit porque a lista e curta e a janela fecharia antes de ser lida. E a
    # unica janela que este tray abre de proposito.
    Start-Process powershell.exe -ArgumentList @(
        '-NoProfile', '-NoExit', '-Command',
        "Set-Location '$repo'; & '$($script:node)' '$cliJs' users list"
    )
})

$menu.Items.Add('-') | Out-Null

$itemRestart = $menu.Items.Add('Reiniciar')
$itemRestart.Add_Click({
    Stop-Server
    Start-Sleep -Milliseconds 500
    if (Start-Server) { Show-Balloon 'Stremio4Manga' 'A reiniciar...' ([System.Windows.Forms.ToolTipIcon]::Info) }
})

$itemExit = $menu.Items.Add('Sair (parar o servidor)')
$itemExit.Add_Click({
    # A limpeza esta no finally la em baixo, para correr tambem quando este
    # script morre por outra via.
    [System.Windows.Forms.Application]::Exit()
})

$script:tray.ContextMenuStrip = $menu
$script:tray.Add_MouseDoubleClick({ Start-Process $openUrl })

# --- vigia: espera pelo arranque e deteta se o servidor morre ---------------

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 2000
$script:timer.Add_Tick({
    if ($script:proc -and $script:proc.HasExited) {
        $script:timer.Stop()
        $script:ready = $false
        Set-Tip 'Stremio4Manga - parado'
        Show-Error 'O servidor terminou inesperadamente. Ve o log.'
        return
    }

    if (-not $script:ready) {
        if (Test-ServerUp) {
            $script:ready = $true
            Set-Tip "Stremio4Manga - $openUrl"
            Show-Balloon 'Stremio4Manga' "Pronto em $openUrl.`nClica duas vezes para abrir." ([System.Windows.Forms.ToolTipIcon]::Info)
        }
        return
    }
})

# --- arranque --------------------------------------------------------------

try {
    if (Start-Server) {
        [System.Windows.Forms.Application]::Run()
    }
} finally {
    # Se este script morrer por outra via, o node nao fica orfao a segurar a
    # porta e a base de dados.
    try { Stop-Server } catch {}
    if ($script:tray) {
        try { $script:tray.Visible = $false; $script:tray.Dispose() } catch {}
        $script:tray = $null
    }
}
