import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
if (process.platform !== "darwin")
  throw Error("Native menu bar tests require macOS.");
const root = resolve(import.meta.dirname, ".."),
  builds = join(root, ".local/native-tests");
mkdirSync(builds, { recursive: true });
const dir = mkdtempSync(join(builds, "run-")),
  output = join(dir, "ModelTests");
for (const [bin, args] of [
  [
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-module-cache-path",
      join(root, ".local/swift-module-cache"),
      "macos/QuotaModel.swift",
      "macos/HistoryModel.swift",
      "macos/ModelTests.swift",
      "-o",
      output,
    ],
  ],
  [output, []],
] as const) {
  const result = spawnSync(bin, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
