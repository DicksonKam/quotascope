# Compatibility and verification scope

QuotaScope is an early release candidate. The implementation was exercised on macOS 27.0.1 (26A434) / Apple Silicon, Node.js 23.9.0, and the bundled Codex CLI 0.162.0-alpha.17.2. Passing on that runtime is not a claim that every permitted runtime/CLI version has been tested. CI runs fixture-based checks on its listed runtimes.

Node.js 22.13+ provides the SQLite API used here. `tsx` is a runtime dependency because both the server and child workers execute TypeScript. Install development dependencies to build, then a runtime-only install can run the built dashboard.

The provider protocol may change. Unknown account identity remains visible but disables cross-reading trends and local joins. A successful capability check establishes supported allowance windows on the installed CLI; it does not establish coverage of every ChatGPT feature.

Real logout/login, sleep/wake recovery, Intel hardware, a fresh physical Mac and a multi-day soak remain manual release checks until exercised. LaunchAgent plist validation and fixture startup are narrower tests. Do not infer these hardware/session guarantees from passing unit tests.

The dashboard reader isolates SQLite analysis from account collection. Synthetic one-year tests cover roughly 525,000 observations and 200,000 token records. Warm polling is cached, but cold aggregates, coverage scans and eligible comparisons still scale with history. No destructive retention is required. Run `npm run test:performance` for machine-specific measurements; it uses synthetic data only.
