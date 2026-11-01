# Project Context: SJSU Parking App

## Product

This project is an Expo React Native app that shows official SJSU garage fullness data. The mobile UI has the `SJSU Parking` header and a full-width segmented control with `Reported Data` and `Expected Values`.

`Reported Data` shows North, West, South, and South Campus garage cards with the source percentage full, address, last source update, and a clear Available, Busy, or Full label. Parking Shuttle Information and its official links appear below those cards. `Expected Values` has a server-provided algorithm dropdown, Now / In 1–90 minutes (roller) / Exact date & time selectors, four predicted fullness percentages, and a shared graph of actual and predicted fullness. The graph always spans live now ±90 minutes, independently of the card target. There are no confidence bands.

## Architecture

- `mobile`: Expo SDK 57 React Native + TypeScript client. It requests the public HTTPS status, algorithm registry, and prediction endpoints configured at build time with `EXPO_PUBLIC_API_BASE_URL`. Parking data is held only in React memory. Native SVG rendering and native date/time controls are included in the initial APK. Expo Updates downloads compatible UI bundles from the existing EAS project; preview and production channels are separate.
- Android 1.3.0 replaces the visit classifier with an opt-in diagnostic West Garage crossing logger at 50, 100, 150, and 160 m around 37.3316667, -121.8827222. Every enter/exit callback is persisted in receipt order, including repeats and unexpected sequences. It stores callback UTC time and optional speed/sample time/accuracy; no coordinates or routes are stored. Speed uses a fix no older than 30 seconds with accuracy at most 50 m, otherwise one high-accuracy request bounded to 10 seconds. Speed can remain unavailable without losing the crossing. Android cloud backup remains disabled.
- The v1 mobile source is inert under `mobile/archive/west-garage-v1/`. The new app retires both old task registrations without opening, migrating, displaying, or clearing `west-garage-tracker.db`. V2 uses `west-garage-crossings-v2.db` and starts paused after upgrade; the user enables it explicitly. The SecureStore installation token is reused. Both collection and upload pause when logging is off. Permission loss stops task registrations on reconciliation. The app root reconciles on launch, foreground return, connectivity return, and every 30 seconds while foregrounded.
- `api`: Node + TypeScript service hosted on the Ubuntu server. It fetches the official SJSU page using the operating system certificate store, normalizes the four garages and shuttle links, reads MySQL history, adapts loopback-only forecast-worker results into the version-one response, caches successful live data for 30 seconds, and rate-limits public requests. Prediction calculations never run on the phone.
- `forecasting`: a Python scientific worker, bound only to `127.0.0.1:3002`. It owns model fitting, inference, saved artifacts, minute Kalman refreshes, nightly retraining, and evaluation reports. It is reached only by the local Node API; it has no Caddy, Tailscale, or mobile route.
- A Tailscale Funnel deployment can route public HTTPS through an outbound Tailscale connection to Caddy at `127.0.0.1:8080`; Caddy strips the `/parking` prefix and proxies to the loopback-only API. The phone never calls a server IP, cleartext HTTP, or the SJSU page directly. Configure a hostname belonging to your deployment in `EXPO_PUBLIC_API_BASE_URL` before building.

`GET /v1/parking-status` returns `sourceUpdatedAt`, `fetchedAt`, `stale`, four garage readings, and shuttle links. Adding `?refresh=1` forces a source refresh; otherwise the API uses a successful response for 30 seconds. A failed refresh returns the last successful data with `stale: true`; no prior data produces HTTP 503. `GET /v1/parking-history` returns `{ readings }`, where `readings` contains at most ten `{ garageName, fullnessPercent, reportedAt }` rows in newest-first order. Both responses are marked `Cache-Control: no-store`. The mobile client preserves its last successful live result as stale if the public API later fails.

The personal tracker adds `POST /v1/installations/enroll` for a one-time, server-issued 12-digit code and `POST /v1/parking-visits/batch` for authenticated summary uploads. The latter returns per-visit accepted, duplicate, or rejected acknowledgements and deduplicates by `clientVisitId`. Installation tokens and enrollment codes are stored as hashes in separate MySQL tables; `PARKING_VISITS_DATABASE_URL` uses a dedicated writer account. Public read endpoints remain unauthenticated. No raw route data is uploaded.

V2 adds `POST /v1/parking-crossings/batch` with 1–25 exact-field events, a 64 KiB body limit, authenticated per-event acknowledgements, and 10 batches/IP/minute. `parking_crossing_events` stores unique `client_event_id`, installation ID, canonical payload JSON, and server receipt time. Only matching installation/payload retries are duplicates; conflicts are rejected. The existing writer gains only SELECT/INSERT on the new table. See `api/CROSSINGS.md` for the full contract. V1 server behavior remains supported.

Crossings become due 24 hours after collection. Background sync requests a minimum 1,440-minute interval; due records also retry on foreground/connectivity return with bounded backoff (30 minutes up to one day). Each wakeup sends at most 250 events. Only individual accepted/duplicate acknowledgements mark records synced; rejected records remain visible as blocked. History, including synced records, remains until explicitly cleared locally. Clearing v2 history discards pending uploads and cannot recall records already received by the server. Background geofencing/task execution is best effort; force-close, device settings, poor signal, and small geofences can delay or prevent callbacks.

## Refresh behavior

The client loads on startup, requests new data every 30 seconds while foregrounded, refreshes after returning to the foreground, and refreshes after pull-to-refresh. A request times out after 12 seconds and displays an actionable error. iOS and Android do not guarantee continuous background updates.

Predictions load when Expected Values is opened or its controls change, refresh every 60 seconds while that screen is foregrounded, and refresh on resume and pull-to-refresh. Relative targets advance from server now each refresh; exact targets stay fixed. Stale forecasts retain their original graph timestamps and are explicitly labelled.

## Prediction API (version 1)

- `GET /v1/prediction-algorithms` returns `{ apiVersion: 1, algorithms: [{ id, name, version, description }] }`.
- `GET /v1/prediction-evaluation` returns the latest read-only rolling-backtest report: data range, readiness, per-garage/horizon MAE and RMSE, conformal calibration results, and ensemble weights. It is for learning and comparison; the mobile UI does not display it yet.
- `GET /v1/parking-predictions` accepts `algorithm` (defaults to `same_time_previous_week`) and either `minutesAhead=1..90` or `targetTime=<ISO timestamp with offset>`. Omit both for Now. Returns `apiVersion`, `currentTime`, `targetTime`, `timezone`, `algorithm`, four `predictions`, and `graph` (`startTime`, `endTime`, four `series` with `observed` and `forecast` minute points). Each point uses `{ time, fullnessPercent }`. Unavailable percentages are `null`; no interpolation or stale fallback is invented. Invalid input returns 400; database errors return 503. Responses use no-store.
- The default algorithm is same local campus day and time in the previous calendar week, using `America/Los_Angeles`. For each prediction card it selects the closest available source record for that garage, before or after the requested moment; equal-distance ties select the later record. The forecast graph retains exact recorded minute points so gaps are visible. The old `same_time_previous_day` request value is accepted as a temporary alias for already-installed app versions.
- The picker contains same-time-last-week, linear, logistic, polynomial, Kalman, kNN, SARIMA, gradient boosting, MLP, and ensemble forecasts. The worker trains on per-garage 15-minute bins using only a 30-minute carry-forward gap; observed graph data is never filled. Context-aware estimates use recent lags through 90 minutes, while distant or historical exact times use a calendar-only seasonal branch. Deployment first creates quick calendar-based bootstrap models so the API becomes usable promptly; the nightly 2:15 AM campus-time job replaces them with full direct-horizon fits and a leakage-safe rolling-origin comparison. The bootstrap evaluation report has no comparison metrics or ensemble weights until that first nightly run. Polynomial and Kalman state refresh every minute. All model card and graph estimates use `sourceTime`/`reportedAt: null`; only the weekly baseline carries source metadata. Conformal prediction calibrates gradient-boosting errors in reports only—no bounds are added to the app. Small-data modes begin with 2 valid bins for Kalman, 14 days for kNN, 21 days for daily SARIMA, and 28 days for boosting/MLP; SARIMA upgrades to weekly seasonality after 12 weeks.
- The SQL timestamps are campus wall-clock values, not UTC. The existing schema cannot distinguish two occurrences of the same minute when daylight-saving time ends.

## OTA delivery

The app is linked to Expo project `64ff7f40-aee0-4ef3-b3f4-4695e935bdf0`. Version 1.1.0 includes expo-updates and uses appVersion as its native runtime compatibility boundary. Local APK builds default to preview. EAS profiles use their named channels. Startup checks download updates without delaying the embedded app; a manual Check for app update / Restart control is also available. Expo's default error recovery remains enabled.

UI-only updates must retain the target APK's app version to reach that runtime. Native dependency or permission changes require a version bump and a new APK. See `mobile/OTA.md` for publish and rollback commands. Server model updates require API/forecast-worker deployment only, not a phone update. Preview and production channels are provisioned in the existing Expo account. Channel publishing requires that account; credentials are never embedded in the APK.

West Garage v2 uses native/runtime version 1.3.0, Android version code 4. It retains precise/background location and explicitly removes both activity-recognition permissions. A new APK is required. Android is the logger platform; iOS retains its existing views.

The 1.3.0 APK was built on the remote server, but its matching v2 API/schema deployment and physical phone testing are pending. It is distributed as a development-signed prerelease. Deploy the server changes before relying on crossing uploads; phone testing requires a separate laptop and phone.

The 1.3.0 APK has a matching local development signing certificate, all four native architectures, runtime 1.3.0/code 4, and no motion permissions. Its SHA-256 is `604f3717ef30ca8c576b70d8510805d0df85a216a0152bb77798fab40fc1eb58`. The latest checks and pending deployment/physical tests are described in the GitHub prerelease notes.

The prediction API requires its own loopback forecast worker and MySQL grants. The deployment guide describes a fresh server setup; no private server backup is included in this repository.

Preview and production OTA channels are separate. Android installation, visual behavior, and update/restart require a phone check.

Local APKs and verification receipts are excluded from Git history. Check each GitHub Release for its artifact checksum and current validation status.

## Local development

1. In `api`: on the host operating system, run `npm ci`, then `npm run start`. Node uses the operating system certificate store.
2. For local API development, use an HTTPS endpoint appropriate to the development environment. Do not point a released mobile build at a temporary tunnel.
3. In `mobile`: set `EXPO_PUBLIC_API_BASE_URL` to the HTTPS URL for your deployment, then build an APK. The phone needs ordinary internet access, but does not need to share Wi-Fi with the server.

The Funnel hostname is independent of the home public IP. Keep the server online, connected to Tailscale, and configured with Funnel background mode. Confirm SJSU’s terms and rate limits before public long-term hosting.

Before starting the API, copy `api/.env.example` to `api/.env` and set `PARKING_DATABASE_URL` to its local MySQL connection URL. This value stays on the server, is ignored by Git, and is never included in the mobile build.

For the Ubuntu production migration, see `deploy/ubuntu/README.md`. The API remains loopback-only and is intended to run as `sjsu-parking-api.service`; Tailscale Funnel is the public HTTPS entry point, with Caddy as the loopback-only reverse proxy. The `sjsu-parking-collector.timer` records source updates every minute, never by opening port 3000 directly.
