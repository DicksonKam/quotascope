import { existsSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { verifyBackup } from './backups.ts';
import { Store } from './store.ts';
import { configuration } from './config.ts';
const source = resolve(process.argv[2] ?? ''), target = resolve(process.argv[3] ?? join(configuration().dataDir,'..',`restored-${Date.now()}`));
if (!process.argv[2] || existsSync(target) || !existsSync(join(source,'identity.key')) || !existsSync(join(source,'quotascope.sqlite'))) throw new Error('Usage: npm run restore -- BACKUP_DIRECTORY NEW_EMPTY_TARGET. The target must not exist.');
// Legacy manual backups remain supported; new snapshots must pass their manifest checks.
if(existsSync(join(source,'manifest.json'))||/^(auto|backup)-\d+-[0-9a-f-]{36}$/.test(basename(source)))verifyBackup(source);
mkdirSync(target, { recursive: true, mode: 0o700 });
copyFileSync(join(source,'identity.key'),join(target,'identity.key')); copyFileSync(join(source,'quotascope.sqlite'),join(target,'quotascope.sqlite'));
chmodSync(join(target,'identity.key'),0o600);chmodSync(join(target,'quotascope.sqlite'),0o600);
const store = new Store(join(target,'quotascope.sqlite')); console.log(`Restored ${store.events().length} usage events. Install and start using QUOTASCOPE_DATA_DIR pointing at the new target (npm run service -- install). The installer saves this selection for future starts.`); store.close();
