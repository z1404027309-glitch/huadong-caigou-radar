import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const siteUrl = String(process.env.NOTICE_SITE_URL || "https://huadong-caigou-radar.pages.dev").replace(/\/$/, "");
const output = path.resolve(process.env.MOBILE_OUTPUT || "public/data/mobile-notices.json");
const token = String(process.env.OIDC_TOKEN || "");
const publicOnly = process.env.MOBILE_RESTORE_MODE === "public";

async function getJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { stdout } = await execFileAsync("curl", [
        "--fail", "--silent", "--show-error", "--max-time", "30",
        "-H", `Authorization: Bearer ${token}`, url
      ], { maxBuffer: 64 * 1024 * 1024 });
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

let archive;
let method;
try {
  if (publicOnly) throw new Error("public restore requested");
  if (!token) throw new Error("archive download identity is unavailable");
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
  archive = JSON.parse(parts.join(""));
  if (!Array.isArray(archive.notices) || archive.fetchedAt !== manifest.fetchedAt) {
    throw new Error("mobile archive does not match its manifest");
  }
  method = `${parts.length} chunk(s)`;
} catch (error) {
  console.warn(`Mobile archive chunk restore unavailable: ${error.message}; using the published notices API`);
  const startDate = new Date(Date.now() - (Number(process.env.MOBILE_KEEP_DAYS || 365) + 1) * 86400000).toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);
  const url = `${siteUrl}/api/notices?startDate=${startDate}&endDate=${endDate}`;
  const result = await getJson(url);
  if (!Array.isArray(result.notices) || result.errors?.length || !result.mobileFetchedAt) {
    throw new Error("published notices API did not return a complete Mobile archive");
  }
  const notices = result.notices.filter((item) => item.operator === "中国移动");
  if (!notices.length || new Set(notices.map((item) => String(item.id))).size !== notices.length) {
    throw new Error("published notices API returned an empty or duplicate Mobile archive");
  }
  archive = { fetchedAt: result.mobileFetchedAt, source: "中国移动采购与招标网", notices };
  method = "published notices API";
}

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(archive)}\n`, "utf8");
console.log(`restored ${archive.notices.length} Mobile notices from ${method}`);
