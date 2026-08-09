import fs from "node:fs/promises";
import path from "node:path";

const input = JSON.parse(await fs.readFile(path.resolve("public/data/tower-notices.json"), "utf8"));
const rows = input.notices.filter((item) => item.category === "采购公告");
const output = [];

for (let offset = 0; offset < rows.length; offset += 8) {
  const batch = rows.slice(offset, offset + 8);
  output.push(...await Promise.all(batch.map(async (item) => {
    const response = await fetch("http://www.tower.com.cn/supportal/v1/obp-notice/get-notice-by-id", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json;charset=UTF-8", origin: "http://www.tower.com.cn", referer: "http://www.tower.com.cn/", "user-agent": "Mozilla/5.0" },
      body: JSON.stringify({ id: item.sourceId })
    });
    const payload = await response.json();
    const text = htmlText(payload.data?.noticeContent || "");
    return {
      sourceId: item.sourceId, title: item.title, region: item.region, date: item.date,
      parsed: pick(item),
      evidence: {
        purchaseContent: snippets(text, /采购内容|采购项目概况|项目概况|采购范围|采购需求/g),
        budget: snippets(text, /不含税|采购预算|项目预算|预算金额|最高限价|项目估算/g),
        saleTime: snippets(text, /(?:采购|比选|询价|招标)文件(?:的)?(?:获取|发售|售卖)时间|文件发售时间/g),
        deadline: snippets(text, /(?:响应|应答|投标)文件(?:的)?(?:递交|提交)截止时间|响应截止时间|应答截止时间|投标截止时间/g),
        qualification: snippets(text, /供应商资格要求|参选人资格要求|应答人资格要求|投标人资格要求/g),
        performance: snippets(text, /业绩要求|同类项目业绩|类似项目业绩|业绩证明|合同业绩/g)
      }
    };
  })));
  console.log(`${Math.min(offset + 8, rows.length)}/${rows.length}`);
}

await fs.mkdir(path.resolve("audit"), { recursive: true });
await fs.writeFile(path.resolve("audit/tower-source-audit.json"), JSON.stringify({ auditedAt: new Date().toISOString(), rows: output }, null, 2), "utf8");

function pick(item) {
  return Object.fromEntries(["purchaseContent", "budget", "saleTime", "deadline", "qualification", "performance"].map((key) => [key, item[key]]));
}

function snippets(text, regex) {
  const found = [];
  for (const match of text.matchAll(regex)) {
    found.push(text.slice(Math.max(0, match.index - 35), Math.min(text.length, match.index + 180)).trim());
    if (found.length >= 12) break;
  }
  return found;
}

function htmlText(value) {
  return String(value).replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}
