import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const workerSource = await fs.readFile("server/index.js", "utf8");
const workerModule = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString("base64")}`);
const worker = workerModule.default;

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
  noticeCategories: ["招标公告"],
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
assert(natural.appliedFilters.focusCategories.includes("AI应用"));
assert.deepEqual(natural.appliedFilters.keywords, []);

const explicitRangeResponse = await worker.fetch(new Request("https://local.test/api/notices/search?query=2026-08-04%20%E8%87%B3%202026-08-11%E7%A6%8F%E5%BB%BA%E6%89%80%E6%9C%89%E8%BF%90%E8%90%A5%E5%95%86%E7%9A%84AI%E5%85%AC%E5%91%8A&limit=10"), env);
const explicitRange = await explicitRangeResponse.json();
assert.equal(explicitRange.success, true);
assert.equal(explicitRange.appliedFilters.publishStart, "2026-08-04");
assert.equal(explicitRange.appliedFilters.publishEnd, "2026-08-11");
assert.deepEqual(explicitRange.appliedFilters.keywords, []);

const chineseDateResponse = await worker.fetch(new Request("https://local.test/api/notices/search?query=2026%E5%B9%B48%E6%9C%884%E6%97%A5%E7%A6%8F%E5%BB%BA%E7%A7%BB%E5%8A%A8%E5%85%AC%E5%91%8A"), env);
const chineseDate = await chineseDateResponse.json();
assert.equal(chineseDate.appliedFilters.publishStart, "2026-08-04");
assert.equal(chineseDate.appliedFilters.publishEnd, "2026-08-04");
assert.deepEqual(chineseDate.appliedFilters.keywords, []);

const strictFocusResponse = await worker.fetch(new Request("https://local.test/api/notices/search?query=%E7%A6%8F%E5%BB%BA%E6%9C%AC%E6%9C%88%E6%95%B0%E6%8D%AE%E4%B8%AD%E5%BF%83"), env);
const strictFocus = await strictFocusResponse.json();
assert(strictFocus.items.every((item) => /数据中心|IDC/i.test(item.title)));
assert(!strictFocus.items.some((item) => item.title.includes("市场竞争力提升服务")));

console.log(JSON.stringify({
  options: { provinces: options.provinces.length, operators: options.operators.length, focusGroups: options.focusGroups.length },
  searches: { dataCenter: dataCenter.total, allZhejiang: allZhejiang.total, telecomBudget: telecomBudget.total, natural: natural.total, explicitRange: explicitRange.total, strictFocus: strictFocus.total }
}, null, 2));
