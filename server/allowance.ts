import type { AccountSnapshot, Observation } from '../shared/types.ts';
import { sortWindows, windowKey } from '../shared/allowance.ts';
import { conservativePace } from './metrics.ts';

// In-memory reference for small accounting fixtures. The running dashboard uses
// DashboardData and indexed range queries instead of loading all observations.
export function allowanceView(observations: Observation[], current?: AccountSnapshot) {
  const windows = sortWindows(current?.windows ?? []);
  const windowHistories = windows.map(window => {
    const matches = (o: Observation) => o.account === window.account && windowKey(o) === windowKey(window);
    const identified = current!.identity === 'provider';
    const history = identified ? observations.filter(o => o.source === 'account' && matches(o)) : [window];
    const localHistory = identified ? observations.filter(o => o.source === 'local' && matches(o)) : [];
    // Only readings from the latest uninterrupted identity/window membership can
    // contribute to pace. Old history remains visible with explicit boundaries.
    const series = history.filter(o => o.continuity === current!.continuity);
    const sample = (values: Observation[], count: number) => values.filter((_, i) => i % Math.max(1, Math.floor(values.length / count)) === 0 || i === values.length - 1);
    return { key: windowKey(window), history: sample(history, 450), localHistory: sample(localHistory, 600), rate: conservativePace(series) };
  });
  return {
    windows, latest: windows[0], windowHistories,
    history: windowHistories[0]?.history ?? [], localHistory: windowHistories[0]?.localHistory ?? [],
    rate: windowHistories[0]?.rate ?? conservativePace([]),
    identity: current?.identity ?? null,
  };
}
