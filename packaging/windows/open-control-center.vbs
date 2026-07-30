Option Explicit

Dim shell, fso, appDir, scriptPath, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(appDir, "open-control-center.ps1")

If Not fso.FileExists(scriptPath) Then
  MsgBox "The Norns Local Agent launcher is incomplete. Reinstall the signed package.", _
    vbCritical, "Norns Local Agent"
  WScript.Quit 2
End If

command = Quote(fso.BuildPath( _
  shell.ExpandEnvironmentStrings("%SystemRoot%"), _
  "System32\WindowsPowerShell\v1.0\powershell.exe" _
)) & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Quote(scriptPath)
exitCode = shell.Run(command, 0, True)
If exitCode <> 0 Then
  MsgBox "The local Control Center could not be opened. Reinstall the signed package and try again.", _
    vbExclamation, "Norns Local Agent"
End If
WScript.Quit exitCode

Function Quote(value)
  Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
