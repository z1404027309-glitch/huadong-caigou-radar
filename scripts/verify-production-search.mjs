const baseUrl = String(process.env.NOTICE_SITE_URL || "").replace(/\/$/, "");
if (!/^https:\/\//.test(baseUrl)) throw new Error("NOTICE_SITE_URL must be an HTTPS URL");

const query = "福建移动近两周的招标公告";
const today = new Date().toISOString().slice(0, 10);
const start = new Date(`${today}T00:00:00Z`);
start.setUTCDate(start.getUTCDate() - 13);
const expectedStart = start.toISOString().slice(0, 10);

let lastResult;
for (let attempt = 1; attempt <= 18; attempt += 1) {
  const url = `${baseUrl}/api/notices/search?query=${encodeURIComponent(query)}&limit=50&deployment=${Date.now()}`;
  try {
    const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    lastResult = await response.json();
    const filters = lastResult?.appliedFilters || {};
    const valid = lastResult?.success === true
      && filters.publishStart === expectedStart
      && filters.publishEnd === today
      && Array.isArray(filters.keywords)
      && filters.keywords.length === 0
      && JSON.stringify(filters.provinces) === JSON.stringify(["福建"])
      && JSON.stringify(filters.operators) === JSON.stringify(["中国移动"])
      && JSON.stringify(filters.sourceCategories) === JSON.stringify(["招标公告"]);
    if (valid) {
      console.log(JSON.stringify({ ok: true, url: baseUrl, total: lastResult.total, appliedFilters: filters }, null, 2));
      process.exit(0);
    }
  } catch (error) {
    lastResult = { error: String(error?.message || error) };
  }
  if (attempt < 18) await new Promise((resolve) => setTimeout(resolve, 10_000));
}

console.error(JSON.stringify({
  ok: false,
  url: baseUrl,
  expected: { publishStart: expectedStart, publishEnd: today, keywords: [] },
  received: lastResult
}, null, 2));
process.exit(1);
