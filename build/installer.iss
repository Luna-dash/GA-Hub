; Inno Setup script for GenericAgent-Admin (Windows installer).
;
; Build:
;     iscc build\installer.iss
;
; Output:
;     build\GenericAgent-Admin-<version>-Setup.exe
;
; This script assumes PyInstaller has already produced the onedir bundle at
; build\dist\GenericAgent-Admin\ (run build\build_win.bat for the full chain).

#define MyAppName "GenericAgent Admin"
#define MyAppExeName "GenericAgent-Admin.exe"
#define MyAppPublisher "GenericAgent"
#define MyAppVersion "0.2.0"

[Setup]
; Stable AppId — regenerating this would orphan upgrade paths on existing
; installs. Treat as immutable for the lifetime of the product.
AppId={{7DCB1EB8-DD1B-441D-8E42-01035CC8F892}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL=https://github.com/
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=.
OutputBaseFilename=GenericAgent-Admin-{#MyAppVersion}-Setup
Compression=lzma2/ultra
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
ArchitecturesAllowed=x64
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}
; Stop the running app before upgrade/uninstall so we can replace files.
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; The PyInstaller onedir output. Recurse all subdirs (incl. _internal\webui\dist).
Source: "dist\GenericAgent-Admin\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; Optional post-install launch.
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
