import test from "node:test";
import assert from "node:assert/strict";
import { personalFixture, sampleSchedule } from "./helpers/personal-fixture.js";
import { beginDataset, finishDataset, MAX_STAGE_BYTES, mergeCatalogObservations, stageSchedules } from "../src/personal/ingest.js";
import { uploadPersonalResult } from "../scripts/personal-upload.js";

test("an entirely failed timetable still adds its newly discovered group to the production catalog path", async t => {
  const f = await personalFixture(); t.after(() => f.close());
  const calls = [];
  const request = async (path, options) => {
    const input = JSON.parse(options.body); calls.push(path);
    if (path.endsWith("/catalog")) await mergeCatalogObservations(f.store, input.observations);
    else assert.equal(path, "/internal/personal/source-error");
    return { ok: true };
  };
  const result = { publishable: false, date: "2026-11-12", observations: [{ group: "99Ж", date: "2026-11-12" }], schedules: [],
    coverage: { parsed: 0, discovered: 1 }, errors: [{ id: "99Ж" }], structuralErrors: [] };
  await assert.rejects(uploadPersonalResult({ result, source: {}, request }), /0\/1/u);
  assert.ok((await f.store.groups()).some(g => g.id === "99Ж"));
  assert.equal((await f.store.all("SELECT * FROM active_versions")).length, 0);
  assert.equal((await f.store.all("SELECT * FROM jobs")).length, 0);
  assert.equal(calls.at(-1), "/internal/personal/source-error");
  assert.ok(!calls.some(path => /begin|stage|finish/u.test(path)));
});

test("published PDFs activate before the catalog and respect the receiver's batch size", async () => {
  const schedules = await Promise.all(Array.from({ length: 40 }, (_, i) => sampleSchedule(String(i + 1) + "ТМ")));
  const result = { publishable: true, date: schedules[0].date, schedules, observations: schedules.map(s => ({ group: s.group, date: s.date })) };
  for (const [maxStageSchedules, sizes] of [[12, [12, 12, 12, 4]], [24, [24, 16]]]) {
    const calls = [];
    await uploadPersonalResult({ result, source: {}, generation: 1, contentHash: "fixture",
      async request(path, { body }) {
        calls.push([path.split("/").at(-1), JSON.parse(body)]);
        return { maxStageSchedules, catalogSeedKnown: true };
      },
    });
    assert.deepEqual(calls.map(([name]) => name),
      ["begin", ...sizes.map(() => "stage"), "finish", "catalog", "catalog", "catalog", "catalog"]);
    assert.deepEqual(calls.filter(([name]) => name === "stage").map(([, { schedules }]) => schedules.length), sizes);
  }
});

test("large UTF-8 timetables still split at the byte limit", async () => {
  const schedules = await Promise.all(Array.from({ length: 24 }, (_, i) => sampleSchedule(String(i + 1) + "ТМ")));
  for (const schedule of schedules) for (const lesson of schedule.lessons)
    lesson.variants[0].subject = "Я".repeat(2900);
  const sizes = [];
  await uploadPersonalResult({ result: { publishable: true, date: schedules[0].date, schedules, observations: [] },
    source: {}, generation: 1, contentHash: "fixture", async request(path, { body }) {
      if (path.endsWith("/stage")) {
        assert.ok(Buffer.byteLength(body) <= MAX_STAGE_BYTES);
        sizes.push(JSON.parse(body).schedules.length);
      }
      return { maxStageSchedules: 24, catalogSeedKnown: true };
    },
  });
  assert.ok(sizes.length > 1);
  assert.equal(sizes.reduce((a,b) => a+b), schedules.length);
});

test("overlapping observations preserve both catalog dates and replay writes nothing", async t => {
  const f = await personalFixture();
  t.after(() => f.close());
  await mergeCatalogObservations(f.store, [{ group: "8Са", date: "2026-11-19" }]);
  await mergeCatalogObservations(f.store, [{ group: "8СА", date: "2026-11-18" }]);
  const [group] = await f.store.groups();
  assert.deepEqual(group.dates, ["2026-11-18", "2026-11-19"]);
  assert.equal(group.sourceLabels.length, 2);
  const changes = f.sqlite.prepare("SELECT total_changes() AS n").get().n;
  await mergeCatalogObservations(f.store, [{ group: "8СА", date: "2026-11-18" }]);
  assert.equal(f.sqlite.prepare("SELECT total_changes() AS n").get().n, changes);
});

test("a ready upload skips staging while finish and catalog still run", async t => {
  const f = await personalFixture();
  t.after(() => f.close());
  const s = await sampleSchedule();
  const result = { publishable: true, date: s.date, schedules: [s], observations: [{ group: s.group, date: s.date }] };
  const calls = [];
  const options = { result, source: {}, generation: 1, contentHash: "fixture", async request(path, { body }) {
    const action = path.split("/").at(-1);
    const input = JSON.parse(body);
    calls.push(action);
    if (action === "begin") return { ready: await beginDataset(f.store, input), catalogSeedKnown: true };
    if (action === "stage") await stageSchedules(f.store, input.id, input.schedules);
    if (action === "finish") await finishDataset(f.store, input.id);
    return { ok: true };
  } };
  await uploadPersonalResult(options);
  assert.deepEqual(calls.splice(0), ["begin", "stage", "finish", "catalog"]);
  await uploadPersonalResult(options);
  assert.deepEqual(calls, ["begin", "finish", "catalog"]);
});
