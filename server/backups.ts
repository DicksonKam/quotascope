import { mkdirSync, copyFileSync, chmodSync, writeFileSync, readFileSync, readdirSync, lstatSync, existsSync, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.ts';
export interface BackupManifest {
 version:1; id:string; createdAt:number; automatic:boolean;
 hashes:Record<string,string>; counts:Record<string,number>;
}
const digest=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const tables=['observations','events','attempts','annotations'];
export function verifyBackup(folder:string):BackupManifest {
 const manifest=JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8')) as BackupManifest;
 if(manifest.version!==1||!/^(auto|backup)-\d+-[0-9a-f-]{36}$/.test(manifest.id)||!Number.isFinite(manifest.createdAt)||typeof manifest.automatic!=='boolean')throw Error('Invalid backup manifest.');
 for(const name of ['quotascope.sqlite','identity.key']) {
  const path=join(folder,name);
  if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()||digest(path)!==manifest.hashes[name])throw Error('Backup integrity check failed.');
 }
 const db=new DatabaseSync(join(folder,'quotascope.sqlite'),{readOnly:true});
 try {
  if(Object.values(db.prepare('PRAGMA quick_check').get()!)[0]!=='ok')throw Error('Backup database check failed.');
  if((db.prepare("SELECT value FROM meta WHERE key='schema'").get() as any)?.value!=='2')throw Error('Unsupported backup schema.');
  for(const table of tables)if((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as any).n!==manifest.counts[table])throw Error('Backup record counts do not match.');
 }finally{db.close();}
 return manifest;
}
export function rotateBackups(root:string,keep=7,trash=join(homedir(),'.Trash'),protectedId?:string) {
 const candidates: {folder:string;manifest:BackupManifest}[]=[];
 for(const entry of readdirSync(root,{withFileTypes:true})) {
  if(!entry.isDirectory()||!entry.name.startsWith('auto-'))continue;
  const folder=join(root,entry.name);
  try{const manifest=verifyBackup(folder);if(manifest.automatic&&manifest.id===entry.name)candidates.push({folder,manifest});}catch{/* Incomplete or unverifiable copies are preserved for inspection. */}
 }
 candidates.sort((a,b)=>b.manifest.createdAt-a.manifest.createdAt);
 const moved:string[]=[];
 const obsolete=protectedId?candidates.filter(c=>c.manifest.id!==protectedId).slice(Math.max(0,keep-1)):candidates.slice(Math.max(1,keep));
 for(const candidate of obsolete) {
  if(!existsSync(trash)||!lstatSync(trash).isDirectory()||lstatSync(trash).isSymbolicLink())throw Error('Trash unavailable. Older backups were preserved.');
  const target=join(trash,`quotascope-${candidate.manifest.id}-${randomUUID()}`);
  renameSync(candidate.folder,target);
  if(existsSync(candidate.folder)||!existsSync(target))throw Error('Could not verify recoverable backup move.');
  moved.push(target);
 }
 return moved;
}
export function createBackup(dir:string,automatic:boolean,now=Date.now(),options:{keep?:number;trash?:string}={}) {
 const root=join(dir,'backups');mkdirSync(root,{recursive:true,mode:0o700});
 if(lstatSync(root).isSymbolicLink())throw Error('Backup directory must not be a symbolic link.');
 const id=`${automatic?'auto':'backup'}-${now}-${randomUUID()}`,folder=join(root,id);
 mkdirSync(folder,{mode:0o700});
 const source=new Store(join(dir,'quotascope.sqlite'));
 try{source.backup(join(folder,'quotascope.sqlite'));}finally{source.close();}
 chmodSync(join(folder,'quotascope.sqlite'),0o600);
 copyFileSync(join(dir,'identity.key'),join(folder,'identity.key'));chmodSync(join(folder,'identity.key'),0o600);
 const snapshot=new DatabaseSync(join(folder,'quotascope.sqlite'),{readOnly:true});
 const counts:Record<string,number>={};
 try{for(const table of tables)counts[table]=(snapshot.prepare(`SELECT count(*) AS n FROM ${table}`).get() as any).n;}finally{snapshot.close();}
 const manifest:BackupManifest={version:1,id,createdAt:now,automatic,counts,hashes:Object.fromEntries(['quotascope.sqlite','identity.key'].map(name=>[name,digest(join(folder,name))]))};
 writeFileSync(join(folder,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
 verifyBackup(folder);
 // The new verified copy is kept even if Trash access prevents retention cleanup.
 let retentionWarning:string|null=null;
 try{rotateBackups(root,options.keep??7,options.trash,automatic?id:undefined);}catch{retentionWarning='Older automatic copies were preserved because recoverable cleanup was unavailable.';}
 return {id,at:now,verified:true,automatic,retentionWarning};
}
export function ensureAutomaticBackup(dir:string,now=Date.now()) {
 const store=new Store(join(dir,'quotascope.sqlite'));
 let last:ReturnType<typeof createBackup>|undefined;
 try{last=store.get('lastBackup');}finally{store.close();}
 if(last&&now-last.at>=0&&now-last.at<86400000&&/^(auto|backup)-\d+-[0-9a-f-]{36}$/.test(last.id)) {
  try{verifyBackup(join(dir,'backups',last.id));return last;}catch{/* Missing or damaged latest copy is replaced with a new verified snapshot. */}
 }
 return createBackup(dir,true,now);
}
