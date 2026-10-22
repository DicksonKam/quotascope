import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
// Render the menu bar panel offscreen against the local service, for visual review in both appearances.
// Usage: npm run snapshot:menubar [-- <output folder> [port]]
if (process.platform !== "darwin")
  throw Error("Menu bar snapshots require macOS.");
const root = resolve(import.meta.dirname, ".."),
  output =
    process.argv[2] ??
    join(
      root,
      ".local/menu-bar-snapshots",
      new Date().toISOString().replaceAll(":", "-"),
    ),
  port = process.argv[3] ?? "4317",
  tool = join(root, ".local/menu-bar-snapshots/snapshot");
mkdirSync(output, { recursive: true });
mkdirSync(dirname(tool), { recursive: true });
for (const [bin, args] of [
  [
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-D",
      "QUOTASCOPE_SNAPSHOT",
      "-module-cache-path",
      join(root, ".local/swift-module-cache"),
      "macos/QuotaModel.swift",
      "macos/HistoryModel.swift",
      "macos/QuotaScope.swift",
      "macos/HistoryView.swift",
      "macos/Snapshot.swift",
      "-o",
      tool,
      "-framework",
      "AppKit",
      "-framework",
      "SwiftUI",
    ],
  ],
  [tool, [output, port]],
] as const) {
  const result = spawnSync(bin, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Snapshots written to ${output}`);
