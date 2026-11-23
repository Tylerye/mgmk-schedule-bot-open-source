import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { compactSchedule, MAX_STAGE_BYTES, MAX_STAGE_SCHEDULES } from "../src/personal/ingest.js";

export const personalFingerprint = source => JSON.stringify([source.id, source.lastModified ?? null, source.contentLength ?? null, source.etag ?? null]);
export async function uploadPersonalResult({ result, source, contentHash, generation, request }) {
  const post = (path, payload) => request("/internal/personal/" + path, { method: "POST", body: JSON.stringify(payload) }, { retryBusy: true });
  const uploadObservations = async (observations, seedVersion) => {
    for (let i = 0; i < observations.length; i += 10)
      await post("catalog", { observations: observations.slice(i, i + 10), seedVersion: i + 10 >= observations.length ? seedVersion : undefined });
  };
  const seed = await readFile(new URL("../config/personal-catalog.json", import.meta.url));
  const seedVersion = createHash("sha256").update(seed).digest("hex");
  const historical = () => JSON.parse(seed).flatMap(g => g.dates.map(date => ({ group: g.label, date })));
  if (!result.publishable) {
    await uploadObservations([...historical(), ...result.observations], seedVersion);
    await post("source-error", { date: result.date, coverage: result.coverage,
      groups: result.errors.map(e => e.id), structuralErrors: result.structuralErrors.length });
    throw new Error(`Personal parser coverage failed: ${result.coverage.parsed}/${result.coverage.discovered}`);
  }
  const manifest = Object.fromEntries(result.schedules.map(s => [s.canonicalGroup, s.hash]));
  const id = createHash("sha256").update(JSON.stringify([1, contentHash, generation, result.date])).digest("hex");
  let begin;
  try {
    begin = await post("begin", { id, date: result.date, generation, manifest, sourceId: source.id,
      fingerprint: personalFingerprint(source), observations: [], seedVersion });
    // Old Workers continue accepting three schedules while a rolling deploy
    // moves new Workers to larger batches. The request body bound still applies.
    const cap = Number.isInteger(begin.maxStageSchedules) && begin.maxStageSchedules > 0
      ? Math.min(begin.maxStageSchedules, MAX_STAGE_SCHEDULES) : 3;
    if (begin.ready !== true) {
      let schedules = [];
      for (const schedule of result.schedules.map(compactSchedule)) {
        if (schedules.length && (schedules.length === cap
          || Buffer.byteLength(JSON.stringify({ id, schedules: [...schedules, schedule] })) > MAX_STAGE_BYTES)) {
          await post("stage", { id, schedules });
          schedules = [];
        }
        schedules.push(schedule);
      }
      if (schedules.length) await post("stage", { id, schedules });
    }
    await post("finish", { id });
    console.log(JSON.stringify({ event: "personal_source_activated", date: result.date, groups: result.schedules.length }));
  } catch (error) {
    // Catalog discovery is independent of staging. Preserve the source error
    // if the catalog also fails, so the existing recovery records this failure.
    await uploadObservations(result.observations).catch(() => {});
    throw error;
  }
  // Historical discovery is versioned and never delays a published PDF.
  // Keep real observations first so news about new groups survives a seed retry.
  try {
    await uploadObservations(result.observations);
    if (begin.catalogSeedKnown !== true)
      await uploadObservations(historical(), seedVersion);
  } catch {
    console.warn(JSON.stringify({ event: "personal_catalog_deferred", date: result.date }));
  }
  return { id, groups: result.schedules.length };
}
