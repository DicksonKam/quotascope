import type { Store } from './store.ts';
import type { Observation } from '../shared/types.ts';

export interface ChartObservation extends Observation { chartSegment: number; }
export const historyLimit = 600;

// Apply the range and identity scope before sampling. Preserve both sides of every
// boundary plus first/last/min/max in each time bin. In pathological histories with
// more boundaries than the display budget, show the most recent portion explicitly.
export function queryHistory(store: Store, window: Observation, source: 'account' | 'local', from: number, to: number) {
  const sql = `WITH raw AS MATERIALIZED (
    SELECT key,at,data,
      CAST(json_extract(data,'$.used') AS REAL) AS used,
      json_extract(data,'$.reset') AS reset,json_extract(data,'$.continuity') AS continuity,
      json_extract(data,'$.duration') AS duration,json_extract(data,'$.plan') AS plan
    FROM observations WHERE json_extract(data,'$.account')=? AND json_extract(data,'$.bucket')=?
      AND json_extract(data,'$.slot')=? AND json_extract(data,'$.source')=? AND at>=? AND at<=?
  ), previous AS (
    SELECT *,lag(at) OVER w AS previous_at,lag(used) OVER w AS previous_used,
      lag(reset) OVER w AS previous_reset,lag(continuity) OVER w AS previous_continuity,
      lag(duration) OVER w AS previous_duration,lag(plan) OVER w AS previous_plan
    FROM raw WINDOW w AS (ORDER BY at,key)
  ), marked AS (
    SELECT key,at,used,CASE WHEN previous_at IS NULL OR at-previous_at>? OR used<previous_used
      OR abs(reset-previous_reset)>60 OR continuity IS NOT previous_continuity
      OR duration IS NOT previous_duration OR plan IS NOT previous_plan THEN 1 ELSE 0 END AS boundary
    FROM previous
  ), charted AS MATERIALIZED (
    SELECT *,sum(boundary) OVER w AS segment,coalesce(lead(boundary) OVER w,1) AS end_boundary,
      CAST((at-?)*100.0/? AS INTEGER) AS bin FROM marked WINDOW w AS (ORDER BY at,key)
  ), bins AS (
    SELECT bin,min(at) AS first_at,max(at) AS last_at,min(used) AS low,max(used) AS high FROM charted GROUP BY bin
  ), picks AS (
    SELECT bin,first_at,last_at,min(CASE WHEN used=low THEN at END) AS low_at,
      min(CASE WHEN used=high THEN at END) AS high_at FROM charted JOIN bins USING(bin) GROUP BY bin
  ) SELECT raw.data,charted.segment FROM charted JOIN picks USING(bin) JOIN raw USING(key)
    WHERE (SELECT count(*) FROM raw)<=? OR boundary=1 OR end_boundary=1
      OR charted.at IN(first_at,last_at,low_at,high_at)
    ORDER BY charted.at DESC,charted.key DESC LIMIT ?`;
  const rows = store.db.prepare(sql).all(window.account, window.bucket, window.slot, source, from, to,
    source === 'account' ? 120000 : 6 * 3600000, from, Math.max(1, to - from + 1), historyLimit, historyLimit + 1) as { data: string; segment: number }[];
  const truncated = rows.length > historyLimit;
  const points: ChartObservation[] = rows.slice(0, historyLimit).reverse().map(r => ({ ...JSON.parse(r.data), chartSegment: r.segment }));
  return { points, truncated };
}

export function queryPace(store: Store, window: Observation, now: number): Observation[] {
  return (store.db.prepare(`SELECT data FROM observations WHERE json_extract(data,'$.account')=?
    AND json_extract(data,'$.bucket')=? AND json_extract(data,'$.slot')=? AND json_extract(data,'$.source')='account'
    AND at>=? AND at<=? AND json_extract(data,'$.continuity')=? ORDER BY at DESC,key DESC LIMIT 10000`)
    .all(window.account, window.bucket, window.slot, now - 6 * 3600000, now, window.continuity ?? '') as { data: string }[])
    .reverse().map(r => JSON.parse(r.data));
}
