# QuotaScope

A private, local allowance dashboard for Mac users with a signed-in Codex account. See how much remains in each reported window, when it resets, and whether monitoring is healthy.

QuotaScope reads the allowance windows returned by your installed Codex app-server. It does **not** monitor every ChatGPT model, tool, device or subscription feature. It is an independent project, not an OpenAI product.

**Release status: early preview — source builds only.** Automated local checks pass, and sleep/wake recovery has been observed on the development Mac. This preview is intended for evaluation; it is not a notarized downloadable Mac app.

The initial preview passed the [GitHub Actions matrix](https://github.com/DicksonKam/quotascope/actions/runs/38906930137) on macOS and Linux with Node 22 and 24.

Remaining validation includes the 72-hour monitoring observation, a real logout/login startup check, and broader Mac compatibility. Intel, older macOS, a fresh physical Mac, physical multi-monitor/Spaces behavior and the latest native dark appearance remain unverified. See the [release checklist](docs/public/release-checklist.md) and [compatibility scope](docs/public/compatibility.md) for exact evidence and limitations.

![Synthetic demonstration; no personal account data](docs/public/demo.png)

## Setup

Use macOS, Node.js 22.13 or later, npm, and a signed-in Codex CLI that supports `account/rateLimits/read`. Supported runtime and architecture checks are listed in [compatibility](docs/public/compatibility.md).

```sh
npm ci --ignore-scripts
npm run build
npm run doctor
npm start
```

Open <http://127.0.0.1:4317>. Doctor can report that the service is not running before the first start. For an executable outside PATH, set `QUOTASCOPE_CODEX` to its absolute path. Sign in through Codex itself; QuotaScope never changes authentication.

For a native menu bar panel with no Dock icon, install Apple's Command Line Tools (`xcode-select --install` if needed), then run:

```sh
npm run menubar -- install
npm run menubar -- status
```

This builds a local `~/Applications/QuotaScope.app`, installs its login entry, and enables the background collector. The menu bar shows your remaining percentage inside an arc with an outward pointer (empty on the left, full on the right), updated even with the panel closed. Click it for allowance history, the current balance and reset time; **Open dashboard** opens the detailed interface. Both start after signing into macOS. Quitting the menu bar app leaves collection running. This source-built app is ad-hoc signed locally, not a notarized downloadable release. See the [menu bar guide](docs/public/menu-bar.md).

For background monitoring with only the browser dashboard:

```sh
npm run service -- install
npm run service -- status
```

The Mac must be awake and the user session active. Sleep, shutdown, sign-out and connectivity failures leave visible gaps; readings that were never collected cannot be recovered. There is no keep-awake behavior.

## Everyday use

Overview shows all current balances, reset times and monitoring health. Expand allowance history when needed. Details contains activity, evidence, backups, exports and optional comparison notes. Dates default to your browser's timezone; the footer lets you change it.

Account readings and local token logs are separate sources. Missing identities and gaps stay explicit. Estimates never become official quotas or price/value claims.

See the [operating guide](docs/public/guide.md) for startup, pause, recovery, configuration and updating a moved checkout. Read [privacy](PRIVACY.md) before exporting metadata or sharing a backup. [Contributing](CONTRIBUTING.md) describes fixture-only checks and release preparation. Licensed under [MIT](LICENSE).
