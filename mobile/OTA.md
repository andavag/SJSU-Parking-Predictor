# App updates

The first version 1.1.0 APK includes Expo Updates, the chart renderer, and native date/time pickers. It checks the existing EAS project on startup, uses its embedded bundle offline, and downloads compatible updates for a later launch. The app also has a manual update/restart control. Default Expo error recovery is enabled.

`node scripts/verify-ota.mjs` checks the current preview update and applies the same manifest-provided asset headers as the Android client. Pass an update ID when you need to assert a specific bundle.

## Publish a UI update

From `mobile`, using the owner's Expo account:

```bash
npx eas-cli login
npx eas-cli channel:create preview
npx eas-cli channel:create production
npx eas-cli update --channel preview --environment preview --platform android --message "Describe the UI change"
```

Create the channels only if they do not already exist. Set `EXPO_PUBLIC_API_BASE_URL` in each EAS environment to your HTTPS API base URL. Always specify `--environment` so a remote bundle uses the intended API address. Check the preview update on the phone before publishing the same source to production:

```bash
npx eas-cli update --channel production --environment production --platform android --message "Describe the verified UI change"
```

Local APKs use the preview channel in app.json. EAS builds select the channel in eas.json. Use `npx eas-cli build --profile preview --platform android` for an internal build and production for production builds. OTA updates affect compatible installed apps on that channel; they are not APK distribution.

## Compatibility and rollback

The runtime policy is appVersion. Keep the installed APK's app version for UI/JavaScript-only changes. Bump the version and create a new APK when changing native dependencies, permissions, or native configuration. Existing 1.1.0 installs will keep their compatible bundle. The API's `apiVersion: 1` is checked before using predictions.

West Garage tracker 1.2.0 has a separate native runtime because it adds location, task, storage, and permission modules. Crossing logger 1.3.0 removes the motion permission and uses runtime 1.3.0 (Android code 4). Install the new APK for this change. Publish subsequent UI fixes only to the matching runtime; do not send the archived classifier or v2 logger across incompatible runtimes.

To roll back a published update, use `npx eas-cli update:republish` to republish a known-good update group to the affected branch, or `npx eas-cli update:roll-back-to-embedded --channel preview` to restore this APK's embedded UI. Use the production channel only when rolling back a production release. See the CLI prompts for group/branch selection. No custom unsafe fallback or certificate bypass is enabled.

## Verification

In an installed release APK, check the algorithm dropdown, roller, exact calendar/time, card target, fixed live ±90-minute graph, and airplane-mode error state. Publish a small preview label change at runtime 1.1.0, use Check for app update, restart, and confirm it appears. Then test rollback. OTA downloading and native UI cannot be fully validated in Expo Go or by unit tests.

References: [SDK 57 Updates](https://docs.expo.dev/versions/v57.0.0/sdk/updates/), [EAS Update setup](https://docs.expo.dev/eas-update/getting-started/), [runtime versions](https://docs.expo.dev/eas-update/runtime-versions/).
