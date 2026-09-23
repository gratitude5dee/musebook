// packages/distributor/src/analytics/schedule.ts — §12.3.10's decaying
// collection schedule, keyed off publish time: T+1h/6h/24h/72h/7d, then stop.
// `days` is the `?date=` window the Postiz analytics route takes.

const TICKS: readonly { readonly afterHours: number; readonly days: number }[] = [
  { afterHours: 1, days: 1 },
  { afterHours: 6, days: 1 },
  { afterHours: 24, days: 1 },
  { afterHours: 72, days: 7 },
  { afterHours: 168, days: 7 },
];

/**
 * Which ticks of the decaying schedule are due for a post published at
 * `publishedAt` as of `now`. Returns the `days` window for each due tick —
 * one Postiz analytics call per due tick (each is a live provider API call
 * against the platform's quota, so the schedule is a budget, not a preference).
 */
export function dueTicks(publishedAt: Date, now: Date): readonly number[] {
  const elapsedHours = (now.getTime() - publishedAt.getTime()) / 3_600_000;
  return TICKS.filter((t) => elapsedHours >= t.afterHours).map((t) => t.days);
}

/** Nothing is collected after the 7-day tick. */
export function collectionComplete(publishedAt: Date, now: Date): boolean {
  return now.getTime() - publishedAt.getTime() >= 168 * 3_600_000;
}
