import { test } from "node:test";
import assert from "node:assert/strict";
import {
  menuBarAgent,
  appInfo,
  menuBarLabel,
} from "../server/menu-bar-files.ts";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { trashAgent } from "../server/service-files.ts";

test("menu bar login starts in a GUI session without a Dock icon and permits intentional quit", () => {
  const plist = menuBarAgent("/Applications/A & B/QuotaScope.app");
  assert.ok(plist.includes("A &amp; B"));
  assert.ok(plist.includes("<key>RunAtLoad</key><true/>"));
  assert.ok(plist.includes("<key>SuccessfulExit</key><false/>"));
  assert.ok(plist.includes("<string>Aqua</string>"));
  assert.ok(!plist.includes("server/index.ts"));
  assert.ok(appInfo().includes("<key>LSUIElement</key><true/>"));
  assert.ok(appInfo().includes(menuBarLabel));
  if (process.platform === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "quotascope-native-plist-"));
    for (const [name, content] of [
      ["agent.plist", plist],
      ["Info.plist", appInfo()],
    ]) {
      const file = join(dir, name);
      writeFileSync(file, content);
      assert.equal(spawnSync("/usr/bin/plutil", ["-lint", file]).status, 0);
    }
  }
});
test("app bundle removal remains recoverable and preserves bundle contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "quotascope-app-trash-")),
    app = join(dir, "QuotaScope.app"),
    trash = join(dir, "Trash");
  mkdirSync(app);
  writeFileSync(join(app, "fixture"), "preserve");
  assert.throws(() => trashAgent(app, trash), /Trash unavailable/);
  assert.ok(existsSync(app));
  mkdirSync(trash);
  const saved = trashAgent(app, trash)!;
  assert.equal(readFileSync(join(saved, "fixture"), "utf8"), "preserve");
  assert.ok(!existsSync(app));
  assert.equal(trashAgent(app, trash), null);
});
