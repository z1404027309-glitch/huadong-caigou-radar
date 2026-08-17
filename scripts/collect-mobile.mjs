import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { constants as cryptoConstants } from "node:crypto";

const OUTPUT = path.resolve(process.env.MOBILE_OUTPUT || "public/data/mobile-notices.json");
const LIST_API = "https://b2b.10086.cn/api-b2b/api-sync-es/white_list_api/b2b/publish/queryList";
const REGIONS = ["浙江", "江西", "福建"];
const KEEP_DAYS = Number(process.env.MOBILE_KEEP_DAYS || 365);
const CATEGORIES = [
  { category: "采购公告", publishType: "PROCUREMENT", publishOneType: "PROCUREMENT" },
  { category: "直接采购公告", publishType: "PROCUREMENT", publishOneType: "ONE_SOURCE_PROCUREMENT" },
  { category: "采购意见征求公告", publishType: "PURCHASE_SERVICE", publishOneType: "PURCHASE_OPINION" }
];
const legacyAgent = new https.Agent({ secureOptions: cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT });

const existing = await readArchive();
const endDate = new Date().toISOString().slice(0, 10);
const startDate = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
const collected = [];

for (const config of CATEGORIES) {
  let reachedStart = false;
  for (let current = 1; current <= 1000 && !reachedStart; current++) {
    const page = await fetchList(current, config);
    const records = page.records;
    if (!records.length) break;
    for (const item of records) {
      const date = String(item.publishDate || "").slice(0, 10);
      if (date && date < startDate) {
        reachedStart = true;
        continue;
      }
      const notice = toNotice({ ...item, category: config.category });
      if (notice && (!notice.date || notice.date <= endDate)) collected.push(notice);
    }
    if (page.last || (page.totalPages > 0 && current >= page.totalPages)) break;
  }
}

const notices = [...new Map([...existing.notices, ...collected]
  .filter((item) => !item.date || item.date >= startDate)
  .map((item) => [String(item.id), item]))
  .values()]
  .sort((a, b) => `${b.date} ${b.createDate || ""}`.localeCompare(`${a.date} ${a.createDate || ""}`));

await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
await fs.writeFile(OUTPUT, `${JSON.stringify({
  fetchedAt: new Date().toISOString(),
  source: "中国移动采购与招标网",
  notices
}, null, 2)}\n`, "utf8");
console.log(`saved ${notices.length} notices to ${OUTPUT}`);

async function fetchList(current, config) {
  const payload = await postJson(LIST_API, {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      origin: "https://b2b.10086.cn",
      referer: "https://b2b.10086.cn/b2b/main/listVendorNotice.html?noticeType=2",
      processInstId: "-1",
      userLoginName: "-1",
      "user-agent": "Mozilla/5.0"
    }, {
      name: "",
      publishType: config.publishType,
      publishOneType: config.publishOneType,
      publishOneTypes: [config.publishOneType],
      purchaseType: "",
      companyType: "",
      size: 100,
      current,
      sfactApplColumn5: "PC"
    });
  const data = payload?.data;
  const records = data?.content || data?.records || data?.items ||
    payload?.content || payload?.records || payload?.items || [];
  return {
    records: Array.isArray(records) ? records : [],
    last: Boolean(data?.last ?? payload?.last),
    totalPages: Number(data?.totalPages ?? payload?.totalPages ?? 0)
  };
}

function postJson(url, headers, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "POST",
      headers: { ...headers, "content-length": Buffer.byteLength(data) },
      agent: legacyAgent
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((response.statusCode || 500) >= 400) return reject(new Error(`mobile list ${response.statusCode}`));
        try { resolve(JSON.parse(text)); } catch { reject(new Error("mobile list returned invalid JSON")); }
      });
    });
    request.on("error", reject);
    request.setTimeout(30000, () => request.destroy(new Error("mobile list timeout")));
    request.end(data);
  });
}

function toNotice(item) {
  const regionText = `${item.name || ""} ${item.companyTypeName || ""}`;
  const region = REGIONS.find((name) => regionText.includes(name));
  if (!region) return null;
  const publishId = String(item.id || "");
  const publishUuid = item.uuid || "";
  const publishType = item.publishType || "PROCUREMENT";
  const publishOneType = item.publishOneType || "PROCUREMENT";
  const params = new URLSearchParams({ publishId, publishUuid, publishType, publishOneType });
  return {
    id: `mobile-${publishId || publishUuid}`,
    sourceId: publishId,
    publishId,
    publishUuid,
    publishType,
    publishOneType,
    category: item.category,
    title: item.name || "未命名采购公告",
    operator: "中国移动",
    sourceName: "中国移动采购与招标网",
    region,
    date: String(item.publishDate || "").split(" ")[0],
    createDate: item.publishDate || "",
    url: `https://b2b.10086.cn/#/noticeDetail?${params}`,
    fieldsReady: false
  };
}

async function readArchive() {
  try {
    const archive = JSON.parse(await fs.readFile(OUTPUT, "utf8"));
    return { notices: Array.isArray(archive.notices) ? archive.notices : [] };
  } catch {
    return { notices: [] };
  }
}
