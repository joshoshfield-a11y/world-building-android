package com.dogbyte.worldalbum

import android.app.Activity
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView

class MainActivity : Activity() {
    private lateinit var web: WebView
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        web.loadUrl("file:///android_asset/www/mobile.html")
    }
    override fun onPause() { super.onPause(); web.onPause() }
    override fun onResume() { super.onResume(); web.onResume() }
}
