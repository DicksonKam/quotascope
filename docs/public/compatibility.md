# Compatibility and verification scope

QuotaScope is an early release candidate. Verification on 16 October 2026 used macOS 27.0.1 (26A434) / Apple Silicon and the bundled Codex CLI 0.162.0-alpha.17.2. The live service was checked on Node.js 23.9.0.

Fresh source copies in paths containing spaces passed dependency installation, type checking, 88 unit/component tests, production build, 77 application HTTP assertions, the additional large-history export HTTP suite and the 31-second worker check on Node.js **22.13.0, 22.23.3 and 24.22.0**. Source publication preparation also passed on 22.23.3 and 24.22.0. A separate Node 24.22.0 installation with only production dependencies and prebuilt dashboard assets passed both HTTP suites, including generated login-agent command execution against fixture data. These are isolated installations on the same Mac, not fresh physical machines.

The GitHub Actions workflow is configured for Node 22 and 24 on macOS and Linux. Remote CI has not yet run; local results do not establish GitHub runner or Linux compatibility. Passing on the tested versions does not establish compatibility with every future Node or Codex CLI version.

Node.js 22.13+ provides the SQLite API used here. `tsx` is a runtime dependency because both the server and child workers execute TypeScript. Install development dependencies to build, then a runtime-only install can run the built dashboard.

The provider protocol may change. Unknown account identity remains visible but disables cross-reading trends and local joins. A successful capability check establishes supported allowance windows on the installed CLI; it does not establish coverage of every ChatGPT feature.

Real logout/login, sleep/wake recovery, Intel hardware, a fresh physical Mac and a multi-day soak remain manual release checks until exercised. LaunchAgent plist validation and fixture startup are narrower tests. Do not infer these hardware/session guarantees from passing unit tests.

The dashboard reader isolates SQLite analysis from account collection. Synthetic one-year tests cover roughly 525,000 observations and 200,000 token records. Warm polling is cached, but cold aggregates, coverage scans and eligible comparisons still scale with history. No destructive retention is required. Run `npm run test:performance` for machine-specific measurements; it uses synthetic data only.
