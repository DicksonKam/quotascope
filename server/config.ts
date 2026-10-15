import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Configuration {
  root: string;
  dataDir: string;
  port: number;
  codex: string;
  settingsPath: string;
  legacy: boolean;
  logRoot?: string;
}

export function configuration(
  root = resolve(import.meta.dirname, ".."),
  env = process.env,
  home = homedir(),
): Configuration {
  const base = join(home, "Library", "Application Support", "QuotaScope");
  const settingsPath = resolve(
    env.QUOTASCOPE_CONFIG ?? join(base, "settings.json"),
  );
  let saved: {
    dataDir?: string;
    port?: number;
    codex?: string;
    logRoot?: string;
  } = {};
  if (existsSync(settingsPath)) {
    saved = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (
      !saved ||
      typeof saved !== "object" ||
      (saved.dataDir !== undefined && typeof saved.dataDir !== "string") ||
      (saved.codex !== undefined && typeof saved.codex !== "string") ||
      (saved.logRoot !== undefined && typeof saved.logRoot !== "string")
    )
      throw Error(
        "Invalid QuotaScope settings. Restore a valid settings.json or use QUOTASCOPE_CONFIG.",
      );
  }
  const port = Number(env.PORT ?? saved.port ?? 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("PORT must be an integer between 1024 and 65535.");
  const legacyDir = join(root, ".local");
  if (
    !env.QUOTASCOPE_DATA_DIR &&
    saved.dataDir &&
    resolve(saved.dataDir) !== legacyDir &&
    !existsSync(join(saved.dataDir, "quotascope.sqlite")) &&
    existsSync(join(legacyDir, "quotascope.sqlite"))
  ) {
    throw Error(
      "Saved history location is unavailable and this checkout contains existing history. Set QUOTASCOPE_DATA_DIR to the intended history directory and reinstall; the existing data was preserved.",
    );
  }
  const legacy =
    !env.QUOTASCOPE_DATA_DIR &&
    !saved.dataDir &&
    existsSync(join(legacyDir, "quotascope.sqlite"));
  return {
    root,
    settingsPath,
    port,
    legacy,
    dataDir: resolve(
      env.QUOTASCOPE_DATA_DIR ??
        saved.dataDir ??
        (legacy ? legacyDir : join(base, "data")),
    ),
    logRoot: env.QUOTASCOPE_LOG_ROOT ?? saved.logRoot,
    codex: env.QUOTASCOPE_CODEX ?? saved.codex ?? "codex",
  };
}
