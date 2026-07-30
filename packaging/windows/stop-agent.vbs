Option Explicit

Dim fso, appDir, cliPath, process, processes, remaining, attempts

Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
cliPath = fso.BuildPath( _
  fso.BuildPath(fso.BuildPath(fso.BuildPath(appDir, "app"), "node_modules"), "@norns"), _
  "runner\dist\cli.js" _
)
For attempts = 1 To 100
  remaining = 0
  Set processes = GetObject("winmgmts:\\.\root\cimv2").ExecQuery( _
    "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'" _
  )
  For Each process In processes
    If Not IsNull(process.CommandLine) Then
      If InStr(1, process.CommandLine, cliPath, vbTextCompare) > 0 Then
        remaining = remaining + 1
        If attempts = 1 Then
          process.Terminate()
        End If
      End If
    End If
  Next
  If remaining = 0 Then
    WScript.Quit 0
  End If
  WScript.Sleep 100
Next

WScript.Quit 1
