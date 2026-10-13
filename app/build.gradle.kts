import groovy.json.JsonSlurper

// Push notifications: put the google-services.json file from your Firebase project (Android app "com.fiveplus.app")
// next to this file (app/google-services.json). Without it the app builds and works, with no push notifications.
val fcm: Map<String, String> = run {
    val f = file("google-services.json")
    if (!f.exists()) return@run emptyMap()
    try {
        val j = JsonSlurper().parse(f) as Map<*, *>
        val pi = j["project_info"] as Map<*, *>
        val clients = (j["client"] as List<*>).map { it as Map<*, *> }
        val c = clients.firstOrNull { (((it["client_info"] as Map<*, *>)["android_client_info"] as Map<*, *>)["package_name"]) == "com.fiveplus.app" } ?: clients.first()
        mapOf(
            "APP_ID" to ((c["client_info"] as Map<*, *>)["mobilesdk_app_id"]?.toString() ?: ""),
            "API_KEY" to (((c["api_key"] as List<*>).first() as Map<*, *>)["current_key"]?.toString() ?: ""),
            "PROJECT_ID" to (pi["project_id"]?.toString() ?: ""),
            "SENDER_ID" to (pi["project_number"]?.toString() ?: ""),
        )
    } catch (e: Exception) { logger.warn("google-services.json could not be read: ${e.message}"); emptyMap() }
}

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
        buildConfigField("String", "APP_URL", "\"https://fiveplus.onrender.com\"")
        // The demo inside the app checks this address for a newer version every time it opens,
        // so changes show up without installing a new APK. (The GitHub repository must be public.)
        for (k in listOf("APP_ID", "API_KEY", "PROJECT_ID", "SENDER_ID")) buildConfigField("String", "FCM_$k", "\"${fcm[k] ?: ""}\"")
        buildConfigField("String", "DEMO_UPDATE_URL", "\"https://raw.githubusercontent.com/fartusabdirehmanebrahim-droid/5plus-android/main/app/src/main/assets/index.html\"")
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
    implementation("com.google.firebase:firebase-messaging:24.0.0")
}
