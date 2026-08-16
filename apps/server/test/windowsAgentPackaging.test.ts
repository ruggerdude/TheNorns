import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path: string) => readFileSync(resolve(workspace, path), "utf8");

describe("desktop local-agent packaging", () => {
  it("bundles its own Node runtime and digest-pinned MinGit payload", () => {
    const script = read("scripts/package-windows-agent.ps1");
    expect(script).toContain("Copy-Item -Force (Get-Command node.exe).Source");
    expect(script).toContain("MinGit-2.55.0.3-64-bit.zip");
    expect(script).toContain("f48e2d2dc74a24454adc6d8fd0ac25bf9c2386f19cfb06202b9465aaad4f9f05");
    expect(script).toContain("Get-FileHash -Algorithm SHA256");
    expect(script).toContain("npm install --prefix $appPayload --omit=dev");
  });

  it("installs per-user, starts at login, and opens the loopback Control Center", () => {
    const installer = read("packaging/windows/NornsLocalAgent.iss");
    expect(installer).toContain("PrivilegesRequired=lowest");
    expect(installer).toContain("DefaultDirName={localappdata}");
    expect(installer).toContain('Subkey: "Software\\Classes\\norns-agent"; Flags: deletekey');
    expect(installer).toContain("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    expect(installer).toContain("open-control-center.vbs");
    expect(installer).toContain("PrepareToInstall");
    expect(installer).not.toContain("pair-agent.vbs");
    const launcher = read("packaging/windows/open-control-center.ps1");
    expect(launcher).toContain("HMACSHA256");
    expect(launcher).toContain("request_id");
  });

  it("publishes only signed platform installers and requires notarized macOS", () => {
    const workflow = read(".github/workflows/local-agent-installer.yml");
    expect(workflow).toContain('"signed=false" >> $env:GITHUB_OUTPUT');
    expect(workflow).toContain("needs.macos.outputs.notarized == 'true'");
    expect(workflow).toContain('if [ "$WINDOWS_SIGNED" = "true" ]');
    expect(workflow).toContain('assets=("$macos_asset")');
    expect(workflow).toContain('assets+=("$windows_asset")');
    expect(workflow).toContain("actions/upload-artifact@v4");
  });

  it("builds one universal macOS app with authenticated Control Center launch", () => {
    const packaging = read("scripts/package-macos-agent.sh");
    expect(packaging).toContain("node-v$NODE_VERSION-darwin-$ARCH.tar.gz");
    expect(packaging).toContain("EXPECTED_SHA256");
    expect(packaging).toContain("-target arm64-apple-macos13.0");
    expect(packaging).toContain("-target x86_64-apple-macos13.0");
    expect(packaging).toContain("lipo -create");
    expect(packaging).toContain('--component-plist "$COMPONENT_PLIST"');

    const info = read("packaging/macos/Info.plist.in");
    expect(info).not.toContain("<string>norns-agent</string>");
    const component = read("packaging/macos/component.plist");
    expect(component).toContain("<key>BundleIsRelocatable</key>");
    expect(component).toContain("<false/>");
    expect(component).toContain("Applications/Norns Local Agent.app");
    const launcher = read("packaging/macos/NornsLocalAgent.swift");
    expect(launcher).toContain("HMAC<SHA256>");
    expect(launcher).toContain('("request_id", requestID)');
    const agent = read("packaging/macos/agent.sh");
    expect(agent).toContain("com.thenorns.local-agent.plist");
    expect(agent).toContain("NORNS_ENABLE_DEVICE_ENROLLMENT");
    expect(agent).toContain("NORNS_ENABLE_DEVICE_CONTROL");
    expect(agent).toContain("NORNS_ENABLE_DEVICE_EXECUTION");
    expect(agent).toContain("agent-start");
    expect(agent).toContain("xcode-select --install");

    const windowsAgent = read("packaging/windows/start-agent.vbs");
    expect(windowsAgent).toContain("NORNS_ENABLE_DEVICE_ENROLLMENT");
    expect(windowsAgent).toContain("NORNS_ENABLE_DEVICE_CONTROL");
    expect(windowsAgent).toContain("NORNS_ENABLE_DEVICE_EXECUTION");
  });

  it("requires Developer ID signing and Apple notarization before Mac publication", () => {
    const signing = read("scripts/sign-notarize-macos-agent.sh");
    expect(signing).toContain("APPLICATION_IDENTITY");
    expect(signing).toContain("INSTALLER_IDENTITY");
    expect(signing).toContain("codesign --verify --deep --strict");
    expect(signing).toContain('--scripts "$PACKAGE_SCRIPTS"');
    expect(signing).toContain('--component-plist "$COMPONENT_PLIST"');
    expect(signing).toContain("notarytool submit");
    expect(signing).toContain("stapler staple");
    expect(signing).toContain("notarized=true");
  });
});
