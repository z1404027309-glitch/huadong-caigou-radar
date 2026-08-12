export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/notices") return getNotices(url, env);
    if (url.pathname === "/api/notices/search") return searchNotices(request, url, env);
    if (url.pathname === "/api/notices/search-options") return getNoticeSearchOptions(env);
    if (url.pathname === "/api/refresh") return handleRefresh(request, env);
    if (url.pathname === "/api/refresh-needed") return getRefreshNeeded(env);
    if (url.pathname === "/api/refresh-finish") return finishRefresh(request, env);
    if (url.pathname === "/api/archive-sync") return syncNoticeArchive(request, env);
    if (url.pathname === "/api/document") return getDocument(url);
    if (url.pathname === "/api/focus-rules") return handleFocusRules(request, env);
    if (url.pathname === "/api/scoring-settings") return handleScoringSettings(request, env);
    if (url.pathname.includes("ort-wasm-simd-threaded.jsep") && url.pathname.endsWith(".wasm")) {
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      headers.set("content-encoding", "gzip");
      headers.set("content-type", "application/wasm");
      return new Response(asset.body, { status: asset.status, headers });
    }
    return env.ASSETS.fetch(request);
  }
};

const DEFAULT_SCORING_SETTINGS = [
  { id: "keyword", name: "关键词匹配度", type: "keyword", maxScore: 30, enabled: true, parameter: 3 },
  { id: "budget", name: "项目预算", type: "budget", maxScore: 25, enabled: true, parameter: 1000 },
  { id: "deadline", name: "截止时间充足度", type: "deadline", maxScore: 15, enabled: true, parameter: 8 },
  { id: "target", name: "目标省份和运营商", type: "target", maxScore: 10, enabled: true, parameter: "浙江,江西,福建|中国移动,中国联通,中国铁塔,中国电信" },
  { id: "advantage", name: "历史优势领域", type: "advantage", maxScore: 10, enabled: true, parameter: 1 },
  { id: "threshold", name: "资格及业绩门槛", type: "threshold", maxScore: 10, enabled: true, parameter: "门槛越低得分越高" }
];

async function handleScoringSettings(request, env) {
  if (!env.DB) return json({ error: "settings_database_unavailable" }, 503, "no-store");
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS scoring_settings (
    id TEXT PRIMARY KEY,
    criteria TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();

  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT criteria, updated_at FROM scoring_settings WHERE id = 'default'").first();
    return json({
      criteria: row ? safeScoringSettings(row.criteria) : DEFAULT_SCORING_SETTINGS,
      updatedAt: row?.updated_at || null
    }, 200, "no-store");
  }

  if (request.method === "PUT") {
    const body = await request.json().catch(() => ({}));
    const criteria = sanitizeScoringSettings(body.criteria);
    const total = criteria.filter((item) => item.enabled).reduce((sum, item) => sum + item.maxScore, 0);
    if (!criteria.length || total !== 100) return json({ error: "score_total_must_equal_100", total }, 400, "no-store");
    const updatedAt = new Date().toISOString();
    await env.DB.prepare("INSERT INTO scoring_settings (id, criteria, updated_at) VALUES ('default', ?, ?) ON CONFLICT(id) DO UPDATE SET criteria = excluded.criteria, updated_at = excluded.updated_at")
      .bind(JSON.stringify(criteria), updatedAt).run();
    return json({ criteria, updatedAt }, 200, "no-store");
  }

  return json({ error: "method_not_allowed" }, 405, "no-store");
}

function safeScoringSettings(value) {
  try { return sanitizeScoringSettings(JSON.parse(value || "[]")); } catch { return DEFAULT_SCORING_SETTINGS; }
}

function sanitizeScoringSettings(value) {
  const allowedTypes = new Set(["keyword", "budget", "deadline", "target", "advantage", "threshold"]);
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((item, index) => ({
    id: String(item.id || `criterion-${index + 1}`).replace(/[^a-z0-9-]/gi, "").slice(0, 60) || `criterion-${index + 1}`,
    name: String(item.name || "评分项").trim().slice(0, 30),
    type: allowedTypes.has(item.type) ? item.type : "keyword",
    maxScore: Math.max(0, Math.min(100, Math.round(Number(item.maxScore) || 0))),
    enabled: item.enabled !== false,
    parameter: typeof item.parameter === "number" ? Math.max(0, item.parameter) : String(item.parameter || "").slice(0, 200)
  })).filter((item) => item.name);
}

async function handleFocusRules(request, env) {
  if (!env.DB) return json({ error: "rules_database_unavailable" }, 503, "no-store");
  await ensureFocusSchema(env.DB);

  if (request.method === "GET") {
    const [groupResult, ruleResult] = await Promise.all([
      env.DB.prepare("SELECT id, name, created_at FROM focus_groups ORDER BY created_at ASC").all(),
      env.DB.prepare("SELECT id, group_id, name, keywords, operator, created_at FROM focus_rules ORDER BY created_at ASC").all()
    ]);
    const rules = (ruleResult.results || []).map((row) => ({
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      keywords: JSON.parse(row.keywords || "[]"),
      operator: row.operator,
      createdAt: row.created_at
    }));
    const groups = (groupResult.results || []).map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      rules: rules.filter((rule) => rule.groupId === row.id)
    }));
    return json({ groups, rules }, 200, "no-store");
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim().slice(0, 40);
    if (body.type === "group") {
      if (!name) return json({ error: "invalid_group" }, 400, "no-store");
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      await env.DB.prepare("INSERT INTO focus_groups (id, name, created_at) VALUES (?, ?, ?)").bind(id, name, createdAt).run();
      return json({ group: { id, name, createdAt, rules: [] } }, 201, "no-store");
    }
    const groupId = String(body.groupId || "").trim();
    const operator = ["全部运营商", "中国移动", "中国联通", "中国铁塔", "中国电信"].includes(body.operator) ? body.operator : "全部运营商";
    const keywords = Array.isArray(body.keywords)
      ? body.keywords.map((value) => String(value).trim().slice(0, 40)).filter(Boolean).slice(0, 20)
      : [];
    if (!name || !groupId || !keywords.length) return json({ error: "invalid_rule" }, 400, "no-store");
    const group = await env.DB.prepare("SELECT id FROM focus_groups WHERE id = ?").bind(groupId).first();
    if (!group) return json({ error: "group_not_found" }, 404, "no-store");
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await env.DB.prepare("INSERT INTO focus_rules (id, group_id, name, keywords, operator, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, groupId, name, JSON.stringify(keywords), operator, createdAt).run();
    return json({ rule: { id, groupId, name, keywords, operator, createdAt } }, 201, "no-store");
  }

  if (request.method === "DELETE") {
    const targetUrl = new URL(request.url);
    const id = targetUrl.searchParams.get("id") || "";
    const type = targetUrl.searchParams.get("type") || "rule";
    if (!/^[a-z0-9-]{2,80}$/i.test(id)) return json({ error: "invalid_id" }, 400, "no-store");
    if (type === "group") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM focus_rules WHERE group_id = ?").bind(id),
        env.DB.prepare("DELETE FROM focus_groups WHERE id = ?").bind(id)
      ]);
    } else {
      await env.DB.prepare("DELETE FROM focus_rules WHERE id = ?").bind(id).run();
    }
    return json({ ok: true }, 200, "no-store");
  }

  return json({ error: "method_not_allowed" }, 405, "no-store");
}

const DEFAULT_FOCUS_GROUPS = [
  { id: "group-ai-computing", name: "AI与算力基础设施", rules: [
    ["rule-ai", "AI应用", ["AI", "人工智能", "大模型", "机器学习"]],
    ["rule-computing", "算力中心", ["智算", "智算中心", "超算", "超算中心", "算力"]],
    ["rule-datacenter", "数据中心", ["数据中心", "IDC"]]
  ] },
  { id: "group-digital-government", name: "数字政府与智慧应用", rules: [
    ["rule-government", "数字政府", ["数字政府", "政务信息化", "电子政务"]],
    ["rule-city-brain", "城市大脑", ["城市大脑"]],
    ["rule-smart-app", "智慧应用", ["智慧城市", "智慧园区", "智慧交通", "智慧政务", "智能化", "信息化"]]
  ] },
  { id: "group-consulting-design", name: "咨询规划与设计", rules: [
    ["rule-feasibility", "可研咨询", ["可研", "可行性研究", "可行性研究报告"]],
    ["rule-preliminary-design", "初步设计", ["初设", "初步设计"]],
    ["rule-planning-design", "规划设计", ["规划设计", "勘察设计", "方案设计"]],
    ["rule-lifecycle-consulting", "全过程咨询", ["全过程咨询"]]
  ] },
  { id: "group-engineering", name: "工程建设与机电", rules: [
    ["rule-construction", "施工建设", ["施工", "工程建设", "改造工程"]],
    ["rule-electromechanical", "机电电力", ["机电", "机电工程", "电力", "电气工程"]],
    ["rule-communication", "通信工程", ["通信工程", "通信施工", "通信设备"]]
  ] },
  { id: "group-renewable", name: "新能源与绿色能源", rules: [
    ["rule-solar", "光伏", ["光伏", "光伏发电"]],
    ["rule-storage-charging", "储能充电", ["储能", "充电桩"]],
    ["rule-wind-energy", "风电节能", ["风电", "新能源", "节能改造"]]
  ] }
];

async function ensureFocusSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS focus_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS focus_rules (
      id TEXT PRIMARY KEY,
      group_id TEXT,
      name TEXT NOT NULL,
      keywords TEXT NOT NULL,
      operator TEXT NOT NULL DEFAULT '全部运营商',
      created_at TEXT NOT NULL
    )`)
  ]);
  const columns = await db.prepare("PRAGMA table_info(focus_rules)").all();
  if (!(columns.results || []).some((column) => column.name === "group_id")) {
    await db.prepare("ALTER TABLE focus_rules ADD COLUMN group_id TEXT").run();
  }
  const groupCount = await db.prepare("SELECT COUNT(*) AS count FROM focus_groups").first();
  if (Number(groupCount?.count || 0) > 0) return;
  const now = new Date().toISOString();
  const statements = [];
  for (const group of DEFAULT_FOCUS_GROUPS) {
    statements.push(db.prepare("INSERT OR IGNORE INTO focus_groups (id, name, created_at) VALUES (?, ?, ?)").bind(group.id, group.name, now));
    for (const [id, name, keywords] of group.rules) {
      statements.push(db.prepare("INSERT OR IGNORE INTO focus_rules (id, group_id, name, keywords, operator, created_at) VALUES (?, ?, ?, ?, '全部运营商', ?)")
        .bind(id, group.id, name, JSON.stringify(keywords), now));
    }
  }
  await db.batch(statements);
}

const DETAIL_API = "https://b2b.10086.cn/api-b2b/api-sync-es/white_list_api/b2b/publish/queryDetail";
const ARCHIVE_SOURCES = ["mobile", "unicom", "tower", "telecom"];
const SUPPORTED_PROVINCES = ["浙江", "江西", "福建"];
const SUPPORTED_OPERATORS = ["中国移动", "中国联通", "中国铁塔", "中国电信"];
const NOTICE_CATEGORY_GROUPS = {
  "招采公告": ["招标公告", "采购公告", "直接采购公告"],
  "询比公告": ["询比公告"],
  "采购需求": ["采购意见征求公告", "采购需求公示"],
  "预公告": ["资格预审公告", "采购项目预公告"]
};
const SUPPORTED_NOTICE_CATEGORIES = Object.keys(NOTICE_CATEGORY_GROUPS);
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_AUDIENCE = "huadong-caigou-radar";
const REFRESH_REPOSITORY = "z1404027309-glitch/huadong-caigou-radar";

async function getNotices(url, env) {
  const searchMode = url.searchParams.has("q") || url.searchParams.has("limit");
  const query = String(url.searchParams.get("q") || "").trim();
  const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "10", 10) || 10));
  const endDate = validDate(url.searchParams.get("endDate")) || new Date().toISOString().slice(0, 10);
  const startDate = validDate(url.searchParams.get("startDate")) || (searchMode ? "2025-01-01" : endDate);
  if (startDate > endDate) return json({ notices: [], error: "invalid_date_range" }, 400);

  const notices = [];
  const errors = [];
  const archives = {};
  const storedArchives = await readStoredArchives(env);
  for (const source of ARCHIVE_SOURCES) {
    try {
      let archive = storedArchives[source];
      if (!archive) {
        const assetUrl = new URL(`/data/${source}-notices.json`, url.origin);
        const response = await env.ASSETS.fetch(new Request(assetUrl));
        if (!response.ok) throw new Error(`archive ${response.status}`);
        archive = await response.json();
      }
      archives[source] = archive.fetchedAt || "";
      notices.push(...(archive.notices || []).filter((item) =>
        item.date >= startDate && item.date <= endDate
      ).map(normalizeCategory));
    } catch (error) {
      errors.push(`${source}: ${String(error?.message || error)}`);
    }
  }

  notices.sort((a, b) => `${b.date} ${b.createDate || ""}`.localeCompare(`${a.date} ${a.createDate || ""}`));
  if (searchMode) {
    const items = notices
      .filter((item) => matchesNoticeQuery(item, query))
      .slice(0, limit)
      .map(toPublicNoticeItem);
    return json({ success: true, items }, 200, "public, max-age=60");
  }
  return json({
    notices,
    fetchedAt: new Date().toISOString(),
    mobileFetchedAt: archives.mobile || "",
    unicomFetchedAt: archives.unicom || "",
    towerFetchedAt: archives.tower || "",
    telecomFetchedAt: archives.telecom || "",
    errors
  }, notices.length || !errors.length ? 200 : 502);
}

async function searchNotices(request, url, env) {
  if (!['GET', 'POST'].includes(request.method)) return json({ success: false, error: "method_not_allowed" }, 405, "no-store");
  const focusRules = await readFocusRules(env);
  let body;
  if (request.method === "GET") {
    const query = String(url.searchParams.get("query") || url.searchParams.get("q") || "").trim();
    body = parseNaturalNoticeQuery(query, focusRules);
    if (url.searchParams.has("limit")) body.limit = url.searchParams.get("limit");
  } else {
    body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ success: false, error: "invalid_json_body" }, 400, "no-store");
    }
  }

  const filters = normalizeNoticeSearchFilters(body);
  if (filters.error) return json({ success: false, error: filters.error }, 400, "no-store");

  const { notices, errors } = await loadNotices(url, env, filters.publishStart, filters.publishEnd);
  const matched = notices
    .filter((item) => matchesStructuredNoticeSearch(item, filters, focusRules))
    .sort((a, b) => compareNotices(a, b, filters.sort));
  const items = matched.slice(0, filters.limit).map(toPublicNoticeItem);

  return json({
    success: true,
    total: matched.length,
    returned: items.length,
    appliedFilters: filters,
    items,
    ...(errors.length ? { sourceErrors: errors } : {})
  }, 200, "no-store");
}

function parseNaturalNoticeQuery(query, focusRules) {
  const today = new Date().toISOString().slice(0, 10);
  const provinces = SUPPORTED_PROVINCES.filter((province) => query.includes(province));
  const operators = SUPPORTED_OPERATORS.filter((operator) => query.includes(operator) || query.includes(operator.replace("中国", "")));
  const noticeCategoryAliases = [
    ["招采公告", /招采公告|招标|采购公告|直接采购|单一来源/],
    ["采购需求", /采购需求|意见征求|征求意见|需求公示/],
    ["询比公告", /询比|比选/],
    ["预公告", /预公告|资格预审/]
  ];
  const noticeCategories = [...new Set([
    ...SUPPORTED_NOTICE_CATEGORIES.filter((category) => query.includes(category)),
    ...noticeCategoryAliases.filter(([, pattern]) => pattern.test(query)).map(([category]) => category)
  ])];
  const focusCategories = [...new Set(focusRules.filter((rule) =>
    query.includes(rule.name)
    || query.includes(rule.groupName)
    || rule.keywords.some((keyword) => normalizeSearchText(query).includes(normalizeSearchText(keyword)))
  ).map((rule) => rule.name))];
  const matchedFocusKeywords = [...new Set(focusRules.flatMap((rule) => rule.keywords)
    .filter((keyword) => normalizeSearchText(query).includes(normalizeSearchText(keyword))))];
  const { publishStart, publishEnd } = naturalDateRange(query, today);

  let keywordText = query;
  const removable = [
    ...SUPPORTED_PROVINCES.flatMap((value) => [value, `${value}省`]),
    ...SUPPORTED_OPERATORS.flatMap((value) => [value, value.replace("中国", "")]),
    ...SUPPORTED_NOTICE_CATEGORIES,
    "直接采购", "单一来源", "意见征求", "征求意见", "需求公示", "询比", "比选", "招标", "资格预审", "项目预公告", "采购预公告",
    ...focusRules.flatMap((rule) => [rule.name, rule.groupName, ...rule.keywords]),
    "所有运营商", "全部运营商", "四家运营商", "运营商", "挂网", "公告", "项目", "采购", "发布", "查询", "搜索", "查找", "查一下", "帮我查", "看看", "重新查询", "重新搜索", "重新查找", "重新查", "再查询", "再搜索", "再查一次", "重查", "关于", "有关", "相关", "方面", "一批",
    "今天", "今日", "本日", "本周", "这周", "本月", "这个月", "一周内", "近一周", "最近一周", "一个月内", "近一个月", "最近一个月", "半年", "半年内", "近半年", "最近半年"
  ].sort((a, b) => b.length - a.length);
  for (const value of removable) keywordText = keywordText.replaceAll(value, " ");
  keywordText = keywordText.replace(/近\s*\d+\s*(?:日|天)|最近\s*\d+\s*(?:日|天)/g, " ");
  keywordText = keywordText.replace(/20\d{2}(?:年|[-/.])\d{1,2}(?:月|[-/.])\d{1,2}日?/g, " ");
  keywordText = keywordText.replace(/\d{1,2}月\d{1,2}日/g, " ");
  keywordText = keywordText.replace(/(?:近|最近)\s*\d+\s*个?月(?:内)?|\d+\s*个月(?:内)?/g, " ");
  keywordText = keywordText.replace(/(?:至|到|~|～)/g, " ");
  const extractedKeywords = keywordText.split(/[\s,，;；、的]+/)
    .map((value) => value.trim().replace(/^(?:关于|有关|相关)/, "").replace(/(?:相关|方面)$/u, ""))
    .filter((value) => value.length >= 2);
  const keywords = matchedFocusKeywords.length
    ? matchedFocusKeywords
    : focusCategories.length ? [] : extractedKeywords;

  return { provinces, operators, noticeCategories, focusCategories, keywords, publishStart, publishEnd, limit: 10 };
}

function naturalDateRange(query, today) {
  const explicitDates = [...query.matchAll(/(20\d{2})(?:年|[-/.])(\d{1,2})(?:月|[-/.])(\d{1,2})日?/g)]
    .map((match) => normalizeExplicitDate(match[1], match[2], match[3]))
    .filter(Boolean);
  if (explicitDates.length >= 2) {
    return {
      publishStart: explicitDates[0] <= explicitDates[1] ? explicitDates[0] : explicitDates[1],
      publishEnd: explicitDates[0] <= explicitDates[1] ? explicitDates[1] : explicitDates[0]
    };
  }
  if (explicitDates.length === 1) return { publishStart: explicitDates[0], publishEnd: explicitDates[0] };
  const monthDay = query.match(/(?:^|\D)(\d{1,2})月(\d{1,2})日/);
  if (monthDay) {
    const inferred = normalizeExplicitDate(today.slice(0, 4), monthDay[1], monthDay[2]);
    if (inferred) return { publishStart: inferred, publishEnd: inferred };
  }
  if (/今天|今日|本日/.test(query)) return { publishStart: today, publishEnd: today };
  const recent = query.match(/(?:近|最近)\s*(\d+)\s*(?:日|天)/);
  if (recent) return { publishStart: offsetIsoDate(today, -(Math.min(365, Math.max(1, Number(recent[1]))) - 1)), publishEnd: today };
  if (/一周内|近一周|最近一周/.test(query)) return { publishStart: offsetIsoDate(today, -6), publishEnd: today };
  const recentMonths = query.match(/(?:近|最近)\s*(\d+)\s*个?月(?:内)?|(\d+)\s*个月(?:内)?/);
  if (recentMonths) {
    const count = Number(recentMonths[1] || recentMonths[2]);
    return { publishStart: offsetIsoMonth(today, -Math.min(12, Math.max(1, count))), publishEnd: today };
  }
  if (/一个月内|近一个月|最近一个月/.test(query)) return { publishStart: offsetIsoMonth(today, -1), publishEnd: today };
  if (/半年(?:内)?|近半年|最近半年/.test(query)) return { publishStart: offsetIsoMonth(today, -6), publishEnd: today };
  if (/本周|这周/.test(query)) {
    const date = new Date(`${today}T00:00:00Z`);
    const day = date.getUTCDay() || 7;
    return { publishStart: offsetIsoDate(today, -(day - 1)), publishEnd: today };
  }
  if (/本月|这个月/.test(query)) return { publishStart: `${today.slice(0, 7)}-01`, publishEnd: today };
  return { publishStart: "2025-01-01", publishEnd: today };
}

function normalizeExplicitDate(year, month, day) {
  const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? "" : value;
}

function offsetIsoDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function offsetIsoMonth(date, months) {
  const [year, month, day] = date.split("-").map(Number);
  const firstOfTarget = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0)).getUTCDate();
  firstOfTarget.setUTCDate(Math.min(day, lastDay));
  return firstOfTarget.toISOString().slice(0, 10);
}

async function getNoticeSearchOptions(env) {
  const groups = await readFocusGroups(env);
  return json({
    success: true,
    provinces: SUPPORTED_PROVINCES,
    operators: SUPPORTED_OPERATORS,
    noticeCategories: SUPPORTED_NOTICE_CATEGORIES,
    focusGroups: groups.map((group) => ({
      name: group.name,
      categories: group.rules.map((rule) => ({ name: rule.name, keywords: rule.keywords, operator: rule.operator }))
    }))
  }, 200, "public, max-age=60");
}

async function loadNotices(url, env, startDate, endDate) {
  const notices = [];
  const errors = [];
  const storedArchives = await readStoredArchives(env);
  for (const source of ARCHIVE_SOURCES) {
    try {
      let archive = storedArchives[source];
      if (!archive) {
        const response = await env.ASSETS.fetch(new Request(new URL(`/data/${source}-notices.json`, url.origin)));
        if (!response.ok) throw new Error(`archive ${response.status}`);
        archive = await response.json();
      }
      notices.push(...(archive.notices || [])
        .filter((item) => item.date >= startDate && item.date <= endDate)
        .map(normalizeCategory));
    } catch (error) {
      errors.push(`${source}: ${String(error?.message || error)}`);
    }
  }
  return { notices, errors };
}

function normalizeNoticeSearchFilters(body) {
  const today = new Date().toISOString().slice(0, 10);
  const publishStart = validDate(body.publishStart || body.startDate) || "2025-01-01";
  const publishEnd = validDate(body.publishEnd || body.endDate) || today;
  const deadlineStart = validDate(body.deadlineStart) || "";
  const deadlineEnd = validDate(body.deadlineEnd) || "";
  if (publishStart > publishEnd || (deadlineStart && deadlineEnd && deadlineStart > deadlineEnd)) {
    return { error: "invalid_date_range" };
  }
  return {
    provinces: normalizeAllowedList(body.provinces ?? body.province, SUPPORTED_PROVINCES, normalizeProvince),
    operators: normalizeAllowedList(body.operators ?? body.operator, SUPPORTED_OPERATORS, normalizeOperator),
    noticeCategories: normalizeAllowedList(body.noticeCategories ?? body.noticeCategory, SUPPORTED_NOTICE_CATEGORIES),
    focusCategories: normalizeStringList(body.focusCategories ?? body.focusCategory, 10),
    keywords: normalizeStringList(body.keywords ?? body.keyword ?? body.q, 10),
    publishStart,
    publishEnd,
    deadlineStart,
    deadlineEnd,
    budgetMin: normalizeBudgetFilter(body.budgetMin),
    budgetMax: normalizeBudgetFilter(body.budgetMax),
    sort: ["publishDate_desc", "publishDate_asc", "budget_desc", "deadline_asc"].includes(body.sort) ? body.sort : "publishDate_desc",
    limit: Math.min(50, Math.max(1, Number.parseInt(body.limit || "10", 10) || 10))
  };
}

function normalizeAllowedList(value, allowed, mapper = (item) => item) {
  return [...new Set(normalizeStringList(value, allowed.length).map(mapper).filter((item) => allowed.includes(item)))];
}

function normalizeStringList(value, max) {
  const list = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))].slice(0, max);
}

function normalizeProvince(value) {
  return String(value || "").replace(/省$/, "");
}

function normalizeOperator(value) {
  const short = String(value || "").replace(/^中国/, "").replace(/运营商$/, "");
  return ({ 移动: "中国移动", 联通: "中国联通", 铁塔: "中国铁塔", 电信: "中国电信" })[short] || String(value || "");
}

function normalizeBudgetFilter(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function matchesStructuredNoticeSearch(item, filters, focusRules) {
  const province = String(item.region || item.province || "");
  if (filters.provinces.length && !filters.provinces.includes(province)) return false;
  if (filters.operators.length && !filters.operators.includes(String(item.operator || ""))) return false;
  if (filters.noticeCategories.length && !filters.noticeCategories.includes(String(item.category || ""))) return false;

  const deadline = firstDate(item.deadline || item.responseDeadline || item.bidDeadline);
  if (filters.deadlineStart && (!deadline || deadline < filters.deadlineStart)) return false;
  if (filters.deadlineEnd && (!deadline || deadline > filters.deadlineEnd)) return false;

  const budget = parseBudgetWan(item.budget);
  if (filters.budgetMin != null && (budget == null || budget < filters.budgetMin)) return false;
  if (filters.budgetMax != null && (budget == null || budget > filters.budgetMax)) return false;

  const haystack = noticeSearchHaystack(item);
  if (filters.keywords.some((keyword) => !haystack.includes(normalizeSearchText(keyword)))) return false;
  if (filters.focusCategories.length) {
    const selected = focusRules.filter((rule) => filters.focusCategories.includes(rule.name) || filters.focusCategories.includes(rule.groupName));
    const title = normalizeSearchText(item.title);
    if (!selected.length || !selected.some((rule) =>
      (rule.operator === "全部运营商" || rule.operator === item.operator)
      && rule.keywords.some((keyword) => title.includes(normalizeSearchText(keyword)))
    )) return false;
  }
  return true;
}

function noticeSearchHaystack(item) {
  return normalizeSearchText([item.title, item.purchaseContent, item.category, item.noticeType, item.projectNo, item.qualification, item.performance].filter(Boolean).join(" "));
}

function parseBudgetWan(value) {
  const text = String(value || "").replace(/,/g, "");
  const match = text.match(/([\d.]+)\s*(亿元|万元|元)/);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  return match[2] === "亿元" ? number * 10000 : match[2] === "元" ? number / 10000 : number;
}

function compareNotices(a, b, sort) {
  if (sort === "publishDate_asc") return `${a.date} ${a.createDate || ""}`.localeCompare(`${b.date} ${b.createDate || ""}`);
  if (sort === "budget_desc") return (parseBudgetWan(b.budget) ?? -1) - (parseBudgetWan(a.budget) ?? -1);
  if (sort === "deadline_asc") return (firstDate(a.deadline || a.responseDeadline || a.bidDeadline) || "9999-12-31").localeCompare(firstDate(b.deadline || b.responseDeadline || b.bidDeadline) || "9999-12-31");
  return `${b.date} ${b.createDate || ""}`.localeCompare(`${a.date} ${a.createDate || ""}`);
}

async function readFocusGroups(env) {
  if (!env.DB) return DEFAULT_FOCUS_GROUPS.map((group) => ({
    ...group,
    rules: group.rules.map(([id, name, keywords]) => ({ id, name, keywords, operator: "全部运营商" }))
  }));
  await ensureFocusSchema(env.DB);
  const [groupResult, ruleResult] = await Promise.all([
    env.DB.prepare("SELECT id, name, created_at FROM focus_groups ORDER BY created_at ASC").all(),
    env.DB.prepare("SELECT id, group_id, name, keywords, operator, created_at FROM focus_rules ORDER BY created_at ASC").all()
  ]);
  return (groupResult.results || []).map((group) => ({
    ...group,
    rules: (ruleResult.results || []).filter((rule) => rule.group_id === group.id).map((rule) => ({
      id: rule.id,
      name: rule.name,
      keywords: safeKeywordList(rule.keywords),
      operator: rule.operator || "全部运营商"
    }))
  }));
}

async function readFocusRules(env) {
  const groups = await readFocusGroups(env);
  return groups.flatMap((group) => group.rules.map((rule) => ({ ...rule, groupName: group.name })));
}

function safeKeywordList(value) {
  try { return Array.isArray(value) ? value : JSON.parse(value || "[]"); } catch { return []; }
}

async function handleRefresh(request, env) {
  if (!env.DB) return json({ error: "refresh_database_unavailable" }, 503, "no-store");
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS refresh_jobs (
    id TEXT PRIMARY KEY,
    requested_at TEXT NOT NULL,
    status TEXT NOT NULL
  )`).run();

  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT id, requested_at, status FROM refresh_jobs ORDER BY requested_at DESC LIMIT 1").first();
    if (!row) return json({ status: "idle" }, 200, "no-store");
    const archiveTimes = await readArchiveTimes(request, env);
    const completed = Object.values(archiveTimes).length === 4
      && Object.values(archiveTimes).every((value) => value && value > row.requested_at);
    if (completed && row.status !== "completed") {
      await env.DB.prepare("UPDATE refresh_jobs SET status = 'completed' WHERE id = ?").bind(row.id).run();
    }
    return json({
      id: row.id,
      status: completed ? "completed" : row.status,
      requestedAt: row.requested_at,
      archiveTimes
    }, 200, "no-store");
  }

  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, "no-store");
  const latest = await env.DB.prepare("SELECT id, requested_at, status FROM refresh_jobs ORDER BY requested_at DESC LIMIT 1").first();
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  if (latest?.requested_at > tenMinutesAgo && latest.status !== "completed") {
    return json({ id: latest.id, status: latest.status, requestedAt: latest.requested_at, reused: true }, 202, "no-store");
  }

  const id = crypto.randomUUID();
  const requestedAt = new Date().toISOString();
  await env.DB.prepare("INSERT INTO refresh_jobs (id, requested_at, status) VALUES (?, ?, 'queued')")
    .bind(id, requestedAt).run();
  return json({ id, status: "queued", requestedAt }, 202, "no-store");
}

async function getRefreshNeeded(env) {
  if (!env.DB) return json({ shouldRun: false }, 200, "no-store");
  await ensureArchiveSchema(env.DB);
  const row = await env.DB.prepare("SELECT id, requested_at FROM refresh_jobs WHERE status = 'queued' ORDER BY requested_at DESC LIMIT 1").first();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const shouldRun = Boolean(row?.requested_at && row.requested_at > oneHourAgo);
  if (shouldRun) {
    await env.DB.prepare("UPDATE refresh_jobs SET status = 'running' WHERE id = ? AND status = 'queued'").bind(row.id).run();
  }
  return json({
    shouldRun,
    id: row?.id || null,
    requestedAt: row?.requested_at || null
  }, 200, "no-store");
}

async function finishRefresh(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, "no-store");
  if (!env.DB) return json({ error: "refresh_database_unavailable" }, 503, "no-store");
  const token = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const claims = await verifyGithubOidcToken(token).catch(() => null);
  if (!claims) return json({ error: "unauthorized" }, 401, "no-store");
  const results = await request.json().catch(() => ({}));
  const failedSources = ARCHIVE_SOURCES.filter((source) => results[source] !== "success");
  await ensureArchiveSchema(env.DB);
  const job = await env.DB.prepare("SELECT id FROM refresh_jobs WHERE status IN ('queued', 'running') ORDER BY requested_at DESC LIMIT 1").first();
  const status = "completed";
  if (job) await env.DB.prepare("UPDATE refresh_jobs SET status = ? WHERE id = ?").bind(status, job.id).run();
  return json({ success: true, status, failedSources }, 200, "no-store");
}

async function syncNoticeArchive(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, "no-store");
  if (!env.DB) return json({ error: "archive_database_unavailable" }, 503, "no-store");
  const source = new URL(request.url).searchParams.get("source") || "";
  if (!ARCHIVE_SOURCES.includes(source)) return json({ error: "invalid_source" }, 400, "no-store");
  const token = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const claims = await verifyGithubOidcToken(token).catch(() => null);
  if (!claims) return json({ error: "unauthorized" }, 401, "no-store");

  const archive = await request.json().catch(() => null);
  if (!archive || !Array.isArray(archive.notices) || archive.notices.length > 10000) {
    return json({ error: "invalid_archive" }, 400, "no-store");
  }
  const fetchedAt = String(archive.fetchedAt || new Date().toISOString());
  await ensureArchiveSchema(env.DB);
  await env.DB.prepare(`INSERT INTO notice_archives (source, fetched_at, payload, updated_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(source) DO UPDATE SET
    fetched_at = excluded.fetched_at, payload = excluded.payload, updated_at = excluded.updated_at`)
    .bind(source, fetchedAt, JSON.stringify({ ...archive, fetchedAt }), new Date().toISOString()).run();
  await completeRefreshJobs(env.DB);
  return json({ success: true, source, fetchedAt, count: archive.notices.length }, 200, "no-store");
}

async function ensureArchiveSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS notice_archives (
      source TEXT PRIMARY KEY,
      fetched_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS refresh_jobs (
      id TEXT PRIMARY KEY,
      requested_at TEXT NOT NULL,
      status TEXT NOT NULL
    )`)
  ]);
}

async function readStoredArchives(env) {
  if (!env.DB) return {};
  await ensureArchiveSchema(env.DB);
  const result = await env.DB.prepare("SELECT source, payload FROM notice_archives").all();
  const archives = {};
  for (const row of result.results || []) {
    try { archives[row.source] = JSON.parse(row.payload); } catch {}
  }
  return archives;
}

async function completeRefreshJobs(db) {
  const job = await db.prepare("SELECT id, requested_at FROM refresh_jobs WHERE status != 'completed' ORDER BY requested_at DESC LIMIT 1").first();
  if (!job) return;
  const rows = await db.prepare("SELECT source, fetched_at FROM notice_archives").all();
  const times = Object.fromEntries((rows.results || []).map((row) => [row.source, row.fetched_at]));
  if (ARCHIVE_SOURCES.every((source) => times[source] && times[source] > job.requested_at)) {
    await db.prepare("UPDATE refresh_jobs SET status = 'completed' WHERE id = ?").bind(job.id).run();
  }
}

async function verifyGithubOidcToken(token) {
  if (!token || token.split(".").length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  const header = JSON.parse(new TextDecoder().decode(base64UrlBytes(headerPart)));
  const claims = JSON.parse(new TextDecoder().decode(base64UrlBytes(payloadPart)));
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== "RS256" || !header.kid || claims.iss !== OIDC_ISSUER || claims.aud !== OIDC_AUDIENCE) return null;
  if (Number(claims.exp || 0) < now || Number(claims.nbf || 0) > now + 30) return null;
  if (claims.repository !== REFRESH_REPOSITORY || claims.ref !== "refs/heads/main") return null;
  if (!String(claims.workflow_ref || "").includes("/.github/workflows/collect-unicom.yml@refs/heads/main")) return null;
  const config = await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`).then((response) => response.json());
  const jwks = await fetch(config.jwks_uri).then((response) => response.json());
  const jwk = (jwks.keys || []).find((key) => key.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlBytes(signaturePart), new TextEncoder().encode(`${headerPart}.${payloadPart}`));
  return valid ? claims : null;
}

function base64UrlBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function readArchiveTimes(request, env) {
  const stored = await readStoredArchives(env);
  const result = Object.fromEntries(Object.entries(stored).map(([source, archive]) => [source, String(archive.fetchedAt || "")]));
  if (Object.keys(result).length === ARCHIVE_SOURCES.length) return result;
  const origin = new URL(request.url).origin;
  await Promise.all(ARCHIVE_SOURCES.map(async (source) => {
    if (result[source]) return;
    try {
      const response = await env.ASSETS.fetch(new Request(new URL(`/data/${source}-notices.json`, origin)));
      if (!response.ok) return;
      const archive = await response.json();
      result[source] = String(archive.fetchedAt || "");
    } catch {}
  }));
  return result;
}

function matchesNoticeQuery(item, query) {
  if (!query) return true;
  const province = String(item.region || item.province || "");
  const operator = String(item.operator || "");
  const shortOperator = operator.replace(/^中国/, "");
  const haystack = normalizeSearchText([
    item.title,
    item.purchaseContent,
    item.category,
    item.noticeType,
    item.projectNo,
    item.budget,
    province,
    operator,
    `${province}${shortOperator}`,
    `${province}${operator}`
  ].filter(Boolean).join(" "));
  const terms = String(query).split(/[\s,，;；、]+/).map(normalizeSearchText).filter(Boolean);
  return terms.every((term) => haystack.includes(term));
}

function normalizeSearchText(value) {
  return String(value || "").toLowerCase().replace(/[\s\-_—（）()【】\[\]，,。.:：;；/\\]+/g, "");
}

function toPublicNoticeItem(item) {
  return {
    title: String(item.title || ""),
    operator: String(item.operator || ""),
    province: String(item.region || item.province || ""),
    publishDate: firstDate(item.date || item.publishDate || item.createDate),
    deadline: firstDate(item.deadline || item.responseDeadline || item.bidDeadline),
    budget: String(item.budget || ""),
    category: String(item.category || ""),
    sourceCategory: String(item.sourceCategory || ""),
    url: String(item.url || "")
  };
}

function firstDate(value) {
  const text = String(value || "");
  const numeric = text.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  const chinese = text.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  const match = numeric || chinese;
  if (!match) return "";
  return `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
}

function normalizeCategory(item) {
  const title = item.title || "";
  let sourceCategory = item.sourceCategory || item.category || "采购公告";
  const titleCategory = inferTitleCategory(title);
  if (titleCategory) {
    sourceCategory = titleCategory;
  } else if (!item.category) {
    if (item.operator === "中国联通") sourceCategory = /采购需求/.test(title) ? "采购需求公示" : /招标/.test(title) ? "招标公告" : "询比公告";
    if (item.operator === "中国电信") sourceCategory = /资格预审/.test(title) ? "资格预审公告" : /招标/.test(title) ? "招标公告" : "询比公告";
    if (item.operator === "中国铁塔") sourceCategory = String(item.noticeType) === "49" || /预公告|采购计划发布/.test(title) ? "采购项目预公告" : "采购公告";
  }
  const category = Object.entries(NOTICE_CATEGORY_GROUPS).find(([, values]) => values.includes(sourceCategory))?.[0] || "招采公告";
  return { ...item, sourceCategory, category };
}

function inferTitleCategory(title) {
  const text = String(title || "").replace(/\s+/g, "");
  if (/询比(?:采购)?公告|询价公告|比选公告/.test(text)) return "询比公告";
  if (/采购意见征求公告|意见征求公告|征求意见公告/.test(text)) return "采购意见征求公告";
  if (/采购需求公示|采购需求公告/.test(text)) return "采购需求公示";
  if (/资格预审公告/.test(text)) return "资格预审公告";
  if (/采购项目预公告|采购预公告|项目预公告/.test(text)) return "采购项目预公告";
  if (/直接采购公告|单一来源采购公告/.test(text)) return "直接采购公告";
  if (/招标公告/.test(text)) return "招标公告";
  if (/采购公告/.test(text)) return "采购公告";
  return "";
}

async function getDocument(url) {
  const item = {
    id: url.searchParams.get("publishId") || "",
    uuid: url.searchParams.get("publishUuid") || "",
    publishType: url.searchParams.get("publishType") || "PROCUREMENT",
    publishOneType: url.searchParams.get("publishOneType") || "PROCUREMENT"
  };
  if (!/^\d{8,25}$/.test(item.id)) return new Response("invalid publishId", { status: 400 });

  try {
    const response = await fetch(DETAIL_API, {
      method: "POST",
      headers: upstreamHeaders(),
      body: JSON.stringify({
        publishId: item.id,
        publishUuid: item.uuid,
        publishType: item.publishType,
        publishOneType: item.publishOneType,
        sfactApplColumn5: "PC"
      })
    });
    if (!response.ok) throw new Error(`detail ${response.status}`);
    const data = (await response.json())?.data || {};
    const content = data.noticeContent || data.content || "";
    const contentType = String(data.contentType || "").toLowerCase();
    if (!content) return new Response("document unavailable", { status: 404 });

    if (contentType === "pdf") {
      return new Response(decodeBase64(content), {
        headers: {
          "content-type": "application/pdf",
          "cache-control": "public, max-age=86400",
          "content-disposition": `inline; filename="${item.id}.pdf"`
        }
      });
    }
    return new Response(content, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=86400"
      }
    });
  } catch (error) {
    return new Response(String(error?.message || error), { status: 502 });
  }
}

function upstreamHeaders() {
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    origin: "https://b2b.10086.cn",
    referer: "https://b2b.10086.cn/b2b/main/listVendorNotice.html?noticeType=2",
    processInstId: "-1",
    userLoginName: "-1"
  };
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : "";
}

function json(data, status = 200, cacheControl = "public, max-age=300") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl
    }
  });
}
