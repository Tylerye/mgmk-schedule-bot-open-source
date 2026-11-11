import test from "node:test";
import assert from "node:assert/strict";
import { personalFixture } from "./helpers/personal-fixture.js";
import { mergeCatalogObservations } from "../src/personal/ingest.js";
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
