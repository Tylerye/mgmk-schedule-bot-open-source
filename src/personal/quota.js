// Per-subsystem allocation, not an increase to Cloudflare's account allowance.
// Leave at least half the account's 100k writes outside this Worker.
export function personalQuota(env = {}) {
  const written = Number(env.PERSONAL_DAILY_WRITES ?? 28000);
  const background = Number(env.PERSONAL_BACKGROUND_WRITES ?? 22000);
  const source = Number(env.PERSONAL_SOURCE_WRITES ?? 26000);
  if (![written, background, source].every(Number.isSafeInteger)
    || background < 1000 || background >= source || source >= written || written > 50000)
    throw new Error('Invalid personal quota allocation');
  return { written, background, source };
}

export const manualJobsOnly = mode => mode === 'normal' ? '' : " AND json_extract(payload,'$.manual')=1";
