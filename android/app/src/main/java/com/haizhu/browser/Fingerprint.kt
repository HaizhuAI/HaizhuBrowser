package com.haizhu.browser

import java.security.MessageDigest
import kotlin.random.Random

/**
 * Fingerprint spoofing — same persona algorithm as the desktop build.
 * Mode "per-session" rotates on app restart; "per-domain" derives a stable
 * persona from the host hash.
 */
object Fingerprint {
    var enabled = false
    var mode = "per-session"
    private var sessionSeed = randomSeed()

    fun rotate() { sessionSeed = randomSeed() }
    private fun randomSeed() = ByteArray(16).also { Random.nextBytes(it) }.joinToString("") { "%02x".format(it) }

    private data class Persona(
        val ua: String, val platform: String, val vendor: String,
        val width: Int, val height: Int, val langs: List<String>,
        val cores: Int, val mem: Int, val gpu: String, val tz: Int,
        val noise: List<Int>, val canvasNoise: Double, val audioNoise: Double
    )

    private val UA = listOf(
        Triple("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "Win32", "Google Inc."),
        Triple("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "Linux x86_64", "Google Inc."),
        Triple("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "MacIntel", "Google Inc."),
        Triple("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0", "Win32", "")
    )
    private val SCR = listOf(1920 to 1080, 1536 to 864, 1366 to 768, 2560 to 1440, 1600 to 900)
    private val LANG = listOf(listOf("en-US", "en"), listOf("en-GB", "en"), listOf("zh-CN", "zh", "en"), listOf("ja-JP", "en"))
    private val GPU = listOf(
        "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        "WebKit WebGL"
    )

    private fun rngFor(seed: String): Sequence<Int> = sequence {
        var h = MessageDigest.getInstance("SHA-256").digest(seed.toByteArray())
        while (true) { for (b in h) yield(b.toInt() and 0xff); h = MessageDigest.getInstance("SHA-256").digest(h) }
    }

    private fun persona(seed: String): Persona {
        val rnd = rngFor(seed).iterator()
        fun <T> pick(l: List<T>): T = l[rnd.next() % l.size]
        val ua = pick(UA); val scr = pick(SCR); val langs = pick(LANG)
        val noise = (1..16).map { rnd.next() }
        return Persona(ua.first, ua.second, ua.third, scr.first, scr.second, langs,
            pick(listOf(4, 6, 8, 12)), pick(listOf(4, 8, 16)), pick(GPU),
            pick(listOf(0, -480, -300, 60, 120)), noise,
            0.001 + rnd.next() / 255.0 * 0.004, 0.0001 + rnd.next() / 255.0 * 0.0009)
    }

    /** JS evaluated at document-start in every frame. Returns null when disabled. */
    fun bootstrap(host: String): String? {
        if (!enabled) return null
        val seed = if (mode == "per-domain") host else sessionSeed
        val p = persona(seed)
        return """
(function(){
'use strict';
if (window.__hz_fp) return; window.__hz_fp = true;
const P = { ua:${p.ua.js()}, platform:${p.platform.js()}, vendor:${p.vendor.js()},
 langs:${p.langs.joinToString(",") { it.js() }}.split('|'), cores:${p.cores}, mem:${p.mem},
 w:${p.width}, h:${p.height}, gpu:${p.gpu.js()}, tz:${p.tz},
 noise:[${p.noise.joinToString(",")}], cn:${p.canvasNoise}, an:${p.audioNoise} };
let np=0; const nz=()=>P.noise[(np++)%P.noise.length]/255-0.5;
const def=(o,k,v)=>{try{Object.defineProperty(o,k,{get:()=>v,configurable:true})}catch(e){}};
def(Navigator.prototype,'userAgent',P.ua);
def(Navigator.prototype,'appVersion',P.ua.replace('Mozilla/',''));
def(Navigator.prototype,'platform',P.platform);
def(Navigator.prototype,'vendor',P.vendor);
def(Navigator.prototype,'language',P.langs[0]);
def(Navigator.prototype,'languages',Object.freeze(P.langs));
def(Navigator.prototype,'hardwareConcurrency',P.cores);
def(Navigator.prototype,'deviceMemory',P.mem);
def(Navigator.prototype,'webdriver',false);
def(Navigator.prototype,'doNotTrack','1');
def(Screen.prototype,'width',P.w); def(Screen.prototype,'height',P.h);
def(Screen.prototype,'availWidth',P.w); def(Screen.prototype,'availHeight',P.h-40);
def(Screen.prototype,'colorDepth',24); def(Screen.prototype,'pixelDepth',24);
Date.prototype.getTimezoneOffset=function(){return P.tz};
const _gid=CanvasRenderingContext2D.prototype.getImageData;
CanvasRenderingContext2D.prototype.getImageData=function(x,y,w,h){const d=_gid.call(this,x,y,w,h);const n=Math.max(1,(d.data.length*P.cn)|0);for(let i=0;i<n;i++){const q=(Math.abs(nz())*d.data.length)|0;d.data[q]^=1}return d};
const _td=HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL=function(){try{const x=this.getContext('2d');if(x&&this.width&&this.height){const g=x.getImageData(0,0,1,1);g.data[0]^=1;x.putImageData(g,(Math.abs(nz())*this.width)|0,(Math.abs(nz())*this.height)|0)}}catch(e){}return _td.apply(this,arguments)};
const _gp=WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter=function(q){if(q===37445)return'WebKit';if(q===37446)return P.gpu;if(q===7937)return'WebKit';if(q===7938)return'WebKit WebGL';return _gp.call(this,q)};
if(window.WebGL2RenderingContext){const g2=WebGL2RenderingContext.prototype.getParameter;WebGL2RenderingContext.prototype.getParameter=function(q){if(q===37445)return'WebKit';if(q===37446)return P.gpu;return g2.call(this,q)}}
if(window.OfflineAudioContext){const _sr=OfflineAudioContext.prototype.startRendering;OfflineAudioContext.prototype.startRendering=function(){return _sr.call(this).then(b=>{try{const d=b.getChannelData(0);for(let i=0;i<Math.min(64,d.length);i++)d[i]+=nz()*P.an}catch(e){}return b})}}
})();
""".trimIndent()
    }

    private fun String.js() = "'" + replace("\\", "\\\\").replace("'", "\\'") + "'"
}
