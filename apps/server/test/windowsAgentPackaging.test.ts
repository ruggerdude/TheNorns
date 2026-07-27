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

  it("installs per-user, starts at login, and registers the pairing protocol", () => {
    const installer = read("packaging/windows/NornsLocalAgent.iss");
    expect(installer).toContain("PrivilegesRequired=lowest");
    expect(installer).toContain("DefaultDirName={localappdata}");
    expect(installer).toContain("Software\\Classes\\norns-agent");
    expect(installer).toContain("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    expect(installer).toContain("pair-agent.vbs");
    expect(read("packaging/windows/pair-agent.vbs")).toContain(
      'NORNS_AGENT_ALLOWED_ORIGIN") = "https://thenorns.up.railway.app"',
    );
  });

  it("never publishes an unsigned installer as a release", () => {
    const workflow = read(".github/workflows/local-agent-installer.yml");
    expect(workflow).toContain("Publishing requires WINDOWS_CODESIGN_PFX_BASE64");
    expect(workflow).toContain("needs.windows.outputs.signed == 'true'");
    expect(workflow).toContain("needs.macos.outputs.notarized == 'true'");
    expect(workflow).toContain("actions/upload-artifact@v4");
  });

  it("builds one universal macOS app with pairing and launch-agent integration", () => {
    const packaging = read("scripts/package-macos-agent.sh");
    expect(packaging).toContain("node-v$NODE_VERSION-darwin-$ARCH.tar.gz");
    expect(packaging).toContain("EXPECTED_SHA256");
    expect(packaging).toContain("-target arm64-apple-macos13.0");
    expect(packaging).toContain("-target x86_64-apple-macos13.0");
    expect(packaging).toContain("lipo -create");

    const info = read("packaging/macos/Info.plist.in");
    expect(info).toContain("<string>norns-agent</string>");
    const agent = read("packaging/macos/agent.sh");
    expect(agent).toContain("com.thenorns.local-agent.plist");
    expect(agent).toContain("NORNS_AGENT_ALLOWED_ORIGIN=");
    expect(agent).toContain("xcode-select --install");
  });

  it("requires Developer ID signing and Apple notarization before Mac publication", () => {
    const signing = read("scripts/sign-notarize-macos-agent.sh");
    expect(signing).toContain("APPLICATION_IDENTITY");
    expect(signing).toContain("INSTALLER_IDENTITY");
    expect(signing).toContain("codesign --verify --deep --strict");
    expect(signing).toContain("notarytool submit");
    expect(signing).toContain("stapler staple");
    expect(signing).toContain("notarized=true");
  });
});
