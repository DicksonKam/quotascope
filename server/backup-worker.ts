import { join } from 'node:path';
import { createBackup, ensureAutomaticBackup } from './backups.ts';
import { Store } from './store.ts';
const dir=process.env.QUOTASCOPE_DATA_DIR!;
try {
 const result=process.env.QUOTASCOPE_BACKUP_MODE==='automatic'?ensureAutomaticBackup(dir):createBackup(dir,false);
 const store=new Store(join(dir,'quotascope.sqlite'));
 try{store.set('lastBackup',result);store.set('backupError',null);}finally{store.close();}
}catch {
 const store=new Store(join(dir,'quotascope.sqlite'));
 try{store.set('backupError','A verified backup could not be completed. Existing snapshots and history were preserved.');}finally{store.close();}
 process.exitCode=1;
}
