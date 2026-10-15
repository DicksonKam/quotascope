import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Coverage } from '../shared/monitoring.ts';
import type { AccountSnapshot, Annotation, Attempt, Observation, TokenEvent } from '../shared/types.ts';
export class Store {
  db: DatabaseSync;
  private coverageCache: Coverage | null = null;
  constructor(public path: string, readOnly = false) {
    if (readOnly) {
      this.db = new DatabaseSync(path, { readOnly: true });
      this.db.exec('PRAGMA busy_timeout=5000');
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations (key TEXT PRIMARY KEY, at INTEGER, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, at INTEGER, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issues (key TEXT PRIMARY KEY, code TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS annotations (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS observation_at ON observations(at);
      CREATE INDEX IF NOT EXISTS event_at ON events(at);`);
    const v = this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema') as any;
    if (v?.value === '1') {
      // Archive the old derived ledger and cursors in place. Keep all observations and notes.
      this.db.exec(`BEGIN; ALTER TABLE events RENAME TO event_archive_v1;
        CREATE TABLE events (key TEXT PRIMARY KEY, at INTEGER, data TEXT NOT NULL);
        ALTER TABLE files RENAME TO file_archive_v1; CREATE TABLE files (key TEXT PRIMARY KEY, data TEXT NOT NULL);
        UPDATE meta SET value='2' WHERE key='schema'; COMMIT;`);
    } else if (v && v.value !== '2') throw new Error('Unsupported database schema. Preserve this file and use a compatible version.');
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('schema', '2');
    this.db.exec('CREATE INDEX IF NOT EXISTS event_at_v2 ON events(at)');
    this.db.exec(`CREATE INDEX IF NOT EXISTS observation_scope_at ON observations(
      json_extract(data,'$.account'),json_extract(data,'$.bucket'),json_extract(data,'$.slot'),json_extract(data,'$.source'),at,key);
      CREATE INDEX IF NOT EXISTS attempt_success_at ON attempts(CAST(json_extract(data,'$.at') AS INTEGER)) WHERE json_extract(data,'$.ok')=1;
      CREATE TABLE IF NOT EXISTS dashboard_revisions (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
    // Revisions change in the same transaction as the data, including worker writes.
    // Rolled-back writes cannot invalidate a committed cache or advance its revision.
    for (const table of ['observations', 'events', 'attempts', 'annotations', 'issues']) {
      this.db.prepare('INSERT OR IGNORE INTO dashboard_revisions VALUES (?,0)').run(table);
      for (const operation of ['INSERT', 'UPDATE']) {
        let name = `dashboard_${table}_${operation.toLowerCase()}`;
        const existing = this.db.prepare("SELECT tbl_name FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { tbl_name: string } | undefined;
        // A schema-1 ledger can have been archived together with its old triggers.
        if (existing && existing.tbl_name !== table) name += '_live';
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${operation} ON ${table}
          BEGIN UPDATE dashboard_revisions SET value=value+1 WHERE name='${table}'; END;`);
      }
    }
  }
  get<T>(key: string): T | undefined { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as any; return row ? JSON.parse(row.value) : undefined; }
  set(key: string, value: unknown) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value)); }
  observe(o: Observation) {
    const key = JSON.stringify([o.account, o.bucket, o.slot, o.source, o.at, o.used, o.reset]);
    this.db.prepare('INSERT OR IGNORE INTO observations VALUES (?,?,?)').run(key, o.at, JSON.stringify(o));
  }
  saveAccountSnapshot(snapshot: AccountSnapshot) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      snapshot.windows.forEach(o => this.observe(o));
      this.set('accountSnapshot', snapshot);
      this.set('accountContinuityBroken', false);
      this.attempt({ at: snapshot.at, ok: true, message: 'Account allowance updated' });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  accountReadFailed(message: string, at = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.set('accountContinuityBroken', true);
      this.attempt({ at, ok: false, message });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(e: TokenEvent) {
    const row = this.db.prepare('SELECT data FROM events WHERE key=?').get(e.key) as any;
    if (row) {
      const previous: TokenEvent = JSON.parse(row.data);
      if (['input','cached','cacheWrite','output','reasoning','total'].some(k=>(previous as any)[k] !== (e as any)[k])) {
        previous.flags = [...new Set([...previous.flags, 'response-id-conflict'])];
        this.db.prepare('UPDATE events SET data=? WHERE key=?').run(JSON.stringify(previous),e.key);
        this.issue(e.key,'response-id-conflict');
      } else if (previous.turnStart == null && e.turnStart != null) {
        previous.turnStart=e.turnStart;
        this.db.prepare('UPDATE events SET data=? WHERE key=?').run(JSON.stringify(previous),e.key);
      }
      return;
    }
    this.db.prepare('INSERT INTO events VALUES (?,?,?)').run(e.key, e.at, JSON.stringify(e));
  }
  cursor<T>(key: string): T | undefined { const row = this.db.prepare('SELECT data FROM files WHERE key=?').get(key) as any; return row ? JSON.parse(row.data) : undefined; }
  saveCursor(key: string, data: unknown) { this.db.prepare('INSERT OR REPLACE INTO files VALUES (?,?)').run(key, JSON.stringify(data)); }
  issue(key: string, code: string) { this.db.prepare('INSERT OR IGNORE INTO issues VALUES (?,?)').run(key, code); }
  issues(): { code: string; count: number }[] { return this.db.prepare('SELECT code, count(*) AS count FROM issues GROUP BY code ORDER BY count DESC').all() as any; }
  observations(): Observation[] { return this.db.prepare('SELECT data FROM observations ORDER BY at').all().map((r: any) => JSON.parse(r.data)); }
  hasAccount(account: string): boolean {
    if (account.startsWith('unattributed') || account === 'manual-account') return false;
    return !!this.db.prepare("SELECT 1 FROM observations WHERE json_extract(data,'$.account')=? AND coalesce(json_extract(data,'$.identity'),'provider')!='unknown' LIMIT 1").get(account);
  }
  events(): TokenEvent[] { return this.db.prepare('SELECT data FROM events ORDER BY at').all().map((r: any) => JSON.parse(r.data)); }
  attempt(a: Attempt) { this.coverageCache=null; this.db.prepare('INSERT INTO attempts(data) VALUES (?)').run(JSON.stringify(a)); }
  attempts(): Attempt[] { return this.db.prepare('SELECT data FROM attempts ORDER BY id DESC LIMIT 20').all().map((r: any) => JSON.parse(r.data)); }
  coverage(): Coverage {
    if(this.coverageCache)return this.coverageCache;
    const rows=this.db.prepare(`WITH successes AS (
      SELECT DISTINCT CAST(json_extract(data,'$.at') AS INTEGER) AS at FROM attempts WHERE json_extract(data,'$.ok')=1
    ), intervals AS (SELECT lag(at) OVER (ORDER BY at) AS start, at AS end FROM successes)
    SELECT start,end FROM intervals WHERE end-start>120000 ORDER BY end DESC`).all() as {start:number;end:number}[];
    const bounds=this.db.prepare(`SELECT min(CAST(json_extract(data,'$.at') AS INTEGER)) AS firstSuccessAt,
      max(CAST(json_extract(data,'$.at') AS INTEGER)) AS lastSuccessAt FROM attempts WHERE json_extract(data,'$.ok')=1`).get() as {firstSuccessAt:number|null;lastSuccessAt:number|null};
    // Derived from the durable attempt ledger, including across restarts and pauses.
    return this.coverageCache={...bounds,thresholdMs:120000,gapCount:rows.length,gaps:rows.map(r=>({...r}))};
  }
  annotate(a: Annotation) { const r = this.db.prepare('INSERT INTO annotations(data) VALUES (?)').run(JSON.stringify(a)); return Number(r.lastInsertRowid); }
  annotations(): Annotation[] { return this.db.prepare('SELECT id,data FROM annotations ORDER BY id DESC').all().map((r: any) => ({ ...JSON.parse(r.data), id: r.id })); }
  backup(path: string) { this.db.prepare('VACUUM INTO ?').run(path); }
  close() { this.db.close(); }
}
