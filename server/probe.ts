import { configuration } from './config.ts';
import { readAccount, accountObservations } from './account.ts';
try { const result = accountObservations(await readAccount(20000, configuration().codex), () => 'redacted'); console.log(JSON.stringify(result, null, 2)); }
catch (e) { console.error((e as Error).message); process.exitCode = 1; }
