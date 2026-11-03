# Compatibility and verification scope

QuotaScope is an early release candidate. Verification on 16 October 2026 used macOS 27.0.1 (26A434) / Apple Silicon and the bundled Codex CLI 0.162.0-alpha.17.2. The live service was checked on Node.js 23.9.0. This describes tested configurations, not a promise of uninterrupted monitoring or support for every ChatGPT feature.

## Current source checks

Fresh copies of the current source in paths containing spaces passed dependency installation, type checking, **93 unit/component tests**, production build, **79 application HTTP assertions**, the additional large-history export HTTP suite, and the 31-second worker check on Node.js **22.13.0, 22.23.3 and 24.22.0**. The installation used the lockfile and disabled package lifecycle scripts.

A separate Node 24.22.0 installation with only production dependencies and copied built dashboard assets passed both HTTP suites, including generated login-agent command execution against restored fixture data. These are isolated installations on the same Mac, not fresh physical machines.

Node.js 22.13+ provides the SQLite API used here. `tsx` is a runtime dependency because both the server and child workers execute TypeScript. Development dependencies are needed to build the dashboard; production dependencies suffice to run its built assets.

Every push runs all four [GitHub Actions jobs](https://github.com/DicksonKam/quotascope/actions/workflows/ci.yml) on hosted macOS and Linux runners with Node 22 and 24. macOS jobs also run native tests and the app build. Linux jobs verify the fixture-based server/dashboard suites, not the native Mac app or a real provider login. Passing on these runners does not establish compatibility with every Mac, future Node release or Codex CLI version.

## Monitoring and recovery

Both user login entries are installed, enabled and loaded on the development Mac. Their plists validate, the live service responds, and the existing backup passes database integrity, record-count and database/key hash checks. Fixture tests cover pause/restart persistence, retry recovery, restoration and generated service startup.

Natural sleep/wake recovery was observed twice on this Mac: successful account reads resumed approximately 130 and 85 seconds after full wake. The same collector process was running across those events. Recorded sleep/dark-wake intervals overlap the long reading gaps. This is evidence of recovery on this configuration, not proof of the cause of every failed read or a guarantee of an immediate read after wake. Sleep, shutdown and provider failures can leave gaps.

The 72-hour reliability observation is still in progress. A real logout/login or reboot followed by login has not been verified. Loaded LaunchAgents and fixture startup do not prove a fresh login works.

The provider protocol may change. Unknown account identity remains visible but disables cross-reading trends and local joins. A successful capability check establishes supported allowance windows on the installed CLI; it does not establish coverage of every ChatGPT feature.

## Native menu bar

The native Swift model/history suite and source-built app passed on the above Apple Silicon Mac. The bundle compiled and passed ad-hoc signature verification. Earlier live lifecycle checks verified repeated installation, duplicate-instance prevention, crash restart, intentional quit with continued collection, refresh and opening the full dashboard.

The current allowance-only panel was visually checked in light appearance with 30-day and current-cycle history. The current dashboard was checked in light/dark appearances and at a narrow 390px viewport. An earlier native revision was checked in dark appearance; the latest native dark palette has not yet received a visual check. The menu follows the Mac's appearance, while the dashboard has its own appearance control.

Native tests cover clamped placement on small and negative-origin display rectangles, range-response ordering, failure recovery, calendar ranges and sampled gap/reset continuity. These simulated displays do not establish physical multi-monitor or full-screen Space behavior.

The app targets macOS 13+ and the build machine's architecture. Older macOS, Intel hardware and a fresh physical Mac remain unverified. A local ad-hoc signature is not Developer ID signing or notarization; this is a source-built project, not a ready-to-download signed app. See [menu bar setup](menu-bar.md).

## History growth

The dashboard reader isolates SQLite analysis from account collection. Synthetic one-year tests cover roughly 525,000 observations and 200,000 token records. Warm polling is cached, but cold aggregates, coverage scans and eligible comparisons still scale with history. No destructive retention is required. Run `npm run test:performance` for machine-specific measurements; it uses synthetic data only.

See the [release checklist](release-checklist.md) for completed checks and remaining gates.
