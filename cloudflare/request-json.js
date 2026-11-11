export class InputError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readJson(request, maxBytes, timeoutMs = 5000) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new InputError(413, 'request too large');
  if (!request.body) throw new InputError(400, 'invalid JSON');
  const reader = request.body.getReader();
  const chunks = []; let length = 0, finished = false, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new InputError(408, 'request body timeout')), timeoutMs); });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) { finished = true; break; }
      length += value.byteLength;
      if (length > maxBytes) throw new InputError(413, 'request too large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let result;
    try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new InputError(400, 'invalid JSON'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new InputError(400, 'JSON object required');
    return result;
  } finally {
    clearTimeout(timer);
    if (!finished) void reader.cancel().catch(() => {});
  }
}
