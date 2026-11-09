package com.haizhu.browser

import android.content.Context
import java.io.File
import java.net.URL

/**
 * EasyList-subset blocker — same grammar as the desktop engine:
 * ||domain^ anchors, |url^ anchors, @@ exceptions, $type modifiers.
 */
class Adblock(private val ctx: Context) {
    private val dir = File(ctx.filesDir, "adblock").apply { mkdirs() }
    var enabled = true
    var blocked = 0

    private data class Rule(val re: Regex, val exception: Boolean, val types: Set<String>?, val domains: Set<String>?)
    private val rules = mutableListOf<Rule>()

    private val lists = mapOf(
        "easylist" to "https://easylist.to/easylist/easylist.txt",
        "easyprivacy" to "https://easylist.to/easylist/easyprivacy.txt",
        "easylistchina" to "https://easylist-downloads.adblockplus.org/easylistchina.txt"
    )

    fun ensureListsAsync() {
        Thread {
            lists.forEach { (name, url) ->
                val f = File(dir, "$name.txt")
                try {
                    if (!f.exists() || System.currentTimeMillis() - f.lastModified() > 7 * 86400_000L) {
                        val r = Net.client.newCall(okhttp3.Request.Builder().url(url).build()).execute()
                        if (r.isSuccessful) f.writeText(r.body!!.string())
                    }
                } catch (_: Exception) {}
            }
            compile()
        }.start()
    }

    fun compile() {
        rules.clear()
        dir.listFiles { f -> f.name.endsWith(".txt") }?.forEach { f ->
            f.forEachLine { line -> addRule(line.trim()) }
        }
    }

    fun addRule(raw: String) {
        var line = raw
        if (line.isEmpty() || line.startsWith("!") || line.startsWith("[") || line.contains("##") || line.contains("#@#")) return
        var exception = false
        if (line.startsWith("@@")) { exception = true; line = line.substring(2) }
        var types: MutableSet<String>? = null
        var domains: MutableSet<String>? = null
        val di = line.indexOf('$')
        if (di >= 0) {
            val opts = line.substring(di + 1).split(',')
            line = line.substring(0, di)
            types = mutableSetOf()
            opts.forEach { o ->
                val kv = o.split('=', limit = 2)
                if (kv[0] == "domain" && kv.size == 2) domains = kv[1].split('|').map { it.lowercase() }.toMutableSet()
                else if (kv[0] in setOf("script","image","stylesheet","xmlhttprequest","subdocument","media","font","other","websocket","third-party")) types.add(kv[0])
            }
            if (types.isEmpty()) types = null
        }
        val re = try {
            when {
                line.startsWith("||") -> {
                    val host = line.substring(2).substringBefore('^')
                    Regex("^[a-z]+://([^/]*\\.)?" + Regex.escape(host) + "(/|\\?|:|$)", RegexOption.IGNORE_CASE)
                }
                line.startsWith("|") -> Regex("^" + globRe(line.substring(1).removeSuffix("^")), RegexOption.IGNORE_CASE)
                line.endsWith("|") -> Regex(globRe(line.dropLast(1)) + "$", RegexOption.IGNORE_CASE)
                else -> Regex(globRe(line).replace("\\^", "[^\\w\\-_.%]"), RegexOption.IGNORE_CASE)
            }
        } catch (_: Exception) { return }
        rules.add(Rule(re, exception, types?.toSet(), domains?.toSet()))
    }

    private fun globRe(s: String): String {
        val sb = StringBuilder()
        s.forEach { c -> if (c == '*') sb.append(".*") else sb.append(Regex.escape(c.toString())) }
        return sb.toString()
    }

    fun test(url: String, resType: String, pageHost: String?): Boolean {
        if (!enabled) return false
        var blocked = false
        for (r in rules) {
            if (r.types != null && resType !in r.types) continue
            if (r.domains != null) {
                if (pageHost == null || r.domains.none { pageHost == it || pageHost.endsWith(".$it") }) continue
            }
            if (!r.re.containsMatchIn(url)) continue
            if (r.exception) return false
            blocked = true
        }
        if (blocked) this.blocked++
        return blocked
    }
}
