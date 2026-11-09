# Haizhu Browser — APK 逆向调研报告 / Reverse-Engineering Report

> 样本目录 `D:\Devin\HaizhuBrowser`。分析方法：androguard 静态解析（manifest/权限/ABI/dex 字符串）、资源清单嗅探、特征关键字聚类。jadx 深度反编译用于重点类。

## 1. 样本总览 / Corpus

| 样本 | 包名 | 大小 | 引擎 | 定位 |
|---|---|---|---|---|
| Chrome 148 | `com.android.chrome` | 28M(apks) | Chromium 全量 | 基线参照 |
| Edge 153 | `com.microsoft.emmx` | 265M | Chromium + onnxruntime + Bing | AI(Copilot)+企业同步 |
| Opera 100 | `com.opera.browser` | 227M(apks) | Chromium | 内置VPN+ABP广告拦截 |
| Stay 1.6.0 | `com.dajiu.stay` | 23M(apks) | WebView + 自研扩展框架 | **油猴/WebExtension 标杆** |
| Solo 2.5.6 | `com.kuqing.solo.browser` | 40M | WebView+腾讯X5 | **AI深度搜索+全功能** |
| Via 7.3.0β | `mark.via` / `.gp` | 6.8M | 纯系统 WebView | **极致轻量+高可定制** |
| 鸭鸭 5.301 | `com.duckduckgo.mobile.android` | 72M | WebView + 自研隐私栈 | **隐私防护标杆** |

## 2. 关键实现点（dex 证据）

### Stay — Userscript 引擎教科书
- `userscript_prod.db` 本地脚本库；`/userscript/push|pull` 云同步；`/userscript/searchGreasyfork` 直连 Greasyfork 搜索安装。
- 完整 `GM_apis` 注入（`GM_info`/`GM_apis.set/.list/.delete`），`@run-at`/`@match`/`@include`/`@grant` 全套元数据。
- 自带 `webextension` 命名空间：`com.dajiu.stay.webextension.javascriptapis.scripting.InjectionResult` — 即兼容 Chrome 扩展 API 的 `scripting.executeScript` 子集。
- **资源嗅探**：`/sniffer/sniffer.app.js`、`SNIFFER_UA`、`window.__snifferIframe` — 注入隐藏 iframe 探测页内视频源；`/sniffer/get-sniffer-app-js` 动态下发嗅探脚本（可热更新规则）。
- m3u8：`Lio/lindstrom/m3u8/parser/*` Java 侧 HLS 解析器，配合 `下载解析m3u8文件失败` → 嗅探→解析→下载闭环。
- 广告：`adblock/RuleTrie`、`RegexRule`、`AllUrlsRule` — Trie 结构匹配，性能优于逐条正则。

### Via — 6.8MB 的架构极限
- **纯系统 WebView** 无内置内核，全部功能走 JS 注入 + `evaluateJavascript`。
- userscript：标准 `==UserScript==` 解析 + **伪装 Tampermonkey API shim**（`via-fake-tampermonkey`：向检测 TM 存在的脚本返回 `version:'4.5.1'`）。
- **站点配置** `SiteConf{userAgentChoice=,injection=}`：按域名独立 UA/JS/CSS 注入（夜间 css `via_inject_css_night`、广告屏蔽 css `via_inject_css_blocker`）。
- 代理：完整 `Proxy rules` + SOCKS（`socks://127.0.0.1:1080`）。
- EasyList 订阅制：内置 easylist + 各地区列表（abpvn/rolist/koreanlist/…）可选更新。
- 数据库直接操作脚本表：`UPDATE scripts SET grant = …`。

### Solo — 全能型（本项目的最近参照系）
- `SoloUserScript` + `__solo_userscript_gm__` 桥；m3u8 探测正则 `\.m3u8?(?:\?|$|/|#)`、媒体参数正则 `(?:format|type|file)=…(mp4|m3u8|mpd|ts…)`。
- `MediaSniff`/`mediaSniffEarly`/`videoSniffRow` — 页内媒体嗅探 UI。
- **指纹**：`dd_fingerprint`/`tab_fingerprint`/`setFingerprint` — 按 tab 随机指纹。
- 代理全家桶：`solo-proxy`，HTTP/SOCKS4/SOCKS5/SOCKS5_SSL + 鉴权。
- `com.ai.deepsearch.*` — AI 深度搜索为首页入口（Launcher 即 `com.ai.deepsearch.Launcher`）。
- 反面教材：74 权限、381 Activity、`injectAds`（向页面注入自家广告）、友盟/个推/米推全家桶——**本项目要剔除的正是这类**。

### 鸭鸭 = DuckDuckGo — 隐私防护教科书
- `libnetguard.so`（应用跟踪拦截 VPN）、`libwg-go.so`（WireGuard）、`libsqlcipher.so`（加密存储）、`libhttps-bloom-lib.so`（HTTPS 升级布隆过滤器）、`liburl_predictor.so`。
- `RealUserAgent.kt`/`injectUserAgent`/`customUserAgent` — UA 伪装注入。
- 大量 `injectVpn`/`injectCookie`/`injectPixel` — 网络栈埋点与拦截。
- Duck.ai 已产品化：`VoiceChat`/`ImageGeneration`/`PlusLimit` 等会话态——**证实 duck.ai 内置 AI 的产品路径**。

### Opera / Chrome / Edge — 大厂参照
- Opera：`org.adblockplus.browser` 内置 ABP、`ADBLOCK_CSS`、免费 VPN（131 个 vpn 资源）、`ProxyApi`/`PROXY_API`。
- Edge：`libonnxruntime.so`（端侧 AI）、`libbingopus.so`（Copilot）、`Trust Protection Lists` 追踪防护清单（广告/分析/挖矿/指纹 分类列表，值得借鉴的数据资产）。
- Chrome：基线，无额外可借鉴特性（功能全部下沉内核）。

## 3. 功能矩阵 → 本项目取舍

| 能力 | 来源样本 | 本项目实现（桌面） | 本项目实现（安卓） |
|---|---|---|---|
| 抓包调试 | (桌面刚需) | **CDP Network 域**：请求/响应头、body、时序、HAR 导出 | WebView `shouldInterceptRequest` + OkHttp 记录层 |
| 资源嗅探 | Stay/Solo | `webRequest` 全量 URL + mime/扩展名过滤（m3u8/mpd/mp4/flv/m4s/mp3…） | `shouldInterceptRequest` 同款规则 |
| m3u8 下载 | Stay | master→variant 解析、6 并发分片、顺序写 .ts | 同算法 Kotlin 版 |
| 油猴脚本 | Stay/Via/Solo | 元数据解析 + `@match` glob + 全 GM_* API（postMessage→IPC 桥） + document-start/end/idle | `@JavascriptInterface` 桥 + `evaluateJavascript` 注入 |
| 浏览器扩展 | Stay | `session.loadExtension`（MV2 + MV3 子集），zip/crx 安装 | WebView 无扩展 API → 提供 userscript 等价替代 |
| 代理 | Opera/Solo/Via | `ses.setProxy` HTTP/HTTPS/SOCKS4/5/PAC + 鉴权回调 | `ProxyController`（API29+）/反射 fallback |
| 指纹伪装 | Solo/鸭鸭 | 主世界 early-inject：navigator/screen/canvas/WebGL/audio/TZ/WebRTC | `evaluateJavascript` document-start 同款脚本 |
| 匿名模式 | 鸭鸭 | 内存 partition + 指纹 persona + 代理链 | 无数据目录 WebView + 清除接口 |
| 广告拦截 | Opera/Via/鸭鸭 | EasyList 订阅解析（`||domain^`/`|anchor`/`@@`例外/`$type`） | 同规则集 `shouldInterceptRequest` |
| AI 助手 | Edge/Solo/鸭鸭 | duck.ai vqd 握手 + OpenAI 兼容端点导入 | 同一 HTTP 协议层 |
| AI Agent | —（独家） | 工具循环：cookies/capture/DOM/run_js/click/fill/navigate | evaluateJavascript + CookieManager 同款 |

## 4. 架构决定

1. **桌面 = Electron + CDP**：Electron 即 Chromium，天然拿到 DevTools 协议——抓包/注入/扩展三件套零妥协，远优于系统 WebView2（无扩展、无 CDP 全量）。
2. **Android = Kotlin WebView**：对齐 Via 路线（系统内核，包体 <15M），功能全部由 Java 桥 + JS 注入实现；放弃内置 Chromium fork（维护成本不可接受）。
3. **共用资产**：指纹 persona 生成算法、EasyList 规则编译器、userscript 元数据解析器、嗅探正则表、AI 协议层——双端各写一份但语义对齐。

## 5. 明确剔除
Solo 的 push SDK 全家桶/`injectAds` 页面广告注入/读取剪贴板/后台定位；Edge 的遥测；Opera 的 pangle 广告 split。**零遥测、零广告、最小权限**是本项目基线。
