import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const siteUrl = String(process.env.NOTICE_SITE_URL || "https://huadong-caigou-radar.pages.dev").replace(/\/$/, "");
const output = path.resolve(process.env.MOBILE_OUTPUT || "public/data/mobile-notices.json");
const token = String(process.env.OIDC_TOKEN || "");
if (!token) throw new Error("archive download identity is unavailable");

async function getJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { stdout } = await execFileAsync("curl", [
        "--fail", "--silent", "--show-error", "--max-time", "30",
        "-H", `Authorization: Bearer ${token}`, url
      ], { maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch (error) {
      // execFile errors can include command arguments, including the token.
      const detail = String(error?.stderr || "").trim();
      lastError = new Error(`archive download failed${detail ? `: ${detail}` : ""}`);
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

const base = `${siteUrl}/api/notices/archive?source=mobile`;
const manifest = await getJson(`${base}&manifest=1`);
if (!Number.isInteger(manifest.chunks) || manifest.chunks < 1 || manifest.chunks > 1000) {
  throw new Error("invalid mobile archive manifest");
}

const parts = [];
for (let index = 0; index < manifest.chunks; index++) {
  const chunk = await getJson(`${base}&chunk=${index}`);
  if (chunk.index !== index || typeof chunk.payload !== "string") {
    throw new Error(`invalid mobile archive chunk ${index}`);
  }
  parts.push(chunk.payload);
}

const payload = parts.join("");
const archive = JSON.parse(payload);
if (!Array.isArray(archive.notices) || archive.fetchedAt !== manifest.fetchedAt) {
  throw new Error("mobile archive does not match its manifest");
}
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, payload, "utf8");
console.log(`restored ${archive.notices.length} Mobile notices from ${parts.length} chunk(s)`);
