package com.haizhu.browser

import android.content.Context
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * Userscript engine — Tampermonkey-compatible metadata parsing + @match glob
 * + a GM_* surface bridged through a JavascriptInterface. Semantics mirror the
 * desktop engine (src/main/userscripts.js).
 */
class UserscriptEngine(private val ctx: Context) {
    private val dir = File(ctx.filesDir, "userscripts").apply { mkdirs() }

    data class Meta(
        var name: String = "Unnamed", var namespace: String = "",
        var version: String = "0", var runAt: String = "document-idle",
        val match: MutableList<String> = mutableListOf(),
        val include: MutableList<String> = mutableListOf(),
        val exclude: MutableList<String> = mutableListOf(),
        val grant: MutableList<String> = mutableListOf(),
        val resource: MutableMap<String, String> = mutableMapOf(),
        var noframes: Boolean = false
    )
    data class Script(val id: String, val meta: Meta, val code: String, var enabled: Boolean)

    val scripts = mutableMapOf<String, Script>()
    private val values by lazy {
        JSONObject(ctx.getSharedPreferences("gm_values", 0).getString("data", "{}") ?: "{}")
    }

    init { loadAll() }

    fun loadAll() {
        scripts.clear()
        dir.listFiles { f -> f.name.endsWith(".user.js") }?.forEach { f ->
            runCatching {
                val code = f.readText()
                val meta = parseMeta(code) ?: return@runCatching
                val id = f.name.removeSuffix(".user.js")
                scripts[id] = Script(id, meta, code, !File(dir, "$id.disabled").exists())
            }
        }
    }

    fun parseMeta(src: String): Meta? {
        val block = Regex("//\\s*==UserScript==([\\s\\S]*?)//\\s*==/UserScript==").find(src) ?: return null
        val m = Meta()
        block.groupValues[1].lines().forEach { line ->
            val r = Regex("^\\s*//\\s*@([A-Za-z_-]+)\\s*(.*)$").find(line) ?: return@forEach
            val k = r.groupValues[1].lowercase(); val v = r.groupValues[2].trim()
            when (k) {
                "name" -> m.name = v; "namespace" -> m.namespace = v; "version" -> m.version = v
                "run-at" -> m.runAt = v; "noframes" -> m.noframes = true
                "match" -> m.match.add(v); "include" -> m.include.add(v)
                "exclude" -> m.exclude.add(v); "grant" -> m.grant.add(v)
                "resource" -> v.split(" ", limit = 2).let { if (it.size == 2) m.resource[it[0]] = it[1] }
            }
        }
        if (m.match.isEmpty() && m.include.isEmpty()) m.include.add("*")
        return m
    }

    fun idOf(m: Meta) = MessageDigest.getInstance("MD5")
        .digest((m.namespace + "|" + m.name).toByteArray())
        .joinToString("") { "%02x".format(it) }.take(16)

    fun install(code: String): Script {
        val meta = parseMeta(code) ?: throw IllegalArgumentException("no ==UserScript== block")
        val id = idOf(meta)
        File(dir, "$id.user.js").writeText(code)
        File(dir, "$id.disabled").delete()
        return Script(id, meta, code, true).also { scripts[id] = it }
    }

    fun remove(id: String) {
        File(dir, "$id.user.js").delete(); File(dir, "$id.disabled").delete()
        scripts.remove(id)
    }

    fun setEnabled(id: String, on: Boolean) {
        scripts[id]?.enabled = on
        val f = File(dir, "$id.disabled")
        if (on) f.delete() else f.writeText("")
    }

    fun matchesFor(url: String, topFrame: Boolean): List<Script> = scripts.values.filter { s ->
        if (!s.enabled || (!topFrame && s.meta.noframes)) return@filter false
        val pats = s.meta.match + s.meta.include
        pats.any { patternRe(it).matches(url) } && s.meta.exclude.none { patternRe(it).matches(url) }
    }

    fun patternRe(p: String): Regex {
        val s = p.trim()
        if (s == "<all_urls>" || s == "*") return Regex("^https?://.+")
        val m = Regex("^(\\*|https?|file|ftp)://([^/]*)(/.*)?$", RegexOption.IGNORE_CASE).find(s)
        if (m != null) {
            val scheme = if (m.groupValues[1] == "*") "https?" else Regex.escape(m.groupValues[1])
            val host = m.groupValues[2].lowercase()
            val hostRe = when {
                host == "*" -> "[^/]+"
                host.startsWith("*.") -> "([^/]+\\.)?" + Regex.escape(host.substring(2))
                else -> Regex.escape(host).replace("\\*", "[^/]*")
            }
            val pathRe = (m.groupValues[3].ifEmpty { "/" })
                .let { Regex.escape(it).replace("\\*", ".*") }
            return Regex("^$scheme://$hostRe$pathRe$", RegexOption.IGNORE_CASE)
        }
        return Regex("^" + Regex.escape(s).replace("\\*", ".*") + "$", RegexOption.IGNORE_CASE)
    }

    /** Page-world GM bridge; page posts to window.__hzgm (JavascriptInterface). */
    fun bridgeJs(sid: String): String = """
(function(){
'use strict';
if (!window.__hzgm) return;
const pending=new Map();let seq=0;
const call=(op,args)=>new Promise((res,rej)=>{const id='g'+(++seq);pending.set(id,{res,rej});
 window.__hzgm.gmCall(${sid.js()},id,op,JSON.stringify(args));});
window.__hz_gm_reply=(id,val,err)=>{const p=pending.get(id);if(!p)return;pending.delete(id);err?p.rej(new Error(err)):p.res(val);};
const api={
 GM_info:{script:{},scriptHandler:'Haizhu',version:'1.0.0'},
 GM_getValue:(k,d)=>call('getValue',[k,d]),
 GM_setValue:(k,v)=>call('setValue',[k,v]),
 GM_deleteValue:k=>call('deleteValue',[k]),
 GM_listValues:()=>call('listValues',[]),
 GM_addStyle:c=>call('addStyle',[c]),
 GM_openInTab:(u,o)=>call('openInTab',[u,o]),
 GM_xmlhttpRequest:d=>call('xhr',[d]).then(r=>{['onload','onerror','ontimeout','onreadystatechange'].forEach(k=>{try{d[k]&&d[k](r)}catch(e){}});return r}),
 GM_download:(a,b)=>call('download',[a,b]),
 GM_notification:(a,b)=>call('notification',[a,b]),
 GM_setClipboard:v=>call('setClipboard',[v]),
 GM_getResourceText:n=>call('resourceText',[n]),
 GM_getResourceURL:n=>call('resourceURL',[n]),
 unsafeWindow:window
};
window['__hz_gm_api_'+${sid.js()}]=api;
try{Object.assign(window,api)}catch(e){}
})();
""".trimIndent()

    fun wrap(s: Script): String = """
/* ==Haizhu injected: ${s.meta.name} v${s.meta.version}== */
(function(){
const __gm = window['__hz_gm_api_' + ${s.id.js()}] || {};
const GM_info = { script: ${JSONObject().apply {
            put("name", s.meta.name); put("namespace", s.meta.namespace); put("version", s.meta.version)
        }}, scriptHandler: 'Haizhu', version: '1.0.0' };
const { ${s.meta.grant.filter { it.startsWith("GM_") }.joinToString(",")} } = __gm;
const unsafeWindow = window;
try {
${s.code}
} catch(e){ console.error('[userscript ${s.meta.name}]', e); }
})();
""".trimIndent()

    /** GM ops executed on the app side. Returns JSON-able result. */
    fun execOp(sid: String, op: String, argsJson: String, webView: WebView?, onOpenTab: (String) -> Unit): Any? {
        val args = JSONArray(argsJson)
        fun arg(i: Int): Any? = if (i < args.length()) args.get(i) else null
        val store = values.optJSONObject(sid) ?: JSONObject().also { values.put(sid, it); saveValues() }
        return when (op) {
            "getValue" -> if (store.has(arg(0) as String)) store.get(arg(0) as String) else arg(1)
            "setValue" -> { store.put(arg(0) as String, arg(1)); saveValues(); true }
            "deleteValue" -> { store.remove(arg(0) as String); saveValues(); true }
            "listValues" -> store.keys().asSequence().toList()
            "openInTab" -> { onOpenTab(arg(0) as String); true }
            "setClipboard" -> {
                val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                cm.setPrimaryClip(android.content.ClipData.newPlainText("hz", arg(0)?.toString() ?: "")); true
            }
            "addStyle" -> { webView?.evaluateJavascript(
                "(function(){const s=document.createElement('style');s.textContent=${(arg(0) as String).js()};document.head.appendChild(s);})()", null); true }
            "xhr" -> {
                val d = JSONObject(args.getJSONObject(0).toString())
                val req = okhttp3.Request.Builder().url(d.optString("url"))
                    .method(d.optString("method", "GET"), d.optString("data").takeIf { it.isNotEmpty() }
                        ?.let { okhttp3.RequestBody.create(null, it) }).build()
                val r = Net.client.newCall(req).execute()
                JSONObject().apply {
                    put("status", r.code); put("statusText", r.message)
                    put("responseText", r.body?.string()?.take(200000) ?: "")
                    put("readyState", 4); put("finalUrl", r.request.url.toString())
                }
            }
            else -> "unsupported:$op"
        }
    }

    private fun saveValues() {
        ctx.getSharedPreferences("gm_values", 0).edit().putString("data", values.toString()).apply()
    }

    private fun String.js() = "'" + replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n") + "'"

    class Bridge(private val engine: UserscriptEngine, private val webView: WebView,
                 private val onOpenTab: (String) -> Unit) {
        @JavascriptInterface
        fun gmCall(sid: String, id: String, op: String, argsJson: String) {
            Thread {
                val result = runCatching { engine.execOp(sid, op, argsJson, webView, onOpenTab) }
                val js = result.fold(
                    onSuccess = { "window.__hz_gm_reply(${id.js()},${JSONObject.quote(it?.toString() ?: "null")},null)" },
                    onFailure = { "window.__hz_gm_reply(${id.js()},null,${JSONObject.quote(it.message ?: "err")})" })
                webView.post { webView.evaluateJavascript(js, null) }
            }.start()
        }
        private fun String.js() = "'" + this + "'"
    }
}

/** Shared OkHttp client honoring current proxy settings. */
object Net {
    var proxy: java.net.Proxy? = null
    val client: okhttp3.OkHttpClient
        get() = (proxy?.let { okhttp3.OkHttpClient.Builder().proxy(it).build() }
            ?: okhttp3.OkHttpClient.Builder().build())
}
