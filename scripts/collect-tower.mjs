import fs from "node:fs/promises";
import path from "node:path";
import { extractDeadline as extractUnifiedDeadline, textAttachmentsFromDetail } from "./lib/deadline-extractor.mjs";

const OUTPUT = path.resolve("public/data/tower-notices.json");
const API = "http://www.tower.com.cn/supportal/v1";
const PROVINCES = [
  { code: "330000", name: "浙江" },
  { code: "360000", name: "江西" },
  { code: "350000", name: "福建" }
];
const KEEP_DAYS = Number(process.env.TOWER_KEEP_DAYS || 365);
const EXTRACTOR_VERSION = 11;
const NOTICE_CATEGORIES = [{ category: "采购公告", body: { purchaseNoticeType: "2", excludeNoticeType: "49" } }, { category: "采购项目预公告", body: { purchaseNoticeType: "2", noticeType: "49" } }];

const existing = await readArchive();
const existingById = new Map(existing.notices.map((item) => [String(item.sourceId || item.id), item]));
const collected = [];

for (const province of PROVINCES) {
 for (const noticeConfig of NOTICE_CATEGORIES) {
  const payload = await post("/obp-notice/query-notice", {
    ...noticeConfig.body,
    provAdmCode: province.code,
    current: 1,
    size: 100
  });
  const records = payload.data?.records || [];
  for (const [index, summary] of records.entries()) {
    summary.category = noticeConfig.category;
    const cached = existingById.get(String(summary.noticeId));
    if (cached?.fieldsReady && cached.extractorVersion === EXTRACTOR_VERSION) {
      collected.push({ ...cached, ...summaryToBase(summary, province.name) });
      continue;
    }
    console.log(`[${province.name} ${index + 1}/${records.length}] ${summary.noticeTitle}`);
    try {
      const detail = await post("/obp-notice/get-notice-by-id", { id: summary.noticeId });
      collected.push(toNotice(summary, detail.data || {}, province.name));
    } catch (error) {
      console.warn(`detail failed ${summary.noticeId}: ${error.message}`);
      collected.push({ ...summaryToBase(summary, province.name), fieldsReady: false });
    }
  }
 }
}

const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
const notices = [...new Map([...existing.notices, ...collected]
  .filter((item) => !item.date || item.date >= cutoff)
  .map((item) => [String(item.id), sanitizeNotice(item)]))
  .values()]
  .sort((a, b) => `${b.date} ${b.createDate || ""}`.localeCompare(`${a.date} ${a.createDate || ""}`));

await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
await fs.writeFile(OUTPUT, `${JSON.stringify({
  fetchedAt: new Date().toISOString(),
  source: "中国铁塔在线商务平台",
  notices
}, null, 2)}\n`, "utf8");
console.log(`saved ${notices.length} notices to ${OUTPUT}`);

async function post(endpoint, body) {
  const response = await fetch(`${API}${endpoint}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: "http://www.tower.com.cn",
      referer: "http://www.tower.com.cn/",
      "user-agent": "Mozilla/5.0"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${endpoint} ${response.status}`);
  const payload = await response.json();
  if (payload.resultStat !== "000") throw new Error(payload.mess || payload.message || "request failed");
  return payload;
}

function isProcurementNotice(item) {
  const text = `${item.noticeTitle || ""} ${item.purchaseNoticeType || ""}`;
  return String(item.purchaseNoticeType) === "2"
    && /公告/.test(text)
    && !/候选人|结果|中标|中选|失败|终止|变更|公示|预公示/.test(text);
}

function isArchivedProcurement(item) {
  return !/候选人|结果|中标|中选|失败|终止|变更|公示|预公示/.test(item.title || "");
}

function toNotice(summary, detail, region) {
  const html = detail.noticeContent || "";
  const blocks = htmlBlocks(html);
  const deadlineFields = extractUnifiedDeadline({
    structuredValues: structuredDeadlineValues(detail),
    html,
    attachmentTexts: textAttachmentsFromDetail(detail)
  });
  return sanitizeNotice({
    ...summaryToBase({ ...summary, ...detail }, region),
    purchaseContent: extractPurchaseContent(html, blocks),
    budget: extractBudget(blocks),
    saleTime: extractTowerTime(blocks, "sale"),
    ...deadlineFields,
    qualification: extractQualification(blocks),
    performance: extractPerformance(blocks),
    fieldsReady: true,
    extractorVersion: EXTRACTOR_VERSION
  });
}

function structuredDeadlineValues(detail) {
  return ["replyEndTime", "responseEndTime", "bidEndTime", "tenderEndTime", "deadline"]
    .map((key) => detail?.[key] ? { value: detail[key], source: `详情接口.${key}` } : null)
    .filter(Boolean);
}

function summaryToBase(item, region) {
  const id = String(item.noticeId || "");
  return {
    id: `tower-${id}`,
    sourceId: id,
    operator: "中国铁塔",
    sourceName: "中国铁塔在线商务平台",
    title: item.noticeTitle || "未命名采购公告",
    region,
    date: String(item.publicationTimeStr || item.createTime || "").slice(0, 10),
    createDate: item.publicationTimeStr || item.createTime || "",
    noticeType: item.noticeType || "",
    category: item.category || (String(item.noticeType) === "49" ? "采购项目预公告" : "采购公告"),
    projectNo: item.noticeNum || "",
    url: `http://www.tower.com.cn/#/noticeDetail?id=${id}`
  };
}

function extractPurchaseContent(html, blocks) {
  const contentIndex = blocks.findIndex((line) => /(?:采购内容|采购需求概况及规模|采购需求概况)[:：]/.test(line.replace(/\s+/g, "")));
  if (contentIndex >= 0) {
    const sameLine = blocks[contentIndex]
      .replace(/^.*?(?:采购内容|采购需求概况及规模|采购需求概况)[:：]\s*/, "")
      .replace(/[，,。；;]?\s*(?:项目预算|采购预算|预算金额|总价最高限价|不含税|含税).*$/u, "")
      .trim();
    if (sameLine.length >= 2) return sameLine.slice(0, 400);
    const nextLine = blocks.slice(contentIndex + 1, contentIndex + 3)
      .find((line) => line.length >= 2 && !isHeading(line));
    if (nextLine) return nextLine.slice(0, 400);
  }

  const overview = findLabeledParagraph(blocks, /采购项目概况[:：]?/);
  if (overview) return overview
    .replace(/[，,。；;]?\s*(?:不含税|含税)(?:总)?(?:预算|总价).*$/u, "")
    .trim()
    .slice(0, 400);

  const tables = [...String(html || "").matchAll(/<table\b[\s\S]*?<\/table>/gi)];
  for (const match of tables) {
    const rows = [...match[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((row) =>
      [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => htmlText(cell[1]))
    );
    if (!rows.length) continue;
    const header = rows[0];
    const productIndex = header.findIndex((value) => /采购内容|服务名称|产品名称|货物名称|项目名称/.test(value));
    const quantityIndex = header.findIndex((value) => /预估数量|采购数量|需求数量|数量/.test(value));
    const unitIndex = header.findIndex((value) => /单位/.test(value));
    if (productIndex < 0) continue;
    const values = rows.slice(1).map((row) => {
      const product = row[productIndex];
      const quantity = quantityIndex >= 0 ? row[quantityIndex] : "";
      const unit = unitIndex >= 0 ? row[unitIndex] : "";
      return product ? `${product}${quantity ? `，数量${quantity}${unit}` : ""}` : "";
    }).filter(Boolean);
    if (values.length) return values.join("；").slice(0, 400);
  }
  return "公告未明确列示";
}

function extractBudget(blocks) {
  for (const line of blocks) {
    const compact = line.replace(/\s+/g, "");
    if (!/采购预算|项目预算|预算金额|总价最高限价|最高限价|不含税(?:总)?预算|不含税总价/.test(compact)) continue;
    const total = compact.match(/不含税总价(?:为|是|[:：])?([0-9][\d,.]*)\s*(亿元|万元|元)/);
    if (total) return `${total[1]}${total[2]}`;
    const nonTax = compact.match(/不含税(?:总)?预算(?:为|是|[:：])?([0-9][\d,.]*)\s*(亿元|万元|元)/);
    if (nonTax) return `${nonTax[1]}${nonTax[2]}`;
    const tail = compact.replace(/^.*?(?:总价最高限价|最高限价|采购预算|项目预算|预算金额)[:：]?/, "");
    const amount = tail.match(/([0-9][\d,.]*)\s*(亿元|万元|元)/);
    if (amount) return `${amount[1]}${amount[2]}`;
  }
  return "公告未明确列示";
}

function extractTowerTime(blocks, kind) {
  const text = blocks.join(" ").replace(/\s+/g, "");
  const date = "20\\d{2}年\\d{1,2}月\\d{1,2}日(?:\\d{1,2}时(?:\\d{1,2}分)?)?";
  const label = kind === "sale"
    ? "(?:(?:采购|比选|询价|招标)文件(?:的)?(?:获取|发售|售卖)时间|文件发售时间)"
    : "(?:(?:响应|应答|投标)文件(?:的)?(?:递交|提交)截止时间|(?:响应|应答|投标)截止时间)";
  // Requiring “为/：” plus an absolute date prevents qualification clauses such
  // as “自响应文件递交截止时间前36个月” from being mistaken for the real deadline.
  const match = text.match(new RegExp(`${label}(?:（即(?:响应|应答|投标)截止时间）)?(?:为|是)?[:：]?【?(${date})(?:(?:至|到)(${date}))?`));
  if (!match) return "公告未明确列示";
  return match[2] ? `${match[1]}至${match[2]}` : match[1];
}

function extractQualification(blocks) {
  const start = blocks.findIndex((line) => /供应商资格要求|参选人资格要求|应答人资格要求|资格要求/.test(line));
  if (start < 0) return "公告未明确列示";
  const next = blocks.slice(start + 1, start + 6).find((line) =>
    line.length >= 16 && !isHeading(line)
  );
  return next?.slice(0, 700) || "公告未明确列示";
}

function extractPerformance(blocks) {
  const line = blocks.find((value) => /业绩要求|同类项目业绩|类似项目业绩|业绩证明/.test(value));
  if (!line) return "公告资格条款中未单列业绩要求";
  return line.slice(0, 700);
}

function findLabeledParagraph(blocks, label) {
  const index = blocks.findIndex((line) => label.test(line));
  if (index < 0) return "";
  const same = blocks[index].replace(/^.*?采购项目概况[:：]?\s*/, "");
  if (same.length >= 8) return same;
  return blocks.slice(index + 1, index + 3).find((line) => line.length >= 8 && !isHeading(line)) || "";
}

function isHeading(value) {
  return /^(?:\d+(?:\.\d+)*[.、]?\s*)?(?:采购项目简介|采购范围及相关要求|供应商资格要求|参选人资格要求|应答人资格要求|资格要求)$/.test(String(value || "").trim());
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

function sanitizeNotice(item) {
  const result = { ...item };
  for (const key of ["purchaseContent", "qualification", "performance"]) {
    let value = htmlText(result[key] || "").replace(/<.*$/, "").replace(/\s+/g, " ").trim();
    if (!value || (key === "qualification" && isHeading(value))) value = "公告未明确列示";
    result[key] = value.slice(0, 700);
  }
  return result;
}

async function readArchive() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT, "utf8"));
  } catch {
    return { notices: [] };
  }
}
