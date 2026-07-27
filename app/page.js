"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const SOURCE = "https://b2b.10086.cn/b2b/main/listVendorNotice.html?noticeType=2#/biddingProcurementBulletin";
const regions = ["全部", "浙江", "江西", "福建"];
const colors = { 浙江: "#0f766e", 江西: "#b45309", 福建: "#2563eb" };

let paddlePromise;

export default function Home() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const [region, setRegion] = useState("全部");
  const [query, setQuery] = useState("");
  const [startDate, setStartDate] = useState(weekAgo);
  const [endDate, setEndDate] = useState(today);
  const [notices, setNotices] = useState([]);
  const [status, setStatus] = useState("loading");
  const [fetchedAt, setFetchedAt] = useState("");
  const requestId = useRef(0);

  async function refresh() {
    const currentRequest = ++requestId.current;
    setStatus("loading");
    setNotices([]);
    try {
      const params = new URLSearchParams({ startDate, endDate });
      const response = await fetch(`/api/notices?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("source unavailable");
      const data = await response.json();
      const list = (data.notices || []).map((item) => ({ ...item, extractionStatus: "等待识别" }));
      if (currentRequest !== requestId.current) return;
      setNotices(list);
      setFetchedAt(data.fetchedAt || new Date().toISOString());
      setStatus(list.length ? "live" : "empty");
      void enrichAll(list, currentRequest);
    } catch {
      if (currentRequest === requestId.current) setStatus("unavailable");
    }
  }

  async function enrichAll(list, currentRequest) {
    let cursor = 0;
    const worker = async () => {
      while (cursor < list.length && currentRequest === requestId.current) {
        const item = list[cursor++];
        updateNotice(item.id, { extractionStatus: "正在读取公告…" });
        try {
          const result = await recognizeNotice(item);
          updateNotice(item.id, { ...result, extractionStatus: result.method === "ocr" ? "PaddleOCR 已识别" : "PDF 文字已提取" });
        } catch (error) {
          updateNotice(item.id, { extractionStatus: "暂未识别，可点击重试", extractionError: String(error?.message || error) });
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }

  function updateNotice(id, patch) {
    setNotices((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  async function retry(item) {
    updateNotice(item.id, { extractionStatus: "正在重新识别…" });
    try {
      const result = await recognizeNotice(item, true);
      updateNotice(item.id, { ...result, extractionStatus: result.method === "ocr" ? "PaddleOCR 已识别" : "PDF 文字已提取" });
    } catch (error) {
      updateNotice(item.id, { extractionStatus: "识别失败，请稍后重试", extractionError: String(error?.message || error) });
    }
  }

  useEffect(() => { refresh(); }, []);

  const filtered = useMemo(() => notices.filter((item) => {
    const regionOk = region === "全部" || item.region === region;
    const queryOk = !query.trim() || `${item.title} ${item.region} ${item.purchaseContent || ""}`.toLowerCase().includes(query.trim().toLowerCase());
    return regionOk && queryOk;
  }), [notices, query, region]);

  const counts = useMemo(() => Object.fromEntries(regions.map((name) => [
    name,
    name === "全部" ? notices.length : notices.filter((n) => n.region === name).length
  ])), [notices]);

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#">华东采购公告雷达</a>
        <a className="source-link" href={SOURCE} target="_blank" rel="noreferrer">访问原始公告 →</a>
      </header>

      <section className="hero">
        <div className="eyebrow"><span /> 中国移动采购与招标网 · 智能筛选</div>
        <h1>三省商机，<em>一屏掌握</em></h1>
        <p>聚焦浙江、江西、福建采购公告。自动读取 PDF 文字，图片公告由免费的 PaddleOCR.js 在浏览器本地识别。</p>
        <div className="search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"/></svg>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索项目名称、采购内容或关键词…" />
          {query && <button onClick={() => setQuery("")}>清除</button>}
        </div>
        <div className="date-bar">
          <label><span>开始日期</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
          <i>至</i>
          <label><span>结束日期</span><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
          <button onClick={refresh} disabled={status === "loading"}>查询公告</button>
        </div>
      </section>

      <section className="dashboard">
        <aside>
          <div className="aside-title">地区筛选</div>
          <div className="filters">
            {regions.map((name) => (
              <button className={region === name ? "active" : ""} onClick={() => setRegion(name)} key={name}>
                <span className="dot" style={{ background: name === "全部" ? "#111827" : colors[name] }} />
                <span>{name}</span><b>{counts[name]}</b>
              </button>
            ))}
          </div>
          <div className="tip">
            <span>识别说明</span>
            优先读取 PDF 文字层；纯图片公告才会启动 PaddleOCR。首次 OCR 需加载中文模型，可能稍慢。
          </div>
        </aside>

        <div className="content">
          <div className="list-head">
            <div>
              <h2>{region === "全部" ? "全部采购公告" : `${region}采购公告`}</h2>
              <p>{status === "loading" ? "正在连接数据源…" : `找到 ${filtered.length} 条结果`}</p>
            </div>
            <button className="refresh" onClick={refresh} disabled={status === "loading"}>
              <span className={status === "loading" ? "spin" : ""}>↻</span> 刷新
            </button>
          </div>

          {status === "loading" && <Loading />}
          {status !== "loading" && filtered.length > 0 && (
            <div className="notice-list">
              {filtered.map((item) => (
                <article className="notice" key={item.id}>
                  <div className="notice-top">
                    <span className="region" style={{ color: colors[item.region], background: `${colors[item.region]}12` }}>{item.region}</span>
                    {item.date && <time>{item.date}</time>}
                    <span className={`extract-state ${item.extractionStatus?.includes("正在") ? "working" : ""}`}>{item.extractionStatus}</span>
                  </div>
                  <h3>{item.title}</h3>
                  <div className="detail-grid">
                    <Detail label="采购内容" value={item.purchaseContent} wide />
                    <Detail label="采购预算金额" value={item.budget} />
                    <Detail label="采购文件售卖时间" value={item.saleTime} />
                    <Detail label="应答截止时间" value={item.deadline} />
                    <Detail label="应答人资格" value={item.qualification} wide />
                    <Detail label="业绩要求" value={item.performance} wide />
                  </div>
                  <div className="notice-foot">
                    <span>中国移动采购与招标网</span>
                    <div>
                      {item.extractionStatus?.includes("重试") || item.extractionStatus?.includes("失败") ?
                        <button className="retry" onClick={() => retry(item)}>重新识别</button> : null}
                      <a href={item.url} target="_blank" rel="noreferrer">查看原公告 →</a>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
          {status !== "loading" && filtered.length === 0 && (
            <div className="empty">
              <div className="radar"><span /><i /></div>
              <h3>{query ? "没有匹配的公告" : status === "unavailable" ? "数据源暂时未响应" : "该日期暂无三省采购公告"}</h3>
              <p>{query ? "请更换关键词或地区。" : "可以稍后重试，或前往中国移动采购与招标网查看。"}</p>
              <div className="empty-actions">
                <button onClick={refresh}>重新获取</button>
                <a href={SOURCE} target="_blank" rel="noreferrer">前往原站 →</a>
              </div>
            </div>
          )}
          <footer>
            <span>{fetchedAt ? `最近更新：${new Date(fetchedAt).toLocaleString("zh-CN", { hour12: false })}` : "等待首次更新"}</span>
            <span>识别结果供商机筛选，正式投标请复核原公告</span>
          </footer>
        </div>
      </section>
    </main>
  );
}

function Loading() {
  return <div className="skeletons">{[1, 2, 3, 4].map((n) => <div className="skeleton" key={n}><i /><b /><span /></div>)}</div>;
}

function Detail({ label, value, wide }) {
  return <div className={wide ? "detail wide" : "detail"}><span>{label}</span><p>{value || "正在识别或公告未单独列示"}</p></div>;
}

async function recognizeNotice(item, force = false) {
  const cacheKey = `notice-fields:v3:${item.id}`;
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey));
      if (cached) return cached;
    } catch {}
  }

  const params = new URLSearchParams({
    publishId: item.publishId,
    publishUuid: item.publishUuid || "",
    publishType: item.publishType || "PROCUREMENT",
    publishOneType: item.publishOneType || "PROCUREMENT"
  });
  const response = await fetch(`/api/document?${params}`, { cache: "force-cache" });
  if (!response.ok) throw new Error("公告正文获取失败");
  const type = response.headers.get("content-type") || "";
  let text = "";
  let method = "text";

  if (type.includes("pdf")) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    const pdf = await pdfjs.getDocument({ data: bytes }).promise;
    text = await extractPdfText(pdf);
    if (text.replace(/\s/g, "").length < 180) {
      method = "ocr";
      text = await ocrPdf(pdf);
    }
  } else {
    text = stripHtml(await response.text());
  }

  const result = { ...extractFields(text), method };
  try { localStorage.setItem(cacheKey, JSON.stringify(result)); } catch {}
  return result;
}

async function extractPdfText(pdf) {
  const pages = [];
  for (let index = 1; index <= pdf.numPages; index++) {
    const page = await pdf.getPage(index);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => `${item.str}${item.hasEOL ? "\n" : " "}`).join(""));
  }
  return pages.join("\n");
}

async function ocrPdf(pdf) {
  paddlePromise ||= import("@paddleocr/paddleocr-js").then(({ PaddleOCR }) =>
    PaddleOCR.create({ lang: "ch", ocrVersion: "PP-OCRv5", ortOptions: { backend: "auto" } })
  );
  const ocr = await paddlePromise;
  const pages = [];
  for (let index = 1; index <= Math.min(pdf.numPages, 4); index++) {
    const page = await pdf.getPage(index);
    const viewport = page.getViewport({ scale: 1.7 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    const [result] = await ocr.predict(blob);
    pages.push((result?.items || []).map((entry) => entry.text || entry.recText || entry.value || "").join("\n"));
  }
  return pages.join("\n");
}

function extractFields(source) {
  const text = normalize(source);
  const qualificationSection = getSection(text, /(?:二|2)[、.．]\s*(?:资格要求|投标人资格要求|应答人资格要求)/, /(?:三|3)[、.．]\s*(?:获取|采购文件|招标文件)/);
  return {
    purchaseContent: extractPurchaseContent(text),
    budget: extractBudget(text),
    saleTime: extractDateRange(text),
    deadline: extractDeadline(text),
    qualification: extractRequirement(qualificationSection, ["应答人资格", "投标人资格", "供应商资格"], true),
    performance: extractRequirement(qualificationSection, ["业绩要求", "合同业绩", "同类合同"], false) || "公告资格条款中未单列业绩要求"
  };
}

function extractPurchaseContent(text) {
  const labeled = extractPurchaseParagraph(text, ["采购内容", "项目需求", "招标内容"]);
  if (labeled) return labeled;
  return "公告未明确列示";
}

function extractPurchaseParagraph(text, labels) {
  for (const label of labels) {
    const index = text.indexOf(label);
    if (index < 0) continue;
    const tail = text.slice(index + label.length, index + label.length + 1400)
      .replace(/^\s*[：:、.]?\s*/, "");
    const stop = tail.search(/\n\s*(?:\d+\.\d+|（\d+）|\(\d+\)|[一二三四五六七八九十]+[、.．])\s*/);
    const value = singleRequirement(stop > 15 ? tail.slice(0, stop) : tail);
    if (value.length > 8) return value;
  }
  return "";
}

function singleRequirement(value) {
  const normalized = normalize(value);
  if (!normalized) return "";
  const nextItem = normalized.search(/\n\s*(?:\d+\.\d+|（\d+）|\(\d+\))\s*/);
  return clean(nextItem > 20 ? normalized.slice(0, nextItem) : normalized).slice(0, 700);
}

function extractBudget(text) {
  const labels = ["项目预算金额", "采购预算金额", "预算总金额", "预算金额"];
  for (const label of labels) {
    const index = text.indexOf(label);
    if (index < 0) continue;
    const tail = text.slice(index + label.length, index + label.length + 260);
    const stop = tail.search(/\n\s*(?:\d+\.\d+|（\d+）|\(\d+\)|[一二三四五六七八九十]+[、.．])\s*/);
    const field = stop > 5 ? tail.slice(0, stop) : tail;
    const amount = extractMoney(field);
    if (amount) return amount;
  }
  return "公告未明确列示";
}

function extractMoney(value) {
  const compact = String(value || "").replace(/\s+/g, "");
  const untaxed = compact.match(/不含税[^0-9]{0,30}(?:[（(](万元|亿元|元)[）)])?[^0-9]{0,12}([0-9][\d,.]*)(?:[（(](万元|亿元|元)[）)]|(万元|亿元|元))?/);
  if (untaxed) return formatMoney(untaxed[2], untaxed[3] || untaxed[4] || untaxed[1]);
  const amount = compact.match(/([0-9][\d,.]*)(?:[（(](万元|亿元|元)[）)]|(万元|亿元|元))/);
  return amount ? formatMoney(amount[1], amount[2] || amount[3]) : "";
}

function formatMoney(number, unit) {
  if (!number || !unit) return "";
  const normalized = number.includes(".")
    ? number.replace(/0+$/, "").replace(/\.$/, "")
    : number;
  return `${normalized}${unit}`;
}

function extractDateRange(text) {
  const compact = text.replace(/\s+/g, "");
  const match = compact.match(/(?:采购文件|招标文件)(?:售卖|获取|发售)?时间(?:为|：|:)?(\d{4}年\d{1,2}月\d{1,2}日\d{1,2}时\d{1,2}分(?:至|到)\d{4}年\d{1,2}月\d{1,2}日\d{1,2}时\d{1,2}分)/);
  return match?.[1] || "公告未单独列示";
}

function extractDeadline(text) {
  const compact = text.replace(/\s+/g, "");
  const match = compact.match(/(?:应答|投标)(?:文件)?截止时间(?:为|：|:)?(\d{4}年\d{1,2}月\d{1,2}日\d{1,2}时\d{1,2}分)/);
  return match?.[1] || "公告未单独列示";
}

function extractRequirement(section, labels, first) {
  if (!section) return first ? "公告未单独列示" : "";
  const number = "(?:（\\d+）|\\(\\d+\\)|\\d+(?:\\.\\d+)+|\\d+\\.)";
  const items = section.match(new RegExp(`(?:^|\\n)\\s*${number}[、.．]?\\s*.+?(?=\\n\\s*${number}[、.．]?\\s*|$)`, "gs")) || [];
  const found = items.find((item) => labels.some((label) => item.includes(label)));
  return clean(found || (first ? items[0] : "")).slice(0, 700);
}

function extractLabeled(text, labels, limit) {
  for (const label of labels) {
    const index = text.indexOf(label);
    if (index < 0) continue;
    const tail = text.slice(index, index + limit);
    const stop = tail.slice(label.length).search(/\n\s*\d+(?:\.\d+)+|\n\s*[一二三四五六七八九十]+、/);
    return clean(stop > 10 ? tail.slice(0, label.length + stop) : tail);
  }
  return "";
}

function getSection(text, startPattern, endPattern) {
  const start = text.search(startPattern);
  if (start < 0) return "";
  const tail = text.slice(start);
  const end = tail.search(endPattern);
  return end > 0 ? tail.slice(0, end) : tail.slice(0, 5000);
}

function stripHtml(value) {
  return normalize(value.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&"));
}

function normalize(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

function clean(value) {
  return normalize(value).slice(0, 1800);
}
