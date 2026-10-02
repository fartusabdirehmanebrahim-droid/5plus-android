package com.fiveplus.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions

// Starts Firebase (push notifications) from the settings in google-services.json, and makes the notification
// channels: "Order alarms" rings like a phone call; "Updates" is a normal notification.
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        startFirebase(this)
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = getSystemService(NotificationManager::class.java)
            val ring = NotificationChannel(CH_RING, "Order alarms", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "New requests, bookings and paid orders. Rings even when 5PLUS is closed."
                setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 800, 400, 800, 400, 800)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            }
            val info = NotificationChannel(CH_INFO, "Updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Prices sent, orders accepted, messages and documents."
            }
            nm.createNotificationChannel(ring); nm.createNotificationChannel(info)
        }
    }

    companion object {
        const val CH_RING = "orders_ring"
        const val CH_INFO = "updates"
        val pushReady: Boolean get() = BuildConfig.FCM_APP_ID.isNotEmpty()

        fun startFirebase(app: Application) {
            if (!pushReady || FirebaseApp.getApps(app).isNotEmpty()) return
            try {
                FirebaseApp.initializeApp(app, FirebaseOptions.Builder()
                    .setApiKey(BuildConfig.FCM_API_KEY)
                    .setApplicationId(BuildConfig.FCM_APP_ID)
                    .setProjectId(BuildConfig.FCM_PROJECT_ID)
                    .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                    .build())
            } catch (e: Exception) { /* bad settings: the app works without push */ }
        }
    }
}
