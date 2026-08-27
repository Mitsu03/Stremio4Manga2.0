@echo off
REM ==========================================================================
REM  start-server.cmd - arranca o Stremio4Manga destacado do terminal.
REM
REM  Corre em node sem consola visivel e aparece um icone na bandeja do
REM  sistema, ao lado do relogio:
REM    - duplo-clique no icone        -> abre o publicOrigin do config
REM    - botao direito > Ver log      -> abre o log do servidor
REM    - botao direito > Ver contas   -> lista as contas
REM    - botao direito > Reiniciar    -> reinicia o servidor
REM    - botao direito > Sair         -> para o servidor
REM
REM  Fechar este terminal (ou a janela que o abriu) NAO para o servidor. Para
REM  o parar, usa o "Sair" no icone da bandeja ou o stop-server.cmd.
REM
REM  Precisa de Node 22 ou mais recente e de um build feito: na raiz do
REM  repositorio, "npm ci" e "npm run build". O install.ps1 faz as duas coisas
REM  e ainda regista o arranque automatico.
REM ==========================================================================
start "" wscript.exe "%~dp0start-server.vbs"
exit /b 0
