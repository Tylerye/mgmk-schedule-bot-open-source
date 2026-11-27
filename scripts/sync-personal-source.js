// Independent recovery for the new subsystem. PDF parsing stays in Actions;
// the original group's source jobs and their delivery status are untouched.
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { listDriveFiles, inspectNewestDriveFiles, downloadDriveFile } from "../src/source/drive.js";
import { extractPdf } from "../src/pdf/extract.js";
import { parseAllGroupSchedules } from "../src/personal/parse.js";
import { createWorkerRequester } from "./worker-request.js";
import { personalFingerprint, uploadPersonalResult } from "./personal-upload.js";
import { dateInTimezone, addDays } from "../src/dates.js";

const config = await loadConfig({ dryRun: true });
const request = createWorkerRequester({ baseUrl: process.env.WORKER_BASE_URL, sharedSecret: process.env.PARSER_SHARED_SECRET });
const today = dateInTimezone(new Date(), "Europe/Minsk");
const end = addDays(today, 5);
const listed = (await listDriveFiles(config)).filter(f => f.audience === "students" && f.scheduleDate >= today && f.scheduleDate <= end);
const { sources, failures } = await inspectNewestDriveFiles(listed, config);
const deferredDates = new Set(failures.map(({ file }) => file.scheduleDate));
for (const source of sources) {
  try {
    const status = await request("/internal/personal/source-status", {
      method: "POST", body: JSON.stringify({ id: source.id, date: source.scheduleDate }),
    });
    if (status.known?.fingerprint === personalFingerprint(source)) {
      console.log(JSON.stringify({ event: "personal_source_unchanged", date: source.scheduleDate }));
      continue;
    }
    const generation = Date.now();
    const raw = await downloadDriveFile(source, config);
    const result = parseAllGroupSchedules(await extractPdf(raw), { expectedDate: source.scheduleDate, bells: config.bells });
    const uploaded = await uploadPersonalResult({ result, source, generation, contentHash: createHash("sha256").update(raw.bytes).digest("hex"), request });
    console.log(JSON.stringify({ event: "personal_source_ready", date: result.date, groups: uploaded.groups }));
  } catch {
    deferredDates.add(source.scheduleDate);
  }
}
if (deferredDates.size) {
  await request("/internal/personal/source-error", { method: "POST", body: JSON.stringify({ date: [...deferredDates].sort()[0] }) }).catch(() => {});
  throw new Error(`Personal source recovery incomplete for: ${[...deferredDates].sort().join(", ")}`);
}
