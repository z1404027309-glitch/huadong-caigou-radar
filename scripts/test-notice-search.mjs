import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const workerSource = await fs.readFile("server/index.js", "utf8");
const workerModule = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString("base64")}`);
const worker = workerModule.default;
const today = new Date().toISOString().slice(0, 10);

function offsetMonth(date, months) {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

const env = {
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      const file = path.join(process.cwd(), "public", url.pathname.replace(/^\//, ""));
      try {
        return new Response(await fs.readFile(file), { status: 200, headers: { "content-type": "application/json" } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }
  }
};

async function search(body) {
  const response = await worker.fetch(new Request("https://local.test/api/notices/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }), env);
  assert.equal(response.status, 200);
  return response.json();
}

const optionsResponse = await worker.fetch(new Request("https://local.test/api/notices/search-options"), env);
const options = await optionsResponse.json();
assert.deepEqual(options.provinces, ["浙江", "江西", "福建"]);
assert.equal(options.operators.length, 4);
assert.deepEqual(options.noticeCategories, ["招采公告", "询比公告", "采购需求", "预公告"]);
assert(options.focusGroups.some((group) => group.categories.some((category) => category.name === "数据中心")));

const dataCenter = await search({
  provinces: ["福建"],
  operators: ["移动"],
  focusCategories: ["数据中心"],
  publishStart: "2026-08-01",
  publishEnd: "2026-08-11",
  limit: 10
});
assert(dataCenter.items.every((item) => item.province === "福建" && item.operator === "中国移动"));

const allZhejiang = await search({
  provinces: ["浙江"],
  publishStart: "2026-08-10",
  publishEnd: "2026-08-10",
  limit: 50
});
assert(allZhejiang.total > 0);
assert(allZhejiang.items.every((item) => item.province === "浙江" && item.publishDate === "2026-08-10"));

const telecomBudget = await search({
  provinces: ["福建"],
  operators: ["电信"],
  noticeCategories: ["招采公告"],
  budgetMin: 100,
  publishStart: "2026-08-01",
  publishEnd: "2026-08-11",
  limit: 50
});
assert(telecomBudget.items.every((item) => item.province === "福建" && item.operator === "中国电信"));

const invalidRange = await worker.fetch(new Request("https://local.test/api/notices/search", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ publishStart: "2026-08-11", publishEnd: "2026-08-01" })
}), env);
assert.equal(invalidRange.status, 400);

const naturalResponse = await worker.fetch(new Request("https://local.test/api/notices/search?query=%E4%B8%80%E5%91%A8%E5%86%85%E7%A6%8F%E5%BB%BA%E6%89%80%E6%9C%89%E8%BF%90%E8%90%A5%E5%95%86%E7%9A%84AI%E5%85%AC%E5%91%8A&limit=10"), env);
const natural = await naturalResponse.json();
assert.equal(natural.success, true);
assert.deepEqual(natural.appliedFilters.provinces, ["福建"]);
assert.deepEqual(natural.appliedFilters.operators, []);
assert.deepEqual(natural.appliedFilters.focusCategories, []);
assert.deepEqual(natural.appliedFilters.keywords, ["AI"]);

const explicitRangeResponse = await worker.fetch(new Request("https://local.test/api/notices/search?query=2026-08-04%20%E8%87%B3%202026-08-11%E7%A6%8F%E5%BB%BA%E6%89%80%E6%9C%89%E8%BF%90%E8%90%A5%E5%95%86%E7%9A%84AI%E5%85%AC%E5%91%8A&limit=10"), env);
const explicitRange = await explicitRangeResponse.json();
assert.equal(explicitRange.success, true);
assert.equal(explicitRange.appliedFilters.publishStart, "2026-08-04");
assert.equal(explicitRange.appliedFilters.publishEnd, "2026-08-11");
assert.deepEqual(explicitRange.appliedFilters.keywords, ["AI"]);

const chineseDateResponse = await worker.fetch(new Request("https://local.test/api/notices/search?query=2026%E5%B9%B48%E6%9C%884%E6%97%A5%E7%A6%8F%E5%BB%BA%E7%A7%BB%E5%8A%A8%E5%85%AC%E5%91%8A"), env);
const chineseDate = await chineseDateResponse.json();
assert.equal(chineseDate.appliedFilters.publishStart, "2026-08-04");
assert.equal(chineseDate.appliedFilters.publishEnd, "2026-08-04");
assert.deepEqual(chineseDate.appliedFilters.keywords, []);

const strictFocusResponse = await worker.fetch(new Request("https://local.test/api/notices/search?query=%E7%A6%8F%E5%BB%BA%E6%9C%AC%E6%9C%88%E6%95%B0%E6%8D%AE%E4%B8%AD%E5%BF%83"), env);
const strictFocus = await strictFocusResponse.json();
assert(strictFocus.items.every((item) => /数据中心|IDC/i.test(item.title)));
assert(!strictFocus.items.some((item) => item.title.includes("市场竞争力提升服务")));

const oneMonthResponse = await worker.fetch(new Request("https://local.test/api/notices/search?query=%E7%A6%8F%E5%BB%BA%E7%9C%81%E4%B8%80%E4%B8%AA%E6%9C%88%E5%86%85%E6%89%80%E6%9C%89%E8%BF%90%E8%90%A5%E5%95%86%E7%9A%84AI%E5%85%AC%E5%91%8A&limit=10"), env);
const oneMonth = await oneMonthResponse.json();
assert.equal(oneMonth.appliedFilters.publishStart, offsetMonth(today, 1));
assert.equal(oneMonth.appliedFilters.publishEnd, today);
assert.deepEqual(oneMonth.appliedFilters.keywords, ["AI"]);

const monthDayResponse = await worker.fetch(new Request("https://local.test/api/notices/search?query=%E6%B5%99%E6%B1%9F%E7%A7%BB%E5%8A%A88%E6%9C%887%E6%97%A5%E5%8F%91%E5%B8%83%E7%9A%84%E9%87%87%E8%B4%AD%E5%85%AC%E5%91%8A"), env);
const monthDay = await monthDayResponse.json();
assert.equal(monthDay.appliedFilters.publishStart, "2026-08-07");
assert.equal(monthDay.appliedFilters.publishEnd, "2026-08-07");
assert.deepEqual(monthDay.appliedFilters.keywords, []);

const eightMonthsResponse = await worker.fetch(new Request("https://local.test/api/notices/search?query=%E7%A6%8F%E5%BB%BA8%E4%B8%AA%E6%9C%88%E5%86%85AI%E5%85%AC%E5%91%8A"), env);
const eightMonths = await eightMonthsResponse.json();
assert.equal(eightMonths.appliedFilters.publishStart, offsetMonth(today, 8));
assert.equal(eightMonths.appliedFilters.publishEnd, today);
assert.deepEqual(eightMonths.appliedFilters.keywords, ["AI"]);

for (const [phrase, months] of [["近2个月", 2], ["三个月内", 3], ["过去十二个月", 12], ["18个月以内", 18]]) {
  const response = await worker.fetch(new Request(`https://local.test/api/notices/search?query=${encodeURIComponent(`福建${phrase}数据中心`)}`), env);
  const result = await response.json();
  assert.equal(result.appliedFilters.publishStart, offsetMonth(today, months), phrase);
  assert.equal(result.appliedFilters.publishEnd, today, phrase);
  assert(!result.appliedFilters.keywords.some((keyword) => keyword.includes("月")), phrase);
}

const powerTenderResponse = await worker.fetch(new Request("https://local.test/api/notices/search?query=%E7%A6%8F%E5%BB%BA%E7%A7%BB%E5%8A%A8%E4%B8%80%E4%B8%AA%E6%9C%88%E5%86%85%E7%9A%84%E5%85%B3%E4%BA%8E%E7%94%B5%E6%BA%90%E6%8B%9B%E6%A0%87%E9%87%87%E8%B4%AD%E9%A1%B9%E7%9B%AE"), env);
const powerTender = await powerTenderResponse.json();
assert.deepEqual(powerTender.appliedFilters.provinces, ["福建"]);
assert.deepEqual(powerTender.appliedFilters.operators, ["中国移动"]);
assert.deepEqual(powerTender.appliedFilters.noticeCategories, ["招采公告"]);
assert.deepEqual(powerTender.appliedFilters.keywords, ["电源"]);

const inquiryResponse = await worker.fetch(new Request("https://local.test/api/notices/search?query=%E4%B8%AD%E5%9B%BD%E7%A7%BB%E5%8A%A8%E8%AF%A2%E6%AF%94%E5%85%AC%E5%91%8A&limit=50"), env);
const inquiry = await inquiryResponse.json();
assert.deepEqual(inquiry.appliedFilters.noticeCategories, ["询比公告"]);
assert(inquiry.items.every((item) => item.category === "询比公告" && item.sourceCategory === "询比公告"));

const classifiedKeywordsResponse = await worker.fetch(new Request("https://local.test/api/notices/search?query=%E7%A6%8F%E5%BB%BA%E7%A7%BB%E5%8A%A8%E4%B8%80%E4%B8%AA%E6%9C%88%E5%86%85%E7%9A%84%E5%85%B3%E4%BA%8E%E6%95%B0%E6%8D%AE%E4%B8%AD%E5%BF%83%E5%92%8C%E5%85%89%E4%BC%8F%E6%8B%9B%E6%A0%87%E9%87%87%E8%B4%AD%E9%A1%B9%E7%9B%AE"), env);
const classifiedKeywords = await classifiedKeywordsResponse.json();
assert.deepEqual(classifiedKeywords.appliedFilters.focusCategories.sort(), ["数据中心", "光伏"].sort());
assert.deepEqual(classifiedKeywords.appliedFilters.keywords, []);

const halfYearSmartAppsResponse = await worker.fetch(new Request("https://local.test/api/notices/search?query=%E7%A6%8F%E5%BB%BA%E8%BF%90%E8%90%A5%E5%95%86%E5%8D%8A%E5%B9%B4%E6%99%BA%E6%85%A7%E5%BA%94%E7%94%A8%E5%85%AC%E5%91%8A"), env);
const halfYearSmartApps = await halfYearSmartAppsResponse.json();
assert.deepEqual(halfYearSmartApps.appliedFilters.provinces, ["福建"]);
assert.deepEqual(halfYearSmartApps.appliedFilters.operators, []);
assert.deepEqual(halfYearSmartApps.appliedFilters.focusCategories, ["智慧应用"]);
assert.deepEqual(halfYearSmartApps.appliedFilters.keywords, []);
assert.equal(halfYearSmartApps.appliedFilters.publishStart, offsetMonth(today, 6));
assert.equal(halfYearSmartApps.appliedFilters.publishEnd, today);

const retryHalfYearSmartAppsResponse = await worker.fetch(new Request("https://local.test/api/notices/search?query=%E9%87%8D%E6%96%B0%E6%9F%A5%E8%AF%A2%E7%A6%8F%E5%BB%BA%E8%BF%90%E8%90%A5%E5%95%86%E5%8D%8A%E5%B9%B4%E6%99%BA%E6%85%A7%E5%BA%94%E7%94%A8%E5%85%AC%E5%91%8A"), env);
const retryHalfYearSmartApps = await retryHalfYearSmartAppsResponse.json();
assert.deepEqual(retryHalfYearSmartApps.appliedFilters.focusCategories, ["智慧应用"]);
assert.deepEqual(retryHalfYearSmartApps.appliedFilters.keywords, []);
assert.equal(retryHalfYearSmartApps.total, halfYearSmartApps.total);

const digitalGovernmentResponse = await worker.fetch(new Request(`https://local.test/api/notices/search?query=${encodeURIComponent("一个月内浙江数字政府公告")}&limit=10`), env);
const digitalGovernment = await digitalGovernmentResponse.json();
assert.deepEqual(digitalGovernment.appliedFilters.focusCategories, ["数字政府"]);
assert.deepEqual(digitalGovernment.appliedFilters.keywords, []);
assert(digitalGovernment.items.some((item) => item.title.includes("电子政务")));

const tenderInfoResponse = await worker.fetch(new Request(`https://local.test/api/notices/search?query=${encodeURIComponent("今天福建运营商招标信息")}&limit=10`), env);
const tenderInfo = await tenderInfoResponse.json();
assert.deepEqual(tenderInfo.appliedFilters.provinces, ["福建"]);
assert.deepEqual(tenderInfo.appliedFilters.noticeCategories, ["招采公告"]);
assert.deepEqual(tenderInfo.appliedFilters.keywords, []);
assert.equal(Object.values(tenderInfo.summary.byProvince).reduce((sum, count) => sum + count, 0), tenderInfo.total);
assert.equal(Object.values(tenderInfo.summary.byOperator).reduce((sum, count) => sum + count, 0), tenderInfo.total);
assert.equal(Object.values(tenderInfo.summary.byCategory).reduce((sum, count) => sum + count, 0), tenderInfo.total);

const tenderBriefResponse = await worker.fetch(new Request(`https://local.test/api/notices/search?query=${encodeURIComponent("浙江运营商招标简报")}&limit=10`), env);
const tenderBrief = await tenderBriefResponse.json();
assert.deepEqual(tenderBrief.appliedFilters.provinces, ["浙江"]);
assert.deepEqual(tenderBrief.appliedFilters.noticeCategories, ["招采公告"]);
assert.deepEqual(tenderBrief.appliedFilters.keywords, []);
assert(tenderBrief.total > 0);

console.log(JSON.stringify({
  options: { provinces: options.provinces.length, operators: options.operators.length, focusGroups: options.focusGroups.length },
  searches: { dataCenter: dataCenter.total, allZhejiang: allZhejiang.total, telecomBudget: telecomBudget.total, natural: natural.total, explicitRange: explicitRange.total, strictFocus: strictFocus.total, oneMonth: oneMonth.total, monthDay: monthDay.total, eightMonths: eightMonths.total }
}, null, 2));
