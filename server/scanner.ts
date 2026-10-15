import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { parseRecord, type Context } from './parser.ts';
import type { Store } from './store.ts';
// Version 4 replays old cursors once to recover records skipped by the old broad catch.
const parserVersion = 4;
export function findLogs(root: string, onFailure?: (path: string) => void, missingIsEmpty = true): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap(e => e.isSymbolicLink() ? [] : e.isDirectory() ? findLogs(join(root, e.name), onFailure, false) : e.isFile() && e.name.endsWith('.jsonl') ? [join(root, e.name)] : []);
  } catch (error) {
    if (missingIsEmpty && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (!onFailure) throw error;
    onFailure(root);
    return [];
  }
}
export async function scan(store: Store, hash: (v: unknown) => string, roots = [join(homedir(), '.codex/sessions'), join(homedir(), '.codex/archived_sessions')]) {
  const start = Date.now(); let bytes = 0, changed = 0, failed = 0;
  const discoveryFailure = (path: string) => { failed++; store.issue(hash(path) + ':discovery', 'source-discovery-failed'); };
  const files = [...new Set(roots.flatMap(root => findLogs(root, discoveryFailure)))].sort();
  for (const file of files) {
    const key = hash(file);
    let inTransaction = false;
    try {
      const stat = statSync(file), inode = `${stat.dev}:${stat.ino}`;
      let ctx = store.cursor<Context>(key);
      if (!ctx || ctx.inode !== inode || stat.size < ctx.offset || ctx.parser !== parserVersion || stat.size === ctx.offset && stat.mtimeMs !== ctx.modified) {
        if (ctx) store.issue(key + ':replacement', ctx.parser !== parserVersion ? 'import-replay-v4' : 'source-replaced-or-truncated');
        ctx = { account: 'unattributed-local', device: hash('local-device'), thread: hash(file), session: hash(file), model: 'unknown', effort: 'unknown', speed: 'unknown', parent: false, offset: 0, inode, modified: 0, parser: parserVersion };
      }
      if (stat.size === ctx.offset) continue;
      changed++; let carry = Buffer.alloc(0); let offset = ctx.offset; let dropping = false;

      // Bound reads to the size at scan start; a concurrent append is handled next time.
      if (stat.size > offset) for await (const chunk of createReadStream(file, { start: offset, end: stat.size - 1, highWaterMark: 64 * 1024 })) {
        // Reserve the writer before reading deduplication state. A deferred
        // read-to-write upgrade can fail immediately when another worker writes.
        store.db.exec('BEGIN IMMEDIATE');inTransaction=true;
        bytes += chunk.length;
        carry = Buffer.concat([carry, chunk]);
        let index: number;
        while ((index = carry.indexOf(10)) !== -1) {
          const line = carry.subarray(0, index); const lineStart = offset;
          offset += index + 1; carry = carry.subarray(index + 1);
          if (!dropping) {
            // Only these record types are relevant. JSON text is never stored or logged.
            let d: any;
            try { d = JSON.parse(line.toString('utf8')); }
            catch { store.issue(`${key}:${lineStart}`, 'malformed-record'); continue; }
            // Persistence/parser failures must roll back this chunk, never skip the line.
            if (d && ['session_meta', 'turn_context', 'token_usage_record', 'event_msg'].includes(d.type)) parseRecord(d, ctx, store, hash, key, lineStart);
          }
          dropping = false;
        }
        if (carry.length > 2_000_000) { offset += carry.length; carry = Buffer.alloc(0); dropping = true; store.issue(`${key}:${offset}`, 'oversize-record-skipped'); }
        ctx.offset = dropping ? ctx.offset : offset; ctx.modified = stat.mtimeMs;
        store.saveCursor(key,ctx);store.db.exec('COMMIT');inTransaction=false;
      }
      // The last committed cursor includes exactly the context for its completed lines.
      // A failed chunk discards its in-memory context; the next scan reloads that cursor.
    } catch {
      if (inTransaction) store.db.exec('ROLLBACK');
      failed++;
      store.issue(key + ':incomplete', 'source-import-incomplete');
    }
  }
  let indexedMissing: number | null = null;
  const index = join(homedir(), '.codex/state_5.sqlite');
  if (roots.length === 2 && existsSync(index)) {
    let db: DatabaseSync | undefined;
    try { db = new DatabaseSync(index, { readOnly: true }); indexedMissing = db.prepare('SELECT rollout_path FROM threads').all().filter((r: any) => !existsSync(r.rollout_path)).length; } catch { /* Optional source inventory. */ } finally { db?.close(); }
  }
  const report = { at: Date.now(), files: files.length, changed, bytes, elapsedMs: Date.now() - start, indexedMissing, failed, complete: failed === 0, completeAccountCoverage: false };
  store.set('scan', report);
  if (failed) throw new Error('Local import incomplete. Saved progress is preserved; retry will resume from committed cursors.');
  return report;
}
