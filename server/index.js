export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/notices") return getNotices(url);
    if (url.pathname === "/api/document") return getDocument(url);
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

const LIST_API = "https://b2b.10086.cn/api-b2b/api-sync-es/white_list_api/b2b/publish/queryList";
const DETAIL_API = "https://b2b.10086.cn/api-b2b/api-sync-es/white_list_api/b2b/publish/queryDetail";
const REGIONS = ["浙江", "江西", "福建"];

async function getNotices(url) {
  try {
    const endDate = validDate(url.searchParams.get("endDate")) || new Date().toISOString().slice(0, 10);
    const startDate = validDate(url.searchParams.get("startDate")) || endDate;
    if (startDate > endDate) return json({ notices: [], error: "invalid_date_range" }, 400);

    const collected = [];
    let reachedStart = false;
    for (let current = 1; current <= 10 && !reachedStart; current++) {
      const content = await fetchList(current);
      if (!content.length) break;
      for (const item of content) {
        const date = String(item.publishDate || "").slice(0, 10);
        if (date && date < startDate) {
          reachedStart = true;
          continue;
        }
        if (date && date <= endDate) collected.push(item);
      }
    }

    const notices = collected.filter(isTargetNotice).slice(0, 50).map(toNotice);
    return json({ notices, fetchedAt: new Date().toISOString(), scannedCount: collected.length });
  } catch (error) {
    return json({ notices: [], fetchedAt: new Date().toISOString(), error: "upstream_unavailable", message: String(error?.message || error) }, 502);
  }
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

async function fetchList(current) {
  const response = await fetch(LIST_API, {
    method: "POST",
    headers: upstreamHeaders(),
    body: JSON.stringify({
      name: "",
      publishType: "PROCUREMENT",
      publishOneType: "PROCUREMENT",
      publishOneTypes: ["PROCUREMENT"],
      purchaseType: "",
      companyType: "",
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
  const subtype = `${item.publishOneType || ""} ${item.publishOneType_dictText || ""}`;
  const procurement = /PROCUREMENT|采购公告|招标公告|询比公告|谈判采购公告/.test(subtype);
  const result = /候选人|中选结果|中标结果|采购结果|流标|废标|失败公告|终止公告|公示/.test(item.name || "");
  return region && procurement && !result;
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
    title: item.name || "未命名采购公告",
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300"
    }
  });
}
