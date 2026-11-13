// Minsk is UTC+03:00 year-round. Gate before any D1 access or HTTP fanout.
export function backgroundPolicy(now = new Date()) {
  const local = new Date(now.getTime() + 3 * 3600000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const night = minute >= 21 * 60 + 30 || minute < 6 * 60;
  return { night, intervalMinutes: night ? 15 : 1,
    run: !night || minute % 15 === 0,
    // Allow the final night check to age normally during the morning handover.
    staleAfterMs: (night || minute < 6 * 60 + 5 ? 20 : 5) * 60000 };
}
