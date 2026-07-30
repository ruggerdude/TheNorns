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
CloseApplications=no
UninstallDisplayIcon={app}\runtime\node.exe

[Files]
Source: "..\..\dist-agent\windows\payload\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKCU; Subkey: "Software\Classes\norns-agent"; Flags: deletekey dontcreatekey
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Norns Local Agent"; ValueData: """{sys}\wscript.exe"" ""{app}\start-agent.vbs"""; Flags: uninsdeletevalue

[Icons]
Name: "{group}\Norns Local Agent Control Center"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\open-control-center.vbs"""; WorkingDir: "{app}"

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\open-control-center.vbs"""; Flags: runhidden nowait postinstall

[UninstallRun]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\stop-agent.vbs"""; Flags: runhidden waituntilterminated

[Code]
var
  WasPreviouslyConfigured: Boolean;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  StopScript: String;
begin
  Result := '';
  WasPreviouslyConfigured :=
    FileExists(ExpandConstant('{app}\start-agent.vbs')) or
    RegValueExists(
      HKCU,
      'Software\Microsoft\Windows\CurrentVersion\Run',
      'Norns Local Agent'
    );
  if not WasPreviouslyConfigured then
    exit;

  StopScript := ExpandConstant('{app}\stop-agent.vbs');
  if not FileExists(StopScript) then
  begin
    Result :=
      'The existing Norns Local Agent could not be stopped safely. ' +
      'Close it and run this installer again.';
    exit;
  end;

  if (not Exec(
    ExpandConstant('{sys}\wscript.exe'),
    '"' + StopScript + '"',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  )) or (ResultCode <> 0) then
  begin
    Result :=
      'The existing Norns Local Agent did not stop before upgrade. ' +
      'Close it and run this installer again.';
  end;
end;
