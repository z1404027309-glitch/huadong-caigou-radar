import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const archivePath = path.resolve(process.env.MOBILE_OUTPUT || "public/data/mobile-notices.json");
const siteUrl = process.env.RECOGNIZER_SITE_URL || "https://huadong-caigou.z1404027309.chatgpt.site";
const days = Number(process.env.BROWSER_RECOGNIZE_DAYS || 31);
const province = String(process.env.BROWSER_RECOGNIZE_PROVINCE || "").trim();
const titleFilter = String(process.env.BROWSER_RECOGNIZE_TITLE || "").trim();
const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const archive = JSON.parse(await fs.readFile(archivePath, "utf8"));
const notices = Array.isArray(archive.notices) ? archive.notices : [];
const candidates = notices.filter((item) =>
  item.publishId && item.publishUuid
  && (!item.date || item.date >= cutoff)
  && (!province || item.region === province)
  && (!titleFilter || String(item.title || "").includes(titleFilter))
  && (item.fieldsReady !== true || !item.deadline || item.deadlineStatus !== "recognized")
);

console.log(`browser recognizer: ${candidates.length} candidate(s), cutoff=${cutoff}`);
if (!candidates.length) process.exit(0);

const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
});
let completed = 0;
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  page.on("console", (message) => {
    if (message.type() === "error") console.warn(`browser console: ${message.text()}`);
  });
  await page.goto(siteUrl, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(() => typeof window.__HUADONG_RECOGNIZE_NOTICE__ === "function", null, { timeout: 180000 });

  for (const item of candidates) {
    console.log(`browser recognizing ${item.sourceId}: ${item.title}`);
    const result = await page.evaluate(async (notice) => window.__HUADONG_RECOGNIZE_NOTICE__(notice, true), item);
    const deadline = result.deadline === "公告未单独列示" ? "" : String(result.deadline || "");
    const websiteBudget = result.budget === "公告未明确列示" ? "" : String(result.budget || "");
    const budget = websiteBudget || String(item.budget || "");
    Object.assign(item, result, {
      deadline,
      budget,
      deadlineStatus: deadline ? "recognized" : "not_found",
      deadlineEvidence: deadline,
      deadlineSource: result.method === "ocr" ? "网站 PaddleOCR" : "网站 PDF 文字",
      fieldsReady: true,
      recognizer: "website-browser",
      recognizedAt: new Date().toISOString()
    });
    completed += 1;
  }
} finally {
  await browser.close();
}

archive.fetchedAt = new Date().toISOString();
await fs.writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
console.log(`browser recognizer completed ${completed}/${candidates.length}`);
