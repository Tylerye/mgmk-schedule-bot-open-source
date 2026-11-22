import { createHash } from "node:crypto";
import { mkdtemp, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseScheduleDate } from "../src/dates.js";
import { groupKey, displayGroup } from "../src/personal/catalog.js";
import { boundedBytes, boundedText } from "../src/source/bounded.js";

const folder = process.env.PERSONAL_WEEKLY_DRIVE_FOLDER_ID;
if (!/^[\w-]{20,100}$/u.test(folder ?? "")) throw new Error("Missing weekly Drive folder ID");

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function source(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error("Google Drive returned HTTP " + response.status);
  return response;
}
async function worker(action, body = {}) {
  const response = await fetch(new URL("/internal/personal/" + action, process.env.WORKER_BASE_URL), {
    method: "POST",
    headers: { authorization: "Bearer " + process.env.PARSER_SHARED_SECRET, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Weekly schedule endpoint returned HTTP " + response.status);
  return response.json();
}

const page = await boundedText(await source("https://drive.google.com/drive/folders/" + folder));
const effectiveFrom = parseScheduleDate(page.match(/<title>([^<]+)<\/title>/u)?.[1]);
const ids = [...new Set([...page.matchAll(/data-id="([A-Za-z0-9_-]{20,})"[\s\S]{0,2000}?data-tooltip="[^"]+\.xls Microsoft Excel"/giu)]
  .map(match => match[1]))].sort();
if (!effectiveFrom || !ids.length || ids.length > 25) throw new Error("Unrecognized weekly folder");

const dir = await mkdtemp(join(tmpdir(), "mgmk-week-"));
try {
  const files = [];
  const digests = [];
  const signature = Buffer.from("d0cf11e0a1b11ae1", "hex");
  for (const id of ids) {
    const url = "https://drive.usercontent.google.com/download?" + new URLSearchParams({ id, export: "download", confirm: "t" });
    const bytes = Buffer.from(await boundedBytes(await source(url), 4_000_000, 20_000));
    if (!bytes.subarray(0, 8).equals(signature)) throw new Error("Unexpected weekly workbook format");
    const file = join(dir, id + ".xls");
    await writeFile(file, bytes);
    files.push(file);
    digests.push(hash(bytes));
  }
  const fingerprint = hash(JSON.stringify([1, effectiveFrom, digests]));
  const dryRun = process.argv.includes("--dry-run");
  const previous = dryRun ? {} : await worker("week-source-status");
  if (previous.fingerprint === fingerprint) {
    console.log("Weekly source unchanged (" + previous.groups + " groups)");
  } else {
    const { stdout } = await promisify(execFile)(process.env.WEEKLY_PYTHON || "python3",
      ["scripts/read-weekly-xls.py", ...files], { maxBuffer: 512_000, timeout: 30_000 });
    const groups = {};
    for (const { label, days } of JSON.parse(stdout)) {
      const raw = groupKey(label);
      // The semester spreadsheets include specialty suffixes omitted in daily PDFs.
      const id = raw.replace(/^(3|5|8|9)СБА$/u, "$1СА")
        .replace(/^(4|6|10)СБР$/u, "$1СБ")
        .replace(/^(8|9|19|20|31|42)ТСК$/u, "$1ТС")
        .replace(/^(21|22|32|33|43|44)МДК$/u, "$1МД")
        .replace(/^46ТСП$/u, "46ТП");
      if (Object.hasOwn(groups, id)) throw new Error("Duplicate weekly group ID");
      groups[id] = { label: displayGroup(id === raw ? label : id), days };
    }
    const plan = { effectiveFrom, fingerprint, previous: previous.fingerprint ?? null, groups };
    if (!dryRun) {
      const result = await worker("week-source", plan);
      if (result.fingerprint !== fingerprint) throw new Error("Weekly plan activation was not confirmed");
    }
    console.log(JSON.stringify({ workbooks: files.length, groups: Object.keys(groups).length,
      effectiveFrom, bytes: Buffer.byteLength(JSON.stringify(plan)), dryRun }));
  }
} finally {
  // Only this invocation's files inside the temporary directory are removed.
  for (const entry of await readdir(dir)) await unlink(join(dir, entry));
  await rmdir(dir);
}
