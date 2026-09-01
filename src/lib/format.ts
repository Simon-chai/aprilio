/** "2026-08-26 14:20:00" → "08-26 14:20"；非法输入原样返回 */
export function formatShort(ts: string | null): string {
  if (!ts) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(ts);
  if (!m) return ts;
  const [, , month, day, hour, minute] = m;
  return hour ? `${month}-${day} ${hour}:${minute}` : `${month}-${day}`;
}

/** "2026-08-26 14:20:00" → "2026-08-26" */
export function formatDate(ts: string | null): string {
  if (!ts) return "—";
  return ts.slice(0, 10);
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
