import test from "node:test";
import assert from "node:assert/strict";
import { assertPollingAvailable, createSerialExecutor } from "../src/runtime.js";

test("local polling refuses an active webhook without changing it", async () => {
  const calls = [];
  const client = { async call(method) {
    calls.push(method);
    return { url: "https://production.example/telegram/webhook" };
  } };
  await assert.rejects(assertPollingAvailable(client), /Local polling is disabled/);
  assert.deepEqual(calls, ["getWebhookInfo"]);
});

test("local polling is allowed when no webhook is configured", async () => {
  await assert.doesNotReject(assertPollingAvailable({ async call(method) {
    assert.equal(method, "getWebhookInfo");
    return { url: "" };
  } }));
});

test("the shared executor prevents overlapping poll and reconciliation cycles", async () => {
  const exclusive = createSerialExecutor();
  let active = 0;
  let maximum = 0;
  const task = () => exclusive(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });
  await Promise.all([task(), task(), task()]);
  assert.equal(maximum, 1);
});
