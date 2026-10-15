import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function identityFactory(dir: string) {
  const file = join(dir, 'identity.key');
  if (!existsSync(file) && existsSync(join(dir, 'quotascope.sqlite'))) throw new Error('The identifier salt is missing. Preserve this data directory and restore its matching identity.key from backup.');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const salt = readFileSync(file);
  return (value: unknown) => createHmac('sha256', salt).update(String(value ?? 'unknown')).digest('hex').slice(0, 20);
}
export const numeric = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
export const text = (v: unknown, max = 120): string | null => typeof v === 'string' && v.length <= max ? v : null;
// Model/settings values are machine labels, never arbitrary conversation text.
export const label = (v: unknown) => typeof v === 'string' && /^[\w.:-]{1,80}$/.test(v) ? v : 'unknown';
export const csvCell = (value: unknown) => '"' + String(value ?? '').replace(/^\s*[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"';
