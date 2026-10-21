# 5PLUS Android app

This app shows the 5PLUS web app on Android phones and **places USSD calls itself**. When a customer presses
*Send request* in iBedel (or *Send* in Wallet top-up, or pays a plan by USSD), the app calls the code straight
away. The customer doesn't have to press the green call button.

The first time, Android asks "Allow 5PLUS to make and manage phone calls?". The customer taps **Allow**.
If they don't, the dialer opens with the code and they press call themselves.

On a phone with two SIM cards, Android may ask which SIM to use unless a default SIM for calls is set in the phone's settings.

## Links

| What | Link |
|---|---|
| Download the Android app (always the newest) | https://github.com/fartusabdirehmanebrahim-droid/5plus-android/releases/download/app/5PLUS.apk |
| Website | https://fiveplus.onrender.com |
| Release page | https://github.com/fartusabdirehmanebrahim-droid/5plus-android/releases/tag/app |

| Google Play file (AAB) | https://github.com/fartusabdirehmanebrahim-droid/5plus-android/releases/download/app/5PLUS.aab |

Every change pushed to `main` builds a new APK and replaces `5PLUS.apk` on the release, so the download link above never changes.

## Google Play

`5PLUS.aab` is the file Google Play wants. It is signed with the 5PLUS **upload key**, stored here encrypted as
`app/upload.jks.enc`. GitHub builds it only when the repository secret **PLAY_KEY_PASSWORD** is set
(Settings → Secrets and variables → Actions → New repository secret). Keep the key file and its password safe:
every update on Google Play must be signed with the same upload key. Each build has a higher version number automatically.

## What it opens

The app opens the 5PLUS website (`https://fiveplus.onrender.com`, set as `APP_URL` in `app/build.gradle.kts`).
To use another address, change `APP_URL` there and push: GitHub builds the new APK.

## How the APK is built

GitHub builds it by itself: **Actions → Build APK** runs on every push to `main` (about 5 minutes),
then publishes `5PLUS.apk` on the release **app** (link above). Each run also keeps the APK under **Artifacts** as `5PLUS-apk`.

To install: open the download link on the Android phone, open the file, allow installing from this source if asked, then **Install**.

## Or build it on a computer: Android Studio

1. Install **Android Studio** (free, developer.android.com/studio).
2. **Open** this folder. Wait until it finishes "Gradle sync".
3. **Build → Build App Bundle(s) / APK(s) → Build APK(s)**. The APK is in `app/build/outputs/apk/debug/`.
   Or connect your phone with USB debugging on and press ▶ Run.

## Keeping the demo inside the app up to date

`app/src/main/assets/index.html` is the demo page. `python3 demo/build.py` in the main 5PLUS folder updates it.

## Before Google Play

Change `applicationId` if you like, set `versionCode`/`versionName`, and sign the release with your own key
(Android Studio → Build → Generate Signed App Bundle). Google Play asks why the app uses the phone-call permission:
"The app dials the USSD payment code for mobile money transfers when the customer confirms a payment."
