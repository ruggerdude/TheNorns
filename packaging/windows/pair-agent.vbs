Option Explicit

Dim shell, fso, appDir, localData, dataDir, nodePath, cliPath, gitPath, packageBinPath
Dim pairingUri, command, exitCode

If WScript.Arguments.Count <> 1 Then
  MsgBox "Open The Norns in your browser and choose Connect installed agent.", _
    vbInformation, "Norns Local Agent"
  WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
localData = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%")
dataDir = fso.BuildPath(fso.BuildPath(localData, "Norns"), "runner-1")
nodePath = fso.BuildPath(fso.BuildPath(appDir, "runtime"), "node.exe")
cliPath = fso.BuildPath( _
  fso.BuildPath(fso.BuildPath(fso.BuildPath(appDir, "app"), "node_modules"), "@norns"), _
  "runner\dist\cli.js" _
)
gitPath = fso.BuildPath(fso.BuildPath(appDir, "git"), "cmd")
packageBinPath = fso.BuildPath(fso.BuildPath(fso.BuildPath(appDir, "app"), "node_modules"), ".bin")
pairingUri = WScript.Arguments(0)

If Not fso.FileExists(nodePath) Or Not fso.FileExists(cliPath) Then
  MsgBox "Norns Local Agent is incomplete. Reinstall it and try again.", _
    vbCritical, "Norns Local Agent"
  WScript.Quit 2
End If

shell.Environment("PROCESS")("PATH") = _
  fso.BuildPath(appDir, "runtime") & ";" & packageBinPath & ";" & gitPath & ";" & _
  shell.Environment("PROCESS")("PATH")
shell.Environment("PROCESS")("NORNS_AGENT_ALLOWED_ORIGIN") = "https://thenorns.up.railway.app"
shell.CurrentDirectory = appDir
command = Quote(nodePath) & " " & Quote(cliPath) & " pair-url " & Quote(pairingUri) & _
  " --data " & Quote(dataDir)
exitCode = shell.Run(command, 0, True)
If exitCode <> 0 Then
  MsgBox "This connection link could not be used. Return to The Norns and create a new link.", _
    vbExclamation, "Norns Local Agent"
  WScript.Quit exitCode
End If

shell.Run Quote(WScript.FullName) & " " & Quote(fso.BuildPath(appDir, "start-agent.vbs")), 0, False
MsgBox "This computer is connected. Return to The Norns to choose your project folder.", _
  vbInformation, "Norns Local Agent"

Function Quote(value)
  Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
