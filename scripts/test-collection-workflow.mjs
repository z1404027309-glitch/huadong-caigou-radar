import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(".github/workflows/collect-unicom.yml", "utf8");
const worker = fs.readFileSync("server/index.js", "utf8");
const mobileCollector = fs.readFileSync("scripts/collect-mobile.mjs", "utf8");

const forcedSchedules = [
  "15 0,4,8 * * *", // Beijing 08:15, 12:15, 16:15
  "0 13,15 * * *"  // Beijing 21:00, 23:00
];

for (const schedule of forcedSchedules) {
  assert(workflow.includes(`- cron: "${schedule}"`), `missing forced schedule: ${schedule}`);
  assert(workflow.includes(`[ "$EVENT_SCHEDULE" = "${schedule}" ]`), `schedule is not forced: ${schedule}`);
}

assert(workflow.includes('- cron: "5,10,20,25,30,35,40,45,50,55 * * * *"'), "refresh polling must explicitly exclude minutes 00 and 15");
assert(!workflow.includes('- cron: "*/5 * * * *"'), "overlapping five-minute schedule must not return");
assert(workflow.includes("https://huadong-caigou-radar.pages.dev/api/refresh-needed"), "refresh polling must use the production site database");
assert(!workflow.includes("https://huadong-caigou.z1404027309.chatgpt.site/api/refresh-needed"), "refresh polling must not use the legacy site database");
assert(worker.includes("DELETE FROM notice_archive_staging WHERE batch_id = ?"), "completed publication batches must delete staged archive payloads");
assert(worker.includes("pruneArchivePublicationHistory(env.DB, batchId)"), "archive sync must prune historical staging payloads before writing a new batch");
assert(workflow.includes("runs-on: windows-latest"), "China Unicom collection must run in Windows system Edge");
assert(workflow.includes("UNICOM_CDP_ENDPOINT"), "China Unicom collection must attach to the externally launched Edge session");
assert(workflow.includes("actions/download-artifact@v4"), "the main publication job must restore the isolated China Unicom archive");
assert(mobileCollector.includes("mobile API returned 403; switching to a same-origin Chromium session"), "China Mobile collection must fall back to a real browser after an API 403");
assert(mobileCollector.includes("credentials: \"include\""), "China Mobile browser requests must preserve same-origin cookies");

console.log("collection workflow configuration is valid");
