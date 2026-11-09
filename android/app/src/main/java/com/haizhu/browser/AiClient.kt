package com.haizhu.browser

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/**
 * AI client — DuckDuckGo AI (duck.ai vqd handshake) + OpenAI-compatible
 * endpoints imported by the user. Agent tool loop handled by MainActivity.
 */
object AiClient {
    private var vqd: String? = null
    private const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    val DUCK_MODELS = listOf("gpt-4o-mini", "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo", "claude-3-haiku-20240307", "mistralai/Mixtral-8x7B-Instruct-v0.1", "o3-mini")

    data class Endpoint(val id: String, val name: String, val base: String, val key: String, val model: String)

    private var endpoints = mutableListOf<Endpoint>()
    var activeProvider = "duck" // or "ep:<id>"

    fun loadEndpoints(ctx: Context) {
        val prefs = ctx.getSharedPreferences("ai", 0)
        activeProvider = prefs.getString("active", "duck") ?: "duck"
        endpoints.clear()
        val arr = JSONArray(prefs.getString("endpoints", "[]") ?: "[]")
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            endpoints.add(Endpoint(o.getString("id"), o.getString("name"), o.getString("base"), o.getString("key"), o.getString("model")))
        }
    }
    fun saveEndpoints(ctx: Context) {
        val arr = JSONArray()
        endpoints.forEach { arr.put(JSONObject().apply { put("id", it.id); put("name", it.name); put("base", it.base); put("key", it.key); put("model", it.model) }) }
        ctx.getSharedPreferences("ai", 0).edit()
            .putString("endpoints", arr.toString()).putString("active", activeProvider).apply()
    }
    fun endpoints() = endpoints.toList()
    fun addEndpoint(ctx: Context, e: Endpoint) { endpoints.add(e); saveEndpoints(ctx) }

    private fun handshake() {
        val req = Request.Builder().url("https://duckduckgo.com/duckchat/v1/status")
            .header("x-vqd-accept", "1").header("User-Agent", UA).header("Referer", "https://duckduckgo.com/").build()
        val r = Net.client.newCall(req).execute()
        vqd = r.header("x-vqd-4") ?: r.header("x-vqd-hash-1")
        if (vqd == null) throw IllegalStateException("duck.ai handshake failed")
        r.close()
    }

    /** Blocking chat call — run on a worker thread. */
    fun chat(messages: JSONArray, model: String?): String {
        return if (activeProvider == "duck") duckChat(messages, model) else epChat(messages, model)
    }

    private fun duckChat(messages: JSONArray, model: String?): String {
        if (vqd == null) handshake()
        val body = JSONObject().put("model", model ?: "gpt-4o-mini").put("messages", messages)
        fun attempt(): okhttp3.Response {
            val req = Request.Builder().url("https://duckduckgo.com/duckchat/v1/chat")
                .header("content-type", "application/json").header("accept", "text/event-stream")
                .header("x-vqd-4", vqd!!).header("User-Agent", UA)
                .header("Referer", "https://duckduckgo.com/").header("Origin", "https://duckduckgo.com")
                .post(body.toString().toRequestBody("application/json".toMediaType())).build()
            return Net.client.newCall(req).execute()
        }
        var r = attempt()
        r.header("x-vqd-4")?.let { vqd = it }
        if (r.code == 429 || r.code == 418) { vqd = null; handshake(); r = attempt() }
        if (!r.isSuccessful) throw IllegalStateException("duck.ai HTTP ${r.code}")
        val text = r.body!!.string()
        val sb = StringBuilder()
        text.lines().forEach { l ->
            if (l.startsWith("data:")) {
                val d = l.removePrefix("data:").trim()
                if (d != "[DONE]") runCatching { sb.append(JSONObject(d).optString("message")) }
            }
        }
        return sb.toString()
    }

    private fun epChat(messages: JSONArray, model: String?): String {
        val ep = endpoints.find { "ep:" + it.id == activeProvider } ?: throw IllegalStateException("endpoint missing")
        val body = JSONObject().put("model", model ?: ep.model).put("messages", messages).put("stream", false)
        val req = Request.Builder().url(ep.base.trimEnd('/') + "/chat/completions")
            .header("content-type", "application/json").header("authorization", "Bearer " + ep.key)
            .post(body.toString().toRequestBody("application/json".toMediaType())).build()
        val r = Net.client.newCall(req).execute()
        if (!r.isSuccessful) throw IllegalStateException("${ep.name} HTTP ${r.code}: ${r.body?.string()?.take(200)}")
        return JSONObject(r.body!!.string()).getJSONArray("choices").getJSONObject(0)
            .getJSONObject("message").getString("content")
    }
}
