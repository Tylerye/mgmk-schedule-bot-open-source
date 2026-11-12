import { credentialOrigin } from "../src/credential-origin.js";
const BUSY_DELAYS_MS = [1000, 2000, 4000, 8000, 10000, 10000, 10000];
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function createWorkerRequester({ baseUrl, sharedSecret, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  baseUrl = credentialOrigin(baseUrl);
  if (typeof sharedSecret !== "string" || !sharedSecret.trim()) throw new Error("Parser authentication is required");
  const headers = { authorization: `Bearer ${sharedSecret}`, "content-type": "application/json" };
  return async function request(path, options = {}, { retryBusy = false } = {}) {
    if (typeof path !== "string" || !/^\/internal\/[A-Za-z0-9_/%.-]+$/.test(path) || path.includes("..") || /%2e|%2f|%5c/i.test(path)) throw new Error("Invalid internal request path");
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          ...options,
          headers: { ...headers, ...(options.headers ?? {}) },
          signal: AbortSignal.timeout(20_000),
          redirect: "error",
        });
      } catch {
        if (!retryBusy || attempt >= BUSY_DELAYS_MS.length) throw new Error(`Worker request ${path} failed: network or timeout`);
        await sleep(BUSY_DELAYS_MS[attempt]);
        continue;
      }
      if (retryBusy && TRANSIENT_STATUS.has(response.status) && attempt < BUSY_DELAYS_MS.length) {
        await sleep(BUSY_DELAYS_MS[attempt]);
        continue;
      }
      if (!response.ok) throw new Error(`Worker request ${path} failed: HTTP ${response.status}`);
      return response.json();
    }
  };
}
