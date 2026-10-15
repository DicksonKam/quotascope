import { dayCutoff } from "../shared/time.ts";
import type { DashboardDetails } from "../shared/api.ts";
import type { Store } from "./store.ts";
import type { AccountSnapshot, Observation } from "../shared/types.ts";
import type { DashboardQuery } from "./dashboard-reader.ts";
import { sortWindows, windowKey } from "../shared/allowance.ts";
import {
  conservativePace,
  summarize,
  comparisons,
  reconstruct,
  trusted,
} from "./metrics.ts";
import { queryHistory, queryPace } from "./history-query.ts";

export class DashboardData {
  private cache = new Map<string, { revision: string; value: any }>();
  private histories = new Map<string, any>();
  constructor(private store: Store) {}
  private cached(name: string, revision: string, build: () => any) {
    const previous = this.cache.get(name);
    if (previous?.revision === revision) return previous.value;
    const value = build();
    this.cache.set(name, { revision, value });
    return value;
  }
  read(query: DashboardQuery = {}, now = Date.now()): DashboardDetails {
    const timezone =
      query.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const store = this.store,
      days = query.days ?? 30,
      view = query.view ?? "overview";
    store.db.exec("BEGIN");
    try {
      const revisions = Object.fromEntries(
        (
          store.db
            .prepare("SELECT name,value FROM dashboard_revisions")
            .all() as { name: string; value: number }[]
        ).map((r) => [r.name, String(r.value)]),
      );
      const current = store.get<AccountSnapshot>("accountSnapshot");
      const windows = sortWindows(current?.windows ?? []);
      const selected =
        windows.find((w) => windowKey(w) === query.window) ?? windows[0];
      const historyKey = JSON.stringify([
        revisions.observations,
        current?.id,
        selected && windowKey(selected),
        days,
      ]);
      let histories = this.histories.get(historyKey);
      if (!histories) {
        const from = now - days * 86400000;
        const account =
          selected && current?.identity === "provider"
            ? queryHistory(store, selected, "account", from, now)
            : { points: selected ? [selected] : [], truncated: false };
        const local =
          selected && current?.identity === "provider"
            ? queryHistory(store, selected, "local", from, now)
            : { points: [], truncated: false };
        histories = {
          history: account.points,
          localHistory: local.points,
          historyTruncated: account.truncated,
          localHistoryTruncated: local.truncated,
          rate: conservativePace(
            selected && current?.identity === "provider"
              ? queryPace(store, selected, now)
              : [],
            now,
          ),
        };
        this.histories.set(historyKey, histories);
        if (this.histories.size > 8)
          this.histories.delete(this.histories.keys().next().value!);
      }
      // A frozen dataset may outlive its original range query. Clip expired points
      // without rerunning a full query until new observations arrive.
      histories = {
        ...histories,
        history: histories.history.filter(
          (o: Observation) => o.at >= now - days * 86400000,
        ),
        localHistory: histories.localHistory.filter(
          (o: Observation) => o.at >= now - days * 86400000,
        ),
      };
      // Pace freshness is checked on every reply even if the sampled history is cached.
      const rate =
        selected && now - selected.at <= 120000
          ? histories.rate
          : conservativePace([], now);
      const usage = this.cached(
        "usage",
        revisions.events + ":" + timezone,
        () => {
          const all = summarize(store.events(), timezone);
          return {
            ...all,
            days: all.days.slice(-90),
            byModel: all.byModel.slice(0, 50),
            bySettings: all.bySettings.slice(0, 100),
            modelsTruncated: all.byModel.length > 50,
            settingsTruncated: all.bySettings.length > 100,
          };
        },
      );
      const recentRate =
        view === "activity"
          ? this.cached(
              "recentRate",
              revisions.events + ":" + Math.floor(now / 60000),
              () => {
                const recent = (
                  store.db
                    .prepare(
                      "SELECT data FROM events WHERE at>? AND at<=? ORDER BY at",
                    )
                    .all(now - 3600000, now) as { data: string }[]
                ).map((r) => JSON.parse(r.data));
                return (
                  recent
                    .filter(trusted)
                    .reduce((sum, e) => sum + e.input + e.output, 0) / 60
                );
              },
            )
          : 0;
      const coverage = this.cached(
        "coverage",
        revisions.attempts + ":" + Math.floor(now / 60000),
        () => this.coverage(now),
      );
      const comparison =
        view === "comparisons"
          ? this.cached(
              "comparison",
              [
                revisions.observations,
                revisions.events,
                revisions.annotations,
              ].join(":"),
              () => {
                const notes = store.annotations();
                const canCompare = notes.some(
                  (a) =>
                    a.kind === "plan" &&
                    a.verified &&
                    a.end !== null &&
                    notes.some(
                      (b) =>
                        b.kind === "coverage" &&
                        b.verified &&
                        b.account === a.account &&
                        b.end !== null &&
                        Math.max(a.at, b.at) < Math.min(a.end!, b.end),
                    ),
                );
                const all = canCompare
                  ? comparisons(store.observations(), store.events(), notes)
                  : comparisons([], [], []);
                return {
                  ...all,
                  pairs: all.pairs.slice(0, 50),
                  cohorts: all.cohorts.slice(0, 100),
                  truncated: all.pairs.length > 50 || all.cohorts.length > 100,
                };
              },
            )
          : null;
      const segments =
        view === "evidence"
          ? this.cached("segments", revisions.observations, () => {
              const recent = (
                store.db
                  .prepare(
                    "SELECT data FROM observations ORDER BY at DESC LIMIT 10000",
                  )
                  .all() as { data: string }[]
              )
                .reverse()
                .map((r) => JSON.parse(r.data));
              return reconstruct(recent).slice(0, 100);
            })
          : [];
      const issues =
        view === "evidence"
          ? this.cached("issues", revisions.issues, () =>
              store.issues().slice(0, 50),
            )
          : [];
      const annotations = (
        store.db
          .prepare("SELECT id,data FROM annotations ORDER BY id DESC LIMIT 100")
          .all() as { id: number; data: string }[]
      ).map((r) => ({ ...JSON.parse(r.data), id: r.id }));
      const accounts =
        view === "comparisons"
          ? this.cached("accounts", revisions.observations, () =>
              (
                store.db
                  .prepare(
                    `SELECT DISTINCT json_extract(data,'$.account') AS account FROM observations
        WHERE coalesce(json_extract(data,'$.identity'),'provider')!='unknown' AND json_extract(data,'$.account') NOT LIKE 'unattributed%'
        AND json_extract(data,'$.account')!='manual-account' ORDER BY account LIMIT 100`,
                  )
                  .all() as { account: string }[]
              ).map((r) => r.account),
            )
          : [];
      const cutoff = dayCutoff(now, timezone);
      const result = {
        windows,
        latest: selected,
        identity: current?.identity ?? null,
        snapshotId: current?.id ?? null,
        ...histories,
        rate,
        windowHistories: selected
          ? [{ key: windowKey(selected), ...histories, rate }]
          : [],
        usage:
          view === "activity"
            ? {
                ...usage,
                days: usage.days.filter(
                  (day: { name: string }) => day.name >= cutoff,
                ),
                recentTokensPerMinute: recentRate,
              }
            : { ...usage, days: [], byModel: [], bySettings: [], sessions: [] },
        coverage,
        segments,
        comparison,
        annotations,
        accounts:
          current?.identity === "provider"
            ? [
                current.account,
                ...accounts.filter((a: string) => a !== current.account),
              ].slice(0, 100)
            : accounts,
        issues,
        query: {
          days,
          window: selected ? windowKey(selected) : "",
          view,
          timezone,
        },
      };
      store.db.exec("COMMIT");
      return result;
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
  }
  private coverage(now: number) {
    const db = this.store.db,
      from = now - 86400000;
    const intervals = `WITH successes AS (SELECT DISTINCT CAST(json_extract(data,'$.at') AS INTEGER) AS at FROM attempts WHERE json_extract(data,'$.ok')=1),
      intervals AS (SELECT lag(at) OVER (ORDER BY at) AS start,at AS end FROM successes)`;
    const bounds = db
      .prepare(
        `SELECT min(CAST(json_extract(data,'$.at') AS INTEGER)) AS firstSuccessAt,
      max(CAST(json_extract(data,'$.at') AS INTEGER)) AS lastSuccessAt FROM attempts WHERE json_extract(data,'$.ok')=1`,
      )
      .get() as { firstSuccessAt: number | null; lastSuccessAt: number | null };
    const summary = db
      .prepare(
        `${intervals} SELECT count(*) AS gapCount,
      coalesce(sum(CASE WHEN end>? AND start<? THEN 1 ELSE 0 END),0) AS recentGaps,
      coalesce(max(CASE WHEN end>? AND start<? THEN min(end,?)-max(start,?) ELSE 0 END),0) AS longestMs
      FROM intervals WHERE end-start>120000`,
      )
      .get(from, now, from, now, now, from) as {
      gapCount: number;
      recentGaps: number;
      longestMs: number;
    };
    const gaps = db
      .prepare(
        `${intervals} SELECT start,end FROM intervals WHERE end-start>120000 ORDER BY end DESC LIMIT 20`,
      )
      .all() as { start: number; end: number }[];
    return {
      ...bounds,
      thresholdMs: 120000,
      gapCount: summary.gapCount,
      gaps,
      recent: { gaps: summary.recentGaps, longestMs: summary.longestMs },
    };
  }
}
