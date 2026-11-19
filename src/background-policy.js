// Minsk is UTC+03:00 year-round. Gate before any D1 access or HTTP fanout.
const nightStart = 20 * 60;
const nightEnd = 6 * 60 + 30;

export function backgroundPolicy(now = new Date()) {
  const local = new Date(now.getTime() + 3 * 3600000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const night = minute >= nightStart || minute < nightEnd;
  return { night, intervalMinutes: night ? 15 : 1,
    run: !night || minute % 15 === 0,
    // Allow the final night check to age normally during the morning handover.
    staleAfterMs: (night || minute < nightEnd + 5 ? 20 : 5) * 60000 };
}
