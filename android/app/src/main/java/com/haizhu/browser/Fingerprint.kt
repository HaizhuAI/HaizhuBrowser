package com.haizhu.browser

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import kotlin.random.Random

/**
 * Fingerprint spoofing — coherent MOBILE personas for Android WebView.
 * Device bundles keep UA model token / GPU renderer / CSS screen / DPR /
 * touch from the same class of real phone; mixing desktop strings
 * (Windows UA, D3D11, 1920x1080) onto a mobile WebView is trivially
 * detectable, so only Android profiles live here.
 * Mode "per-session" rotates on app restart / Rotate; "per-domain"
 * derives a stable persona from the host hash.
 */
object Fingerprint {
    var enabled = false
    var mode = "per-session"
    private var sessionSeed = randomSeed()

    fun rotate() { sessionSeed = randomSeed() }
    private fun randomSeed() = ByteArray(16).also { Random.nextBytes(it) }.joinToString("") { "%02x".format(it) }

    // coherent device bundle: model UA token + GL renderer + CSS-pixel
    // screen + DPR, all from one phone class
    private data class Device(val model: String, val gpuVendor: String, val gpu: String,
                              val w: Int, val h: Int, val dpr: Float)
    private val DEVICES = listOf(
        Device("Pixel 8 Pro", "Qualcomm", "Adreno (TM) 750", 412, 915, 2.625f),
        Device("Pixel 7", "Qualcomm", "Adreno (TM) 730", 412, 917, 2.625f),
        Device("Pixel 6a", "ARM", "Mali-G78 MP20", 412, 889, 2.625f),
        Device("SM-S911B", "Qualcomm", "Adreno (TM) 740", 360, 780, 3.0f),   // Galaxy S23
        Device("SM-G991B", "ARM", "Mali-G78 MP14", 360, 800, 3.0f),          // Galaxy S21
        Device("LE2123", "Qualcomm", "Adreno (TM) 660", 412, 919, 2.75f),    // OnePlus 9
        Device("M2102J20SG", "Qualcomm", "Adreno (TM) 619", 393, 873, 2.75f) // Mi 10T Lite
    )
    private val ANDROID_VER = listOf("13", "14", "15")
    private val CHROME_VER = listOf("130.0.0.0", "131.0.0.0", "132.0.0.0")
    private val LANG = listOf(listOf("en-US", "en"), listOf("en-GB", "en"), listOf("zh-CN", "zh", "en"), listOf("ja-JP", "en"))

    private fun rngFor(seed: String): Sequence<Int> = sequence {
        var h = MessageDigest.getInstance("SHA-256").digest(seed.toByteArray())
        while (true) { for (b in h) yield(b.toInt() and 0xff); h = MessageDigest.getInstance("SHA-256").digest(h) }
    }

    private fun personaJson(seed: String): JSONObject {
        val rnd = rngFor(seed).iterator()
        fun <T> pick(l: List<T>): T = l[rnd.next() % l.size]
        val d = pick(DEVICES)
        val av = pick(ANDROID_VER); val cv = pick(CHROME_VER)
        val langs = pick(LANG)
        val noise = JSONArray().also { a -> repeat(16) { a.put(rnd.next()) } }
        val ua = "Mozilla/5.0 (Linux; Android $av; ${d.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$cv Mobile Safari/537.36"
        return JSONObject()
            .put("ua", ua).put("platform", "Linux armv81").put("vendor", "Google Inc.")
            .put("langs", JSONArray(langs)).put("cores", pick(listOf(8)))
            .put("mem", pick(listOf(4, 8)))
            .put("w", d.w).put("h", d.h).put("dpr", d.dpr)
            .put("gpuVendor", d.gpuVendor).put("gpu", d.gpu)
            .put("tz", pick(listOf(0, -480, -300, 60, 120, 480, 540)))
            .put("touch", 5).put("noise", noise)
            .put("cn", 0.001 + rnd.next() / 255.0 * 0.004)
            .put("an", 0.0001 + rnd.next() / 255.0 * 0.0009)
    }

    /** Persona JSON for the __hzBoot document-start bridge; null when disabled. */
    fun configJson(host: String): String? {
        if (!enabled) return null
        val seed = if (mode == "per-domain") host else sessionSeed
        return personaJson(seed).toString()
    }

    /** JS patch body — expects `P` (persona object) already in scope. Shared
     *  by the document-start stub and the evaluateJavascript fallback. */
    private const val PATCH_JS = """
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
def(Navigator.prototype,'maxTouchPoints',P.touch);
def(Navigator.prototype,'webdriver',false);
def(Navigator.prototype,'doNotTrack','1');
def(Screen.prototype,'width',P.w); def(Screen.prototype,'height',P.h);
def(Screen.prototype,'availWidth',P.w); def(Screen.prototype,'availHeight',P.h-24);
def(Screen.prototype,'colorDepth',24); def(Screen.prototype,'pixelDepth',24);
try{if('ontouchstart' in window===false){window.ontouchstart=null}}catch(e){}
Date.prototype.getTimezoneOffset=function(){return P.tz};
const _gid=CanvasRenderingContext2D.prototype.getImageData;
CanvasRenderingContext2D.prototype.getImageData=function(x,y,w,h){const d=_gid.call(this,x,y,w,h);const n=Math.max(1,(d.data.length*P.cn)|0);for(let i=0;i<n;i++){const q=(Math.abs(nz())*d.data.length)|0;d.data[q]^=1}return d};
const _td=HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL=function(){try{const x=this.getContext('2d');if(x&&this.width&&this.height){const g=x.getImageData(0,0,1,1);g.data[0]^=1;x.putImageData(g,(Math.abs(nz())*this.width)|0,(Math.abs(nz())*this.height)|0)}}catch(e){}return _td.apply(this,arguments)};
const _gp=WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter=function(q){if(q===37445)return P.gpuVendor;if(q===37446)return P.gpu;return _gp.call(this,q)};
if(window.WebGL2RenderingContext){const g2=WebGL2RenderingContext.prototype.getParameter;WebGL2RenderingContext.prototype.getParameter=function(q){if(q===37445)return P.gpuVendor;if(q===37446)return P.gpu;return g2.call(this,q)}}
if(window.OfflineAudioContext){const _sr=OfflineAudioContext.prototype.startRendering;OfflineAudioContext.prototype.startRendering=function(){return _sr.call(this).then(b=>{try{const d=b.getChannelData(0);for(let i=0;i<Math.min(64,d.length);i++)d[i]+=nz()*P.an}catch(e){}return b})}}
"""

    /** Static document-start stub — calls the Java bridge synchronously for
     *  the persona JSON, then applies PATCH_JS literally (no eval → survives
     *  strict-CSP pages as far as the injection surface allows). */
    const val BOOT_JS = """
(function(){
try{
if(window.__hz_fp)return;window.__hz_fp=true;
var bi=window.__hzBoot;if(!bi||!bi.config)return;
var c=bi.config(location.host);if(!c)return;
var P=JSON.parse(c);
$PATCH_JS
}catch(e){}
})();
"""

    /** Fallback injection (evaluateJavascript in onPageStarted) for WebViews
     *  whose build lacks DOCUMENT_START_SCRIPT support. */
    fun bootstrap(host: String): String? {
        val json = configJson(host) ?: return null
        return """(function(){'use strict';if(window.__hz_fp)return;window.__hz_fp=true;const P=$json;$PATCH_JS})();"""
    }
}
