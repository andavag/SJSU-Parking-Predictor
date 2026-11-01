# Android build

Install the Android SDK and NDK required by Expo SDK 57 on the build machine. Set `ANDROID_HOME` and provide the Android SDK path in the generated `android/local.properties`. Copy `.env.example` to `.env` and set a production-ready HTTPS API base URL before building; this value is embedded in the APK.

From `mobile/`:

```bash
npm ci
npx expo prebuild --platform android --no-install
cd android
NODE_ENV=production CMAKE_BUILD_PARALLEL_LEVEL=1 ./gradlew :app:assembleRelease --no-daemon --max-workers=1
```

The output is `android/app/build/outputs/apk/release/app-release.apk`. Verify its package version, permissions, signature, ZIP integrity, and SHA-256 before distribution. A local release build may use a development signing key; installing over a build signed with another key will fail. Do not uninstall an existing app just to resolve a signature mismatch, because that can erase local history and credentials.

For version 1.3.0, verify that precise and background location permissions are present, activity-recognition permissions are absent, and the embedded runtime/version code match the intended release. Deploy the matching crossing API before relying on uploads. Physical phone testing requires a separate laptop and USB-connected phone; agree on a transfer method before moving a server-built APK there.
