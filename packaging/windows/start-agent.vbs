Option Explicit

Dim shell, fso, appDir, localData, dataDir, nodePath, cliPath, gitPath, packageBinPath
Dim process, processes, command

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

If Not fso.FileExists(nodePath) Or Not fso.FileExists(cliPath) Then
  WScript.Quit 2
End If

Set processes = GetObject("winmgmts:\\.\root\cimv2").ExecQuery( _
  "SELECT CommandLine FROM Win32_Process WHERE Name = 'node.exe'" _
)
For Each process In processes
  If Not IsNull(process.CommandLine) Then
    If InStr(1, process.CommandLine, cliPath, vbTextCompare) > 0 And _
       InStr(1, process.CommandLine, "agent-start", vbTextCompare) > 0 Then
      WScript.Quit 0
    End If
  End If
Next

shell.Environment("PROCESS")("PATH") = _
  fso.BuildPath(appDir, "runtime") & ";" & packageBinPath & ";" & gitPath & ";" & _
  shell.Environment("PROCESS")("PATH")
shell.CurrentDirectory = appDir
command = Quote(nodePath) & " " & Quote(cliPath) & " agent-start --data " & Quote(dataDir)
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
