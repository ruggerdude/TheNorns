import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const html = readFileSync(`${webRoot}/dist/index.html`, "utf8");
const entryScripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((match) => match[1]);
if (entryScripts.length === 0) {
  throw new Error("web build did not emit an entry JavaScript asset");
}

const gzipBytes = entryScripts.reduce((total, asset) => {
  const source = readFileSync(`${webRoot}/dist/${asset.replace(/^\//, "")}`);
  return total + gzipSync(source).byteLength;
}, 0);
const maxEntryJsGzipBytes = 161 * 1024;

if (gzipBytes > maxEntryJsGzipBytes) {
  throw new Error(
    `initial JavaScript is ${(gzipBytes / 1024).toFixed(1)} KiB gzip; ` +
      `budget is ${(maxEntryJsGzipBytes / 1024).toFixed(0)} KiB`,
  );
}

console.log(
  `initial JavaScript ${(gzipBytes / 1024).toFixed(1)} KiB gzip ` +
    `(budget ${(maxEntryJsGzipBytes / 1024).toFixed(0)} KiB)`,
);
