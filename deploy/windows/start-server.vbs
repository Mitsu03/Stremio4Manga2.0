' ==========================================================================
'  start-server.vbs - lanca o server-tray.ps1 sem consola nenhuma (nem sequer
'  um flash de janela preta). E este ficheiro que a tarefa do agendador corre
'  ao iniciar sessao; tambem funciona com duplo-clique.
'
'  O wscript.exe e o unico anfitriao no Windows que consegue arrancar um
'  processo verdadeiramente sem janela. O powershell.exe -WindowStyle Hidden
'  cria a consola na mesma e ela pisca durante uma fraccao de segundo - o que
'  numa tarefa que corre a cada inicio de sessao se nota todos os dias.
' ==========================================================================
Dim fso, shell, scriptDir, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & _
      fso.BuildPath(scriptDir, "server-tray.ps1") & """"

' 0 = janela oculta, False = nao esperar pelo fim
shell.Run cmd, 0, False
