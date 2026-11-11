import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerRequester } from "../scripts/worker-request.js";

test("parser result retries a transient D1 lock without changing the request", async () => {
  const statuses = [503, 503, 200];
  const calls = [];
  const delays = [];
  const request = createWorkerRequester({
    baseUrl: "https://worker.example",
    sharedSecret: "secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const status = statuses.shift();
      return { status, ok: status === 200, json: async () => ({ ok: true }) };
    },
    sleep: async (ms) => { delays.push(ms); },
  });
  assert.deepEqual(await request("/internal/jobs/job/result", { method: "POST", body: "same-result" }, { retryBusy: true }), { ok: true });
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ url, options }) => url.endsWith("/result") && options.body === "same-result"));
});

test("parser result does not retry permanent failures", async () => {
  let calls = 0;
  const request = createWorkerRequester({
    baseUrl: "https://worker.example",
    sharedSecret: "secret",
    fetchImpl: async () => { calls++; return { status: 403, ok: false }; },
    sleep: async () => assert.fail("must not sleep"),
  });
  await assert.rejects(request("/internal/jobs/job/result", {}, { retryBusy: true }), /HTTP 403/);
  assert.equal(calls, 1);
});

test("durable result submission retries temporary network and gateway failures", async () => {
  let calls = 0;
  const request = createWorkerRequester({
    baseUrl: "https://worker.example", sharedSecret: "secret", sleep: async () => {},
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw new Error("connection reset");
      if (calls === 2) return { status: 502, ok: false };
      return { status: 202, ok: true, json: async () => ({ ok: true, queued: true }) };
    },
  });
  assert.equal((await request("/internal/jobs/job/result", {}, { retryBusy: true })).queued, true);
  assert.equal(calls, 3);
});
