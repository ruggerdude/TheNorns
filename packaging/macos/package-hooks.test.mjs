import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const preinstall = readFileSync(new URL("./package-scripts/preinstall", import.meta.url), "utf8");
const postinstall = readFileSync(new URL("./package-scripts/postinstall", import.meta.url), "utf8");
const labels = [
  "com.thenorns.local-agent",
  "com.thenorns.local-agent-menubar",
  "com.thenorns.runner",
  "app.thenorns.runner",
];

// Two concurrently loaded GUI users must both survive an upgrade. A third
// user's configured-but-stopped plist must remain stopped.
const fixture = [
  {
    uid: 501,
    home: "/Users/alice",
    loaded: new Set(["com.thenorns.local-agent"]),
    configured: new Set(["com.thenorns.local-agent"]),
  },
  {
    uid: 502,
    home: "/Users/bob",
    loaded: new Set(["app.thenorns.runner"]),
    configured: new Set(["app.thenorns.runner"]),
  },
  {
    uid: 503,
    home: "/Users/carol",
    loaded: new Set(),
    configured: new Set(["com.thenorns.runner"]),
  },
];
const restartRecords = fixture.flatMap((user) =>
  labels
    .filter((label) => user.loaded.has(label) && user.configured.has(label))
    .map((label) => `${user.uid}\t${user.home}\t${label}`),
);
assert.deepEqual(restartRecords, [
  "501\t/Users/alice\tcom.thenorns.local-agent",
  "502\t/Users/bob\tapp.thenorns.runner",
]);

for (const label of labels) {
  assert.match(preinstall, new RegExp(label.replaceAll(".", String.raw`\.`)));
  assert.match(postinstall, new RegExp(label.replaceAll(".", String.raw`\.`)));
}
assert.match(preinstall, /dscl \. -list \/Users UniqueID >"\$USER_LIST"/);
assert.match(preinstall, /done <"\$USER_LIST"/);
assert.match(preinstall, /launchctl print "\$TARGET"/);
assert.match(preinstall, /launchctl bootout "gui\/\$USER_ID\/\$SERVICE_LABEL"/);
assert.match(preinstall, /while \/bin\/launchctl print "gui\/\$USER_ID\/\$SERVICE_LABEL"/);
assert.match(preinstall, /ATTEMPT=\$\(\(ATTEMPT \+ 1\)\)/);
assert.match(preinstall, /"\$ATTEMPT" -ge 20/);
assert.match(preinstall, /\/bin\/sleep 1/);
assert.match(preinstall, /did not stop before upgrade/);
assert.match(preinstall, /stat -f '%u'/);
assert.match(postinstall, /restart-records/);
assert.match(postinstall, /launchctl bootstrap "gui\/\$USER_ID"/);
assert.match(postinstall, /launchctl kickstart "gui\/\$USER_ID\/\$SERVICE_LABEL"/);
assert.doesNotMatch(preinstall, /\/dev\/console/);

console.log("macOS two-GUI-user upgrade fixture: OK");
