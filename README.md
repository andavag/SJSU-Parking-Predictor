# SJSU Parking

An Expo React Native app for SJSU garage fullness and shuttle links, backed by a Node API, MySQL history, and a local Python forecasting worker. The phone uses a configured HTTPS API. The API reads the official parking source, and the forecast worker is reachable only from the server.

## Repository layout

- `mobile/`: Expo SDK 57 app, Android crossing logger, and UI tests.
- `api/`: TypeScript API, collector, and tests.
- `forecasting/`: Python models and tests.
- `deploy/ubuntu/`: example schema, service units, scripts, and a loopback Caddy configuration.

See [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) for behavior and API contracts, [api/CROSSINGS.md](api/CROSSINGS.md) for crossing uploads, and [deploy/ubuntu/README.md](deploy/ubuntu/README.md) for server setup.

## Local development

1. Install Node and Python versions compatible with the checked-in dependencies, and run `npm ci` separately in `api/` and `mobile/`.
2. Copy `api/.env.example` to `api/.env` and set local MySQL connection URLs. Keep passwords on the server. Create the database using `deploy/ubuntu/history-schema.sql` and, for the crossing logger, `deploy/ubuntu/west-garage-schema.sql`.
3. Copy `mobile/.env.example` to `mobile/.env` and set `EXPO_PUBLIC_API_BASE_URL` to your **HTTPS** API base URL. This variable is embedded in the app bundle; never put database credentials there.
4. Run `npm run start` from `api/` and `npm run start` from `mobile/`. The API and forecast worker must remain on loopback behind a separately configured HTTPS entry point for a physical phone.

Run `npm run typecheck` and `npm test` in both Node packages. Run `python3 -m unittest discover -s tests` in `forecasting/` after installing `requirements.txt` in a virtual environment.

## Release status

Android 1.3.0 adds an opt-in West Garage crossing logger. Its server API/schema deployment and physical phone checks are pending. The GitHub 1.3.0 APK is a development-signed prerelease; review its release notes before installing. APKs and local verification receipts are kept outside Git history.

The app does not guarantee background location callbacks or continuous background refresh. Crossing uploads require installation enrollment; public parking reads remain unauthenticated. No raw route or coordinates are uploaded.

## License

The project is MIT licensed. See [LICENSE](LICENSE). The Expo template notice is retained in [mobile/LICENSE](mobile/LICENSE).
