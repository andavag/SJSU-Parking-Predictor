# Instructions for this project

Read `PROJECT_CONTEXT.md` before changing the app. Keep all work inside this directory unless the user explicitly asks to change the parent Java project.

The `mobile` directory is an Expo React Native + TypeScript client. It retrieves data only from an HTTPS API address set in `EXPO_PUBLIC_API_BASE_URL`; never add a certificate bypass, cleartext HTTP, or direct SJSU page scraping in the mobile client. The `api` directory is a Node + TypeScript service intended to listen on loopback behind an HTTPS reverse proxy. Keep data access typed, handle loading/error/stale states, and preserve the `Reported Data`/`Expected Values` segmented layout. Shuttle information belongs below the garage cards, not in a separate tab.

The public API is `GET /v1/parking-status`; `?refresh=1` bypasses its normal 30-second cache. The mobile client refreshes every 30 seconds only while foregrounded, on resume, and when pulled to refresh. Requests time out after 12 seconds. Do not promise continuous background refresh.

Update `PROJECT_CONTEXT.md` if a change alters the public API, architecture, source, or refresh behavior. Run the relevant API/mobile tests and type checks after changes.
