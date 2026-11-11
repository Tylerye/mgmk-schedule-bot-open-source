import { createHash } from "node:crypto";
import { addDays, dateInTimezone } from "./dates.js";
import { downloadDriveFile, hasSourceChanged, inspectDriveFile, listDriveFiles } from "./source/drive.js";
import { extractPdf } from "./pdf/extract.js";
import { applyBellSchedule, parseGroupSchedule } from "./schedule/parse.js";
import { formatScheduleMessage } from "./schedule/format.js";

function inWindow(date, start, end) {
  return date && date >= start && date <= end;
}

export async function discoverCandidates(config, now = new Date()) {
  const today = dateInTimezone(now, config.timezone);
  const end = addDays(today, config.lookaheadDays);
  const listed = (await listDriveFiles(config)).filter(
    (file) => file.audience === "students" && inWindow(file.scheduleDate, today, end),
  );
  const inspected = await Promise.all(listed.map((file) => inspectDriveFile(file, config)));
  const byDate = new Map();
  for (const file of inspected) {
    const current = byDate.get(file.scheduleDate);
    const currentTime = Date.parse(current?.lastModified ?? 0);
    const fileTime = Date.parse(file.lastModified ?? 0);
    if (!current || fileTime > currentTime || (fileTime === currentTime && file.id > current.id)) byDate.set(file.scheduleDate, file);
  }
  return [...byDate.values()].sort((a, b) => a.scheduleDate.localeCompare(b.scheduleDate));
}

export async function checkSchedules({ config, store, logger, now = new Date(), dependencies = {} }) {
  const startedAt = new Date().toISOString();
  store.state.health.lastSourcePollAt = startedAt;
  logger.info("source_poll_started", { windowDays: config.lookaheadDays });
  const discover = dependencies.discoverCandidates ?? discoverCandidates;
  const download = dependencies.downloadDriveFile ?? downloadDriveFile;
  const extract = dependencies.extractPdf ?? extractPdf;
  const parse = dependencies.parseGroupSchedule ?? parseGroupSchedule;
  const candidates = await discover(config, now);
  const results = [];

  for (const candidate of candidates) {
    const previousDocument = store.state.documents[candidate.id];
    const existing = store.state.schedules[candidate.scheduleDate];
    if (existing) {
      const previousScheduleHash = existing.scheduleHash ?? existing.schedule?.hash;
      existing.schedule = applyBellSchedule(existing.schedule, { bells: config.bells, displayGroup: config.displayGroup });
      existing.scheduleHash = existing.schedule.hash;
      if (previousScheduleHash && previousScheduleHash !== existing.scheduleHash) {
        logger.info("schedule_changed", { date: candidate.scheduleDate, reason: "bell_or_format_config" });
      }
    }

    if (!config.dryRun && !hasSourceChanged(previousDocument, candidate) && existing) {
      results.push({ status: "unchanged", file: candidate });
      logger.info("source_unchanged", { date: candidate.scheduleDate, sourceId: candidate.id });
      continue;
    }

    logger.info("new_source_detected", { date: candidate.scheduleDate, sourceId: candidate.id });
    store.state.health.lastSourceChangeAt = new Date().toISOString();
    const rawSource = await download(candidate, config);
    const contentHash = createHash("sha256").update(rawSource.bytes).digest("hex");
    if (!config.dryRun && previousDocument?.contentHash === contentHash && existing) {
      store.state.documents[candidate.id] = { ...previousDocument, ...candidate, contentHash, checkedAt: new Date().toISOString() };
      results.push({ status: "same-content", file: candidate });
      logger.info("source_unchanged", { date: candidate.scheduleDate, sourceId: candidate.id, reason: "content_hash" });
      continue;
    }

    const parsedPdf = await extract(rawSource);
    const schedule = parse(parsedPdf, {
      targetGroup: config.groupName,
      expectedDate: candidate.scheduleDate,
      bells: config.bells,
      displayGroup: config.displayGroup,
    });

    if (config.dryRun) {
      console.log(`\n=== DRY RUN: ${candidate.name} ===\n${formatScheduleMessage(schedule)}\n`);
    } else {
      const nowIso = new Date().toISOString();
      store.state.documents[candidate.id] = {
        id: candidate.id,
        name: candidate.name,
        scheduleDate: candidate.scheduleDate,
        lastModified: candidate.lastModified,
        contentLength: candidate.contentLength,
        etag: candidate.etag,
        contentHash,
        detectedAt: previousDocument?.detectedAt ?? nowIso,
        checkedAt: nowIso,
      };
      const changed = Boolean(existing?.scheduleHash && existing.scheduleHash !== schedule.hash);
      store.state.schedules[schedule.date] = {
        ...(existing ?? {}),
        schedule,
        scheduleHash: schedule.hash,
        sourceId: candidate.id,
        parsedAt: nowIso,
      };
      if (changed) logger.info("schedule_changed", { date: schedule.date, reason: "parsed_content" });
      await store.save();
    }
    store.state.health.lastParserSuccessAt = new Date().toISOString();
    results.push({ status: existing ? "updated" : "new", file: candidate, schedule, contentHash });
    logger.info("schedule_parsed", { date: schedule.date, group: schedule.canonicalGroup, lessons: schedule.lessons.length, contentHash });
  }

  store.state.health.lastSourcePollSuccessAt = new Date().toISOString();
  store.state.health.lastError = null;
  if (!config.dryRun) await store.save();
  if (candidates.length === 0) logger.info("source_unchanged", { reason: "no_candidate_in_window" });
  return results;
}
