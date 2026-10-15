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

The dashboard pause switch suspends account reads and local imports; it does not uninstall the login agent. Manual refresh remains available. Account checks normally run every minute; failures back off to five minutes. Import retries run separately. Closing the dashboard releases its detail reader after two idle minutes while collection continues.

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

Current supported ranges are 7, 30 and 90 days, with up to 600 displayed points per source. Boundary-heavy charts may show only the most recent portion. Full raw history remains exportable. Activity shows 90 calendar days in the selected timezone while totals remain all-time. Rate estimates require enough recent direct readings and never predict an exhaustion time.

Datetime inputs use the selected timezone. Nonexistent or repeated daylight-saving wall times are rejected; select UTC to enter such an instant explicitly. Exports retain UTC plus a legacy, explicitly named Hong Kong rendering for schema compatibility.
