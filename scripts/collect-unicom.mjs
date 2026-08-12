import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { extractDeadline as extractUnifiedDeadline, textAttachmentsFromDetail } from "./lib/deadline-extractor.mjs";

const OUTPUT = path.resolve("public/data/unicom-notices.json");
const PROVINCES = [
  { code: "0033", name: "浙江" },
  { code: "0036", name: "江西" },
  { code: "0035", name: "福建" }
];
const ANNO_TYPES = ["022001", "022002", "022003"];
const KEEP_DAYS = Number(process.env.UNICOM_KEEP_DAYS || 365);
const EXTRACTOR_VERSION = 11;
const CATEGORY_NAMES = { "022001": "采购需求公示", "022002": "招标公告", "022003": "询比公告" };

const browser = await chromium.launch({
  headless: true,
  ...(process.platform === "win32" && process.env.CI !== "true" ? { channel: "msedge" } : {})
});
const context = await browser.newContext({
  locale: "zh-CN",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145 Safari/537.36"
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Debugger.setSkipAllPauses", { skip: true });

try {
  await page.goto("https://www.chinaunicombidding.cn/bidInformation", {
    waitUntil: "networkidle",
    timeout: 90_000
  });

  const summaries = [];
  for (const province of PROVINCES) {
    for (const annoType of ANNO_TYPES) {
      const records = await fetchList(page, province.code, annoType);
      for (const record of records) {
        if (!record?.id) continue;
        summaries.push({ ...record, category: CATEGORY_NAMES[annoType], provinceName: record.provinceName || province.name });
      }
    }
  }

  const unique = [...new Map(summaries.map((item) => [String(item.id), item])).values()];
  const existing = await readArchive();
  const existingById = new Map(existing.notices.map((item) => [String(item.sourceId || item.id), item]));
  const collected = [];

  for (const [index, summary] of unique.entries()) {
    const cached = existingById.get(String(summary.id));
    if (cached?.fieldsReady && cached.extractorVersion === EXTRACTOR_VERSION) {
      collected.push({ ...cached, ...summaryToBase(summary) });
      continue;
    }
    console.log(`[${index + 1}/${unique.length}] ${summary.provinceName} ${summary.annoName}`);
    try {
      const detail = await fetchDetail(page, summary.id, summary.annoType);
      collected.push(toNotice(summary, detail));
    } catch (error) {
      console.warn(`detail failed ${summary.id}: ${error.message}`);
      collected.push({ ...summaryToBase(summary), fieldsReady: false });
    }
  }

  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const merged = [...existing.notices, ...collected]
    .filter((item) => !item.date || item.date >= cutoff);
  const notices = [...new Map(merged.map((item) => [String(item.id), item])).values()]
    .map(sanitizeNotice)
    .sort((a, b) => `${b.date} ${b.createDate || ""}`.localeCompare(`${a.date} ${a.createDate || ""}`));

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, `${JSON.stringify({
    fetchedAt: new Date().toISOString(),
    source: "中国联通采购与招标网",
    notices
  }, null, 2)}\n`, "utf8");
  console.log(`saved ${notices.length} notices to ${OUTPUT}`);
} finally {
  await browser.close();
}

async function fetchList(page, provinceCode, annoType) {
  const first = await page.evaluate(async ({ provinceCode, annoType }) => {
    const response = await fetch("/api/v1/bizAnno/getAnnoList", {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=UTF-8" },
      body: JSON.stringify({
        pageNo: 1,
        pageSize: 100,
        modeNo: "BizAnnoVoMtable",
        annoType,
        provinceCode,
        tenderingType: "1"
      })
    });
    return response.json();
  }, { provinceCode, annoType });
  if (!first?.success) throw new Error(first?.message || "list request failed");
  const records = [...(first.data?.records || [])];
  const pages = Math.min(Number(first.data?.pages || 1), 10);
  for (let pageNo = 2; pageNo <= pages; pageNo++) {
    const next = await page.evaluate(async ({ provinceCode, annoType, pageNo }) => {
      const response = await fetch("/api/v1/bizAnno/getAnnoList", {
        method: "POST",
        headers: { "Content-Type": "application/json;charset=UTF-8" },
        body: JSON.stringify({
          pageNo,
          pageSize: 100,
          modeNo: "BizAnnoVoMtable",
          annoType,
          provinceCode,
          tenderingType: "1"
        })
      });
      return response.json();
    }, { provinceCode, annoType, pageNo });
    records.push(...(next.data?.records || []));
  }
  return records;
}

async function fetchDetail(page, id, annoType) {
  if (annoType === "022001") {
    const waiting = page.waitForResponse((response) => response.url().includes("/getAnnoReAnno"), { timeout: 30000 });
    await page.goto(`https://www.chinaunicombidding.cn/bidInformation/detail?id=${id}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    const payload = await (await waiting).json();
    return payload?.data || { annoText: await page.locator("body").innerHTML() };
  }
  const payload = await page.evaluate(async (noticeId) => {
    const response = await fetch(`/api/v1/bizAnno/getAnnoDetailed/${noticeId}`);
    return response.json();
  }, String(id));
  if (!payload?.success || !payload.data) throw new Error(payload?.message || "detail request failed");
  return payload.data;
}

function isProcurementNotice(item) {
  const text = `${item.annoType || ""} ${item.annoName || ""}`;
  return /招标公告|询比公告|谈判公告|采购公告/.test(text)
    && !/结果|候选人|中标|中选|失败|终止|变更|公示|招募|征集.*意见/.test(text);
}

function isArchivedProcurement(item) {
  return !/结果|候选人|中标|中选|失败|终止|变更|公示|招募|征集.*意见/.test(item.title || "");
}

function toNotice(summary, detail) {
  const html = detail.annoText || "";
  const fields = extractFields(html, summary);
  return {
    ...summaryToBase({ ...summary, ...detail }),
    ...fields,
    fieldsReady: true,
    extractorVersion: EXTRACTOR_VERSION
  };
}

function summaryToBase(item) {
  const id = String(item.id || "");
  return {
    id: `unicom-${id}`,
    sourceId: id,
    operator: "中国联通",
    sourceName: "中国联通采购与招标网",
    title: item.annoName || "未命名采购公告",
    region: item.provinceName || "",
    date: String(item.createDate || "").slice(0, 10),
    createDate: item.createDate || "",
    projectNo: item.projectNo || "",
    bidNo: item.bidNo || "",
    noticeType: item.annoType || "",
    category: item.category || CATEGORY_NAMES[item.annoType] || "采购公告",
    saleTime: formatRange(item.annoStartDate, item.tenderEndDate),
    deadline: formatDateTime(item.replyEndTime),
    url: `https://www.chinaunicombidding.cn/bidInformation/detail?id=${id}`
  };
}

function extractFields(html, summary) {
  const blocks = htmlBlocks(html);
  const text = blocks.join("\n");
  const deadlineFields = extractUnifiedDeadline({
    structuredValues: summary.replyEndTime ? [{ value: summary.replyEndTime, source: "详情接口.replyEndTime" }] : [],
    html,
    attachmentTexts: textAttachmentsFromDetail(summary)
  });
  return {
    purchaseContent: extractPurchaseContent(html, blocks),
    budget: extractBudget(text),
    saleTime: formatRange(summary.annoStartDate, summary.tenderEndDate)
      || extractTimeRange(text, /(?:采购|询比|招标)文件(?:获取|售卖|发售)/),
    ...deadlineFields,
    qualification: extractOneParagraph(blocks, /应答人(?:基本)?资格|供应商资格|投标人资格/),
    performance: extractOneParagraph(blocks, /业绩要求|业绩资格|同类项目业绩/)
      || "公告资格条款中未单列业绩要求"
  };
}

function extractPurchaseContent(html, blocks) {
  const index = blocks.findIndex((line) =>
    /(?:采购内容|项目需求|招标内容)(?:[:：]|$)/.test(line) && !/概况与采购内容/.test(line)
  );
  if (index >= 0) {
    const line = blocks[index].replace(/^.*?(?:采购内容|项目需求|招标内容)(?:[:：])?\s*/, "");
    if (line.length >= 6) return cleanPurchaseContent(line);
    const next = blocks.slice(index + 1, index + 3)
      .find((value) => value.length >= 6 && !/^(?:\d+(?:\.\d+)+|[一二三四五六七八九十]+[、.])/.test(value));
    if (next) return cleanPurchaseContent(next);
  }

  const overviewIndex = blocks.findIndex((line) => /(?:项目概况|项目概述)(?:[:：]|$)/.test(line));
  if (overviewIndex >= 0) {
    const sameLine = blocks[overviewIndex].replace(/^.*?(?:项目概况|项目概述)(?:[:：])?\s*/, "");
    const overview = sameLine.length >= 6 ? sameLine : blocks.slice(overviewIndex + 1, overviewIndex + 4)
      .find((value) => value.length >= 6 && !/^(?:\d+(?:\.\d+)+|[一二三四五六七八九十]+[、.])/.test(value));
    if (overview) return overview
      .replace(/[，,。；;]?\s*(?:采购预算|项目预算|预估金额|预算金额|最高限价).*$/u, "")
      .trim()
      .slice(0, 400);
  }

  const tables = [...html.matchAll(/<table\b[\s\S]*?<\/table>/gi)];
  for (const match of tables) {
    const rows = [...match[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)]
      .map((row) => [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((cell) => htmlText(cell[1])));
    if (!rows.length) continue;
    const header = rows[0];
    const productIndex = header.findIndex((value) => /采购内容|产品或服务名称|产品名称|项目名称|需求描述/.test(value));
    const quantityIndex = header.findIndex((value) => /数量|需求数量/.test(value));
    const unitIndex = header.findIndex((value) => /单位/.test(value));
    if (productIndex < 0 || quantityIndex < 0) continue;
    const values = rows.slice(1).map((row) => {
      const product = row[productIndex];
      const quantity = row[quantityIndex];
      const unit = unitIndex >= 0 ? row[unitIndex] : "";
      return product && quantity ? `${product}，数量${quantity}${unit}` : "";
    }).filter(Boolean);
    if (values.length) return values.join("；").slice(0, 400);
  }
  return "公告未明确列示";
}

function extractBudget(text) {
  const lines = text.split("\n");
  for (const line of lines) {
    if (!/预算|最高(?:应答|投标)?限价/.test(line)) continue;
    const untaxed = line.match(/(?:不含税)[^0-9]{0,25}([0-9][\d,.]*)\s*(亿元|万元|元)/)
      || line.match(/([0-9][\d,.]*)\s*(亿元|万元|元)[^。\n]{0,20}(?:不含税)/);
    if (untaxed) return `${untaxed[1]}${untaxed[2]}`;
    const amount = line.match(/([0-9][\d,.]*)\s*(亿元|万元|元)/);
    if (amount) return `${amount[1]}${amount[2]}`;
  }
  return "公告未明确列示";
}

function cleanPurchaseContent(value) {
  return String(value || "")
    .replace(/[，,。；;]?\s*(?:具体需求)?内容如下\s*[：:]?\s*(?:序号)?[\s\S]*$/u, "")
    .replace(/[，,。；;]?\s*(?:预算金额|项目预算|采购预算|总价最高限价)\s*(?:含税|不含税)?[\s\S]*$/u, "")
    .trim()
    .slice(0, 400);
}

function extractOneParagraph(blocks, label) {
  const index = blocks.findIndex((line) => label.test(line));
  if (index < 0) return "公告未明确列示";
  const heading = blocks[index].trim();
  const headingOnly = isQualificationHeading(heading);
  const same = heading.replace(/^.*?(?:要求|资格)[:：]?\s*/, "");
  if (!headingOnly && same.length >= 12) return same.slice(0, 700);
  const next = blocks.slice(index + 1, index + 4)
    .find((line) => line.length >= 12 && !isQualificationHeading(line) && !/^(?:\d+\.)?\d+\s*$/.test(line));
  return next?.slice(0, 700) || "公告未明确列示";
}

function isQualificationHeading(value) {
  return /^(?:\d+(?:\.\d+)*\s*)?(?:应答人|供应商|投标人)?(?:基本)?资格要求$/.test(String(value || "").trim());
}

function sanitizeNotice(item) {
  const cleaned = { ...item };
  for (const key of ["purchaseContent", "qualification", "performance"]) {
    let value = htmlText(cleaned[key] || "")
      .replace(/<.*$/, "")
      .replace(/(?:mso-[\w-]+|font-family|font-size|letter-spacing|line-height)\s*:[^;\n]+;?/gi, " ")
      .replace(/^[^\u4e00-\u9fff\d]*[>\"]+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!value || (key === "qualification" && (isQualificationHeading(value) || /^(?:要求|资格)$/.test(value)))) value = "公告未明确列示";
    cleaned[key] = value.slice(0, 700);
  }
  return cleaned;
}

function extractTimeRange(text, label) {
  const line = text.split("\n").find((value) => label.test(value));
  if (!line) return "";
  const dates = line.match(/20\d{2}[年/-]\d{1,2}[月/-]\d{1,2}日?(?:\s*\d{1,2}[:时]\d{2}(?:分)?)?/g);
  return dates?.join("至") || "";
}

function htmlBlocks(html) {
  return String(html || "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .split("\n")
    .map(htmlText)
    .filter(Boolean);
}

function htmlText(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatRange(start, end) {
  const left = formatDateTime(start);
  const right = formatDateTime(end);
  return left && right ? `${left}至${right}` : left || right;
}

function formatDateTime(value) {
  return String(value || "").replace(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/,
    "$1年$2月$3日$4时$5分"
  );
}

async function readArchive() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT, "utf8"));
  } catch {
    return { notices: [] };
  }
}
