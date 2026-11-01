# West Garage v1 source archive

These exact source snapshots preserve the 1.2.0 mobile visit-classification tracker before its replacement with the 1.3.0 crossing logger. The `.snapshot` extension prevents compilation, test discovery, and task registration. Nothing imports these files.

The v2 app never opens, migrates, or clears `west-garage-tracker.db`. Existing installation credentials remain in SecureStore under the same key. The server's legacy visit endpoint and tables continue serving older APKs.

Restoring v1 requires restoring these snapshots to `src`, its App/index imports, and its Android motion permission configuration. Do not run both geofence tasks together. The original verified APK remains in `handoff/west-garage-tracker-1.2.0/`.
