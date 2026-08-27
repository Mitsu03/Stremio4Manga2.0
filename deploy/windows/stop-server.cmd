@echo off
REM ==========================================================================
REM  stop-server.cmd - para o servidor e tira o icone da bandeja. Alternativa
REM  ao "Sair" do menu do icone, util quando o icone fica preso.
REM
REM  Encontra o servidor pela PORTA do server\config.json, e nao pela linha de
REM  comandos: o processo aparece como "node.exe ...\main.js", que e um nome
REM  demasiado comum para se matar por semelhanca. Confirma na mesma que quem
REM  tem a porta e um node.exe antes de lhe tocar - a porta 8080 pertence a
REM  meio mundo.
REM
REM  A ULTIMA linha tem um "-ne $PID" que nao e decoracao. O filtro procura
REM  processos powershell.exe cuja linha de comandos contenha
REM  "server-tray.ps1" - e a propria powershell que esta a avaliar o filtro
REM  contem essa string, porque ela faz parte do comando que este .cmd lhe
REM  passou. Sem o "-ne $PID" o script mata-se a si proprio a meio, antes de
REM  imprimir seja o que for, e o sintoma e uma janela que fecha sem
REM  mensagem nenhuma.
REM ==========================================================================
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$cfg = Join-Path '%~dp0' '..\..\server\config.json';" ^
  "$port = 8080; if (Test-Path $cfg) { $j = Get-Content -Raw -Encoding UTF8 $cfg | ConvertFrom-Json; if ($j.listen.port) { $port = [int]$j.listen.port } };" ^
  "$conn = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | Select-Object -First 1;" ^
  "if ($conn) { $srv = Get-CimInstance Win32_Process -Filter \"ProcessId=$($conn.OwningProcess)\" -EA SilentlyContinue } else { $srv = $null };" ^
  "if ($srv -and $srv.Name -eq 'node.exe') {" ^
  "  Stop-Process -Id $srv.ProcessId -Force -EA SilentlyContinue;" ^
  "  Write-Host \"Servidor (porta $port) parado.\" -ForegroundColor Green" ^
  "} elseif ($srv) { Write-Host \"A porta $port e do $($srv.Name) (PID $($srv.ProcessId)), nao deste servidor. Nada foi tocado.\" -ForegroundColor Yellow }" ^
  "else { Write-Host \"Nao havia servidor a correr na porta $port.\" -ForegroundColor Yellow };" ^
  "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" -EA SilentlyContinue | Where-Object { $_.CommandLine -like '*server-tray.ps1*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }"
