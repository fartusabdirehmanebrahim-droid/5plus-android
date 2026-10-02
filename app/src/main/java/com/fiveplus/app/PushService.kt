package com.fiveplus.app

import android.app.Notification
import android.app.PendingIntent
import android.content.Intent
import android.media.RingtoneManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

// Push messages from the 5PLUS server. They arrive even when the app is closed or the phone is locked.
// kind "ring": a new request/booking/first chat: rings for 25 seconds (like the alarm inside the app).
// kind "paid": a paid order: rings for 10 seconds. Anything else: a normal notification.
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        getSharedPreferences("fiveplus", MODE_PRIVATE).edit().putString("fcmToken", token).apply()
    }

    override fun onMessageReceived(msg: RemoteMessage) {
        val d = msg.data
        val kind = d["kind"] ?: "info"
        val title = d["title"] ?: "5PLUS"
        val body = d["body"] ?: ""
        val ring = kind == "ring" || kind == "paid"
        val open = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra("push_goto", d["goto"] ?: "")
        }
        val id = (d["tag"] ?: (title + body)).hashCode()
        val pi = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, if (ring) App.CH_RING else App.CH_INFO)
            .setSmallIcon(R.drawable.ic_stat_5plus)
            .setColor(0xFF0E7A55.toInt())
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setCategory(if (ring) NotificationCompat.CATEGORY_CALL else NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(if (ring) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        if (ring) {
            n.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)) // Android 7 and older
            n.setVibrate(longArrayOf(0, 800, 400, 800, 400, 800))
            n.setTimeoutAfter(if (kind == "paid") 10_000L else 25_000L) // stops the ringing, like the in-app alarm
        }
        val built = n.build()
        if (ring) built.flags = built.flags or Notification.FLAG_INSISTENT // keep ringing until answered or timed out
        try { NotificationManagerCompat.from(this).notify(id, built) } catch (e: SecurityException) { /* notifications are off */ }
    }
}
