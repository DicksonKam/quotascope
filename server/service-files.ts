import { existsSync, lstatSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Remove only the installed agent; keep its data, backups and configuration. */
export function trashAgent(plist: string, trash: string): string | null {
  if (
    !existsSync(trash) ||
    !lstatSync(trash).isDirectory() ||
    lstatSync(trash).isSymbolicLink()
  )
    throw Error("Trash unavailable; the agent file was preserved.");
  if (!existsSync(plist)) return null;
  const destination = join(trash, `${basename(plist)}-${randomUUID()}`);
  renameSync(plist, destination);
  if (existsSync(plist) || !existsSync(destination))
    throw Error("Trash move could not be verified.");
  return destination;
}

export async function waitForServiceStop(
  isLoaded: () => boolean,
  timeoutMs = 35000,
  pollMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isLoaded()) {
    if (Date.now() >= deadline)
      throw Error(
        "The previous service is still unloading. History and agent files were preserved; check service status before retrying.",
      );
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
