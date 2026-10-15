import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const publicRoots = [
  "server",
  "src",
  "shared",
  "tests",
  "scripts",
  "docs/public",
  ".github",
];
export const publicFiles = [
  "README.md",
  "LICENSE",
  "PRIVACY.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "index.html",
  ".gitignore",
];
const extensions = /\.(ts|tsx|css|md|json|yml|png|svg)$/;
const privateText =
  /\/Users\/[^/\s]+|\/private\/var\/folders\/|sk-[A-Za-z0-9]{20,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|PRIVATE_PROMPT_SHOULD_NOT_LEAK(?![\w])/;

export function publicationFiles(root: string): string[] {
  const files = [...publicFiles];
  function visit(path: string) {
    for (const entry of readdirSync(join(root, path), {
      withFileTypes: true,
    })) {
      const rel = join(path, entry.name),
        absolute = join(root, rel);
      if (lstatSync(absolute).isSymbolicLink())
        throw Error(`Publication symlink rejected: ${rel}`);
      if (entry.isDirectory()) visit(rel);
      else {
        if (!extensions.test(entry.name))
          throw Error(`Unexpected publication file: ${rel}`);
        files.push(rel);
      }
    }
  }
  for (const path of publicRoots) {
    if (lstatSync(join(root, path)).isSymbolicLink())
      throw Error(`Publication root symlink rejected: ${path}`);
    visit(path);
  }
  for (const file of files) {
    const absolute = join(root, file);
    if (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink())
      throw Error(`Invalid publication file: ${file}`);
    // Fixtures deliberately contain sentinel strings to prove their exclusion from stored data.
    if (
      !file.endsWith(".png") &&
      !file.startsWith("tests/") &&
      !file.startsWith("scripts/")
    ) {
      if (privateText.test(readFileSync(absolute, "utf8")))
        throw Error(`Review potentially private text in ${file}`);
    }
  }
  return files.sort();
}

export function prepareRelease(
  root: string,
  parent = join(root, ".local/releases"),
) {
  const files = publicationFiles(root);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const target = mkdtempSync(join(parent, "quotascope-source-"));
  const hashes: Record<string, string> = {};
  for (const file of files) {
    const destination = join(target, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(root, file), destination);
    hashes[file] = createHash("sha256")
      .update(readFileSync(destination))
      .digest("hex");
  }
  writeFileSync(
    join(target, "publication-manifest.json"),
    JSON.stringify({ version: 1, files: hashes }, null, 2),
  );
  return { target, fileCount: files.length, files };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(
    JSON.stringify(prepareRelease(resolve(import.meta.dirname, "..")), null, 2),
  );
}
