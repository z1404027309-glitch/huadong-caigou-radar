import fs from "node:fs/promises";
import path from "node:path";

const OUTPUT = path.resolve("public/data/telecom-notices.json");
const LIST_API = "https://caigou.chinatelecom.com.cn/portal/base/announcementJoin/queryListNew";
const DETAIL_API = "https://caigou.chinatelecom.com.cn/portal/base/tenderannouncement/view";
const PROVINCES = [
  { code: "02", name: "浙江" },
  { code: "23", name: "江西" },
  { code: "22", name: "福建" }
];
const KEEP_DAYS = Number(process.env.TELECOM_KEEP_DAYS || 365);
const EXTRACTOR_VERSION = 10;
const NOTICE_TYPES = [{ type: "xi9s", category: "资格预审公告" }, { type: "e2no", category: "招标公告" }, { type: "e3erht", category: "询比公告" }];

const existing = await readArchive();
const existingById = new Map(existing.notices.map((item) => [String(item.sourceId || item.id), item]));
const collected = [];
const summaries = [];

for (const province of PROVINCES) {
 for (const noticeConfig of NOTICE_TYPES) {
  for (let pageNum = 1; pageNum <= 10; pageNum++) {
    const payload = await post(LIST_API, {
      pageNum,
      pageSize: 10,
      type: noticeConfig.type,
      provinceCode: province.code,
      noticeSummary: ""
    });
    const records = payload.data?.pageInfo?.list || [];
    if (!records.length) break;
    summaries.push(...records.map((summary) => ({ summary: { ...summary, category: noticeConfig.category }, region: province.name })));
    if (records.length < 10) break;
  }
 }
}

for (let offset = 0; offset < summaries.length; offset += 8) {
  const batch = summaries.slice(offset, offset + 8);
  const results = await Promise.all(batch.map(async ({ summary, region }) => {
    const sourceId = String(summary.docId || summary.id);
    const cached = existingById.get(sourceId);
    if (cached?.fieldsReady && cached.extractorVersion === EXTRACTOR_VERSION) {
      return { ...cached, ...summaryToBase(summary, region) };
    }
    console.log(`[${offset + 1}-${Math.min(offset + 8, summaries.length)}/${summaries.length}] ${summary.docTitle}`);
    try {
      const detail = await post(DETAIL_API, {
        type: summary.docTypeCode,
        id: summary.docId,
        securityViewCode: summary.securityViewCode
      });
      return toNotice(summary, detail.data || {}, region);
    } catch (error) {
      console.warn(`detail failed ${sourceId}: ${error.message}`);
      return { ...summaryToBase(summary, region), fieldsReady: false };
    }
  }));
  collected.push(...results);
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
  source: "中国电信阳光采购网",
  notices
}, null, 2)}\n`, "utf8");
console.log(`saved ${notices.length} notices to ${OUTPUT}`);

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json;charset=UTF-8",
      origin: "https://caigou.chinatelecom.com.cn",
      referer: "https://caigou.chinatelecom.com.cn/search",
      "user-agent": "Mozilla/5.0"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${response.status}`);
  const payload = await response.json();
  if (payload.code !== 200) throw new Error(payload.msg || "request failed");
  return payload;
}

function isProcurementNotice(item) {
  const title = item.docTitle || "";
  return !item.isCancel
    && /公告/.test(title)
    && !/结果|中选候选人|中标候选人|中选人|中标人|终止|失败|流标|废标|变更|公示/.test(title);
}

function isArchivedProcurement(item) {
  return !/结果|中选候选人|中标候选人|中选人|中标人|终止|失败|流标|废标|变更|公示/.test(item.title || "");
}

function toNotice(summary, detail, region) {
  const packageHtml = Array.isArray(detail.listPackage)
    ? detail.listPackage.map((item) => item?.packageContent || "").filter(Boolean).join("\n")
    : "";
  const html = detail.context || packageHtml;
  const blocks = htmlBlocks(html);
  return sanitizeNotice({
    ...summaryToBase(summary, region),
    title: detail.tenderAnnouncementName || summary.docTitle || "未命名采购公告",
    projectNo: detail.tenderAnnouncementCode || summary.docCode || "",
    purchaseContent: extractPurchaseContent(html, blocks),
    budget: extractBudget(blocks),
    saleTime: formatDateRange(detail.sellDateFrom, detail.sellDateTo) || extractTime(blocks, "sale"),
    deadline: extractDeadline(html, blocks),
    qualification: extractQualification(blocks),
    performance: extractPerformance(blocks),
    fieldsReady: true,
    extractorVersion: EXTRACTOR_VERSION
  });
}

function extractDeadline(html, blocks) {
  const fromBlocks = extractTime(blocks, "deadline");
  if (fromBlocks !== "公告未明确列示") return fromBlocks;
  const text = htmlText(html)
    .replace(/(?<=\d)\s+(?=\d)/g, "")
    .replace(/\s+/g, " ");
  const match = text.match(/(?:应答|响应)(?:文件(?:递交|提交)?)?截止时间[^0-9]{0,30}(20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日(?:\s*\d{1,2}\s*时\s*\d{1,2}\s*分)?|20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/);
  return match?.[1]?.replace(/\s+/g, "") || "公告未明确列示";
}

function formatDateRange(from, to) {
  if (!from || !to) return "";
  const format = (value) => {
    const match = String(value).match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})/);
    if (!match) return String(value);
    return `${match[1]}年${match[2].padStart(2, "0")}月${match[3].padStart(2, "0")}日${match[4].padStart(2, "0")}时${match[5]}分`;
  };
  return `${format(from)}至${format(to)}`;
}

function summaryToBase(item, region) {
  const sourceId = String(item.docId || item.id || "");
  const type = item.docTypeCode || "CompareSelect";
  const securityViewCode = item.securityViewCode || "";
  return {
    id: `telecom-${sourceId}`,
    sourceId,
    operator: "中国电信",
    sourceName: "中国电信阳光采购网",
    title: item.tenderAnnouncementName || item.docTitle || "未命名采购公告",
    region,
    date: String(item.createDate || item.updateTime || "").slice(0, 10),
    createDate: item.createDate || item.updateTime || "",
    noticeType: item.docType || type,
    category: item.category || "询比公告",
    projectNo: item.tenderAnnouncementCode || item.docCode || "",
    url: `https://caigou.chinatelecom.com.cn/DeclareDetails?id=${sourceId}&type=3&docTypeCode=${encodeURIComponent(type)}&securityViewCode=${encodeURIComponent(securityViewCode)}`
  };
}

function extractPurchaseContent(html, blocks) {
  const labeled = findBlock(blocks, /(?:采购内容|采购范围)[:：]/, true);
  if (labeled && !/合同有效期|有效期为/.test(labeled)) return trimField(labeled);
  const overviewIndex = blocks.findIndex((line) => /\d+(?:\.\d+)*\s*项目概况[:：]?/.test(line));
  if (overviewIndex >= 0) {
    const sameLine = blocks[overviewIndex].replace(/^.*?项目概况[:：]?\s*/, "");
    if (sameLine.length >= 18 && !/合同有效期|有效期为/.test(sameLine) && !/^(?:本项目)?(?:购买|采购)服务[。.]?$/.test(sameLine)) return trimField(sameLine);
    const value = blocks.slice(overviewIndex + 1, overviewIndex + 6).find((line) =>
      line.length >= 12 && !isHeading(line) && !/技术.*详见|非设备采购|合同有效期|有效期为/.test(line)
    );
    if (value) return trimField(value);
  }
  const table = extractTableProduct(html);
  return table || "公告未明确列示";
}

function extractTableProduct(html) {
  for (const match of String(html).matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const rows = [...match[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((row) =>
      [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => htmlText(cell[1]))
    );
    const header = rows[0] || [];
    const productIndex = header.findIndex((value) => /产品名称|服务名称|采购内容|标的名称/.test(value));
    const quantityIndex = header.findIndex((value) => /数量|需求数量/.test(value));
    const unitIndex = header.findIndex((value) => /单位/.test(value));
    if (productIndex < 0) continue;
    const values = rows.slice(1).map((row) => {
      const product = row[productIndex];
      const quantity = quantityIndex >= 0 ? row[quantityIndex] : "";
      const unit = unitIndex >= 0 ? row[unitIndex] : "";
      return product ? `${product}${quantity && quantity !== "/" ? `，数量${quantity}${unit === "/" ? "" : unit}` : ""}` : "";
    }).filter(Boolean);
    if (values.length) return values.join("；").slice(0, 400);
  }
  return "";
}

function extractBudget(blocks) {
  const primaryLabels = /本采购项目估算(?:为)?|采购项目估算(?:为)?|项目估算(?:为)?|预估金额|估算金额|总价最高限价|预算金额|项目预算|采购预算|不含税(?:预算|金额|价款)/;
  for (const line of blocks) {
    const compact = line.replace(/\s+/g, "");
    if (!primaryLabels.test(compact)) continue;
    const nonTax = compact.match(/([0-9][\d,.]*)[】\]]*\s*(亿元|万元|元)[（(]?不含税/);
    if (nonTax) return `${nonTax[1]}${nonTax[2]}`;
    const amount = compact.match(/(?:本采购项目估算(?:为)?|采购项目估算(?:为)?|项目估算(?:为)?|预估金额|估算金额|总价最高限价|预算金额|项目预算|采购预算|不含税(?:预算|金额|价款))[^0-9]{0,20}([0-9][\d,.]*)[】\]]*\s*(亿元|万元|元)/);
    if (amount) return `${amount[1]}${amount[2]}`;
  }
  for (const line of blocks) {
    const compact = line.replace(/\s+/g, "");
    const amount = compact.match(/最高(?:响应|应答|投标)?限价[^0-9]{0,20}([0-9][\d,.]*)[】\]]*\s*(亿元|万元|元)/);
    if (amount) return `${amount[1]}${amount[2]}`;
  }
  return "公告未明确列示";
}

function extractTime(blocks, kind) {
  const label = kind === "sale"
    ? /(?:询比|比选|招标|采购)文件(?:的)?(?:获取|发售)时间/
    : /(?:响应|应答|投标)文件(?:递交|提交)?截止时间|(?:响应|应答|投标)截止时间/;
  const index = blocks.findIndex((line) => label.test(line.replace(/\s+/g, "")));
  if (index < 0) return "公告未明确列示";
  const text = blocks.slice(index, index + 8).join(" ").replace(/(?<=\d)\s+(?=\d)/g, "");
  const dates = text.match(/20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日(?:\s*\d{1,2}\s*时(?:\s*\d{1,2}\s*分)?)?|20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g);
  return dates?.slice(0, 2).map((date) => date.replace(/\s+/g, "")).join("至") || "公告未明确列示";
}

function extractQualification(blocks) {
  const start = blocks.findIndex((line) => /供应商(?:基本)?资格要求|参选人资格要求|应答人资格要求|投标人资格要求/.test(line));
  if (start < 0) return "公告未明确列示";
  const value = blocks.slice(start + 1, start + 10).find((line) =>
    line.length >= 16 && !isHeading(line) && !/^(?:\d+(?:\.\d+)*)?\s*(?:响应)?供应商(?:基本)?资格要求[：:]?$/.test(line)
  );
  return value?.slice(0, 700) || "公告未明确列示";
}

function extractPerformance(blocks) {
  const value = blocks.find((line) => /业绩要求|同类项目业绩|类似项目业绩/.test(line));
  return value?.slice(0, 700) || "公告资格条款中未单列业绩要求";
}

function findBlock(blocks, label, preferTail = false) {
  const index = blocks.findIndex((line) => label.test(line) && !/概况与采购内容/.test(line));
  if (index < 0) return "";
  if (preferTail) {
    const tail = blocks[index].replace(/^.*?(?:采购内容|采购范围)[:：]\s*/, "");
    if (tail.length >= 10) return tail;
  }
  return blocks.slice(index + 1, index + 4).find((line) => line.length >= 10 && !isHeading(line)) || "";
}

function trimField(value) {
  return htmlText(value)
    .replace(/[，,。；;]?\s*(?:预估金额|预算金额|项目预算|采购预算|不含税金额|最高限价).*$/u, "")
    .trim()
    .slice(0, 400) || "公告未明确列示";
}

function isHeading(value) {
  const compact = String(value || "").replace(/\s+/g, "");
  return /^(?:\d+(?:\.\d+)*[.、]?|[一二三四五六七八九十]+、)?(?:项目概况与采购内容|项目概况|采购内容|供应商资格要求|参选人资格要求|应答人资格要求|投标人资格要求|文件获取|响应文件的递交)$/.test(compact);
}

function htmlBlocks(html) {
  return String(html || "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<span\b[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/span>/gi, "")
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
    const value = htmlText(result[key] || "").trim();
    result[key] = (value || "公告未明确列示").slice(0, 700);
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
