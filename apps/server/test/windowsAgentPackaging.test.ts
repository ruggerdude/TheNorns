import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path: string) => readFileSync(resolve(workspace, path), "utf8");

describe("Windows local-agent packaging", () => {
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
    expect(workflow).toContain(
      "if: inputs.publish_release && steps.signing.outputs.signed == 'true'",
    );
    expect(workflow).toContain("actions/upload-artifact@v4");
  });
});
