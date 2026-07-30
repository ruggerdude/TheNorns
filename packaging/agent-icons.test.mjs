import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

const infoPlist = readFileSync(new URL("./macos/Info.plist.in", import.meta.url), "utf8");
const macPackager = readFileSync(
  new URL("../scripts/package-macos-agent.sh", import.meta.url),
  "utf8",
);
const windowsDefinition = readFileSync(
  new URL("./windows/NornsLocalAgent.iss", import.meta.url),
  "utf8",
);
const windowsPackager = readFileSync(
  new URL("../scripts/package-windows-agent.ps1", import.meta.url),
  "utf8",
);
const windowsIcon = new URL("./windows/NornsLocalAgent.ico", import.meta.url);

assert.match(infoPlist, /<key>CFBundleIconFile<\/key>\s*<string>NornsLocalAgent\.icns<\/string>/);
assert.match(macPackager, /apps\/web\/public\/favicon\.svg/);
assert.match(macPackager, /iconutil -c icns/);
assert.match(windowsDefinition, /SetupIconFile=.*NornsLocalAgent\.ico/);
assert.match(windowsDefinition, /UninstallDisplayIcon=\{app\}\\NornsLocalAgent\.ico/);
assert.match(windowsDefinition, /IconFilename: "\{app\}\\NornsLocalAgent\.ico"/);
assert.match(windowsPackager, /packaging\\windows\\NornsLocalAgent\.ico/);
assert.ok(statSync(windowsIcon).size > 1_000, "Windows agent icon must not be empty");

console.log("local-agent application icons: OK");
