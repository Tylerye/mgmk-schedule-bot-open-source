// Per-subsystem allocation, not an increase to Cloudflare's account allowance.
// Cap this Worker at 73k of the account's 100k writes.
export function personalQuota(env = {}) {
  const written = Number(env.PERSONAL_DAILY_WRITES ?? 28000);
  const background = Number(env.PERSONAL_BACKGROUND_WRITES ?? 22000);
  const source = Number(env.PERSONAL_SOURCE_WRITES ?? 26000);
  if (![written, background, source].every(Number.isSafeInteger)
    || background < 1000 || background >= source || source >= written || written > 73000)
    throw new Error('Invalid personal quota allocation');
  return { written, background, source };
}

export const manualJobsOnly = mode => mode === 'normal' ? '' : " AND json_extract(payload,'$.manual')=1";
