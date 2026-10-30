# Operating QuotaScope

## Start, stop and monitor

`npm start` runs the server until Ctrl+C. Closing the dashboard does not stop it. Avoid running this alongside the login service on the same port.

`npm run service -- install` validates and installs the user login agent, starts it, and saves your selected data directory, port and executable. It uses absolute paths and does not source shell startup files. Keep the checkout, built dashboard, runtime dependencies and Node executable available.

- `status`: inspect installed/enabled/running state.
- `stop`: stop now, retaining next-login startup.
- `start` or `enable`: enable and start.
- `disable`: stop and disable login startup.
- `uninstall`: stop and move the agent plist to Trash; preserve data, settings and backups.
- `prepare`: validate/stage a plist without installing it.

The dashboard pause switch suspends account reads and local imports; it does not uninstall the login agent. Manual refresh remains available. Account checks normally run every minute. Network-shaped failures, such as no connection yet after waking or moving between networks, retry the next minute; other failures back off to five minutes. Waking from sleep triggers a check within about ten seconds. Import retries run separately. Closing the dashboard releases its detail reader after two idle minutes while collection continues.

## Storage and configuration

New installs use `~/Library/Application Support/QuotaScope/data`. Existing checkout `.local/quotascope.sqlite` installations keep that data location. No automatic move or deletion occurs. The install command saves the selection to `~/Library/Application Support/QuotaScope/settings.json`, so a moved checkout can find history that remains at its saved location. Back up before moving/updating a checkout; run install again from the new path to update the agent. If legacy `.local` moves with the checkout, explicitly select its new absolute path using QUOTASCOPE_DATA_DIR during install. A missing saved location plus detected checkout history stops setup rather than creating a second empty history. For a stable location, restore a verified copy into a new Application Support data directory and install with that directory selected.

Environment overrides take precedence over saved settings:

- `QUOTASCOPE_DATA_DIR`: absolute directory for the database, identity key, backup copies and service logs.
- `PORT`: loopback port, 1024–65535; default 4317.
- `QUOTASCOPE_CODEX`: absolute Codex executable, or executable name on PATH.
- `QUOTASCOPE_CONFIG`: settings file path, useful for isolated setups.
- `QUOTASCOPE_LOG_ROOT`: optional explicit local log root.

For a custom/restored directory, use the same overrides for start and install. The install command persists the data directory/port/executable and passes them to launchd. An explicit log-root override is also carried to the installed service.

```sh
QUOTASCOPE_DATA_DIR="/absolute/path/Restored History" PORT=4318 npm run service -- install
```

A checkout that has never been reinstalled after this update can still have an older agent pointing at its old directory. Before moving it, run the new install command or specify that old data directory explicitly. Do not start a second copy using a new empty location by accident.

## Backups and recovery

Details → Evidence shows backup status. Save private backup and Rescan return promptly; their operation IDs distinguish new requests from earlier successes. Recent requests shows the last requested scan and backup result, including after reopening the dashboard. Automatic monitoring and backups do not replace those results. A restart marks unfinished requests interrupted. A request timeout is not proof that a write failed: reconnect and inspect before retrying. Requests are never replayed after transport errors.

Exports stream from a separate read-only worker so collection can continue. One export runs at a time; a second request asks you to retry. Cancelling the download stops its worker. An export exceeding two minutes is stopped; an interrupted download must be retried rather than treated as complete. JSON/CSV fields and full-history coverage are unchanged.

Daily backups contain the database and matching identity key. Copies are verified with hashes, database integrity and record counts. Keep seven automatic copies; older verified automatic copies move to Trash. Manual copies and unverifiable folders are preserved. If Trash is unavailable, retain old copies and show a warning. There is no automatic history deletion.

Stop the service, choose a verified backup folder, then restore into a **new, nonexistent** target:

```sh
npm run service -- stop
npm run restore -- "/absolute/backup-directory" "/absolute/new-restored-directory"
QUOTASCOPE_DATA_DIR="/absolute/new-restored-directory" npm run service -- install
npm run doctor
```

Restore refuses overwrite. Keep the old data and backup until the restored service has been checked. Settings changes preserve a previous settings copy in the selected data directory's `service` folder. Move unwanted files to operating-system Trash; do not permanently delete data or keys.

## Diagnose a problem

Run `npm run doctor` from the intended checkout with the same overrides. It reads configuration, runtime, prerequisites, data-path permissions, allowance capability, HTTP status and installed plist. It creates no data folders, changes no login/authentication settings, and saves no account readings. An allowance capability check contacts the provider through your installed CLI.

If Codex is missing, set its executable path. If sign-in is missing, sign in through Codex. If another program owns the port, choose a different port and reinstall. If the service is unavailable, start it and reconnect. The dashboard keeps successful observations when a later read fails. Local import failures do not stop account checks.

`data/service/stdout.log` and `stderr.log` are private diagnostics. Do not attach raw files, exports, databases, identity keys, or personal screenshots to public issues.

## What history means

Solid strokes connect readings within a coherent window; dashed connectors indicate uncertainty. Reset changes, account changes and missing reads break continuity. The chart has a table alternative and keyboard observation inspection. Source and time-range controls affect history, not the current all-window balances.

Supported allowance ranges are Current cycle, 7, 30 and 90 days, with up to 600 displayed points per source. Current cycle requires valid inferred timing as described below. Boundary-heavy charts may show only the most recent portion. Full raw history remains exportable. Activity totals follow the selected activity period; the daily chart is capped at 90 calendar days in the selected timezone. Rate estimates require enough recent direct readings and never predict an exhaustion time.

Datetime inputs use the selected timezone. Nonexistent or repeated daylight-saving wall times are rejected; select UTC to enter such an instant explicitly. Exports retain UTC plus a legacy, explicitly named Hong Kong rendering for schema compatibility.

## Activity periods and allowance cycles

On **Details → Activity**, choose **All history** or **Current allowance window**. The selection applies to token totals, model shares, settings, sessions and daily activity. All history includes imported logs from before installation and all locally observed accounts; its chart displays the past 90 days. The current-window view uses the selected account and window, and labels the inferred start and next reset. The chart remains capped at 90 days for unusually long windows.

The inferred start is the provider's reported next reset minus the reported window duration. This is not proof of an observed return to 100%. Percentage drops or increases alone do not establish a renewal. Missing timing, expired windows, stale readings and unknown account identity make the current-window view unavailable; it never silently falls back to all-history totals. Actual early/manual resets or reporting changes can make this inference approximate.

Model shares describe recorded input plus output tokens, not quota charges. Current-window tokens are scoped by response completion timestamp and account. Known turns that began before the boundary and cumulative fallback estimates are excluded; unknown turn starts use completion time. Missing devices/logs and unverified system activity prevent interpreting these as a complete account ledger. Multiple allowance buckets do not establish token-to-bucket attribution.

The **Allowance history** range selector on Overview and the menu bar also offers **Current cycle**, using the same inferred start. Existing 7/30/90-day ranges remain available. Gaps and resets remain visible; no artificial 100% starting point is inserted. Earlier-cycle browsing is not included.


### Provider efficiency changes

QuotaScope reads remaining allowance from the provider's account snapshot. It does not convert tokens into quota, apply an assumed efficiency multiplier, or change earlier measurements after a product announcement. A counter drop is a boundary with an unknown cause; it is not proof of a provider-wide reset or policy change. A scheduled cycle start remains an inference.

Local token counts describe recorded model activity, not billable charges or completed work. Cached input is a subset of input, and reasoning is a subset of output. Response IDs deduplicate shared/forked records; cumulative estimates are excluded when response records exist. Missing required counters exclude that record. New imports preserve an unreported cache-write count as null; older exports may contain zero for an unreported count, so historical zero is not evidence that no writes occurred. Nonzero cache writes remain excluded from reconciled totals until their semantics are established. No server-side cache lifetime, routing, or cross-agent cache-sharing inference is made.

Comparisons require the same account, allowance bucket, slot and window duration, with matching model, effort, speed and cache band. Each cohort separates provider plan codes as well as user plan labels. Direct readings must be no more than two minutes apart; unknown/expired windows and user-noted reset or plan boundaries cannot support a comparison. Three distinct reset windows per cohort are still required. Only chronologically separated plan cohorts are paired. Zero or small rounded movements do not imply free work or an infinite efficiency gain.

These are descriptive local-token/account-quota ratios. Work on other devices, cloud tasks and Work may be missing. Workload difficulty, promotions and account-specific rollout timing are not verified; matching cache bands can also hide improvements that act through increased cache reuse. Therefore a ratio cannot establish that a paid plan now delivers more comparable productive work. An announcement date is not an account reset or an effective rollout boundary, and QuotaScope does not insert one automatically.

The [official prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) describes API cache behavior, not a conversion to ChatGPT subscription allowance. Reviewed 18 October 2026; that documentation does not establish an account-specific rollout date or numerical gain for the reported Codex/Work efficiency update.
