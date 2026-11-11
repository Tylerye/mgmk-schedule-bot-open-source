import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state.js";

test("state migration removes the old private destination but preserves parsed schedules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mgmk-state-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({
    version: 1,
    chatId: "900000001",
    schedules: {
      "2026-09-15": { schedule: { date: "2026-09-15" }, messageId: 13, sentHash: "old" },
    },
  }));
  try {
    const store = new StateStore(path);
    await store.load();
    assert.equal(store.state.chatId, null);
    assert.ok(store.state.schedules["2026-09-15"].schedule);
    assert.equal(store.state.schedules["2026-09-15"].messageId, undefined);
    assert.equal(store.state.version, 3);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("only negative Telegram group IDs can be configured", () => {
  const store = new StateStore("unused.json");
  assert.throws(() => store.configureChat("42"), /group or supergroup/);
  assert.equal(store.configureChat("-100123"), true);
  assert.equal(store.state.chatId, "-100123");
});
