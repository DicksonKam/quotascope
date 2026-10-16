# Release checklist

Status on 16 October 2026: **source release candidate; not a notarized app release**. These checks apply to the current source. Evidence from the personal installation remains private and is excluded from publication.

## Verified locally

- Clean source installation and regression suites on Node 22.13.0, 22.23.3 and 24.22.0, including checkout paths with spaces.
- Production-dependencies-only startup and both HTTP suites on Node 24.22.0 using synthetic accounts and restored fixture data.
- Native model/history tests, app build and ad-hoc signature validation on Apple Silicon.
- Publication allowlist and SHA-256 manifest; bounded scans of tracked source and Git history for credentials, private paths and data artifacts. The only path match was an intentional synthetic test fixture. The public demo contains synthetic balances, not personal account data. Pattern scans are not exhaustive secret detection.
- npm dependency audit reported zero known vulnerabilities at the time of this check; this is not a guarantee against undisclosed vulnerabilities.
- Current live collector health, enabled login entries, database integrity and existing backup integrity.
- Two naturally occurring sleep/wake recoveries on the development Mac, with successful readings after wake and no collector restart.
- Dashboard light/dark and narrow layout checks; native light layout and current-cycle selection.

## Still open

- **Fresh login:** after a normal logout/login or reboot/sign-in, confirm one menu icon, no persistent Dock icon, both services running, and a fresh successful account read. Do not mistake reopening the panel for this check.
- **72-hour observation:** let the existing reliability check finish. Record successes, failures, gaps, integrity and backup health; do not interpret elapsed time as uninterrupted coverage.
- **Compatibility:** Intel, older supported macOS, a fresh physical Mac, physical secondary displays and full-screen Spaces have not been exercised. Review the current native panel in dark appearance.
- **Remote CI:** after an explicitly authorized GitHub push, require the configured macOS/Linux Node 22/24 workflow to pass. Local fixtures do not prove runner compatibility.
- **Publication decision:** review these limitations before publishing. A clearly labeled source preview can disclose them; do not claim broad hardware validation or offer an unsigned bundle as a notarized release.

## Reproduce checks

From a clean source copy:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run test:integration
npm run test:slow
npm run test:performance
npm run test:macos
npm run menubar -- build
npm run release:prepare
```

The last two native commands require macOS and Apple's Command Line Tools. Integration checks need local port binding. The menu-bar build does not install or restart the live app. Preparation creates a new source directory and manifest; review that exact artifact before publishing. Do not include private verification evidence, local databases, identity keys, settings, logs, backups or personal screenshots.
