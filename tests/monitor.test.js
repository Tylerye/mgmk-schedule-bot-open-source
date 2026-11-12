import test from "node:test";
import assert from "node:assert/strict";
import { checkSchedules } from "../src/monitor.js";

const candidate = {
  id: "source-1",
  name: "15.09.26 по учащимся.pdf",
  scheduleDate: "2026-09-15",
  lastModified: "Tue, 15 Sep 2026 10:00:00 GMT",
  contentLength: 100,
  etag: "v1",
};
const config = { curatorUserId: "900000002",
  timezone: "Europe/Minsk",
  lookaheadDays: 5,
  groupName: "8Са",
  displayGroup: "8-Сба",
  bells: { tuesday: [] },
  dryRun: false,
};
const logger = { info() {}, warn() {}, error() {} };

function storeFixture() {
  return {
    state: {
      documents: { "source-1": { ...candidate, contentHash: "content-v1" } },
      schedules: {
        "2026-09-15": {
          scheduleHash: "schedule-v1",
          schedule: { date: "2026-09-15", canonicalGroup: "8CA", lessons: [], source: {}, hash: "schedule-v1" },
        },
      },
      health: {},
    },
    saves: 0,
    async save() { this.saves += 1; },
  };
}

test("duplicate polling checks metadata without downloading the PDF", async () => {
  const store = storeFixture();
  let downloads = 0;
  const results = await checkSchedules({
    config, store, logger,
    now: new Date("2026-09-15T09:00:00Z"),
    dependencies: {
      discoverCandidates: async () => [candidate],
      downloadDriveFile: async () => { downloads += 1; },
    },
  });
  assert.equal(downloads, 0);
  assert.equal(results[0].status, "unchanged");
  assert.ok(store.state.health.lastSourcePollSuccessAt);
});

test("a corrected source replaces the normalized schedule in state", async () => {
  const store = storeFixture();
  const changedCandidate = { ...candidate, etag: "v2", contentLength: 101 };
  const parsedSchedule = { date: "2026-09-15", canonicalGroup: "8CA", displayGroup: "8-Сба", lessons: [], timeline: [], source: {}, hash: "schedule-v2" };
  const results = await checkSchedules({
    config, store, logger,
    now: new Date("2026-09-15T09:00:00Z"),
    dependencies: {
      discoverCandidates: async () => [changedCandidate],
      downloadDriveFile: async () => ({ bytes: new TextEncoder().encode("%PDF-v2") }),
      extractPdf: async () => ({}),
      parseGroupSchedule: () => parsedSchedule,
    },
  });
  assert.equal(results[0].status, "updated");
  assert.equal(store.state.schedules["2026-09-15"].scheduleHash, "schedule-v2");
  assert.equal(store.state.documents["source-1"].etag, "v2");
});

test("temporary source failure does not erase known schedules", async () => {
  const store = storeFixture();
  const existing = store.state.schedules["2026-09-15"];
  await assert.rejects(() => checkSchedules({
    config, store, logger,
    dependencies: { discoverCandidates: async () => { throw new Error("temporary unavailable"); } },
  }), /temporary unavailable/);
  assert.equal(store.state.schedules["2026-09-15"], existing);
});
