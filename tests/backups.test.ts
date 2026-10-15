import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  createBackup,
  verifyBackup,
  ensureAutomaticBackup,
} from "../server/backups.ts";
import { Store } from "../server/store.ts";
import { identityFactory } from "../server/privacy.ts";
const fixture = () => {
  const dir = mkdtempSync(`${tmpdir()}/quotascope-backups-`);
  identityFactory(dir);
  const store = new Store(join(dir, "quotascope.sqlite"));
  store.attempt({ at: 1000, ok: true, message: "Fixture" });
  store.close();
  return dir;
};
test("snapshots verify database, matching identity, record counts and private permissions", () => {
  const dir = fixture(),
    result = createBackup(dir, true, 1000),
    folder = join(dir, "backups", result.id);
  assert.equal(verifyBackup(folder).counts.attempts, 1);
  assert.equal(statSync(join(folder, "identity.key")).mode & 0o777, 0o600);
  assert.equal(statSync(join(folder, "quotascope.sqlite")).mode & 0o777, 0o600);
  writeFileSync(join(folder, "identity.key"), "tampered");
  assert.throws(() => verifyBackup(folder), /integrity/);
});
test("retention moves only older verified automatic copies to recoverable Trash and preserves manual and incomplete copies", () => {
  const dir = fixture(),
    trash = join(dir, "Trash");
  mkdirSync(trash);
  const root = join(dir, "backups");
  const first = createBackup(dir, true, 1000, { keep: 2, trash });
  const manual = createBackup(dir, false, 1500, { keep: 2, trash });
  mkdirSync(join(root, "auto-incomplete"));
  writeFileSync(join(root, "auto-incomplete", "partial"), "preserve");
  createBackup(dir, true, 2000, { keep: 2, trash });
  const newest = createBackup(dir, true, 3000, { keep: 2, trash });
  assert.equal(existsSync(join(root, first.id)), false);
  assert.equal(existsSync(join(root, manual.id)), true);
  assert.equal(existsSync(join(root, newest.id)), true);
  assert.ok(existsSync(join(root, "auto-incomplete", "partial")));
  assert.equal(readdirSync(trash).length, 1);
  const recovered = join(trash, readdirSync(trash)[0]);
  assert.ok(existsSync(join(recovered, "quotascope.sqlite")));
  assert.equal(verifyBackup(recovered).id, first.id);
});
test("unavailable Trash keeps old backups while the new verified copy succeeds", () => {
  const dir = fixture(),
    trash = join(dir, "missing-trash");
  const first = createBackup(dir, true, 1000, { keep: 1, trash });
  const second = createBackup(dir, true, 2000, { keep: 1, trash });
  assert.ok(second.retentionWarning);
  assert.ok(existsSync(join(dir, "backups", first.id)));
  assert.ok(verifyBackup(join(dir, "backups", second.id)));
});

test("restore accepts a verified snapshot from Trash and refuses tampered copies without creating a target", () => {
  const dir = fixture(),
    trash = join(dir, "Trash");
  mkdirSync(trash);
  const first = createBackup(dir, true, 1000, { keep: 1, trash });
  createBackup(dir, true, 2000, { keep: 1, trash });
  const recovered = join(trash, readdirSync(trash)[0]),
    target = join(dir, "restored");
  const run = (destination: string) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "server/restore.ts", recovered, destination],
      { encoding: "utf8" },
    );
  assert.equal(run(target).status, 0);
  const restored = new Store(join(target, "quotascope.sqlite"));
  assert.equal(restored.attempts().length, 1);
  restored.close();
  writeFileSync(join(recovered, "identity.key"), "invalid");
  const rejected = join(dir, "rejected");
  assert.notEqual(run(rejected).status, 0);
  assert.equal(existsSync(rejected), false);
  assert.equal(existsSync(join(dir, "quotascope.sqlite")), true);
});

test("daily schedule rechecks its last copy and replaces a damaged snapshot without deleting it", () => {
  const dir = fixture(),
    first = createBackup(dir, true, 1000);
  const store = new Store(join(dir, "quotascope.sqlite"));
  store.set("lastBackup", first);
  store.close();
  assert.equal(ensureAutomaticBackup(dir, 2000).id, first.id);
  writeFileSync(join(dir, "backups", first.id, "identity.key"), "damaged");
  const replacement = ensureAutomaticBackup(dir, 3000);
  assert.notEqual(replacement.id, first.id);
  assert.ok(existsSync(join(dir, "backups", first.id)));
  assert.ok(verifyBackup(join(dir, "backups", replacement.id)));
});

test("a backwards clock adjustment never rotates away the newly verified automatic copy", () => {
  const dir = fixture(),
    trash = join(dir, "Trash");
  mkdirSync(trash);
  createBackup(dir, true, 3000, { keep: 1, trash });
  const current = createBackup(dir, true, 2000, { keep: 1, trash });
  assert.ok(verifyBackup(join(dir, "backups", current.id)));
  assert.equal(readdirSync(trash).length, 1);
});
