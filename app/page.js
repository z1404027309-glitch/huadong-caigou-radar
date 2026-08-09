"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const SOURCE = "https://b2b.10086.cn/b2b/main/listVendorNotice.html?noticeType=2#/biddingProcurementBulletin";
const regions = ["全部", "浙江", "江西", "福建"];
const colors = { 浙江: "#0f766e", 江西: "#b45309", 福建: "#2563eb" };
const operators = ["全部运营商", "中国移动", "中国联通", "中国铁塔", "中国电信"];
const categories = ["全部类别", "采购公告", "直接采购公告", "采购意见征求公告", "采购需求公示", "询比公告", "招标公告", "资格预审公告", "采购项目预公告"];
const scoringTypes = [
  { value: "keyword", label: "关键词匹配", parameterLabel: "满分命中数", defaultParameter: 3 },
  { value: "budget", label: "预算区间", parameterLabel: "满分预算（万元）", defaultParameter: 1000 },
  { value: "deadline", label: "剩余截止天数", parameterLabel: "满分天数", defaultParameter: 8 },
  { value: "target", label: "省份与运营商", parameterLabel: "省份|运营商", defaultParameter: "浙江,江西,福建|中国移动,中国联通,中国铁塔,中国电信" },
  { value: "advantage", label: "重点分类匹配", parameterLabel: "满分命中数", defaultParameter: 1 },
  { value: "threshold", label: "资格业绩门槛", parameterLabel: "评分说明", defaultParameter: "门槛越低得分越高" }
];
const defaultScoringCriteria = [
  { id: "keyword", name: "关键词匹配度", type: "keyword", maxScore: 30, enabled: true, parameter: 3 },
  { id: "budget", name: "项目预算", type: "budget", maxScore: 25, enabled: true, parameter: 1000 },
  { id: "deadline", name: "截止时间充足度", type: "deadline", maxScore: 15, enabled: true, parameter: 8 },
  { id: "target", name: "目标省份和运营商", type: "target", maxScore: 10, enabled: true, parameter: "浙江,江西,福建|中国移动,中国联通,中国铁塔,中国电信" },
  { id: "advantage", name: "历史优势领域", type: "advantage", maxScore: 10, enabled: true, parameter: 1 },
  { id: "threshold", name: "资格及业绩门槛", type: "threshold", maxScore: 10, enabled: true, parameter: "门槛越低得分越高" }
];

let paddlePromise;

export default function Home() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const [region, setRegion] = useState("全部");
  const [operator, setOperator] = useState("全部运营商");
  const [category, setCategory] = useState("全部类别");
  const [query, setQuery] = useState("");
  const [startDate, setStartDate] = useState(weekAgo);
  const [endDate, setEndDate] = useState(today);
  const [notices, setNotices] = useState([]);
  const [status, setStatus] = useState("loading");
  const [fetchedAt, setFetchedAt] = useState("");
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [activeView, setActiveView] = useState("dashboard");
  const [focusRules, setFocusRules] = useState([]);
  const [focusGroups, setFocusGroups] = useState([]);
  const [ruleName, setRuleName] = useState("");
  const [ruleKeywords, setRuleKeywords] = useState("");
  const [ruleOperator, setRuleOperator] = useState("全部运营商");
  const [ruleGroupId, setRuleGroupId] = useState("");
  const [groupName, setGroupName] = useState("");
  const [rulesStatus, setRulesStatus] = useState("loading");
  const [scoringCriteria, setScoringCriteria] = useState(defaultScoringCriteria);
  const [scoringStatus, setScoringStatus] = useState("loading");
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
      const list = (data.notices || []).map((item) => ({
        ...item,
        extractionStatus: item.fieldsReady ? "公告文字已提取" : "等待识别"
      }));
      if (currentRequest !== requestId.current) return;
      setNotices(list);
      setFetchedAt(data.fetchedAt || new Date().toISOString());
      setStatus(list.length ? "live" : "empty");
      void enrichAll(list.filter((item) => !item.fieldsReady), currentRequest);
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

  async function exportExcel() {
    if (!filtered.length || exporting) return;
    setExporting(true);
    try {
      const { default: writeXlsxFile } = await import("write-excel-file/browser");
      const headers = ["公告日期", "省份", "运营商", "公告类别", "项目名称", "采购内容", "采购预算金额", "采购文件售卖时间", "应答截止时间", "应答人资格", "业绩要求", "原公告链接"];
      const value = (item, key) => item[key] || "公告未明确列示";
      const provinceOrder = { "浙江": 0, "江西": 1, "福建": 2 };
      const sortedNotices = [...filtered].sort((a, b) =>
        (provinceOrder[a.region] ?? 99) - (provinceOrder[b.region] ?? 99)
        || String(b.date || "").localeCompare(String(a.date || ""))
      );
      const cellStyle = {
        align: "center",
        alignVertical: "center",
        wrap: true,
        borderStyle: "thin",
        borderColor: "#BFC7C2"
      };
      const cell = (cellValue, extra = {}) => ({ value: cellValue, ...cellStyle, ...extra });
      const rows = [
        headers.map((title) => cell(title, { fontWeight: "bold", backgroundColor: "#E4EBE5" })),
        ...sortedNotices.map((item) => [
          cell(item.date || ""),
          cell(item.region || ""),
          cell(item.operator || "中国移动"),
          cell(item.category || "采购公告"),
          cell(item.title || ""),
          cell(value(item, "purchaseContent")),
          cell(value(item, "budget")),
          cell(value(item, "saleTime")),
          cell(value(item, "deadline")),
          cell(value(item, "qualification")),
          cell(value(item, "performance")),
          cell(item.url || "")
        ])
      ];
    const workbook = writeXlsxFile(rows, {
      sheet: "东南三省运营商公告",
      columns: [
          { width: 14 }, { width: 10 }, { width: 12 }, { width: 16 }, { width: 42 }, { width: 48 }, { width: 18 },
          { width: 25 }, { width: 22 }, { width: 48 }, { width: 48 }, { width: 45 }
        ]
      });
    await workbook.toFile(`东南三省运营商公告_${startDate}_${endDate}.xlsx`);
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    refresh();
    void loadFocusRules();
    void loadScoringSettings();
  }, []);

  async function loadScoringSettings() {
    setScoringStatus("loading");
    try {
      const response = await fetch("/api/scoring-settings", { cache: "no-store" });
      if (!response.ok) throw new Error("settings unavailable");
      const data = await response.json();
      setScoringCriteria(Array.isArray(data.criteria) && data.criteria.length ? data.criteria : defaultScoringCriteria);
      setScoringStatus("ready");
    } catch {
      setScoringCriteria(defaultScoringCriteria);
      setScoringStatus("error");
    }
  }

  function updateScoringCriterion(id, patch) {
    setScoringCriteria((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function changeScoringType(id, type) {
    const definition = scoringTypes.find((item) => item.value === type);
    updateScoringCriterion(id, { type, parameter: definition?.defaultParameter ?? "" });
  }

  function addScoringCriterion() {
    setScoringCriteria((current) => [...current, {
      id: `criterion-${Date.now()}`,
      name: "新的评分项",
      type: "keyword",
      maxScore: 0,
      enabled: true,
      parameter: 3
    }]);
  }

  async function saveScoringSettings() {
    const total = scoringCriteria.filter((item) => item.enabled).reduce((sum, item) => sum + Number(item.maxScore || 0), 0);
    if (total !== 100 || scoringCriteria.some((item) => !item.name.trim())) return;
    setScoringStatus("saving");
    try {
      const response = await fetch("/api/scoring-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ criteria: scoringCriteria })
      });
      if (!response.ok) throw new Error("save failed");
      const data = await response.json();
      setScoringCriteria(data.criteria);
      setScoringStatus("saved");
      setTimeout(() => setScoringStatus("ready"), 1600);
    } catch {
      setScoringStatus("error");
    }
  }

  async function loadFocusRules() {
    setRulesStatus("loading");
    try {
      const response = await fetch("/api/focus-rules", { cache: "no-store" });
      if (!response.ok) throw new Error("rules unavailable");
      const data = await response.json();
      const groups = Array.isArray(data.groups) ? data.groups : [];
      const rules = groups.flatMap((group) => (group.rules || []).map((rule) => ({ ...rule, groupName: group.name })));
      setFocusGroups(groups);
      setFocusRules(rules);
      setRuleGroupId((current) => current || groups[0]?.id || "");
      setRulesStatus("ready");
    } catch {
      setRulesStatus("error");
    }
  }

  async function addFocusRule(name = ruleName, keywords = ruleKeywords, selectedOperator = ruleOperator, selectedGroupId = ruleGroupId) {
    const keywordList = String(keywords).split(/[，,、]/).map((value) => value.trim()).filter(Boolean);
    if (!name.trim() || !keywordList.length) return;
    setRulesStatus("saving");
    try {
      const response = await fetch("/api/focus-rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), keywords: keywordList, operator: selectedOperator, groupId: selectedGroupId })
      });
      if (!response.ok) throw new Error("save failed");
      const data = await response.json();
      const selectedGroup = focusGroups.find((group) => group.id === selectedGroupId);
      const addedRule = { ...data.rule, groupName: selectedGroup?.name || "未分类" };
      setFocusRules((current) => [...current, addedRule]);
      setFocusGroups((current) => current.map((group) => group.id === selectedGroupId ? { ...group, rules: [...(group.rules || []), data.rule] } : group));
      setRuleName("");
      setRuleKeywords("");
      setRulesStatus("ready");
    } catch {
      setRulesStatus("error");
    }
  }

  async function removeFocusRule(id) {
    setRulesStatus("saving");
    try {
      const response = await fetch(`/api/focus-rules?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("delete failed");
      setFocusRules((current) => current.filter((rule) => rule.id !== id));
      setFocusGroups((current) => current.map((group) => ({ ...group, rules: (group.rules || []).filter((rule) => rule.id !== id) })));
      setRulesStatus("ready");
    } catch {
      setRulesStatus("error");
    }
  }

  async function addFocusGroup() {
    if (!groupName.trim()) return;
    setRulesStatus("saving");
    try {
      const response = await fetch("/api/focus-rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "group", name: groupName.trim() })
      });
      if (!response.ok) throw new Error("save failed");
      const data = await response.json();
      setFocusGroups((current) => [...current, data.group]);
      setRuleGroupId(data.group.id);
      setGroupName("");
      setRulesStatus("ready");
    } catch {
      setRulesStatus("error");
    }
  }

  async function removeFocusGroup(id) {
    setRulesStatus("saving");
    try {
      const response = await fetch(`/api/focus-rules?type=group&id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("delete failed");
      const nextGroups = focusGroups.filter((group) => group.id !== id);
      setFocusGroups(nextGroups);
      setFocusRules((current) => current.filter((rule) => rule.groupId !== id));
      if (ruleGroupId === id) setRuleGroupId(nextGroups[0]?.id || "");
      setRulesStatus("ready");
    } catch {
      setRulesStatus("error");
    }
  }

  const filtered = useMemo(() => notices.filter((item) => {
    const regionOk = region === "全部" || item.region === region;
    const operatorOk = operator === "全部运营商" || item.operator === operator;
    const categoryOk = category === "全部类别" || item.category === category;
    const queryOk = !query.trim() || `${item.title} ${item.region} ${item.purchaseContent || ""}`.toLowerCase().includes(query.trim().toLowerCase());
    return regionOk && operatorOk && categoryOk && queryOk;
  }), [notices, query, region, operator, category]);

  const counts = useMemo(() => {
    const scoped = notices.filter((item) => {
      const operatorOk = operator === "全部运营商" || item.operator === operator;
      const categoryOk = category === "全部类别" || item.category === category;
      const queryOk = !query.trim() || `${item.title} ${item.region} ${item.purchaseContent || ""}`.toLowerCase().includes(query.trim().toLowerCase());
      return operatorOk && categoryOk && queryOk;
    });
    return Object.fromEntries(regions.map((name) => [name, name === "全部" ? scoped.length : scoped.filter((n) => n.region === name).length]));
  }, [notices, operator, category, query]);
  const operatorCounts = useMemo(() => {
    const scoped = notices.filter((item) => {
      const regionOk = region === "全部" || item.region === region;
      const categoryOk = category === "全部类别" || item.category === category;
      const queryOk = !query.trim() || `${item.title} ${item.region} ${item.purchaseContent || ""}`.toLowerCase().includes(query.trim().toLowerCase());
      return regionOk && categoryOk && queryOk;
    });
    return Object.fromEntries(operators.map((name) => [name, name === "全部运营商" ? scoped.length : scoped.filter((n) => n.operator === name).length]));
  }, [notices, region, category, query]);
  const recognitionPending = notices.some((item) =>
    item.extractionStatus?.includes("等待") || item.extractionStatus?.includes("正在")
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleNotices = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const pageNumbers = paginationNumbers(currentPage, pageCount);
  const todayNotices = useMemo(() => notices.filter((item) => item.date === today), [notices, today]);
  const todayOperatorCounts = useMemo(() => Object.fromEntries(
    operators.slice(1).map((name) => [name, todayNotices.filter((item) => item.operator === name).length])
  ), [todayNotices]);
  const focusMatches = useMemo(() => focusRules.map((rule) => {
    const matches = notices.filter((item) => {
      const operatorOk = rule.operator === "全部运营商" || item.operator === rule.operator;
      const haystack = `${item.title || ""} ${item.purchaseContent || ""}`.toLowerCase();
      return operatorOk && rule.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
    });
    return { ...rule, matches };
  }), [focusRules, notices]);
  const focusNotices = useMemo(() => {
    const found = new Map();
    focusMatches.forEach((rule) => rule.matches.forEach((item) => {
      const current = found.get(item.id) || { ...item, focusNames: [] };
      current.focusNames = [...new Set([...current.focusNames, `${rule.groupName || "重点"} · ${rule.name}`])];
      found.set(item.id, current);
    }));
    return [...found.values()].sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).slice(0, 12);
  }, [focusMatches]);

  const scoredNotices = useMemo(() => notices.map((item) => scoreNotice(item, focusRules, scoringCriteria)), [notices, focusRules, scoringCriteria]);
  const todayBudget = useMemo(() => todayNotices.reduce((sum, item) => sum + parseBudget(item.budget), 0), [todayNotices]);
  const weekNotices = useMemo(() => notices.filter((item) => item.date >= weekAgo && item.date <= today), [notices, weekAgo, today]);
  const monthNotices = useMemo(() => notices.filter((item) => String(item.date || "").startsWith(today.slice(0, 7))), [notices, today]);
  const highRelevance = useMemo(() => scoredNotices.filter((item) => item.score >= 70).sort((a, b) => b.score - a.score), [scoredNotices]);
  const scoringTotal = scoringCriteria.filter((item) => item.enabled).reduce((sum, item) => sum + Number(item.maxScore || 0), 0);
  const trendDays = useMemo(() => buildTrend(notices), [notices]);
  const categoryStats = useMemo(() => buildCategoryStats(notices, focusGroups, focusRules), [notices, focusGroups, focusRules]);
  const provinceBudgets = useMemo(() => regions.slice(1).map((name) => ({ name, value: notices.filter((item) => item.region === name).reduce((sum, item) => sum + parseBudget(item.budget), 0) })), [notices]);
  const methodStats = useMemo(() => buildMethodStats(notices), [notices]);
  const deadlines = useMemo(() => scoredNotices.map((item) => ({ ...item, daysLeft: deadlineDays(item.deadline) })).filter((item) => item.daysLeft >= 0 && item.daysLeft <= 7).sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 5), [scoredNotices]);
  const completeness = useMemo(() => notices.map((item) => fieldCompleteness(item)), [notices]);
  const completeRate = completeness.length ? Math.round(completeness.reduce((sum, item) => sum + item.percent, 0) / completeness.length) : 0;
  const reviewCount = completeness.filter((item) => item.missing.length).length;
  const fastestCategory = categoryStats.slice().sort((a, b) => b.growth - a.growth)[0];

  useEffect(() => { setPage(1); }, [region, operator, category, query, startDate, endDate, pageSize]);

  const navItems = [{ id: "dashboard", icon: "▦", label: "首页看板" }, { id: "list", icon: "☷", label: "公告列表" }, { id: "settings", icon: "☷", label: "重点设置" }];

  return (
    <main className="app-shell">
      <aside className="side-nav">
        <button className="side-brand" onClick={() => setActiveView("dashboard")}><span className="brand-mark">◎</span><span><b>公告雷达</b><small>东南三省运营商</small></span></button>
        <p className="nav-caption">主导航</p>
        <nav aria-label="主导航">{navItems.map((item) => <button key={item.id} className={activeView === item.id ? "active" : ""} onClick={() => setActiveView(item.id)}><span>{item.icon}</span>{item.label}</button>)}</nav>
        <div className="sync-card"><b><i />数据同步正常</b><span>完整度 {completeRate}% · 待复核 {reviewCount} 条</span></div>
        <small className="version">v2.0 · 企业版</small>
      </aside>
      <div className="workspace">
        <header className="topbar"><div><span>首页</span><i>/</i><b>{activeView === "dashboard" ? "首页看板" : activeView === "list" ? "公告列表" : activeView === "ranking" ? "商机评分榜单" : "重点设置"}</b></div></header>
        <div className="workspace-body">

      {activeView === "dashboard" && (
        <section className="dashboard-page">
          <div className="page-title"><div><h1>今日商机总览</h1><p>{today} · 自动汇总三省四大运营商公告 · 最后更新 {fetchedAt ? new Date(fetchedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "--"}</p></div><div><button className="primary-action" onClick={() => setActiveView("list")}>查看全部公告</button></div></div>
          <div className="kpi-grid">
            <Kpi label="今日新增公告数" value={todayNotices.length} note={operators.slice(1).map((name) => `${name.replace("中国", "")}${todayOperatorCounts[name]}`).join(" · ")} />
            <Kpi label="今日新增预算总额" value={formatCurrency(todayBudget)} note={`来自 ${todayNotices.filter((item) => parseBudget(item.budget)).length} 条明确预算公告`} />
            <Kpi label="本周公告数" value={weekNotices.length} note={`${weekAgo} 至 ${today}`} />
            <Kpi label="当月公告数" value={monthNotices.length} note={today.slice(0, 7).replace("-", "年") + "月"} />
            <Kpi label="高相关项目" value={highRelevance.length} note="商机评分 ≥ 70" accent />
          </div>
          <div className="dashboard-grid dashboard-grid-refined">
            <Panel className="trend-panel compact-panel" title="市场趋势" subtitle="当前查询周期公告量走势"><div className="bar-chart">{trendDays.map((day) => <div className="bar-col" key={day.date} title={`${day.date}: ${day.count}条`}><i style={{ height: `${Math.max(8, day.height)}%` }} /><small>{day.label}</small></div>)}</div><div className="operator-strip">{operators.slice(1).map((name) => <span key={name}><i style={{ background: operatorColor(name) }} />{name} {operatorCounts[name]}</span>)}</div></Panel>
            <Panel title="商机评分 TOP 4" subtitle="按当前评分规则排序" action={<button onClick={() => setActiveView("ranking")}>更多 →</button>}><div className="score-list">{scoredNotices.slice().sort((a,b)=>b.score-a.score).slice(0,4).map((item)=><button key={item.id} onClick={()=>{setQuery(item.title);setActiveView("list")}}><span>{item.title}</span><i><b style={{width:`${item.score}%`}} /></i><strong>{item.score}</strong></button>)}</div></Panel>
            <Panel className="compact-panel" title="重点分类公告数" subtitle="按自定义大类统计"><MetricBars rows={categoryStats.slice(0,5).map((item)=>({label:item.name,value:item.count}))} /></Panel>
            <Panel title="截止时间临近" subtitle="未来 7 天内到期"><div className="deadline-list">{deadlines.length ? deadlines.map((item)=><a key={item.id} href={item.url} target="_blank" rel="noreferrer"><span><b>{item.title}</b><small>{item.operator} · {item.deadline}</small></span><em>剩 {item.daysLeft} 天</em></a>) : <EmptyMini text="当前无 7 天内到期项目" />}</div></Panel>
          </div>
          <div className="insight-grid">
            <Panel title="各省采购金额趋势" subtitle="仅统计公告明确列示金额"><MetricBars money rows={provinceBudgets.map((item)=>({label:item.name,value:item.value}))} /></Panel>
            <Panel title="采购方式结构" subtitle="招标、询比与直接采购比例"><div className="ratio-row">{methodStats.map((item)=><div key={item.name}><span>{item.name}</span><strong>{item.percent}%</strong><i><b style={{width:`${item.percent}%`}} /></i></div>)}</div></Panel>
            <Panel title="业务方向洞察" subtitle="重点分类增长与平均预算"><div className="business-insight"><p>本月增长最快</p><strong>{fastestCategory?.name || "暂无分类数据"}</strong><span>{fastestCategory ? `较前半周期 ${fastestCategory.growth >= 0 ? "+" : ""}${fastestCategory.growth}%` : "请先配置重点分类"}</span>{categoryStats.slice(0,3).map((item)=><small key={item.name}>{item.name} · 平均预算 {formatCurrency(item.avgBudget)}</small>)}</div></Panel>
          </div>
        </section>
      )}

      {activeView === "ranking" && (
        <section className="ranking-page">
          <div className="page-title"><div><span className="section-kicker">评分结果</span><h1>商机评分榜单</h1><p>按当前启用的评分项实时计算，共 {scoredNotices.length} 条公告</p></div><button className="secondary-action" onClick={() => setActiveView("dashboard")}>返回看板</button></div>
          <section className="ranking-panel">
            <div className="ranking-head"><span>排名</span><span>公告信息</span><span>评分明细</span><span>总分</span></div>
            {scoredNotices.slice().sort((a,b)=>b.score-a.score).map((item,index)=><article className="ranking-row" key={item.id}>
              <strong className={`rank-number ${index < 3 ? "top" : ""}`}>{index + 1}</strong>
              <div className="rank-info"><div><span>{item.region}</span><span>{item.operator}</span><span>{item.category}</span></div><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a></div>
              <div className="score-breakdown">{Object.entries(item.scoreParts).map(([id,part])=><span key={id}>{part.name} {part.score}/{part.maxScore}</span>)}</div>
              <strong className="rank-score">{item.score}</strong>
            </article>)}
          </section>
        </section>
      )}

      {activeView === "settings" && (
        <section className="settings-page b2b-settings">
          <div className="settings-head"><div><span className="section-kicker">公共关注与评分规则</span><h1>重点公告设置</h1><p>分类和评分规则保存在云端，保存后所有设备同步生效。</p></div><button className="secondary-action" onClick={() => setActiveView("dashboard")}>返回看板</button></div>
          <div className="settings-add-row">
            <section className="rule-builder add-group-card"><div><h2>添加大类</h2><p>建立业务方向，例如 AI与算力、工程建设。</p></div><div className="inline-add"><input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="输入新的大类名称" /><button onClick={addFocusGroup} disabled={rulesStatus === "saving"}>添加大类</button></div></section>
            <section className="rule-builder add-rule-card"><div><h2>添加细分类</h2><p>关键词会同时匹配公告标题和采购内容。</p></div><div className="quick-rule-form">
              <select aria-label="所属大类" value={ruleGroupId} onChange={(e) => setRuleGroupId(e.target.value)}>{focusGroups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}</select>
              <input aria-label="规则名称" value={ruleName} onChange={(e) => setRuleName(e.target.value)} placeholder="细分类名称，如 AI应用" />
              <select aria-label="运营商" value={ruleOperator} onChange={(e) => setRuleOperator(e.target.value)}>{operators.map((name) => <option key={name}>{name}</option>)}</select>
              <input aria-label="关键词" value={ruleKeywords} onChange={(e) => setRuleKeywords(e.target.value)} placeholder="关键词，多个用逗号分隔" />
              <button onClick={() => addFocusRule()} disabled={rulesStatus === "saving" || !ruleGroupId}>添加细分类</button>
            </div></section>
          </div>
          <div className="settings-main-grid">
            <section className="scoring-panel">
              <div className="panel-head"><div><h2>商机评分设置</h2><p>评分内容、匹配机制、参数和分值均可调整。</p></div><span className={`score-total ${scoringTotal === 100 ? "valid" : "invalid"}`}>启用项合计 {scoringTotal} 分</span></div>
              <div className="scoring-table-head"><span>评分内容</span><span>匹配机制</span><span>匹配参数</span><span>分值</span><span>启用</span><span>操作</span></div>
              <div className="scoring-table">{scoringCriteria.map((criterion) => {
                const definition = scoringTypes.find((item) => item.value === criterion.type);
                const numericParameter = ["keyword", "budget", "deadline", "advantage"].includes(criterion.type);
                return <div className={`scoring-row ${criterion.enabled ? "" : "disabled"}`} key={criterion.id}>
                  <input value={criterion.name} onChange={(e) => updateScoringCriterion(criterion.id, { name: e.target.value })} aria-label="评分内容" />
                  <select value={criterion.type} onChange={(e) => changeScoringType(criterion.id, e.target.value)} aria-label="匹配机制">{scoringTypes.map((type) => <option value={type.value} key={type.value}>{type.label}</option>)}</select>
                  <label className="parameter-field"><span>{definition?.parameterLabel}</span><input type={numericParameter ? "number" : "text"} min="0" value={criterion.parameter} onChange={(e) => updateScoringCriterion(criterion.id, { parameter: numericParameter ? Number(e.target.value) : e.target.value })} /></label>
                  <label className="score-field"><input type="number" min="0" max="100" value={criterion.maxScore} onChange={(e) => updateScoringCriterion(criterion.id, { maxScore: Math.max(0, Math.min(100, Number(e.target.value))) })} /><span>分</span></label>
                  <label className="switch"><input type="checkbox" checked={criterion.enabled} onChange={(e) => updateScoringCriterion(criterion.id, { enabled: e.target.checked })} /><i /></label>
                  <button className="delete-score" aria-label={`删除${criterion.name}`} onClick={() => setScoringCriteria((current) => current.filter((item) => item.id !== criterion.id))}>×</button>
                </div>;
              })}</div>
              <button className="add-score-item" onClick={addScoringCriterion}>＋ 添加评分项</button>
              <div className="scoring-actions"><button className="secondary-action" onClick={() => setScoringCriteria(defaultScoringCriteria.map((item) => ({ ...item })))}>恢复默认</button><span>{scoringStatus === "saved" ? "评分规则已保存并重新计算" : scoringStatus === "error" ? "云端保存暂不可用，请重试" : scoringTotal !== 100 ? "启用项总分必须等于100分" : "修改后请保存评分设置"}</span><button className="primary-action" onClick={saveScoringSettings} disabled={scoringStatus === "saving" || scoringTotal !== 100}>{scoringStatus === "saving" ? "正在保存…" : "保存评分设置"}</button></div>
            </section>
            <section className="rules-panel">
              <div className="panel-head"><div><h2>当前分类架构</h2><p>{rulesStatus === "loading" ? "正在读取云端分类…" : rulesStatus === "error" ? "规则保存服务暂时不可用，请刷新重试" : `${focusGroups.length} 个大类 · ${focusRules.length} 个细分类`}</p></div>{rulesStatus === "error" && <button className="secondary-action" onClick={loadFocusRules}>重新连接</button>}</div>
              {!focusGroups.length && <div className="rule-empty">暂无分类，请在上方添加。</div>}
              <div className="group-list">{focusGroups.map((group) => {
                const groupRules = focusMatches.filter((rule) => rule.groupId === group.id);
                return <section className="group-card" key={group.id}><div className="group-head"><div><h3>{group.name}</h3><p>{groupRules.length} 个细分类 · 共命中 {groupRules.reduce((sum, rule) => sum + rule.matches.length, 0)} 条</p></div><button aria-label={`删除${group.name}`} onClick={() => removeFocusGroup(group.id)}>删除大类</button></div>{groupRules.map((rule) => <article className="rule-row" key={rule.id}><div><h3>{rule.name}<span>{rule.operator}</span></h3><p>{rule.keywords.join("、")}</p></div><div className="rule-count"><strong>{rule.matches.length}</strong><span>命中</span></div><button aria-label={`删除${rule.name}`} onClick={() => removeFocusRule(rule.id)}>×</button></article>)}</section>;
              })}</div>
            </section>
          </div>
        </section>
      )}

      {activeView === "list" && <section className="list-page"><div className="page-title"><div><h1>公告列表</h1><p>聚焦浙江、江西、福建，统一汇集移动、联通、电信、铁塔采购信息</p></div><div><button className="secondary-action" onClick={exportExcel}>导出 Excel</button><button className="secondary-action" onClick={refresh}>刷新</button></div></div><div className="filter-panel">
            <div className="control-title"><b>快速查询</b><span>按关键词、类别和发布日期筛选公告</span></div>
            <div className="search">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"/></svg>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索项目名称、采购内容或关键词…" />
              {query && <button onClick={() => setQuery("")}>清除</button>}
            </div>
            <div className="filter-selects filter-five">
              <label>
                <span>地区</span>
                <select value={region} onChange={(e) => setRegion(e.target.value)}>
                  {regions.map((name) => <option key={name} value={name}>{name}（{counts[name]}）</option>)}
                </select>
              </label>
              <label>
                <span>运营商</span>
                <select value={operator} onChange={(e) => setOperator(e.target.value)}>
                  {operators.map((name) => <option key={name} value={name}>{name}（{operatorCounts[name]}）</option>)}
                </select>
              </label>
              <label><span>公告类别</span><select value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((name) => <option key={name}>{name}</option>)}</select></label>
              <label><span>开始日期</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
              <label><span>结束日期</span><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
              <button onClick={refresh} disabled={status === "loading"}>查询公告</button>
            </div>
          </div><section className="list-panel">
          <div className="list-head">
            <div>
              <h2>{region === "全部" ? (category === "全部类别" ? "全部采购公告" : category) : `${region}${category === "全部类别" ? "采购公告" : category}`}</h2>
              <p>{status === "loading" ? "正在连接数据源…" : `找到 ${filtered.length} 条结果`}</p>
            </div>
            <div className="list-actions">
              <span className="quality-summary">完整度 {completeRate}% · 待复核 {reviewCount} 条</span>
            </div>
          </div>

          {status === "loading" && <Loading />}
          {status !== "loading" && filtered.length > 0 && (
            <div className="notice-list">
              {visibleNotices.map((item) => (
                <article className="notice" key={item.id}>{(() => { const quality = fieldCompleteness(item); const scored = scoreNotice(item, focusRules, scoringCriteria); return <>
                  <div className="notice-top">
                    <span className="region" style={{ color: colors[item.region], background: `${colors[item.region]}12` }}>{item.region}</span>
                    {item.date && <time>{item.date}</time>}
                    <span className="operator-badge">{item.operator || "中国移动"}</span>
                    <span className="category-badge">{item.category || "采购公告"}</span>
                    <span className={`extract-state ${item.extractionStatus?.includes("正在") ? "working" : ""}`}>{item.extractionStatus}</span>
                    <span className={`quality-badge ${quality.missing.length ? "review" : "complete"}`}>{quality.missing.length ? `待复核 ${quality.missing.length} 项` : "字段完整"}</span><strong className="notice-score">{scored.score} 分</strong>
                  </div>
                  <h3>{item.title}</h3>
                  {item.category !== "采购意见征求公告" && (
                    <div className="detail-grid">
                      <Detail label="采购内容" value={cleanPurchaseContent(item.purchaseContent)} wide />
                      {item.category !== "采购项目预公告" && <Detail label="采购预算金额" value={item.budget} />}
                      {item.category !== "采购项目预公告" && <Detail label="采购文件售卖时间" value={item.saleTime} />}
                      {item.category !== "采购项目预公告" && <Detail label="应答截止时间" value={item.deadline} />}
                    </div>
                  )}
                  <div className="notice-foot">
                    <span>{item.sourceName || "中国移动采购与招标网"}</span>
                    <div>
                      {item.extractionStatus?.includes("重试") || item.extractionStatus?.includes("失败") ?
                        <button className="retry" onClick={() => retry(item)}>重新识别</button> : null}
                      <a href={item.url} target="_blank" rel="noreferrer">查看原公告 →</a>
                    </div>
                  </div>
                </>})()}</article>
              ))}
            </div>
          )}
          {status !== "loading" && filtered.length > 0 && (
            <nav className="pagination" aria-label="公告分页">
              <div className="page-size">
                <span>每页显示</span>
                <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                  {[10, 20, 30, 40].map((size) => <option value={size} key={size}>{size} 条</option>)}
                </select>
              </div>
              <div className="page-buttons">
                <button disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
                {pageNumbers.map((value, index) => value === "…"
                  ? <span className="ellipsis" key={`ellipsis-${index}`}>…</span>
                  : <button className={currentPage === value ? "active" : ""} onClick={() => setPage(value)} key={value}>{value}</button>)}
                <button disabled={currentPage === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>下一页</button>
              </div>
              <span className="page-summary">共 {filtered.length} 条</span>
            </nav>
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
      </section></section>}
        </div>
      </div>
    </main>
  );
}

function Kpi({ label, value, note, accent }) {
  return <article className={`kpi-card ${accent ? "accent" : ""}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}

function Panel({ title, subtitle, className = "", action, children }) {
  return <section className={`data-panel ${className}`}><header><div><h2>{title}</h2><p>{subtitle}</p></div>{action && <div className="panel-action">{action}</div>}</header>{children}</section>;
}

function EmptyMini({ text }) { return <div className="mini-empty">{text}</div>; }

function MetricBars({ rows, money }) {
  const max = Math.max(1, ...rows.map((item) => item.value));
  return <div className="metric-bars">{rows.length ? rows.map((item) => <div key={item.label}><span>{item.label}</span><i><b style={{ width: `${Math.max(4, item.value / max * 100)}%` }} /></i><strong>{money ? formatCurrency(item.value) : item.value}</strong></div>) : <EmptyMini text="暂无统计数据" />}</div>;
}

function operatorColor(name) { return ({ 中国移动: "#1686e8", 中国联通: "#ef4444", 中国铁塔: "#f97316", 中国电信: "#2563eb" })[name] || "#94a3b8"; }

function isMissing(value) {
  return !value || /公告未明确|正在识别|暂未识别|未单独列示/.test(String(value));
}

function fieldCompleteness(item) {
  if (item.category === "采购意见征求公告") return { percent: 100, missing: [] };
  const fields = item.category === "采购项目预公告"
    ? [["采购内容", item.purchaseContent]]
    : [["采购内容", item.purchaseContent], ["采购预算", item.budget], ["文件获取时间", item.saleTime], ["应答截止时间", item.deadline], ["资格要求", item.qualification], ["业绩要求", item.performance]];
  const missing = fields.filter(([, value]) => isMissing(value)).map(([label]) => label);
  return { percent: Math.round((fields.length - missing.length) / fields.length * 100), missing };
}

function parseBudget(value) {
  if (isMissing(value)) return 0;
  const text = String(value).replace(/,/g, "");
  const match = text.match(/(\d+(?:\.\d+)?)\s*(亿元|万元|万|元)/);
  if (!match) return 0;
  const number = Number(match[1]);
  return match[2] === "亿元" ? number * 100000000 : (match[2] === "万元" || match[2] === "万") ? number * 10000 : number;
}

function formatCurrency(value) {
  if (!value) return "¥0";
  if (value >= 100000000) return `¥${(value / 100000000).toFixed(2)}亿`;
  if (value >= 10000) return `¥${(value / 10000).toFixed(value >= 1000000 ? 0 : 1)}万`;
  return `¥${Math.round(value).toLocaleString("zh-CN")}`;
}

function extractDeadlineDate(value) {
  if (isMissing(value)) return null;
  const text = String(value);
  const match = text.match(/(20\d{2})\D{0,2}(\d{1,2})\D{0,2}(\d{1,2})(?:\D{0,3}(\d{1,2}))?/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] || 23));
}

function deadlineDays(value) {
  const date = extractDeadlineDate(value);
  if (!date) return 999;
  return Math.ceil((date.getTime() - Date.now()) / 86400000);
}

function scoreNotice(item, rules, criteria = defaultScoringCriteria) {
  const titleText = String(item.title || "").toLowerCase();
  const contentText = String(item.purchaseContent || "").toLowerCase();
  const haystack = `${titleText} ${contentText}`;
  const eligibleRules = rules.filter((rule) => rule.operator === "全部运营商" || rule.operator === item.operator);
  const matchedKeywords = [...new Set(eligibleRules.flatMap((rule) => rule.keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()))))];
  const matchedRuleCount = eligibleRules.filter((rule) => rule.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))).length;
  const budgetValue = parseBudget(item.budget);
  const days = deadlineDays(item.deadline);
  const thresholdText = `${item.qualification || ""} ${item.performance || ""}`;
  const scoreParts = {};

  for (const criterion of criteria.filter((item) => item.enabled)) {
    const maxScore = Math.max(0, Number(criterion.maxScore) || 0);
    let ratio = 0;
    if (criterion.type === "keyword") {
      const fullCount = Math.max(1, Number(criterion.parameter) || 3);
      const titleHits = matchedKeywords.filter((keyword) => titleText.includes(keyword.toLowerCase())).length;
      const contentOnlyHits = matchedKeywords.filter((keyword) => !titleText.includes(keyword.toLowerCase()) && contentText.includes(keyword.toLowerCase())).length;
      ratio = Math.min(1, (titleHits + contentOnlyHits * 0.7) / fullCount);
    } else if (criterion.type === "budget") {
      const fullAmount = Math.max(1, Number(criterion.parameter) || 1000) * 10000;
      ratio = budgetValue ? Math.min(1, budgetValue / fullAmount) : 0;
    } else if (criterion.type === "deadline") {
      const fullDays = Math.max(1, Number(criterion.parameter) || 8);
      ratio = days >= 999 || days <= 0 ? 0 : Math.min(1, days / fullDays);
    } else if (criterion.type === "target") {
      const [regionText = "", operatorText = ""] = String(criterion.parameter || "").split("|");
      const targetRegions = regionText.split(/[，,、]/).map((value) => value.trim()).filter(Boolean);
      const targetOperators = operatorText.split(/[，,、]/).map((value) => value.trim()).filter(Boolean);
      const regionMatch = !targetRegions.length || targetRegions.includes(item.region);
      const operatorMatch = !targetOperators.length || targetOperators.includes(item.operator);
      ratio = regionMatch && operatorMatch ? 1 : regionMatch || operatorMatch ? 0.5 : 0;
    } else if (criterion.type === "advantage") {
      ratio = Math.min(1, matchedRuleCount / Math.max(1, Number(criterion.parameter) || 1));
    } else if (criterion.type === "threshold") {
      ratio = isMissing(item.qualification) && isMissing(item.performance)
        ? 0.4
        : /不少于|以上|资质|注册资本|累计金额|业绩|认证|许可证/.test(thresholdText) ? 0.6 : 1;
    }
    const partScore = Math.max(0, Math.min(maxScore, Math.round(maxScore * ratio)));
    scoreParts[criterion.id] = { name: criterion.name, score: partScore, maxScore, type: criterion.type };
  }

  const score = Object.values(scoreParts).reduce((sum, part) => sum + part.score, 0);
  return { ...item, score: Math.min(100, score), matchedKeywords, scoreParts };
}

function buildTrend(notices) {
  const grouped = new Map();
  notices.forEach((item) => item.date && grouped.set(item.date, (grouped.get(item.date) || 0) + 1));
  const rows = [...grouped].sort(([a], [b]) => a.localeCompare(b));
  const max = Math.max(1, ...rows.map(([, count]) => count));
  return rows.map(([date, count]) => ({ date, count, height: count / max * 88, label: date.slice(5).replace("-", "/") }));
}

function buildCategoryStats(notices, groups, rules) {
  const midpoint = notices.map((item) => item.date).filter(Boolean).sort()[Math.floor(notices.length / 2)] || "";
  return groups.map((group) => {
    const groupRules = rules.filter((rule) => rule.groupId === group.id);
    const matched = notices.filter((item) => groupRules.some((rule) => (rule.operator === "全部运营商" || rule.operator === item.operator) && rule.keywords.some((word) => `${item.title} ${item.purchaseContent || ""}`.toLowerCase().includes(word.toLowerCase()))));
    const early = matched.filter((item) => item.date < midpoint).length;
    const late = matched.filter((item) => item.date >= midpoint).length;
    const budgets = matched.map((item) => parseBudget(item.budget)).filter(Boolean);
    return { name: group.name, count: matched.length, growth: early ? Math.round((late - early) / early * 100) : late ? 100 : 0, avgBudget: budgets.length ? budgets.reduce((a, b) => a + b, 0) / budgets.length : 0 };
  }).sort((a, b) => b.count - a.count);
}

function buildMethodStats(notices) {
  const methods = [{ name: "招标", test: /招标/ }, { name: "询比", test: /询比|谈判/ }, { name: "直接采购", test: /直接采购/ }];
  const counts = methods.map((method) => ({ name: method.name, count: notices.filter((item) => method.test.test(`${item.category} ${item.title}`)).length }));
  const total = counts.reduce((sum, item) => sum + item.count, 0) || 1;
  return counts.map((item) => ({ ...item, percent: Math.round(item.count / total * 100) }));
}

function paginationNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const values = [1];
  if (current > 4) values.push("…");
  const start = Math.max(2, current - 2);
  const end = Math.min(total - 1, current + 2);
  for (let value = start; value <= end; value++) values.push(value);
  if (current < total - 3) values.push("…");
  values.push(total);
  return values;
}

function Loading() {
  return <div className="skeletons">{[1, 2, 3, 4].map((n) => <div className="skeleton" key={n}><i /><b /><span /></div>)}</div>;
}

function Detail({ label, value, wide }) {
  return <div className={wide ? "detail wide" : "detail"}><span>{label}</span><p>{value || "正在识别或公告未单独列示"}</p></div>;
}

function cleanPurchaseContent(value) {
  return String(value || "公告未明确列示")
    .replace(/[，,。；;]?\s*(?:具体需求)?内容如下\s*[：:]?\s*(?:序号)?[\s\S]*$/u, "")
    .replace(/[，,。；;]?\s*(?:预算金额|项目预算|采购预算|总价最高限价)\s*(?:含税|不含税)?[\s\S]*$/u, "")
    .trim() || "公告未明确列示";
}

async function recognizeNotice(item, force = false) {
  const cacheKey = `notice-fields:v9:${item.id}`;
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
  if (labeled && !looksLikeTableNoise(labeled)) return labeled;
  const tableItem = extractTableProductQuantity(text);
  if (tableItem) return tableItem;
  return "公告未明确列示";
}

function looksLikeTableNoise(value) {
  const text = String(value || "");
  const compact = text.replace(/\s+/g, "");
  const headers = ["采购包", "产品或服务名称", "产品或服务描述", "计量单位", "预估不含税", "数量", "是否属于充分竞争领域"];
  const headerHits = headers.filter((header) => compact.includes(header)).length;
  const shortLines = text.split(/\n+/).filter((line) => line.trim() && line.trim().length <= 2).length;
  return headerHits >= 2 || shortLines >= 8;
}

function extractTableProductQuantity(text) {
  const lines = String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const contentIndex = lines.findIndex((line) => /采购内容|项目需求|招标内容/.test(line));
  const rowIndex = lines.findIndex((line, index) =>
    index > contentIndex && index < contentIndex + 80 && /^(?:标包|采购包|包)\s*\d+$/.test(line)
  );
  if (rowIndex >= 0) {
    const product = lines.slice(rowIndex + 1, rowIndex + 5)
      .find((line) => line.length >= 2 && !/^(?:是|否|台|套|个|项|批|件|辆|组|\d+(?:\.\d+)?)$/.test(line));
    const unitIndex = lines.findIndex((line, index) =>
      index > rowIndex && index < rowIndex + 12 && /^(?:台|套|个|项|批|件|辆|组)$/.test(line)
    );
    if (product && unitIndex > rowIndex) {
      const numbers = lines.slice(unitIndex + 1, unitIndex + 8)
        .filter((line) => /^\d+(?:\.\d+)?$/.test(line));
      const quantity = numbers.length >= 3 ? numbers[1] : numbers[0];
      if (quantity) return `${product.slice(0, 80)}，数量${quantity}${lines[unitIndex]}`;
    }
  }

  const compact = String(text || "").replace(/\s+/g, "");
  const summary = compact.match(
    /(?:包段)?产品名称产品单位需求数量(?:标包|采购包|包)\d+(.{2,80}?)(台|套|个|项|批|件|辆|组)(\d+(?:\.\d+)?)/
  );
  if (!summary) return "";
  const product = summary[1]
    .replace(/^(?:产品名称|产品或服务名称)/, "")
    .replace(/[：:、，,。]+$/, "")
    .slice(0, 80);
  if (!product || !summary[3]) return "";
  return `${product}，数量${summary[3]}${summary[2]}`;
}

function extractPurchaseParagraph(text, labels) {
  for (const label of labels) {
    const index = text.indexOf(label);
    if (index < 0) continue;
    const tail = text.slice(index + label.length, index + label.length + 1400)
      .replace(/^\s*[：:、.]?\s*/, "");
    const nextItem = tail.search(/\n\s*(?:\d+\.\d+|（\d+）|\(\d+\)|[一二三四五六七八九十]+[、.．])\s*/);
    const table = tail.search(
      /\n\s*(?:采购包|包段|产品或服务名称|产品或服务描述|需求描述|对应的集采目录|是否属于充分竞争|计量单位|预估不含税|预算不含税|采\s*\n\s*购\s*\n\s*包|产\s*\n\s*品\s*(?:\n\s*或\s*\n\s*服\s*\n\s*务)?\s*\n\s*名\s*\n\s*称)/
    );
    if (table >= 0 && table <= 15) continue;
    const stops = [nextItem, table].filter((position) => position > 15);
    const stop = stops.length ? Math.min(...stops) : -1;
    const value = singleRequirement(stop > 0 ? tail.slice(0, stop) : tail).slice(0, 400);
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
  const labels = ["总价最高限价", "项目预算金额", "项目预算", "采购预算金额", "采购预算", "预算总金额", "预算金额"];
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
  const match = compact.match(/(?:(?:应答|响应|投标)文件(?:递交|提交)?截止时间|(?:应答|响应|投标)截止时间)(?:（即(?:应答|响应|投标)截止时间）)?(?:为|：|:)?(\d{4}年\d{1,2}月\d{1,2}日\d{1,2}时\d{1,2}分)/);
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
