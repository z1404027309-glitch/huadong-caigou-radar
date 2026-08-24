import assert from "node:assert/strict";
import { extractCommonNoticeFields, preferRecognized } from "./lib/notice-field-extractor.mjs";

const mobile = extractCommonNoticeFields({
  html: `<p>1.1 采购内容：中国移动福建公司大数据智慧审计平台建设。</p>
    <p>1.2 项目预算金额：249.84万元（不含税），264.83万元（含税）。</p>
    <p>采购文件获取时间：2026年8月21日22时00分至2026年8月26日22时00分</p>`
});
assert.equal(mobile.budget, "249.84万元");
assert.match(mobile.purchaseContent, /大数据智慧审计平台建设/);
assert.equal(mobile.saleTime, "2026年8月21日22时00分至2026年8月26日22时00分");

const attachment = extractCommonNoticeFields({
  html: "<p>公告正文未列预算。</p>",
  attachmentTexts: [{ text: "项目预算：320万元。供应商资格：具有有效营业执照。", source: "PDF" }]
});
assert.equal(attachment.budget, "320万元");
assert.match(attachment.qualification, /有效营业执照/);
assert.equal(preferRecognized("公告未明确列示", "320万元"), "320万元");

const estimatedBudget = extractCommonNoticeFields({
  html: "<p>1.2 项目预估金额：216万元（不含税），243.24 万元（含税）。</p>"
});
assert.equal(estimatedBudget.budget, "216万元");

const unitFromBudgetLabel = extractCommonNoticeFields({
  html: "<p>1.5 项目预算金额：2463300（含税）。</p>"
});
assert.equal(unitFromBudgetLabel.budget, "2463300元");

console.log("notice field extractor tests passed");
