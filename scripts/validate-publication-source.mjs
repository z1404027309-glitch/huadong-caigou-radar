import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const source = String(process.argv[2] || "");
if (!["mobile", "unicom", "tower", "telecom"].includes(source)) {
  throw new Error("usage: node scripts/validate-publication-source.mjs <mobile|unicom|tower|telecom>");
}

const relativePath = `public/data/${source}-notices.json`;
const current = JSON.parse(await fs.readFile(relativePath, "utf8"));
const currentNotices = Array.isArray(current.notices) ? current.notices : [];
let baselineNotices = [];
try {
  const { stdout } = await execFileAsync("git", ["show", `HEAD:${relativePath}`], { maxBuffer: 64 * 1024 * 1024 });
  baselineNotices = JSON.parse(stdout).notices || [];
} catch {
  // A new source archive has no baseline; all records must be publishable.
}

const baselineIds = new Set(baselineNotices.map(noticeId));
const added = currentNotices.filter((item) => !baselineIds.has(noticeId(item)));
const incomplete = added.filter((item) => item.fieldsReady !== true);
if (incomplete.length) {
  console.error(JSON.stringify({
    source,
    status: "pending",
    added: added.length,
    incomplete: incomplete.map((item) => ({ id: noticeId(item), title: item.title || "" }))
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ source, status: "completed", added: added.length }));

function noticeId(item) {
  return String(item?.sourceId || item?.id || item?.url || "");
}
