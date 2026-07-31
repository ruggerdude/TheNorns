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
assert.match(signer, /--keychain "\$KEYCHAIN"/);
assert.match(signer, /security find-identity -v "\$KEYCHAIN"/);
assert.equal(
  signer.match(/-T \/usr\/bin\/codesign -T \/usr\/bin\/pkgbuild -T \/usr\/bin\/productsign/g)
    ?.length,
  2,
);
assert.match(launcher, /<key>NORNS_ENABLE_DEVICE_CONTROL<\/key><string>true<\/string>/);
assert.match(launcher, /NORNS_ENABLE_DEVICE_CONTROL="true" \\\n\s*NORNS_LOCAL_AGENT_VERSION=/);

console.log("macOS Local Agent package has a fixed /Applications destination: OK");
