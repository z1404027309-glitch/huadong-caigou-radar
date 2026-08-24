const EMPTY_VALUES = new Set(["", "公告未明确列示", "公告未单独列示"]);

export function extractCommonNoticeFields({ html = "", attachmentTexts = [] } = {}) {
  const sources = [htmlText(html), ...attachmentTexts.map((item) => String(item?.text || ""))]
    .map(normalizeText)
    .filter(Boolean);
  const text = sources.join("\n");
  return {
    purchaseContent: extractLabeledParagraph(text, ["采购内容", "项目需求", "招标内容"]),
    budget: extractBudget(text),
    saleTime: extractDateRange(text, /(?:采购|询比|招标)文件(?:的)?(?:售卖|获取|发售)时间/),
    qualification: extractSection(text, ["应答人资格", "投标人资格", "供应商资格"]),
    performance: extractSection(text, ["业绩要求", "合同业绩", "同类合同"])
  };
}

export function preferRecognized(primary, fallback, defaultValue = "公告未明确列示") {
  const first = String(primary || "").trim();
  if (!EMPTY_VALUES.has(first)) return first;
  const second = String(fallback || "").trim();
  return EMPTY_VALUES.has(second) ? defaultValue : second;
}

function extractBudget(text) {
  const labels = ["总价最高限价", "项目预估金额", "预估金额", "项目预算金额", "项目预算", "采购预算金额", "采购预算", "预算总金额", "预算金额"];
  for (const label of labels) {
    let offset = 0;
    while (offset < text.length) {
      const index = text.indexOf(label, offset);
      if (index < 0) break;
      const tail = text.slice(index + label.length, index + label.length + 320);
      const stop = tail.search(/\n\s*(?:\d+\.\d+|（\d+）|\(\d+\)|[一二三四五六七八九十]+[、.．])\s*/);
      const field = stop > 5 ? tail.slice(0, stop) : tail;
      const amount = extractMoney(field);
      if (amount) return amount;
      offset = index + label.length;
    }
  }
  return "公告未明确列示";
}

function extractMoney(value) {
  const compact = String(value || "").replace(/\s+/g, "");
  const untaxed = compact.match(/([0-9][\d,.]*)(万元|亿元|元)[（(]不含税[）)]/);
  if (untaxed) return formatMoney(untaxed[1], untaxed[2]);
  const taxed = compact.match(/([0-9][\d,.]*)(万元|亿元|元)[（(]含税[）)]/);
  if (taxed) return formatMoney(taxed[1], taxed[2]);
  const plainTaxed = compact.match(/^[：:,，。]*([0-9][\d,.]*)[（(]含税[）)]/);
  if (plainTaxed) return formatMoney(plainTaxed[1], "元");
  const amount = compact.match(/([0-9][\d,.]*)(?:[（(](万元|亿元|元)[）)]|(万元|亿元|元))/);
  return amount ? formatMoney(amount[1], amount[2] || amount[3]) : "";
}

function formatMoney(number, unit) {
  if (!number || !unit) return "";
  const normalized = number.includes(".") ? number.replace(/0+$/, "").replace(/\.$/, "") : number;
  return `${normalized}${unit}`;
}

function extractDateRange(text, label) {
  const compact = text.replace(/\s+/g, "");
  const date = "20\\d{2}年\\d{1,2}月\\d{1,2}日(?:\\d{1,2}时(?:\\d{1,2}分)?)?";
  const match = compact.match(new RegExp(`${label.source}(?:为|是|[:：])?(${date}(?:至|到|~|～)${date})`));
  return match?.[1] || "公告未单独列示";
}

function extractLabeledParagraph(text, labels) {
  for (const label of labels) {
    const match = text.match(new RegExp(`${label}(?:为|是|[:：])?\\s*([^\\n]{6,500})`));
    if (match) return match[1].trim().slice(0, 400);
  }
  return "公告未明确列示";
}

function extractSection(text, labels) {
  for (const label of labels) {
    const index = text.indexOf(label);
    if (index < 0) continue;
    const value = text.slice(index + label.length, index + label.length + 800)
      .split(/\n\s*(?:\d+(?:\.\d+)+|[一二三四五六七八九十]+[、.．])/)[0]
      .replace(/^\s*[:：]\s*/, "")
      .trim();
    if (value.length >= 6) return value.slice(0, 700);
  }
  return "公告未明确列示";
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[\t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlText(value) {
  return String(value || "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}
