# 5PLUS Android app

This app shows the 5PLUS web app on Android phones and **places USSD calls itself**. When a customer presses
*Send request* in iBedel (or *Send* in Wallet top-up, or pays a plan by USSD), the app calls the code straight
away. The customer doesn't have to press the green call button.

The first time, Android asks "Allow 5PLUS to make and manage phone calls?". The customer taps **Allow**.
If they don't, the dialer opens with the code and they press call themselves.

On a phone with two SIM cards, Android may ask which SIM to use unless a default SIM for calls is set in the phone's settings.

## What it opens

On first launch the app asks:

- **Open website**: type the address of your 5PLUS website (the real app on your server, with `https://`).
- **Open the demo**: the whole app runs on the phone with sample accounts, like the demo page. Use this to test now.

To switch later: press and hold the 5PLUS icon → App info → Storage → Clear storage.

When your website is live, you can make the app always open it: in `app/build.gradle.kts` replace
`https://your-5plus-website.com` with your address, then build again.

## Get the APK (free, no programs to install): GitHub

1. Make a free account on **github.com** and sign in.
2. Press **+** (top right) → **New repository**. Name it `5plus-android`, choose **Private**, press **Create repository**.
3. On the new page press **uploading an existing file**. Unzip `5PLUS-android.zip` on your computer, open the folder,
   select **everything inside it** and drag it onto the page. Press **Commit changes**.
4. The `.github` folder is hidden on some computers and may not upload. Check: open the **Actions** tab.
   If it says "Get started with GitHub Actions", press **set up a workflow yourself**, name the file `build-apk.yml`,
   paste the contents of `.github/workflows/build-apk.yml` from the zip, and press **Commit changes**.
5. Open the **Actions** tab → **Build APK**. If a run fails, open it, press **build**, and read the last red lines.
    After about 5 minutes the run turns green.
   Open it, scroll to **Artifacts** and download **5PLUS-apk**. Inside the zip is `app-debug.apk`.
6. Send `app-debug.apk` to your phone (WhatsApp to yourself, a cable, or Google Drive) and open it.
   Android asks to allow installing from this source: allow it, then **Install**.

Every time you upload changed files, GitHub builds a new APK.

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
