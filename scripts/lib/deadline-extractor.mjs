const DEADLINE_LABELS = [
  "响应文件递交截止时间", "响应文件提交截止时间", "电子响应文件递交截止时间", "电子响应文件提交截止时间",
  "应答文件递交截止时间", "应答文件提交截止时间", "电子应答文件递交截止时间", "电子应答文件提交截止时间",
  "投标文件递交截止时间", "投标文件提交截止时间", "电子投标文件递交截止时间", "电子投标文件提交截止时间",
  "响应截止时间", "应答截止时间", "投标截止时间"
];

const LABEL_PATTERN = DEADLINE_LABELS
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join("|");

const DATE_PATTERN = String.raw`(20\s*\d\s*\d)\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*(?:日|号)?(?:[T\s]*(\d{1,2})\s*(?:时|[:：])\s*(\d{1,2})?\s*(?:分|[:：]\d{1,2})?)?`;
const DEADLINE_LABEL = new RegExp(`(?:${LABEL_PATTERN})`, "i");

export function extractDeadline({ structuredValues = [], html = "", attachmentTexts = [] } = {}) {
  for (const candidate of structuredValues) {
    const parsed = normalizeDateTime(candidate?.value ?? candidate);
    if (!parsed) continue;
    return result(parsed, String(candidate?.evidence || candidate?.value || candidate), candidate?.source || "详情接口");
  }

  const bodyText = normalizeDocumentText(html);
  const body = findLabeledDeadline(bodyText);
  if (body) return result(body.deadline, body.evidence, "正文");

  for (const attachment of attachmentTexts) {
    const text = normalizeDocumentText(attachment?.text ?? attachment);
    const found = findLabeledDeadline(text);
    if (found) return result(found.deadline, found.evidence, attachment?.source || attachment?.name || "附件/PDF");
  }

  return {
    deadline: "",
    deadlineStatus: attachmentTexts.length ? "not_found" : "pending_attachment",
    deadlineEvidence: "",
    deadlineSource: attachmentTexts.length ? "正文及附件" : "正文"
  };
}

export function normalizeDocumentText(value) {
  return decodeEntities(String(value || ""))
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|td|th|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u200b\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function normalizeDateTime(value) {
  const match = normalizeDocumentText(value).match(new RegExp(DATE_PATTERN));
  if (!match) return "";
  const year = match[1].replace(/\s/g, "");
  const month = String(Number(match[2])).padStart(2, "0");
  const day = String(Number(match[3])).padStart(2, "0");
  const hour = match[4] == null ? "" : String(Number(match[4])).padStart(2, "0");
  const minute = hour ? String(Number(match[5] || 0)).padStart(2, "0") : "";
  const date = `${year}-${month}-${day}`;
  const parsed = new Date(`${date}T${hour || "00"}:${minute || "00"}:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return "";
  return hour ? `${date} ${hour}:${minute}` : date;
}

export function textAttachmentsFromDetail(detail) {
  const results = [];
  const seen = new Set();
  walk(detail, "详情附件", 0);
  return results;

  function walk(value, source, depth) {
    if (depth > 4 || value == null) return;
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${source}${index + 1}`, depth + 1));
    if (typeof value !== "object") return;
    const name = String(value.fileName || value.name || value.attachName || source);
    for (const key of ["text", "fileText", "pdfText", "ocrText", "contentText", "attachmentText"]) {
      const text = value[key];
      if (typeof text === "string" && text.length > 20 && !seen.has(text)) {
        seen.add(text);
        results.push({ text, source: /pdf/i.test(name) ? `PDF：${name}` : `附件：${name}` });
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (/attach|file|document|附件/i.test(key)) walk(child, name, depth + 1);
    }
  }
}

function findLabeledDeadline(text) {
  const label = text.match(DEADLINE_LABEL);
  if (!label) return null;
  const tail = text.slice(label.index, label.index + 180);
  if (/截止时间(?:之前|以前|前)\s*\d+\s*(?:个?月|天|日|工作日)/.test(tail.slice(0, 80))) return null;
  const dateMatch = tail.match(new RegExp(DATE_PATTERN));
  if (!dateMatch) return null;
  const deadline = normalizeDateTime(dateMatch[0]);
  if (!deadline) return null;
  const start = Math.max(0, label.index - 8);
  const end = label.index + dateMatch.index + dateMatch[0].length + 8;
  const evidence = text.slice(start, Math.min(text.length, end)).replace(/\n/g, " ").trim();
  return { deadline, evidence };
}

function result(deadline, evidence, source) {
  return { deadline, deadlineStatus: "recognized", deadlineEvidence: evidence, deadlineSource: source };
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
