import { dirname, join } from "node:path";
import type { Configuration } from "./config.ts";
export const serviceLabel = "com.dicksonkam.quotascope";
export function launchAgent(
  root: string,
  home: string,
  node: string,
  codex: string,
  config?: Pick<Configuration, "dataDir" | "port" | "settingsPath" | "logRoot">,
) {
  const dataDir =
    config?.dataDir ??
    join(home, "Library/Application Support/QuotaScope/data");
  const escape = (s: string) =>
    s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  const string = (s: string) => `<string>${escape(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(serviceLabel)}
<key>ProgramArguments</key><array>${[node, "--import", "tsx", join(root, "server/index.ts"), "--production"].map(string).join("")}</array>
<key>WorkingDirectory</key>${string(root)}
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>ProcessType</key><string>Standard</string><key>ExitTimeOut</key><integer>30</integer>
<key>EnvironmentVariables</key><dict>
<key>HOME</key>${string(home)}<key>PATH</key>${string([dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"))}
<key>PORT</key>${string(String(config?.port ?? 4317))}<key>QUOTASCOPE_DATA_DIR</key>${string(dataDir)}<key>QUOTASCOPE_CONFIG</key>${string(config?.settingsPath ?? join(home, "Library/Application Support/QuotaScope/settings.json"))}
${config?.logRoot ? "<key>QUOTASCOPE_LOG_ROOT</key>" + string(config.logRoot) : ""}<key>QUOTASCOPE_CODEX</key>${string(codex)}<key>QUOTASCOPE_MANAGED</key><string>launchd</string>
</dict><key>StandardOutPath</key>${string(join(dataDir, "service/stdout.log"))}
<key>StandardErrorPath</key>${string(join(dataDir, "service/stderr.log"))}
</dict></plist>\n`;
}
