package com.haizhu.browser

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.*
import android.widget.*
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.URL

/**
 * Haizhu Browser for Android — system-WebView browser mirroring the desktop
 * feature set: packet capture log, resource sniffer + m3u8 grab, userscripts,
 * proxy profiles, fingerprint spoofing, adblock, Duck.ai + custom API agent.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var omni: EditText
    private lateinit var tabStrip: LinearLayout
    private lateinit var webContainer: FrameLayout
    private lateinit var panel: LinearLayout
    private lateinit var panelTabs: LinearLayout
    private lateinit var panelBody: LinearLayout
    private lateinit var aiBar: LinearLayout
    private lateinit var aiInput: EditText

    private val tabs = mutableListOf<HzTab>()
    private var active: HzTab? = null

    private lateinit var scripts: UserscriptEngine
    private lateinit var adblock: Adblock
    private lateinit var proxyMgr: ProxyMgr
    private lateinit var m3u8: M3u8Downloader
    private val captureOn = java.util.concurrent.atomic.AtomicBoolean(false)
    private var incogNext = 0

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    inner class HzTab(val incognito: Boolean = false) {
        val id = System.identityHashCode(this)
        val webView = WebView(this@MainActivity)
        var title = "New Tab"
        var url = "about:blank"

        init {
            webView.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                loadWithOverviewMode = true
                useWideViewPort = true
                builtInZoomControls = true
                displayZoomControls = false
            }
            webView.addJavascriptInterface(
                UserscriptEngine.Bridge(scripts, webView) { u -> openTab(u, true) }, "__hzgm")
            // fingerprint persona bridge — callable synchronously at true
            // document-start; returns "" while spoofing is off
            webView.addJavascriptInterface(object {
                @JavascriptInterface
                fun config(host: String): String = Fingerprint.configJson(host) ?: ""
            }, "__hzBoot")
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                WebViewCompat.addDocumentStartJavaScript(webView, Fingerprint.BOOT_JS, setOf("*"))
            }
            webView.webViewClient = HzClient(this)
            webView.webChromeClient = HzChrome(this)
            webView.setDownloadListener { url, ua, cd, mime, _ ->
                Sniffer.check(url, mime)
                try { startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))) } catch (_: Exception) {}
            }
        }
    }

    inner class HzClient(private val tab: HzTab) : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
            val url = req.url.toString()
            val host = runCatching { URL(view.url ?: url).host }.getOrNull()
            // adblock
            if (adblock.test(url, resTypeOf(req), host)) {
                return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
            }
            // sniff + capture log (headers/size filled on response — WebView gives us request only)
            Sniffer.check(url)
            if (captureOn.get()) Sniffer.log(Sniffer.Req(url, req.method, System.currentTimeMillis()))
            if (url.endsWith(".user.js")) {
                Thread {
                    runCatching {
                        val code = Net.client.newCall(okhttp3.Request.Builder().url(url).build()).execute().body!!.string()
                        scripts.install(code)
                        runOnUiThread { toast("Userscript installed"); showScripts() }
                    }
                }.start()
                // suppress the raw download/navigation — install is handled
                return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
            }
            return null
        }
        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            tab.url = url; refreshTabs()
            // fingerprint bootstrap + userscript GM bridge at document-start
            Fingerprint.bootstrap(hostOf(url))?.let { view.evaluateJavascript(it, null) }
            scripts.matchesFor(url, true).forEach { s ->
                view.evaluateJavascript(scripts.bridgeJs(s.id), null)
            }
        }
        override fun onPageFinished(view: WebView, url: String) {
            tab.url = url; tab.title = view.title ?: url; refreshTabs()
            scripts.matchesFor(url, true).forEach { s -> view.evaluateJavascript(scripts.wrap(s), null) }
        }
        override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
            val u = req.url.toString()
            return if (u.startsWith("intent://") || u.startsWith("market://")) {
                try { startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, req.url)) } catch (_: Exception) {}
                true
            } else false
        }
    }

    inner class HzChrome(private val tab: HzTab) : WebChromeClient() {
        override fun onReceivedTitle(view: WebView, title: String) { tab.title = title; refreshTabs() }
        override fun onCreateWindow(view: WebView, dialog: Boolean, userGesture: Boolean, resultMsg: android.os.Message): Boolean {
            val t = openTab("about:blank", true)
            (resultMsg.obj as WebView.WebViewTransport).webView = t.webView
            resultMsg.sendToTarget()
            return true
        }
        override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean = false
    }

    private fun resTypeOf(req: WebResourceRequest): String {
        val p = req.url.path ?: ""
        return when {
            p.endsWith(".js") -> "script"; p.endsWith(".css") -> "stylesheet"
            Regex("\\.(png|jpe?g|gif|webp|svg|ico)(\\?|$)").containsMatchIn(p) -> "image"
            Regex("\\.(mp4|webm|m3u8|ts|mp3|m4a)(\\?|$)").containsMatchIn(p) -> "media"
            req.isForMainFrame -> "maindocument"
            else -> "xmlhttprequest"
        }
    }

    private fun hostOf(u: String) = runCatching { URL(u).host }.getOrDefault("x")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        omni = findViewById(R.id.omnibox); tabStrip = findViewById(R.id.tabStrip)
        webContainer = findViewById(R.id.webContainer); panel = findViewById(R.id.panel)
        panelTabs = findViewById(R.id.panelTabs); panelBody = findViewById(R.id.panelBody)
        aiBar = findViewById(R.id.aiBar); aiInput = findViewById(R.id.aiInput)

        scripts = UserscriptEngine(this)
        adblock = Adblock(this).also { it.ensureListsAsync() }
        proxyMgr = ProxyMgr(this)
        m3u8 = M3u8Downloader(this)
        AiClient.loadEndpoints(this)
        proxyMgr.apply()
        AiClient.activeProvider = "duck"

        findViewById<ImageButton>(R.id.bBack).setOnClickListener { active?.webView?.goBack() }
        findViewById<ImageButton>(R.id.bFwd).setOnClickListener { active?.webView?.goForward() }
        findViewById<ImageButton>(R.id.bReload).setOnClickListener { active?.webView?.reload() }
        findViewById<TextView>(R.id.tTabs).setOnClickListener { cycleTab() }
        findViewById<ImageButton>(R.id.bMenu).setOnClickListener { showMenu() }
        findViewById<Button>(R.id.aiSend).setOnClickListener { aiSend(false) }
        findViewById<Button>(R.id.aiAgent).setOnClickListener { aiSend(true) }

        omni.setOnEditorActionListener { _, act, _ ->
            if (act == EditorInfo.IME_ACTION_GO) { navigate(omni.text.toString()); true } else false
        }
        intent?.data?.let { openTab(it.toString(), true) } ?: openTab("https://duckduckgo.com", true)
    }

    fun openTab(url: String, activate: Boolean = true, incognito: Boolean = false): HzTab {
        val t = HzTab(incognito)
        tabs.add(t)
        webContainer.addView(t.webView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        if (activate) activateTab(t)
        if (url != "about:blank") t.webView.loadUrl(normalize(url))
        refreshTabs()
        return t
    }

    private fun activateTab(t: HzTab) {
        tabs.forEach { it.webView.visibility = if (it == t) View.VISIBLE else View.GONE }
        // CookieManager is a process-wide singleton — an incognito tab only
        // suppresses cookies while it is the foreground tab; normal tabs get
        // cookies back the moment they are active again.
        CookieManager.getInstance().setAcceptCookie(!t.incognito)
        active = t
        omni.setText(if (t.url == "about:blank") "" else t.url)
        refreshTabs()
    }

    private fun closeTab(t: HzTab) {
        webContainer.removeView(t.webView); t.webView.destroy(); tabs.remove(t)
        if (active == t) tabs.lastOrNull()?.let { activateTab(it) } ?: openTab("about:blank", true)
        refreshTabs()
    }

    private fun cycleTab() {
        if (tabs.size < 2) return
        val i = tabs.indexOf(active)
        activateTab(tabs[(i + 1) % tabs.size])
    }

    private fun refreshTabs() {
        findViewById<TextView>(R.id.tTabs).text = tabs.size.toString()
        tabStrip.removeAllViews()
        tabs.forEach { t ->
            val v = TextView(this).apply {
                text = (if (t.incognito) "⬤ " else "") + t.title.take(18)
                setTextColor(if (t == active) 0xFF58a6ff.toInt() else 0xFF8b949e.toInt())
                textSize = 12f; setPadding(14, 0, 14, 0)
                setOnClickListener { activateTab(t) }
                setOnLongClickListener { closeTab(t); true }
            }
            tabStrip.addView(v)
        }
    }

    private fun normalize(s: String): String {
        val t = s.trim()
        return when {
            Regex("^[a-z]+://", RegexOption.IGNORE_CASE).containsMatchIn(t) -> t
            t == "localhost" || t.startsWith("localhost:") -> "http://$t"
            Regex("^[\\w-]+(\\.[\\w-]+)+(:\\d+)?(/.*)?$").matches(t) -> "https://$t"
            else -> "https://duckduckgo.com/?q=" + java.net.URLEncoder.encode(t, "utf-8")
        }
    }

    private fun navigate(s: String) { active?.webView?.loadUrl(normalize(s)) }

    private fun toast(m: String) = Toast.makeText(this, m, Toast.LENGTH_SHORT).show()

    /** WebView does not implement the view-source: scheme — fetch the page
     *  through the OkHttp stack and show it in a monospace dialog instead. */
    private fun showSource(u: String) {
        val tv = TextView(this).apply {
            typeface = android.graphics.Typeface.MONOSPACE; textSize = 10f
            setTextIsSelectable(true); setPadding(24, 16, 24, 16)
            setTextColor(0xFFe6edf3.toInt())
        }
        AlertDialog.Builder(this).setTitle("view-source:$u")
            .setView(ScrollView(this).apply { addView(tv) })
            .setNegativeButton("Close", null).show()
        tv.text = "loading…"
        Thread {
            val src = runCatching {
                Net.client.newCall(okhttp3.Request.Builder().url(u).build()).execute().body!!.string()
            }.getOrElse { "error: ${it.message}" }
            runOnUiThread { tv.text = src }
        }.start()
    }

    private fun showMenu() {
        val items = arrayOf(
            "New tab", "New anonymous tab", "Dev panel",
            "Toggle capture (${if (captureOn.get()) "on" else "off"})",
            "Fingerprint: ${if (Fingerprint.enabled) "on" else "off"} / rotate",
            "Proxy: ${proxyMgr.active().name}",
            "AdBlock: ${if (adblock.enabled) "on" else "off"} (${adblock.blocked} blocked)",
            "Clear site data", "View source")
        AlertDialog.Builder(this).setItems(items) { _, i ->
            when (i) {
                0 -> openTab("about:blank", true)
                1 -> openTab("about:blank", true, incognito = true)
                2 -> togglePanel()
                3 -> { captureOn.set(!captureOn.get()); toast("capture ${if (captureOn.get()) "on" else "off"}") }
                4 -> {
                    Fingerprint.enabled = !Fingerprint.enabled
                    if (Fingerprint.enabled) Fingerprint.rotate()
                    toast("fingerprint ${if (Fingerprint.enabled) "on" else "off"}")
                }
                5 -> showPanel("proxy")
                6 -> { adblock.enabled = !adblock.enabled; toast("adblock ${if (adblock.enabled) "on" else "off"}") }
                7 -> { active?.webView?.clearCache(true); CookieManager.getInstance().removeAllCookies(null); toast("cleared") }
                8 -> active?.let { showSource(it.url) }
            }
        }.show()
    }

    // ---------------- panel ----------------
    private val panelPages = listOf("capture", "resources", "cookies", "scripts", "proxy", "fingerprint", "ai")
    private fun togglePanel() {
        panel.visibility = if (panel.visibility == View.VISIBLE) View.GONE else {
            buildPanelTabs(); showPanel("capture"); View.VISIBLE
        }
    }
    private fun buildPanelTabs() {
        panelTabs.removeAllViews()
        panelPages.forEach { p ->
            val tv = TextView(this).apply {
                text = p.uppercase(); setPadding(18, 0, 18, 0); textSize = 12f
                setTextColor(0xFF58a6ff.toInt())
                setOnClickListener { showPanel(p) }
            }
            panelTabs.addView(tv)
        }
    }
    private fun showPanel(page: String) {
        aiBar.visibility = if (page == "ai") View.VISIBLE else View.GONE
        when (page) {
            "capture" -> showCapture()
            "resources" -> showResources()
            "cookies" -> showCookies()
            "scripts" -> showScripts()
            "proxy" -> showProxy()
            "fingerprint" -> showFingerprint()
            "ai" -> panelBody.removeAllViews().also { aiScroll?.let { panelBody.addView(it) } ?: initAiLog() }
        }
    }

    private fun row(vararg views: View) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        views.forEach { addView(it) }
    }
    private fun label(text: String, mono: Boolean = true): TextView = TextView(this).apply {
        this.text = text; setTextColor(0xFFe6edf3.toInt()); textSize = 11.5f
        if (mono) typeface = android.graphics.Typeface.MONOSPACE
        setPadding(0, 4, 0, 4)
    }
    private fun btn(text: String, fn: () -> Unit) = Button(this).apply { this.text = text; setOnClickListener { fn() } }

    private fun showCapture() {
        panelBody.removeAllViews()
        panelBody.addView(row(btn("Clear") { Sniffer.requests.clear(); showCapture() }))
        Sniffer.requests.takeLast(300).reversed().forEach { r ->
            panelBody.addView(label("${r.method} ${r.url.take(160)}\n  → ${r.status} ${r.mime} ${(r.size / 1024)}k"))
        }
    }

    private fun showResources() {
        panelBody.removeAllViews()
        panelBody.addView(row(btn("Clear") { Sniffer.hits.clear(); showResources() }))
        Sniffer.hits.forEach { h ->
            panelBody.addView(label("[${h.type}] ${h.url.take(160)}"))
            panelBody.addView(row(
                btn("Grab") { m3u8.download(h.url, "video") { runOnUiThread { showResources() } } },
                btn("Open") { active?.webView?.loadUrl(h.url) }
            ))
        }
        panelBody.addView(label("\n— Downloads —"))
        m3u8.jobs.values.forEach { j ->
            panelBody.addView(label("${j.status} ${j.name} ${j.done}/${j.total} ${j.file ?: j.error ?: ""}"))
        }
    }

    private fun showCookies() {
        panelBody.removeAllViews()
        val cm = CookieManager.getInstance()
        val u = active?.url ?: return
        val raw = cm.getCookie(u) ?: ""
        panelBody.addView(label("Cookies for ${hostOf(u)}:"))
        raw.split(";").forEach { panelBody.addView(label(it.trim())) }
        panelBody.addView(row(btn("Clear all cookies") { cm.removeAllCookies { runOnUiThread { showCookies() } } }))
    }

    private fun showScripts() {
        panelBody.removeAllViews()
        panelBody.addView(row(btn("Install from URL") {
            val et = EditText(this); et.hint = "https://.../script.user.js"
            AlertDialog.Builder(this).setTitle("Install userscript").setView(et)
                .setPositiveButton("OK") { _, _ ->
                    Thread {
                        runCatching {
                            val code = Net.client.newCall(okhttp3.Request.Builder().url(et.text.toString()).build()).execute().body!!.string()
                            scripts.install(code)
                        }
                        runOnUiThread { showScripts() }
                    }.start()
                }.setNegativeButton("Cancel", null).show()
        }, btn("Reload") { scripts.loadAll(); showScripts() }))
        scripts.scripts.values.forEach { s ->
            panelBody.addView(row(CheckBox(this).apply {
                isChecked = s.enabled; text = "${s.meta.name} v${s.meta.version}"
                setTextColor(0xFFe6edf3.toInt())
                setOnCheckedChangeListener { _, on -> scripts.setEnabled(s.id, on) }
            }, btn("Del") { scripts.remove(s.id); showScripts() }))
        }
    }

    private fun showProxy() {
        panelBody.removeAllViews()
        panelBody.addView(label("Active: ${proxyMgr.active().name} (${proxyMgr.active().mode})"))
        val modes = arrayOf("direct", "http", "socks5", "pac", "system")
        panelBody.addView(row(*modes.map { m -> btn(m) {
            proxyMgr.activeId = if (m in listOf("direct", "system")) m else {
                proxyMgr.profiles.find { it.mode == m }?.id ?: proxyMgr.profiles.firstOrNull()?.id ?: "direct"
            }
            proxyMgr.save(); proxyMgr.apply { runOnUiThread { showProxy() } }
        } }.toTypedArray()))
        panelBody.addView(label("\nAdd profile"))
        val host = EditText(this).apply { hint = "host" }
        val port = EditText(this).apply { hint = "port"; inputType = android.text.InputType.TYPE_CLASS_NUMBER }
        val mode = Spinner(this).apply { adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, arrayOf("http", "socks5", "socks4")) }
        val user = EditText(this).apply { hint = "user (opt)" }
        val pass = EditText(this).apply { hint = "pass (opt)" }
        panelBody.addView(row(host, port)); panelBody.addView(row(mode, user, pass))
        panelBody.addView(btn("Add") {
            val p = ProxyMgr.Profile("p" + System.currentTimeMillis().toString(36),
                "${host.text}:${port.text}", mode.selectedItem as String,
                host.text.toString(), port.text.toString().toIntOrNull() ?: 0,
                user.text.toString(), pass.text.toString())
            proxyMgr.profiles.add(p); proxyMgr.save(); showProxy()
        })
        proxyMgr.profiles.forEach { p ->
            panelBody.addView(row(label("${p.mode} ${p.host}:${p.port}"), btn("Del") {
                proxyMgr.profiles.remove(p); proxyMgr.save(); showProxy()
            }))
        }
    }

    private fun showFingerprint() {
        panelBody.removeAllViews()
        panelBody.addView(row(CheckBox(this).apply {
            isChecked = Fingerprint.enabled; text = "Enable spoofing"
            setTextColor(0xFFe6edf3.toInt())
            setOnCheckedChangeListener { _, on -> Fingerprint.enabled = on }
        }, btn("Rotate") { Fingerprint.rotate(); toast("persona rotated") }))
        panelBody.addView(label("Mode:"))
        panelBody.addView(row(btn("per-session") { Fingerprint.mode = "per-session"; toast("per-session") },
            btn("per-domain") { Fingerprint.mode = "per-domain"; toast("per-domain") }))
        panelBody.addView(label("\nSpoofs: navigator.*, screen, canvas, WebGL, audio, timezone"))
    }

    // ---------------- AI ----------------
    private var aiScroll: ScrollView? = null
    private var aiLogView: LinearLayout? = null
    private val aiHistory = JSONArray()
    private fun initAiLog() {
        aiScroll = ScrollView(this)
        aiLogView = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        aiScroll!!.addView(aiLogView)
        panelBody.removeAllViews(); panelBody.addView(aiScroll)
        aiMsg("ai", "Haizhu Agent ready. duck.ai built-in; add OpenAI-compatible endpoints via menu in a later build — agent can read cookies/captures/DOM and automate the page.")
    }
    private fun aiMsg(kind: String, text: String) {
        val tv = label(if (kind == "tool") "▶ $text" else text, mono = kind == "tool")
        tv.setTextColor(when (kind) { "user" -> 0xFF58a6ff.toInt(); "tool" -> 0xFFd29922.toInt(); else -> 0xFFe6edf3.toInt() })
        aiLogView?.addView(tv)
        aiScroll?.post { aiScroll?.fullScroll(View.FOCUS_DOWN) }
    }

    private fun aiSend(agent: Boolean) {
        val text = aiInput.text.toString().trim(); if (text.isEmpty()) return
        aiInput.setText(""); aiMsg("user", text)
        Thread {
            try {
                if (!agent) {
                    aiHistory.put(JSONObject().put("role", "user").put("content", text))
                    val reply = AiClient.chat(aiHistory, null)
                    aiHistory.put(JSONObject().put("role", "assistant").put("content", reply))
                    runOnUiThread { aiMsg("ai", reply) }
                } else agentLoop(text)
            } catch (e: Exception) { runOnUiThread { aiMsg("ai", "error: ${e.message}") } }
        }.start()
    }

    /** Agent tool loop — same tool names as desktop. */
    private fun jsEval(code: String): String {
        val v = active?.webView ?: return "no tab"
        val latch = java.util.concurrent.CountDownLatch(1)
        val out = arrayOf("null")
        v.post { v.evaluateJavascript("(function(){$code})()") { r -> out[0] = r ?: "null"; latch.countDown() } }
        latch.await(10, java.util.concurrent.TimeUnit.SECONDS)
        return out[0]
    }

    private fun agentLoop(userMsg: String) {
        val sys = "You are Haizhu Agent embedded in an Android developer browser. " +
            "Call tools as JSON lines: {\"tool\":\"name\",\"args\":{...}}. " +
            "Tools: navigate{url}, get_url{}, list_cookies{url}, network_log{filter}, resources{}, " +
            "run_js{code}, page_text{}, dom_query{selector}, click{selector}, fill{selector,value}, screenshot{}. " +
            "When done, answer plainly."
        val msgs = JSONArray().put(JSONObject().put("role", "system").put("content", sys))
            .put(JSONObject().put("role", "user").put("content", userMsg))
        val toolRe = Regex("\\{\"tool\":\\s*\"([^\"]+)\",\\s*\"args\":\\s*(\\{[\\s\\S]*?\\})\\}")
        repeat(8) {
            val reply = AiClient.chat(msgs, null)
            val calls = toolRe.findAll(reply).toList()
            if (calls.isEmpty()) { runOnUiThread { aiMsg("ai", reply) }; return }
            msgs.put(JSONObject().put("role", "assistant").put("content", reply))
            val results = StringBuilder()
            calls.forEach { m ->
                val name = m.groupValues[1]
                val args = runCatching { JSONObject(m.groupValues[2]) }.getOrElse { JSONObject() }
                runOnUiThread { aiMsg("tool", "$name $args") }
                val out = runTool(name, args)
                results.append("$name => $out\n---\n")
            }
            msgs.put(JSONObject().put("role", "user").put("content", "TOOL RESULTS:\n$results"))
        }
        runOnUiThread { aiMsg("ai", "(max iterations reached)") }
    }

    private fun runTool(name: String, a: JSONObject): String {
        val wv = active?.webView ?: return "no active tab"
        return try {
            when (name) {
                "navigate" -> { runOnUiThread { wv.loadUrl(normalize(a.getString("url"))) }; "navigated" }
                "get_url" -> JSONObject().put("url", active?.url).put("title", active?.title).toString()
                "list_cookies" -> CookieManager.getInstance().getCookie(a.optString("url", active?.url)) ?: ""
                "network_log" -> Sniffer.requests.takeLast(100)
                    .filter { a.optString("filter").isEmpty() || it.url.contains(a.getString("filter"), true) }
                    .joinToString("\n") { "${it.method} ${it.url} -> ${it.status}" }
                "resources" -> Sniffer.hits.take(50).joinToString("\n") { "[${it.type}] ${it.url}" }
                "run_js" -> jsEval(a.getString("code"))
                "page_text" -> jsEval("return document.body?document.body.innerText.slice(0,8000):''")
                "dom_query" -> jsEval("return JSON.stringify(Array.from(document.querySelectorAll(${JSONObject.quote(a.getString("selector"))})).slice(0,15).map(e=>({tag:e.tagName,text:(e.innerText||'').slice(0,80),href:e.href||null})))")
                "click" -> jsEval("const e=document.querySelector(${JSONObject.quote(a.getString("selector"))});if(!e)return 'not found';e.scrollIntoView({block:'center'});e.click();return 'clicked'")
                "fill" -> jsEval("const e=document.querySelector(${JSONObject.quote(a.getString("selector"))});if(!e)return 'not found';e.value=${JSONObject.quote(a.getString("value"))};e.dispatchEvent(new Event('input',{bubbles:true}));return 'filled'")
                "screenshot" -> {
                    val latch = java.util.concurrent.CountDownLatch(1)
                    val out = arrayOf("error")
                    runOnUiThread {
                        try {
                            val bmp = Bitmap.createBitmap(wv.width, wv.height, Bitmap.Config.ARGB_8888)
                            wv.draw(android.graphics.Canvas(bmp))
                            val f = java.io.File(getExternalFilesDir("shots") ?: filesDir,
                                "shot_${System.currentTimeMillis()}.png")
                            java.io.FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
                            out[0] = f.absolutePath
                        } catch (e: Exception) { out[0] = "error: ${e.message}" }
                        latch.countDown()
                    }
                    latch.await(10, java.util.concurrent.TimeUnit.SECONDS)
                    out[0]
                }
                else -> "unknown tool"
            }.toString()
        } catch (e: Exception) { "error: ${e.message}" }
    }

    override fun onBackPressed() {
        when {
            panel.visibility == View.VISIBLE -> panel.visibility = View.GONE
            active?.webView?.canGoBack() == true -> active?.webView?.goBack()
            else -> super.onBackPressed()
        }
    }

    override fun onNewIntent(intent: android.content.Intent?) {
        super.onNewIntent(intent)
        intent?.data?.let { openTab(it.toString(), true) }
    }
}
