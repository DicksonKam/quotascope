import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  publicFiles,
  publicRoots,
  publicationFiles,
  prepareRelease,
} from "../scripts/prepare-release.ts";

test("public source excludes personal evidence, databases and credentials and matches its manifest", () => {
  const root = resolve(".");
  const selected = publicationFiles(root);
  assert.ok(selected.includes("README.md"));
  assert.ok(selected.includes(".github/workflows/ci.yml"));
  assert.ok(
    !selected.some((file) =>
      /^\.local|^docs\/(?!public\/)|\.sqlite|identity\.key|\.env/.test(file),
    ),
  );
  const parent = mkdtempSync(join(tmpdir(), "quotascope-publication-"));
  const result = prepareRelease(root, parent);
  const manifest = JSON.parse(
    readFileSync(join(result.target, "publication-manifest.json"), "utf8"),
  );
  assert.equal(Object.keys(manifest.files).length, selected.length);
  for (const file of selected)
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(result.target, file)))
        .digest("hex"),
      manifest.files[file],
    );
});

test("unexpected files and symlinks fail closed rather than enter publication", () => {
  const root = mkdtempSync(join(tmpdir(), "quotascope-publication-invalid-"));
  for (const dir of publicRoots)
    mkdirSync(join(root, dir), { recursive: true });
  for (const file of publicFiles) copyFileSync(resolve(file), join(root, file));
  writeFileSync(join(root, "server/private.sqlite"), "private");
  assert.throws(() => publicationFiles(root), /Unexpected/);
  const other = mkdtempSync(join(tmpdir(), "quotascope-publication-link-"));
  for (const dir of publicRoots)
    if (dir !== "server") mkdirSync(join(other, dir), { recursive: true });
  for (const file of publicFiles)
    copyFileSync(resolve(file), join(other, file));
  symlinkSync(resolve("server"), join(other, "server"));
  assert.throws(() => publicationFiles(other), /symlink/);
});
