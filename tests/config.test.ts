import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configuration } from "../server/config.ts";
import { launchAgent } from "../server/launch-agent.ts";

test("fresh configuration is stable across checkout moves and retains explicit recovery selection", () => {
  const home = mkdtempSync(`${tmpdir()}/quotascope-config-`);
  const first = configuration("/new checkout", {}, home);
  assert.equal(
    first.dataDir,
    join(home, "Library/Application Support/QuotaScope/data"),
  );
  assert.equal(
    configuration("/moved checkout", {}, home).dataDir,
    first.dataDir,
  );
  mkdirSync(join(home, "Library/Application Support/QuotaScope"), {
    recursive: true,
  });
  writeFileSync(
    first.settingsPath,
    JSON.stringify({
      dataDir: join(home, "restored history"),
      port: 5123,
      codex: "/a path/codex",
    }),
  );
  const restored = configuration("/moved checkout", {}, home);
  assert.equal(restored.port, 5123);
  assert.equal(restored.dataDir, join(home, "restored history"));
  const xml = launchAgent(
    "/moved & spaced checkout",
    home,
    "/node path/node",
    restored.codex,
    restored,
  );
  assert.ok(xml.includes("/moved &amp; spaced checkout/server/index.ts"));
  assert.ok(xml.includes("<key>PORT</key><string>5123</string>"));
  assert.ok(xml.includes(restored.dataDir));
  assert.ok(xml.includes("/node path/node"));
  // A Background-class agent and its reader/account children are starved first on a busy Mac.
  assert.ok(xml.includes("<key>ProcessType</key><string>Standard</string>"));
  const explicit = configuration(
    "/moved checkout",
    { QUOTASCOPE_DATA_DIR: "/recovery override", PORT: "5124" },
    home,
  );
  assert.equal(explicit.dataDir, "/recovery override");
  assert.equal(explicit.port, 5124);
});

test("legacy history is preserved, invalid ports and settings are rejected", () => {
  const root = mkdtempSync(`${tmpdir()}/quotascope-legacy-`);
  mkdirSync(join(root, ".local"));
  writeFileSync(join(root, ".local/quotascope.sqlite"), "fixture");
  const home = join(root, "home");
  assert.equal(configuration(root, {}, home).dataDir, join(root, ".local"));
  assert.equal(configuration(root, {}, home).legacy, true);
  assert.throws(() => configuration(root, { PORT: "NaN" }, home), /PORT/);
  assert.throws(() => configuration(root, { PORT: "80" }, home), /PORT/);
  const settingsPath = join(root, "invalid.json");
  writeFileSync(settingsPath, '{"dataDir":42}');
  assert.throws(
    () => configuration(root, { QUOTASCOPE_CONFIG: settingsPath }, home),
    /settings/,
  );
});

test("service uninstall moves only its plist to recoverable Trash and refuses unavailable Trash", async () => {
  const { trashAgent } = await import("../server/service-files.ts");
  const { existsSync, readFileSync } = await import("node:fs");
  const root = mkdtempSync(`${tmpdir()}/quotascope-uninstall-`);
  const plist = join(root, "agent.plist"),
    data = join(root, "history.sqlite"),
    trash = join(root, "Trash");
  writeFileSync(plist, "agent");
  writeFileSync(data, "preserved");
  assert.throws(() => trashAgent(plist, trash), /Trash unavailable/);
  assert.equal(existsSync(plist), true);
  mkdirSync(trash);
  const destination = trashAgent(plist, trash)!;
  assert.equal(existsSync(plist), false);
  assert.equal(readFileSync(destination, "utf8"), "agent");
  assert.equal(readFileSync(data, "utf8"), "preserved");
  assert.equal(trashAgent(plist, trash), null);
});

test("reinstall waits for the unloading service rather than mistaking it for the new process", async () => {
  const { waitForServiceStop } = await import("../server/service-files.ts");
  let checks = 0;
  await waitForServiceStop(() => ++checks < 3, 1000, 1);
  assert.equal(checks, 3);
  await assert.rejects(
    waitForServiceStop(() => true, 0),
    /still unloading/,
  );
});

test("moving legacy history refuses a stale saved path until the new directory is explicitly selected", () => {
  const root = mkdtempSync(`${tmpdir()}/quotascope-moved-`),
    home = join(root, "home");
  const settings = join(root, "settings.json"),
    legacy = join(root, ".local");
  mkdirSync(legacy);
  writeFileSync(join(legacy, "quotascope.sqlite"), "history");
  writeFileSync(
    settings,
    JSON.stringify({ dataDir: join(root, "old-location", ".local") }),
  );
  assert.throws(
    () => configuration(root, { QUOTASCOPE_CONFIG: settings }, home),
    /existing history/,
  );
  assert.equal(
    configuration(
      root,
      { QUOTASCOPE_CONFIG: settings, QUOTASCOPE_DATA_DIR: legacy },
      home,
    ).dataDir,
    legacy,
  );
});
