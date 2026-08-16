import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const component = readFileSync(new URL("./component.plist", import.meta.url), "utf8");
const packager = readFileSync(
  new URL("../../scripts/package-macos-agent.sh", import.meta.url),
  "utf8",
);
const signer = readFileSync(
  new URL("../../scripts/sign-notarize-macos-agent.sh", import.meta.url),
  "utf8",
);
const launcher = readFileSync(new URL("./agent.sh", import.meta.url), "utf8");

assert.match(
  component,
  /<key>RootRelativeBundlePath<\/key>\s*<string>Applications\/Norns Local Agent\.app<\/string>/,
);
assert.match(component, /<key>BundleIsRelocatable<\/key>\s*<false\/>/);
assert.match(component, /<key>BundleOverwriteAction<\/key>\s*<string>upgrade<\/string>/);
assert.match(packager, /--component-plist "\$COMPONENT_PLIST"/);
assert.match(signer, /--scripts "\$PACKAGE_SCRIPTS"/);
assert.match(signer, /--component-plist "\$COMPONENT_PLIST"/);
assert.match(signer, /--keychain "\$INSTALLER_KEYCHAIN"/);
assert.match(signer, /security find-identity -v "\$APPLICATION_KEYCHAIN"/);
assert.match(signer, /security find-identity -v "\$INSTALLER_KEYCHAIN"/);
assert.match(launcher, /<key>NORNS_ENABLE_DEVICE_CONTROL<\/key><string>true<\/string>/);
assert.match(launcher, /<key>NORNS_ENABLE_DEVICE_EXECUTION<\/key><string>true<\/string>/);
assert.match(launcher, /NORNS_ENABLE_DEVICE_CONTROL="true" \\\n\s*NORNS_LOCAL_AGENT_VERSION=/);
assert.match(launcher, /loaded_agent_is_current/);
assert.match(launcher, /\[ "\$LOADED_AGENT_PROGRAM" = "\$NODE" \]/);
assert.match(launcher, /grep -Fq "\$CLI"/);
assert.match(launcher, /NORNS_LOCAL_AGENT_VERSION => \$AGENT_VERSION/);
assert.match(launcher, /NORNS_ENABLE_DEVICE_EXECUTION => true/);

console.log("macOS Local Agent package has a fixed /Applications destination: OK");
