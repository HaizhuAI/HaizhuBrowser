package com.haizhu.browser

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Resource sniffer + capture log + m3u8 downloader.
 * Detection rules mirror the desktop engine (MEDIA_EXT).
 */
object Sniffer {
    private val MEDIA_EXT = Regex("\\.(m3u8|mpd|mp4|webm|mkv|flv|ts|m4s|mp3|m4a|aac|ogg|wav|avi|mov)(\\?|$|/)", RegexOption.IGNORE_CASE)
    private val MEDIA_PARAM = Regex("(?:^|[?&/])(?:format|type|ext|ftype|file(?:type)?|container|mime)=(\"?)(mp4|m4v|webm|mkv|mov|3gp|avi|flv|f4v|m3u8|m3u|hls|mpd|ts|mpeg|mpg)", RegexOption.IGNORE_CASE)

    data class Hit(val url: String, val type: String, val ts: Long, val mime: String = "", val size: Long = 0)
    data class Req(val url: String, val method: String, val ts: Long, var status: Int = 0, var mime: String = "", var size: Long = 0)

    val hits = CopyOnWriteArrayList<Hit>()
    val requests = CopyOnWriteArrayList<Req>()
    var listener: ((Hit) -> Unit)? = null

    fun check(url: String, mime: String? = null, size: Long = 0) {
        val hit = when {
            MEDIA_EXT.containsMatchIn(url) -> Hit(url, kindOf(url), System.currentTimeMillis(), mime ?: "", size)
            mime != null && Regex("mpegurl|mp2t|dash|video/|audio/").containsMatchIn(mime) -> Hit(url, kindOf(url), System.currentTimeMillis(), mime, size)
            MEDIA_PARAM.containsMatchIn(url) -> Hit(url, kindOf(url), System.currentTimeMillis(), mime ?: "", size)
            else -> null
        } ?: return
        if (hits.none { it.url == hit.url }) { hits.add(0, hit); listener?.invoke(hit) }
        if (hits.size > 500) hits.removeLast()
    }

    fun log(req: Req) { requests.add(req); if (requests.size > 2000) requests.removeAt(0) }
    fun clear() { hits.clear(); requests.clear() }

    fun kindOf(url: String): String {
        val m = Regex("\\.([a-z0-9]{2,5})(\\?|$|/)", RegexOption.IGNORE_CASE).find(url) ?: return "media"
        return when (m.groupValues[1].lowercase()) {
            "m3u8" -> "hls"; "mpd" -> "dash"
            "mp4", "webm", "mkv", "flv", "avi", "mov" -> "video"
            "mp3", "m4a", "aac", "ogg", "wav" -> "audio"
            "ts", "m4s" -> "segment"
            else -> m.groupValues[1].lowercase()
        }
    }
}

class M3u8Downloader(private val ctx: Context) {
    data class Job(val id: String, val url: String, val name: String,
                   var status: String = "running", var total: Int = 0, var done: Int = 0,
                   var file: String? = null, var error: String? = null)
    val jobs = ConcurrentHashMap<String, Job>()

    fun download(url: String, name: String, onUpdate: (Job) -> Unit): Job {
        val job = Job(id = java.util.UUID.randomUUID().toString().take(8), url = url, name = name)
        jobs[job.id] = job
        Thread { runCatching { run(job, onUpdate) }.onFailure { job.status = "error"; job.error = it.message; onUpdate(job) } }.start()
        return job
    }

    private fun run(job: Job, onUpdate: (Job) -> Unit) {
        val outDir = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "media").apply { mkdirs() }
        var playlistUrl = job.url
        var text = Net.client.newCall(okhttp3.Request.Builder().url(playlistUrl).build()).execute().body?.string()
            ?: throw IllegalStateException("playlist fetch failed")
        // master playlist -> highest bandwidth variant
        if (text.contains("EXT-X-STREAM-INF")) {
            val lines = text.lines()
            var best: String? = null; var bw = -1
            lines.forEachIndexed { i, l ->
                Regex("BANDWIDTH=(\\d+)").find(l)?.let { m ->
                    if (i + 1 < lines.size && !lines[i + 1].startsWith("#")) {
                        val b = m.groupValues[1].toInt(); if (b > bw) { bw = b; best = URL(URL(playlistUrl), lines[i + 1].trim()).toString() }
                    }
                }
            }
            best?.let { playlistUrl = it; text = Net.client.newCall(okhttp3.Request.Builder().url(it).build()).execute().body?.string() ?: "" }
        }
        val base = playlistUrl.substringBeforeLast('/') + "/"
        val segs = text.lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }
            .map { URL(URL(base), it).toString() }
        if (segs.isEmpty()) throw IllegalStateException("no segments")
        job.total = segs.size
        val file = File(outDir, job.name.replace(Regex("[^\\w\\-.\\u4e00-\\u9fff]+"), "_") + ".ts")
        val out = file.outputStream().buffered()
        segs.forEachIndexed { i, u ->
            val r = Net.client.newCall(okhttp3.Request.Builder().url(u).build()).execute()
            if (!r.isSuccessful) throw IllegalStateException("seg $i HTTP ${r.code}")
            out.write(r.body!!.bytes()); job.done = i + 1; onUpdate(job)
        }
        out.close()
        job.status = "done"; job.file = file.absolutePath; onUpdate(job)
    }
}
