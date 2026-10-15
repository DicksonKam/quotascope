# Contributing

Keep the app simple: loopback HTTP, SQLite, independent collection and isolated workers. Preserve committed history and source logs. Never infer missing readings or merge unidentified accounts. Use recoverable Trash for cleanup.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run test:integration
npm run test:slow
```

The integration and slow-operation checks use isolated synthetic fixtures, not a personal login. They need permission to bind loopback ports. Performance checks are optional for unrelated edits and retain their synthetic files for inspection.

`npm run release:prepare` copies only the explicit allowlist into a new private staging directory, rejects unexpected source file types/symlinks, scans text for likely private artifacts, and writes a SHA-256 manifest. Historical local documentation and personal images remain excluded. Review the exact staged file list and synthetic demo before creating a public commit/archive; do not use a broad `git add .` on the development workspace.

Run setup and checks from that staged source in a clean directory (including a path with spaces). Keep any generated data outside the public source. Do not publish a release until the compatibility limitations have been reviewed. The preparation command does not push, publish or create a remote repository.
