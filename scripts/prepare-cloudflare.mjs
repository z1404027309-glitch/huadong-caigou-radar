import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

fs.copyFileSync("server/index.js", "out/_worker.js");

for (const file of walk("out")) {
  if (!/ort-wasm-simd-threaded\.jsep\..+\.wasm$/.test(file)) continue;
  const input = fs.readFileSync(file);
  fs.writeFileSync(file, zlib.gzipSync(input, { level: 9 }));
}

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(fullPath);
    else yield fullPath;
  }
}
