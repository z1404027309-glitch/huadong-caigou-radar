import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(".github/workflows/collect-unicom.yml", "utf8");

const forcedSchedules = [
  "15 0,4,8 * * *", // Beijing 08:15, 12:15, 16:15
  "0 13,15 * * *"  // Beijing 21:00, 23:00
];

for (const schedule of forcedSchedules) {
  assert(workflow.includes(`- cron: "${schedule}"`), `missing forced schedule: ${schedule}`);
  assert(workflow.includes(`[ "$EVENT_SCHEDULE" = "${schedule}" ]`), `schedule is not forced: ${schedule}`);
}

assert(workflow.includes('- cron: "5-10/5,20-55/5 * * * *"'), "refresh polling must exclude minutes 00 and 15");
assert(!workflow.includes('- cron: "*/5 * * * *"'), "overlapping five-minute schedule must not return");
assert(workflow.includes("https://huadong-caigou-radar.pages.dev/api/refresh-needed"), "refresh polling must use the production site database");
assert(!workflow.includes("https://huadong-caigou.z1404027309.chatgpt.site/api/refresh-needed"), "refresh polling must not use the legacy site database");

console.log("collection workflow configuration is valid");
