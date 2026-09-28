plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.fiveplus.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.fiveplus.app"
        minSdk = 23
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        // Optional: put the address of your 5PLUS website here (the real app on your server) so the app always opens it.
        // Left as it is, the app asks on first launch: your website, or the demo built into the app.
        buildConfigField("String", "APP_URL", "\"https://your-5plus-website.com\"")
    }

    buildFeatures { buildConfig = true }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Uses the debug key so "Build APK" works straight away. Sign with your own key before publishing on Google Play.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.webkit:webkit:1.11.0")
}
