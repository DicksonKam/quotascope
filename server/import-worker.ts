import { join } from 'node:path';
import { Store } from './store.ts';
import { identityFactory } from './privacy.ts';
import { scan } from './scanner.ts';
const dir=process.env.QUOTASCOPE_DATA_DIR!;
const store=new Store(join(dir,'quotascope.sqlite'));
try {
 await scan(store,identityFactory(dir),process.env.QUOTASCOPE_LOG_ROOT?[process.env.QUOTASCOPE_LOG_ROOT]:undefined);
} finally {store.close();}
