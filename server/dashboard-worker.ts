import { Store } from './store.ts';
import { DashboardData } from './dashboard-data.ts';

const store = new Store(process.argv[2], true);
const dashboard = new DashboardData(store);
process.on('message', (message: any) => {
  try {
    const result = dashboard.read(message.query);
    process.send?.({ id: message.id, result, metrics: { pid: process.pid, rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 } });
  }
  catch { process.send?.({ id: message?.id, error: true }); }
});
process.on('disconnect', () => { store.close(); process.exit(0); });
