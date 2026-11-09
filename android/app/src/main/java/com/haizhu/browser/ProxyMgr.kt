package com.haizhu.browser

import android.content.Context
import android.os.Build
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import java.net.InetSocketAddress
import java.net.Proxy

/**
 * Proxy profiles + WebView ProxyController integration (API 29+).
 * Mirrors desktop profiles: direct / http / socks5 / pac / system.
 */
class ProxyMgr(private val ctx: Context) {
    data class Profile(
        val id: String, var name: String, var mode: String,
        var host: String = "", var port: Int = 0,
        var user: String = "", var pass: String = "",
        var pacUrl: String = "", var bypass: String = "<local>"
    )

    private val prefs = ctx.getSharedPreferences("proxy", 0)
    var profiles = mutableListOf<Profile>()
    var activeId = "direct"

    init { load() }

    private fun load() {
        activeId = prefs.getString("active", "direct") ?: "direct"
        prefs.getString("profiles", "[]")?.let { json ->
            val arr = org.json.JSONArray(json)
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                profiles.add(Profile(o.optString("id"), o.optString("name"), o.optString("mode"),
                    o.optString("host"), o.optInt("port"), o.optString("user"), o.optString("pass"),
                    o.optString("pacUrl"), o.optString("bypass", "<local>")))
            }
        }
    }

    fun save() {
        val arr = org.json.JSONArray()
        profiles.forEach { p ->
            arr.put(org.json.JSONObject().apply {
                put("id", p.id); put("name", p.name); put("mode", p.mode)
                put("host", p.host); put("port", p.port); put("user", p.user)
                put("pass", p.pass); put("pacUrl", p.pacUrl); put("bypass", p.bypass)
            })
        }
        prefs.edit().putString("active", activeId).putString("profiles", arr.toString()).apply()
    }

    fun active(): Profile = profiles.find { it.id == activeId } ?: Profile("direct", "Direct", "direct")

    /** Apply to system WebView proxy + our OkHttp client. */
    fun apply(onDone: (String) -> Unit = {}) {
        val p = active()
        Net.proxy = when (p.mode) {
            "http", "https" -> Proxy(Proxy.Type.HTTP, InetSocketAddress(p.host, p.port))
            "socks5", "socks4" -> Proxy(Proxy.Type.SOCKS, InetSocketAddress(p.host, p.port))
            else -> null
        }
        if (Build.VERSION.SDK_INT >= 29 && WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            val controller = ProxyController.getInstance()
            val bypass = p.bypass.split(';', ',').filter { it.isNotBlank() }
            val ex = ctx.mainExecutor
            when (p.mode) {
                "direct" -> controller.clearProxyOverride(ex) { onDone("direct") }
                // androidx.webkit ProxyConfig has no PAC field — WebView proxy
                // override only takes proxy rules + bypass list. Report honestly.
                "pac" -> onDone("pac-unsupported")
                else -> {
                    val scheme = if (p.mode == "http" || p.mode == "https") "http" else "socks5"
                    val b = ProxyConfig.Builder().addProxyRule("$scheme://${p.host}:${p.port}")
                    bypass.forEach { b.addBypassRule(it) }
                    controller.setProxyOverride(b.build(), ex) { onDone(p.mode) }
                }
            }
        } else onDone("unsupported")
    }
}

private fun Context.mainExecutor(): java.util.concurrent.Executor =
    java.util.concurrent.Executor { r -> android.os.Handler(android.os.Looper.getMainLooper()).post(r) }
