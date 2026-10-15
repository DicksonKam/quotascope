# Menu bar app

QuotaScope's native Mac app provides a small allowance panel without a persistent Dock icon. It uses the same collector and saved history as the browser dashboard. Closing the panel, closing the browser or choosing **Quit menu bar app** does not stop background monitoring. macOS must be awake and signed in; missing readings during sleep or shutdown remain gaps.

## Installation

First follow the README setup and build the dashboard. Native builds also require Apple's Command Line Tools, including Swift and iconutil. If unavailable, run `xcode-select --install` and complete Apple's installation, then:

```sh
npm run menubar -- install
npm run menubar -- status
npm run service -- status
```

The installer builds and verifies the app before changing an existing installation. It installs `~/Applications/QuotaScope.app` and a user LaunchAgent for the menu bar. The collector has its own login entry and remains the sole collector. An already-correct collector configuration is kept running. Existing app bundles and replaced menu-bar plists move to Trash, never permanent deletion. Unknown bundles/agents are preserved with an error. Keep the project folder and Node installation available: the collector still runs from that checkout.

Both login entries run after signing into the graphical macOS session, including after a reboot followed by sign-in. The app is not a system-wide daemon and does not collect before login. macOS may require allowing background items in System Settings. This setup uses user LaunchAgents rather than a second app-managed login registration, avoiding duplicate startup mechanisms.

## Everyday use

Click the gauge in the menu bar. The panel shows every returned allowance window, how much remains, reset times and the reading's freshness. **Refresh allowance** requests one account read; it does not enable a paused collector. **Open dashboard** opens the detailed local dashboard in your default browser. The panel follows the Mac's light/dark appearance.

The menu bar reads only the lightweight local status endpoint while its panel is visible. It never reads Codex credentials or imports logs. If disconnected, it preserves the last reading in memory, explicitly marks it stale, and retries while open. A closed/reopened app starts by fetching current status. The app reads the configured local port at launch; reinstall after moving the project or changing connection settings. Opening the app again through Applications reopens its panel; a process lock prevents duplicate menu bar instances.

**Quit menu bar app** hides the icon until you reopen it or sign in again. Monitoring continues. Use the dashboard's background-monitoring switch to pause collection. To remove the menu bar app and its login entry recoverably:

```sh
npm run menubar -- uninstall
```

The collector, history and settings remain. To also remove the collector login entry, use `npm run service -- uninstall`. No history is deleted.

## Verification and distribution limits

`npm run test:macos` checks native decoding, remaining allowance, freshness, invalid ports, refresh token renewal, failure/recovery, overlapping requests and redirect refusal. `npm test` checks login plist behavior and recoverable bundle removal. `npm run menubar -- build` compiles and ad-hoc signs a bundle under `.local`, without installing it. macOS CI is configured for native tests and bundle builds.

The bundle targets macOS 13 or later and the build machine's architecture. Older macOS and Intel hardware require separate validation. A local ad-hoc signature is not Developer ID signing or notarization; do not describe this as a ready-to-download signed app. A real logout/login or reboot test is distinct from validating and loading the LaunchAgents. Public distribution and those physical-session checks remain separate release gates.
