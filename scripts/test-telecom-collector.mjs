import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telecom-collector-"));
const output = path.join(tempDir, "public/data/telecom-notices.json");
const cached = {
  id: "telecom-cached",
  sourceId: "cached",
  title: "Previously recognized notice",
  date: new Date().toISOString().slice(0, 10),
  fieldsReady: true,
  extractorVersion: 11,
  budget: "100万元"
};
const records = [
  { docId: "complete", docTitle: "Complete notice", docTypeCode: "e2no", createDate: cached.date },
  { docId: "pending", docTitle: "Pending notice", docTypeCode: "e2no", createDate: cached.date },
  { docId: "cached", docTitle: "Previously recognized notice", docTypeCode: "e2no", createDate: cached.date }
];

try {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ notices: [cached] }));
  process.chdir(tempDir);
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("/queryListNew")) {
      const list = body.provinceCode === "23" && body.type === "e2no" ? records : [];
      return new Response(JSON.stringify({ code: 200, data: { pageInfo: { list } } }), { status: 200 });
    }
    if (body.id !== "complete") return new Response("Forbidden", { status: 403 });
    return new Response(JSON.stringify({
      code: 200,
      data: { tenderAnnouncementName: "Complete notice", context: "<p>采购内容：软件服务。</p>" }
    }), { status: 200 });
  };
  await import("./collect-telecom.mjs");
  const archive = JSON.parse(await fs.readFile(output, "utf8"));
  assert.deepEqual(new Set(archive.notices.map((item) => item.sourceId)), new Set(["complete", "cached"]));
  assert(archive.notices.every((item) => item.fieldsReady === true));
  assert.equal(archive.notices.find((item) => item.sourceId === "cached")?.budget, "100万元");
  console.log("telecom pending details do not block completed notices");
} finally {
  process.chdir(originalCwd);
  await fs.rm(tempDir, { recursive: true, force: true });
}
