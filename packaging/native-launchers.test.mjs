import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const swift = readFileSync(new URL("./macos/NornsLocalAgent.swift", import.meta.url), "utf8");
const agentShell = readFileSync(new URL("./macos/agent.sh", import.meta.url), "utf8");
const powershell = readFileSync(
  new URL("./windows/open-control-center.ps1", import.meta.url),
  "utf8",
);

function transcript(purpose, fields) {
  return `${purpose}\n${fields
    .map(([name, value]) => `${name}:${Buffer.byteLength(value, "utf8")}:${value}\n`)
    .join("")}`;
}

const firstSecret = randomBytes(32);
const secondSecret = randomBytes(32);
const origin = "http://127.0.0.1:43123";
const requestId = randomBytes(32).toString("base64url");
const requestTranscript = transcript("norns:agent-host-native-launch-request:v1", [
  ["origin", origin],
  ["request_id", requestId],
]);
const firstProof = createHmac("sha256", firstSecret).update(requestTranscript).digest("base64url");
const secondProof = createHmac("sha256", secondSecret)
  .update(requestTranscript)
  .digest("base64url");
assert.notEqual(firstProof, secondProof, "a stale process secret cannot authenticate a new host");

for (const source of [swift, powershell]) {
  assert.match(source, /norns:agent-host-native-launch-request:v1/);
  assert.match(source, /norns:agent-host-native-launch-response:v1/);
  assert.match(source, /request_id/);
  assert.match(source, /request_proof/);
  assert.match(source, /response_proof/);
}
assert.match(swift, /HMAC<SHA256>\.isValidAuthenticationCode/);
assert.match(swift, /for _ in 0\.\.<attempts/);
assert.match(swift, /NSStatusBar\.system\.statusItem/);
assert.match(swift, /Open Local Control Center/);
assert.match(swift, /Quit Norns Local Agent/);
assert.match(swift, /runAgentAction\("stop"\)/);
assert.match(swift, /let result = self\.ensureAgentHost\(\)[\s\S]*?self\.waitForControlCenterURL/);
assert.match(powershell, /FixedTimeEquals/);
assert.match(powershell, /for \(\$attempt = 0; \$attempt -lt 50/);
assert.match(powershell, /stale file, dead port, or invalid response proof/);
assert.match(powershell, /GetLeftPart\(\[System\.UriPartial\]::Authority\) -cne \$expectedOrigin/);
assert.equal(new URL("http://[::1]:43123/#bootstrap=value").origin, "http://[::1]:43123");

const swiftBody = swift.match(/withJSONObject:\s*\[([\s\S]*?)\]\s*\)/)?.[1] ?? "";
assert.doesNotMatch(swiftBody, /native_launch_secret/);
const powershellBody = powershell.match(/\$body = @\{([\s\S]*?)\}\s*\| ConvertTo-Json/)?.[1] ?? "";
assert.doesNotMatch(powershellBody, /native_launch_secret/);

const openCase = agentShell.match(/ {2}open\)([\s\S]*?) {2}start\)/)?.[1] ?? "";
assert.ok(openCase, "macOS app must have a non-destructive open action");
assert.doesNotMatch(openCase, /stop_old_agents|kickstart -k/);
assert.match(agentShell, /NORNS_LOCAL_AGENT_VERSION/);
assert.match(agentShell, /INSTALLED_SERVICE_VERSION/);
assert.match(agentShell, /com\.thenorns\.local-agent-menubar/);
assert.match(agentShell, /\/opt\/homebrew\/bin:\/usr\/local\/bin/);
assert.match(agentShell, /<key>PATH<\/key><string>%s<\/string>/);
assert.match(agentShell, /stop\)/);

console.log("native launcher mutual-HMAC and stale-discovery fixtures: OK");
