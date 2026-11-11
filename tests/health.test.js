import test from "node:test";
import assert from "node:assert/strict";
import { healthSnapshot } from "../src/health.js";

test("health status exposes operational timestamps without configuration secrets", () => {
  const snapshot = healthSnapshot({
    chatId: "-1001",
    pinnedSchedule: { date: "2026-09-16" },
    pinCapability: { canPin: false },
    health: {
      startedAt: "start",
      lastTelegramSuccessAt: "telegram",
      lastSourcePollAt: "poll",
      lastSourcePollSuccessAt: "success",
      lastSourceChangeAt: "change",
      lastParserSuccessAt: "parser",
      nextSourcePollAt: "next",
      lastError: null,
    },
  });
  assert.equal(snapshot.configuredChat, true);
  assert.equal(snapshot.pinnedScheduleDate, "2026-09-16");
  assert.equal(snapshot.canPinMessages, false);
  assert.equal("botToken" in snapshot, false);
  assert.equal("adminUserId" in snapshot, false);
});
