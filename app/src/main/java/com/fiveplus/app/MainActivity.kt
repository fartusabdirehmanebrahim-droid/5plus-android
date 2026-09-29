package com.fiveplus.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * 5PLUS for Android: shows the 5PLUS web app and places USSD calls itself.
 *
 * When the web app asks to dial a code (iBedel "Send request", wallet top-up "Send", paying a plan by USSD),
 * this app calls it directly with ACTION_CALL, so the customer doesn't press the green call button.
 * That needs the "Phone" permission, which the app asks for the first time. Without it, the dialer opens instead.
 *
 * The app opens either your 5PLUS website (the real app on your server) or the demo that is built into the app
 * (it runs entirely on the phone, like the demo page). Which one is chosen on first launch, or fixed by APP_URL
 * in app/build.gradle.kts.
 */
class MainActivity : AppCompatActivity() {

    private var web: WebView? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingCode: String? = null
    private var startUrl: String = ""
    private val prefs by lazy { getSharedPreferences("fiveplus", MODE_PRIVATE) }

    // The demo inside the app is served from this address, so the phone treats it like a normal https website.
    private val assetHost = "appassets.androidplatform.net"
    private val demoUrl = "https://$assetHost/assets/index.html"
    private val assetLoader by lazy {
        WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
    }

    /* ---------- demo updates without reinstalling ---------- */
    // The newest demo downloaded from DEMO_UPDATE_URL. Whichever is newer (this file or the one inside the APK) is shown.
    private val demoFile by lazy { File(filesDir, "demo/index.html") }
    private val bundledStamp by lazy { try { assets.open("index.html").use { stampOf(readHead(it)) } } catch (e: Exception) { 0L } }
    private var lastCheck = 0L
    private fun readHead(input: java.io.InputStream): String { val b = ByteArray(4096); val n = input.read(b); return if (n > 0) String(b, 0, n) else "" }
    private fun stampOf(head: String): Long = Regex("name=\"sarrif-build\" content=\"(\\d+)\"").find(head)?.groupValues?.get(1)?.toLongOrNull() ?: 0L
    private fun fileStamp(): Long = try { if (demoFile.exists()) FileInputStream(demoFile).use { stampOf(readHead(it)) } else 0L } catch (e: Exception) { 0L }

    private fun checkDemoUpdate() {
        if (startUrl != demoUrl) return
        lastCheck = System.currentTimeMillis()
        Thread {
            try {
                val c = URL(BuildConfig.DEMO_UPDATE_URL).openConnection() as HttpURLConnection
                c.connectTimeout = 10000; c.readTimeout = 30000; c.useCaches = false
                c.setRequestProperty("Cache-Control", "no-cache")
                if (c.responseCode != 200) return@Thread
                val bytes = c.inputStream.use { it.readBytes() }
                val head = String(bytes, 0, minOf(bytes.size, 4096))
                val stamp = stampOf(head)
                if (!head.contains("<html", ignoreCase = true) || stamp <= maxOf(bundledStamp, fileStamp())) return@Thread
                demoFile.parentFile?.mkdirs()
                val tmp = File(demoFile.parentFile, "index.tmp")
                tmp.writeBytes(bytes)
                if (!tmp.renameTo(demoFile)) { demoFile.delete(); tmp.renameTo(demoFile) }
                runOnUiThread {
                    Toast.makeText(this, "5PLUS updated", Toast.LENGTH_SHORT).show()
                    web?.reload()
                }
            } catch (e: Exception) { /* offline: keep the version we have */ }
        }.start()
    }

    override fun onResume() {
        super.onResume()
        if (web != null && System.currentTimeMillis() - lastCheck > 60_000) checkDemoUpdate()
    }

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }
    private val askCallPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val code = pendingCode
        pendingCode = null
        if (code != null) placeCall(code, granted)
        if (!granted) Toast.makeText(this, "Phone calls are off: press call in the dialer.", Toast.LENGTH_LONG).show()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val w = web
                if (w != null && w.canGoBack()) w.goBack() else finish()
            }
        })
        val fixed = BuildConfig.APP_URL.trim()
        val saved = prefs.getString("start", null)
        when {
            fixed.startsWith("https://") && !fixed.contains("your-5plus-website") -> openWeb(fixed)
            saved != null -> openWeb(saved)
            else -> openWeb(demoUrl) // the app opens straight away and asks for the language
        }
    }

    /* ---------- first launch: website or built-in demo ---------- */
    private fun showChooser() {
        val pad = dp(24)
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, dp(48), pad, pad)
            setBackgroundColor(Color.WHITE)
        }
        fun text(s: String, size: Float, bold: Boolean = false, color: Int = Color.parseColor("#0F2724")) = TextView(this).apply {
            text = s
            setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
            setTextColor(color)
            if (bold) typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, dp(12))
        }
        box.addView(text("5PLUS", 28f, true, Color.parseColor("#0E7A55")))
        box.addView(text("Hal meel ka adeego", 16f, color = Color.parseColor("#4B605B")))
        box.addView(text("Open your 5PLUS website", 18f, true))
        val input = EditText(this).apply {
            hint = "https://your-website.com"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine()
        }
        box.addView(input)
        box.addView(button("Open website") {
            var url = input.text.toString().trim()
            if (url.isEmpty()) { input.error = "Type your website address"; return@button }
            if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://$url"
            prefs.edit().putString("start", url).apply()
            openWeb(url)
        })
        box.addView(text("", 8f))
        box.addView(text("Or try the demo", 18f, true))
        box.addView(text("The whole app runs on this phone with sample accounts. Tap DEMO at the top for the logins.", 15f, color = Color.parseColor("#4B605B")))
        box.addView(button("Open the demo") {
            prefs.edit().putString("start", demoUrl).apply()
            openWeb(demoUrl)
        })
        box.addView(text("To switch later: press and hold the 5PLUS icon → App info → Storage → Clear storage.", 13f, color = Color.parseColor("#7A8C87")))
        setContentView(ScrollView(this).apply { addView(box) })
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(Color.WHITE)
        setBackgroundColor(Color.parseColor("#0E7A55"))
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)).apply { bottomMargin = dp(8) }
        setOnClickListener { onClick() }
    }

    /* ---------- the web app ---------- */
    @SuppressLint("SetJavaScriptEnabled")
    private fun openWeb(url: String) {
        startUrl = url
        val w = WebView(this)
        web = w
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false // the voice guide on the first screen
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString 5PLUS-Android/1.0"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, false)
        w.addJavascriptInterface(Bridge(), "SarrifAndroid")
        w.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (request.url.host != assetHost) null
                else if (request.url.path == "/assets/index.html" && fileStamp() > bundledStamp)
                    WebResourceResponse("text/html", "utf-8", FileInputStream(demoFile))
                else assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                return when (u.scheme?.lowercase()) {
                    "tel" -> { dial(u.toString()); true }
                    "http", "https" -> if (isOwnSite(u)) false else { openOutside(u); true }
                    else -> { openOutside(u); true } // whatsapp:, mailto:, intent: …
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showOffline()
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            // Full screen for videos (the YouTube full-screen button).
            private var fullView: View? = null
            private var fullCallback: WebChromeClient.CustomViewCallback? = null
            override fun onShowCustomView(view: View, callback: WebChromeClient.CustomViewCallback) {
                if (fullView != null) { callback.onCustomViewHidden(); return }
                fullView = view; fullCallback = callback
                (window.decorView as FrameLayout).addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
            override fun onHideCustomView() {
                fullView?.let { (window.decorView as FrameLayout).removeView(it) }
                fullView = null
                fullCallback?.onCustomViewHidden(); fullCallback = null
            }

            // Picture uploads: Premier Wallet payment screenshots, product and visa pictures.
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    pickFiles.launch(params.createIntent())
                    true
                } catch (e: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }
        }
        setContentView(w)
        w.loadUrl(url)
        checkDemoUpdate()
    }

    private fun isOwnSite(u: Uri): Boolean {
        if (u.host == assetHost) return true
        val start = Uri.parse(startUrl)
        return u.host.equals(start.host, ignoreCase = true)
    }

    private fun openOutside(u: Uri) {
        try {
            startActivity(if (u.scheme == "intent") Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME) else Intent(Intent.ACTION_VIEW, u))
        } catch (e: Exception) {
            Toast.makeText(this, "No app on this phone can open that link.", Toast.LENGTH_SHORT).show()
        }
    }

    private fun showOffline() {
        web?.loadDataWithBaseURL(null, """
            <html><body style="font-family:sans-serif;padding:32px;color:#0F2724">
            <h2 style="color:#0E7A55">5PLUS</h2><p>${getString(R.string.offline)}</p>
            <p><a href="${startUrl}" style="display:inline-block;background:#0E7A55;color:#fff;padding:12px 20px;border-radius:12px;text-decoration:none">${getString(R.string.retry)}</a></p>
            </body></html>""".trimIndent(), "text/html", "utf-8", null)
    }

    /* ---------- USSD calls ---------- */
    // Called by the web app (window.SarrifAndroid.call) and for any tel: link.
    private inner class Bridge {
        @JavascriptInterface
        fun call(code: String) {
            runOnUiThread {
                val here = web?.url?.let { Uri.parse(it) }
                if (here != null && isOwnSite(here)) dial("tel:$code")
            }
        }

        @JavascriptInterface
        fun isApp(): Boolean = true
    }

    private fun dial(telUrl: String) {
        val code = Uri.decode(telUrl.removePrefix("tel:").removePrefix("//")).trim()
        if (!Regex("^[0-9*#+]{2,40}$").matches(code)) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED) {
            placeCall(code, true)
            return
        }
        pendingCode = code
        if (!prefs.getBoolean("askedCall", false)) {
            prefs.edit().putBoolean("askedCall", true).apply()
            AlertDialog.Builder(this)
                .setTitle(R.string.call_permission_title)
                .setMessage(R.string.call_permission_text)
                .setPositiveButton(R.string.call_permission_ok) { _, _ -> askCallPermission.launch(Manifest.permission.CALL_PHONE) }
                .setOnCancelListener { askCallPermission.launch(Manifest.permission.CALL_PHONE) }
                .show()
        } else {
            askCallPermission.launch(Manifest.permission.CALL_PHONE)
        }
    }

    private fun placeCall(code: String, direct: Boolean) {
        // "#" must be written as %23 in a tel: address, or everything after it is lost.
        val uri = Uri.parse("tel:" + code.replace("#", Uri.encode("#")))
        try {
            startActivity(Intent(if (direct) Intent.ACTION_CALL else Intent.ACTION_DIAL, uri))
        } catch (e: SecurityException) {
            startActivity(Intent(Intent.ACTION_DIAL, uri))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "This device can't make phone calls.", Toast.LENGTH_LONG).show()
        }
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        web?.destroy()
        super.onDestroy()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
