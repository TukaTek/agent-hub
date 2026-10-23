# Mobile builds and store releases

CortexAI Agent Hub's public repository does not contain production App Store Connect,
Google Play, Apple team, or private EAS submission identifiers. Those values
belong in the release operator's private configuration.

Self-hosters normally do not need to publish their own mobile app: the CortexAI Agent Hub
client can select a compatible server from the sign-in screen. If you distribute
your own branded build, use your own Expo and store accounts.

## Configure a build

1. `apps/mobile` is linked to the TukaTek Expo project `@tukatek/agent-hub`.
   To use your own account, run `eas init` and change `owner`, `slug`,
   `extra.eas.projectId` and `updates.url` in `app.json` together.
2. Choose unique iOS and Android application identifiers.
3. Configure `EXPO_PUBLIC_API_URL` in the EAS `production` and `preview`
   environments. Every `eas.json` profile maps to one of them, and OTA updates
   read the same value. Production builds require a valid HTTPS URL.
4. Keep store application IDs, team IDs, signing credentials, API keys, and
   review-account credentials out of Git.
5. Before a native iOS or Android build, run
   `pnpm --filter @cortexai-agent-hub/mobile exec expo install --check`. Attachment pickers
   and other Expo native modules must match the SDK (SDK 57 needs
   `expo-image-picker@~57.0.11`, not 17.x). Use `pnpm exec expo install --fix`
   from `apps/mobile` if that check fails.

From `apps/mobile`:

```sh
eas env:create --environment production --name EXPO_PUBLIC_API_URL --value https://app.example.com --visibility plaintext
eas env:create --environment preview --name EXPO_PUBLIC_API_URL --value https://app.example.com --visibility plaintext
eas config --platform android --profile android-apk
eas build --platform ios --profile production
eas submit --platform ios --profile production --latest
```

The first build on each platform must run interactively. EAS can't generate
an Android keystore or iOS signing credentials with `--non-interactive`:

1. `eas build --platform android --profile android-apk`: let EAS generate and
   store the keystore, then back it up from `eas credentials -p android`.
2. `eas build --platform ios --profile production`: sign in to the Apple
   Developer account and let EAS create the distribution certificate,
   provisioning profile and push key.
3. `eas submit --platform ios --latest` with an App Store Connect API key, then
   add the build to an internal TestFlight group in App Store Connect.

EAS can prompt for store identity interactively. For automated submission, add
the required identifiers through a private CI configuration or a short-lived
local change that is never committed.

Before submission, verify the production API, account deletion, sign-in,
notifications, store privacy answers, age rating, screenshots, support page,
and review account on a physical device.

## Android APK

Until CortexAI Agent Hub is on Google Play, Android users can install an APK. Run the
`release-android-apk` workflow from `main` in GitHub Actions when native code
changes. It builds the `android-apk` EAS profile, signed with the project's
managed keystore, and replaces the rolling `android` GitHub release, so the
download link stays the same:

```text
https://github.com/TukaTek/agent-hub/releases/download/android/cortexai-agent-hub.apk
```

The APK uses the production update channel, so JavaScript changes reach it
through the over-the-air updates below without a new APK. A Google Play install
is signed with Play's key, so switching from the APK to Play means uninstalling
the APK first.

## Android push

For Android push notifications, create a Firebase project and register the app's
Android package. Download `google-services.json` and, from `apps/mobile`, store
it as an EAS file environment variable:

```sh
eas env:create --environment production --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --visibility secret
```

Keep the file and credentials out of Git. Upload an FCM V1 service account key
with `eas credentials` under Android > Google Service Account > FCM V1. Then
rebuild the APK: Firebase configuration is native, so an OTA update cannot add
it to an existing binary. Builds without the variable remain supported.

## Over-the-air updates

Production and preview builds include `expo-updates` and use the corresponding
EAS Update channel. The runtime version follows the public app version, so bump
`expo.version` whenever native code, config plugins, permissions, or native
dependencies change, then create and submit new store builds.

OTA publishing is optional. Set the `MOBILE_OTA_ENABLED` Actions repository
variable to `true` only after linking `apps/mobile` to an Expo project and adding
an `EXPO_TOKEN` Actions secret with access to it. Without that variable, CI skips
the hosted update job. Once enabled, CI publishes a production OTA update after
the full test suite passes on `main` when the revision only changes mobile
JavaScript, TypeScript, or bundled CSS. CI skips OTA publishing when native
configuration, modules, dependencies, assets, or the update workflow changed.

To publish a compatible update manually from `apps/mobile`:

```sh
eas update --platform all --channel production --environment production --message "Short description"
```

Installed release builds download a compatible update in the background on
launch and apply it after the next restart. Builds created before
`expo-updates` was configured cannot receive OTA updates and must be replaced
with a new iOS and Android build once.
