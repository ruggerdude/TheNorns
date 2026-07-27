#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif

[Setup]
AppId={{125E1B65-B7A7-4E0C-BE5A-B2076C96DF77}
AppName=Norns Local Agent
AppVersion={#MyAppVersion}
AppPublisher=The Norns
AppPublisherURL=https://thenorns.up.railway.app
DefaultDirName={localappdata}\Programs\Norns Local Agent
DefaultGroupName=Norns Local Agent
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=..\..\dist-agent\windows\installer
OutputBaseFilename=Norns-Local-Agent-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ChangesAssociations=yes
CloseApplications=no
UninstallDisplayIcon={app}\runtime\node.exe

[Files]
Source: "..\..\dist-agent\windows\payload\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKCU; Subkey: "Software\Classes\norns-agent"; ValueType: string; ValueData: "URL:Norns Local Agent"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\norns-agent"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\norns-agent\DefaultIcon"; ValueType: string; ValueData: "{app}\runtime\node.exe,0"
Root: HKCU; Subkey: "Software\Classes\norns-agent\shell\open\command"; ValueType: string; ValueData: """{sys}\wscript.exe"" ""{app}\pair-agent.vbs"" ""%1"""
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Norns Local Agent"; ValueData: """{sys}\wscript.exe"" ""{app}\start-agent.vbs"""; Flags: uninsdeletevalue

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\stop-agent.vbs"""; Flags: runhidden waituntilterminated
Filename: "{sys}\wscript.exe"; Parameters: """{app}\start-agent.vbs"""; Flags: runhidden nowait

[UninstallRun]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\stop-agent.vbs"""; Flags: runhidden waituntilterminated
