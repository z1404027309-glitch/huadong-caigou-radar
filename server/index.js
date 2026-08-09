export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/notices") return getNotices(url, env);
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

const LIST_API = "https://b2b.10086.cn/api-b2b/api-sync-es/white_list_api/b2b/publish/queryList";
const DETAIL_API = "https://b2b.10086.cn/api-b2b/api-sync-es/white_list_api/b2b/publish/queryDetail";
const REGIONS = ["浙江", "江西", "福建"];

async function getNotices(url, env) {
  const endDate = validDate(url.searchParams.get("endDate")) || new Date().toISOString().slice(0, 10);
  const startDate = validDate(url.searchParams.get("startDate")) || endDate;
  if (startDate > endDate) return json({ notices: [], error: "invalid_date_range" }, 400);

  const notices = [];
  const errors = [];
  try {
    const collected = [];
    let reachedStart = false;
    const mobileCategories = [
      { category: "采购公告", publishType: "PROCUREMENT", publishOneType: "PROCUREMENT" },
      { category: "直接采购公告", publishType: "PROCUREMENT", publishOneType: "ONE_SOURCE_PROCUREMENT" },
      { category: "采购意见征求公告", publishType: "PURCHASE_SERVICE", publishOneType: "PURCHASE_OPINION" }
    ];
    for (const config of mobileCategories) {
     reachedStart = false;
     for (let current = 1; current <= 10 && !reachedStart; current++) {
      const content = await fetchList(current, startDate, endDate, config);
      if (!content.length) break;
      for (const item of content) {
        const date = String(item.publishDate || "").slice(0, 10);
        if (date && date < startDate) {
          reachedStart = true;
          continue;
        }
        if (date && date <= endDate) collected.push({ ...item, category: config.category });
      }
     }
    }

    notices.push(...collected.filter(isTargetNotice).map(toNotice));
  } catch (error) {
    errors.push(`mobile: ${String(error?.message || error)}`);
  }

  const archives = {};
  for (const source of ["unicom", "tower", "telecom"]) {
    try {
      const assetUrl = new URL(`/data/${source}-notices.json`, url.origin);
      const response = await env.ASSETS.fetch(new Request(assetUrl));
      if (!response.ok) throw new Error(`archive ${response.status}`);
      const archive = await response.json();
      archives[source] = archive.fetchedAt || "";
      notices.push(...(archive.notices || []).filter((item) =>
        item.date >= startDate && item.date <= endDate
      ).map(normalizeCategory));
    } catch (error) {
      errors.push(`${source}: ${String(error?.message || error)}`);
    }
  }

  notices.sort((a, b) => `${b.date} ${b.createDate || ""}`.localeCompare(`${a.date} ${a.createDate || ""}`));
  return json({
    notices,
    fetchedAt: new Date().toISOString(),
    unicomFetchedAt: archives.unicom || "",
    towerFetchedAt: archives.tower || "",
    telecomFetchedAt: archives.telecom || "",
    errors
  }, notices.length || !errors.length ? 200 : 502);
}

function normalizeCategory(item) {
  if (item.category) return item;
  const title = item.title || "";
  let category = "采购公告";
  if (item.operator === "中国联通") category = /采购需求/.test(title) ? "采购需求公示" : /招标/.test(title) ? "招标公告" : "询比公告";
  if (item.operator === "中国电信") category = /资格预审/.test(title) ? "资格预审公告" : /招标/.test(title) ? "招标公告" : "询比公告";
  if (item.operator === "中国铁塔") category = String(item.noticeType) === "49" || /预公告|采购计划发布/.test(title) ? "采购项目预公告" : "采购公告";
  return { ...item, category };
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

async function fetchList(current, startDate, endDate, config) {
  const response = await fetch(LIST_API, {
    method: "POST",
    headers: upstreamHeaders(),
    body: JSON.stringify({
      name: "",
      publishType: config.publishType,
      publishOneType: config.publishOneType,
      publishOneTypes: [config.publishOneType],
      purchaseType: "",
      companyType: "",
      creationDateStart: startDate,
      creationDateEnd: endDate,
      size: 100,
      current,
      sfactApplColumn5: "PC"
    })
  });
  if (!response.ok) throw new Error(`list ${response.status}`);
  const payload = await response.json();
  return payload?.data?.content || payload?.data?.records || [];
}

function isTargetNotice(item) {
  const text = `${item.name || ""} ${item.companyTypeName || ""}`;
  const region = REGIONS.some((name) => text.includes(name));
  return region && ["采购公告", "直接采购公告", "采购意见征求公告"].includes(item.category);
}

function toNotice(item) {
  const regionText = `${item.name || ""} ${item.companyTypeName || ""}`;
  const region = REGIONS.find((name) => regionText.includes(name));
  const params = new URLSearchParams({
    publishId: String(item.id || ""),
    publishUuid: item.uuid || "",
    publishType: item.publishType || "PROCUREMENT",
    publishOneType: item.publishOneType || "PROCUREMENT"
  });
  return {
    id: String(item.id || item.uuid),
    publishId: String(item.id || ""),
    publishUuid: item.uuid || "",
    publishType: item.publishType || "PROCUREMENT",
    publishOneType: item.publishOneType || "PROCUREMENT",
    category: item.category || item.publishOneType_dictText || "采购公告",
    title: item.name || "未命名采购公告",
    operator: "中国移动",
    sourceName: "中国移动采购与招标网",
    region,
    date: String(item.publishDate || "").split(" ")[0],
    url: `https://b2b.10086.cn/#/noticeDetail?${params}`
  };
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
