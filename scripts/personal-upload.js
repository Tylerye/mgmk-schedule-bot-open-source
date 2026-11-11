import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { compactSchedule } from "../src/personal/ingest.js";

export const personalFingerprint = source => JSON.stringify([source.id, source.lastModified ?? null, source.contentLength ?? null, source.etag ?? null]);
export async function uploadPersonalResult({ result, source, contentHash, generation, request }) {
  const seed = JSON.parse(await readFile(new URL("../config/personal-catalog.json", import.meta.url)));
  const observations = [...seed.flatMap(g => g.dates.map(date => ({ group: g.label, date }))), ...result.observations];
  // Discovery must survive a failed group or a rejected schedule batch. It is
  // a separate transaction path and never activates incomplete timetables.
  for (let i = 0; i < observations.length; i += 10) await request("/internal/personal/catalog", { method: "POST", body: JSON.stringify({ observations: observations.slice(i, i + 10) }) }, { retryBusy: true });
  if (!result.publishable) {
    await request("/internal/personal/source-error", { method: "POST", body: JSON.stringify({ date: result.date, coverage: result.coverage,
      groups: result.errors.map(e => e.id), structuralErrors: result.structuralErrors.length }) });
    throw new Error(`Personal parser coverage failed: ${result.coverage.parsed}/${result.coverage.discovered}`);
  }
  const manifest = Object.fromEntries(result.schedules.map(s => [s.canonicalGroup, s.hash]));
  const id = createHash("sha256").update(JSON.stringify([1, contentHash, generation, result.date])).digest("hex");
  const base = { id, date: result.date, generation, manifest, sourceId: source.id, fingerprint: personalFingerprint(source) };
  await request("/internal/personal/begin", { method: "POST", body: JSON.stringify({ ...base, observations: [] }) }, { retryBusy: true });
  const schedules = result.schedules.map(compactSchedule);
  for (let i = 0; i < schedules.length; i += 3) await request("/internal/personal/stage", { method: "POST", body: JSON.stringify({ id, schedules: schedules.slice(i, i + 3) }) }, { retryBusy: true });
  await request("/internal/personal/finish", { method: "POST", body: JSON.stringify({ id }) }, { retryBusy: true });
  return { id, groups: schedules.length };
}
