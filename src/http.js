const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithRetry(url, options = {}, settings = {}) {
  const retries = settings.httpRetries ?? settings.retries ?? 3;
  const timeoutMs = settings.httpTimeoutMs ?? settings.timeoutMs ?? 30_000;
  const baseDelayMs = settings.baseDelayMs ?? 350;
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = settings.abortSignal ? AbortSignal.any([timeout, settings.abortSignal]) : timeout;
      const response = await fetch(url, {
        ...options,
        headers: {
          "user-agent": "MGMC-Schedule-Bot/0.1 (+https://college.by/)",
          ...(options.headers ?? {}),
        },
        signal,
      });
      if (!TRANSIENT_STATUS.has(response.status) || attempt === retries) return response;
      lastError = new Error(`Transient HTTP ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
    }
    const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 150);
    settings.logger?.warn("retry", { operation: "http_fetch", attempt, delayMs: delay, error: lastError?.message });
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw lastError;
}
