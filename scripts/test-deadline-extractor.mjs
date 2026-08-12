import assert from "node:assert/strict";
import { extractDeadline, normalizeDocumentText } from "./lib/deadline-extractor.mjs";

const regression = extractDeadline({
  html: `<div>6.1 响应文件递交截止时间（即响应截止时间）为<br>【2026年8月17日9时00分】。</div>`
});
assert.deepEqual(regression, {
  deadline: "2026-08-17 09:00",
  deadlineStatus: "recognized",
  deadlineEvidence: "6.1 响应文件递交截止时间（即响应截止时间）为 【2026年8月17日9时00分】。",
  deadlineSource: "正文"
});

assert.equal(extractDeadline({ html: "电子应答文件提交截止时间为：2026-08-18 14:30" }).deadline, "2026-08-18 14:30");
assert.equal(extractDeadline({ structuredValues: [{ value: "2026-08-19T10:00:00", source: "详情接口.replyEndTime" }] }).deadline, "2026-08-19 10:00");
assert.equal(extractDeadline({ html: "正文未列截止时间", attachmentTexts: [{ text: "投标截止时间即2026年8月20日10时30分", source: "PDF：采购文件.pdf" }] }).deadlineSource, "PDF：采购文件.pdf");
assert.equal(normalizeDocumentText("<p>响应文件</p><p>递交截止时间为2026年8月17日</p>"), "响应文件\n递交截止时间为2026年8月17日");

console.log("deadline extractor tests passed");
