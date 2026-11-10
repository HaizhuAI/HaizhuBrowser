# Changelog / 更新日志

All notable changes to HaizhuBrowser / 海柱浏览器 are documented here.

## [1.8.0] — 2025-11-11

### Added / 新增 — 人机验证应对体系（真 Chrome 基线层，常开）
调研 undetected-chromedriver / puppeteer-extra-stealth / rebrowser-patches / nodriver 的公开手段后按 Electron 架构移植，`src/main/stealth.js`：

- **线级身份层**——每个会话重写 `User-Agent` + `Sec-CH-UA`/`Sec-CH-UA-Mobile`/`Sec-CH-UA-Platform`(+Full-Version-List) 为真 Chrome 140 品牌串，清除 Electron 默认泄漏的 `Electron/x.y` UA/CH 品牌；`Accept-Language` 兜底；环境标签的 persona 头覆写保持最高优先级
- **JS 基线面**（CDP `Page.addScriptToEvaluateOnNewDocument`，document-start、**全 frame 含跨域 challenge iframe、零 DOM 痕迹**）——`window.chrome` 完整面（app/runtime【仅安全源】/csi/loadTimes，合并进 Electron 空 stub）、plugins↔mimeTypes 交叉引用真类原型（5 个 PDF Viewer 插件）、permissions↔Notification 矛盾面复刻真 Chrome 怪癖（HTTP 下 query=prompt 而 permission=denied）、`webdriver=false`、`userAgentData` 品牌覆写、`vendor=Google Inc.`、`pdfViewerEnabled`、`doNotTrack`、全量 `toString` native 掩码、软渲 WebGL 按平台遮罩为主流核显串（SwiftShader/llvmpipe → UHD 630/620）
- **真人输入引擎**——`webContents.sendInputEvent` trusted 管线：贝塞尔曲线 mouseMove + ease-out 减速 + ±2px 落点抖动 + 60–160ms 悬停 + 45–120ms 按压时长；`humanType` 55–175ms 键间延迟
- **Turnstile 求解器**——穿透 shadowRoot 递归定位 challenge iframe/容器 → 真人轨迹点击复选框区 → 轮询 `cf-turnstile-response`/`cf_clearance`
- **反爬自检**——24 项探针（webdriver/chrome/plugins/UA-CH/权限/WebGL/屏幕/时区等）逐项 pass/FAIL/WARN
- **面板**：指纹页新增「人机验证应对」——反爬自检 + 过 Turnstile 两个真实按钮，四语言键
- **MCP +4 工具（共 40）**：`stealth_audit` / `human_click` / `human_type` / `solve_turnstile`
- `--disable-blink-features=AutomationControlled` 启动开关
- **刻意规避**（rebrowser/DataDome 公开研究）：不调用 `Runtime.enable`、不开 `--remote-debugging-port`——两者均为 CF 在用的 5 行 JS 探针检测向量

### Changed / 修复
- **`<script>` bootstrap 注入收窄到顶层 frame**——子 frame 注入在跨域 iframe（CF challenge widget）里可被 MutationObserver 观测；子 frame 改由 CDP 全 frame 无痕迹注入覆盖
- Electron 的 `window.chrome` 空 stub 检测出并合并（此前 `chrome_obj` 探测失败）
- 插件/ mimeType 交叉引用修复（每插件独立 mime，`enabledPlugin` 回指自身）

### Verified / 实测（打包产物）
- `stealth_audit` @ bot.sannysoft.com：**24/24 全绿**（含 WebGL 遮罩生效）
- httpbin/headers 回显：`Sec-Ch-Ua:"Not_A Brand";v="24","Chromium";v="140","Google Chrome";v="140"` + Platform Windows + 干净 UA
- **nowsecure.nl（nodriver 同款 CF 测试站）：无挑战页直出正文**（"NOWSECURE BY NODRIVER" 渲染）— 静默信任级通过
- nopecha CF managed challenge：验证器持续循环——判定为云机房 IP 信誉 + 软渲光栅输出（字符串可遮、像素不可伪），非浏览器侧信号
- MCP `tools/list`：40 工具；humanClick/audit/solve 全链路实调

## [1.7.0] — 2025-11-11

### Added / 新增 — MCP 智能体接入（Windows + Linux 桌面版）
- **内嵌 MCP 服务端** `src/main/mcp.js`：Streamable HTTP 端点 `http://127.0.0.1:<port>/mcp`（默认 8765），完整 JSON-RPC：`initialize`/`ping`/`tools/list`/`tools/call`/通知/批量/SSE 监听流；Bearer 令牌鉴权（自动生成、可重置），仅绑回环
- **36 个工具**：标签/导航（omnibox 式 URL+搜索归一化）/页面文本与 HTML/DOM 查询/点击/填充/JS 执行/截图（真 PNG image 块）/抓包启停+网络日志+请求体+HAR 导出/资源嗅探+下载/Cookie 增删查/localStorage/指纹环境（列表/启动/人格）/代理（列表/切换）/广告拦截/油猴脚本/书签/历史/内置 AI 对话——页级工具可指定 `tabId`，默认作用于活动标签
- **stdio 桥**：零依赖 `mcp-stdio.js` 自动写入 `<userData>`，Claude Desktop / Codex 等以子进程方式拉起即可接入（逐行 JSON-RPC ↔ HTTP 转发）
- **设置页 MCP 区块**：启停开关、端口、运行状态、令牌（截断显示+重新生成）、stdio/HTTP 两份客户端配置一键复制，四语言键
- IPC：`mcp:state` / `mcp:set` / `mcp:regen` / `mcp:config`，host 与内部页双 preload 暴露 `hz.mcp` / `hzNav.mcp`

### Fixed / 修复
- `run_js` 兼容裸表达式（agent 常写 `document.title`）：先尝试表达式包裹再回退语句体
- `set_cookie`/`delete_cookie` 未给 `url` 时自动回落当前页 URL（Electron `cookies.set` 必需）
- `activate_tab`/`close_tab` 对不存在标签静默成功 → 改为报错 `no such tab`
- `storage_get` 在 opaque origin/禁用 DOM 存储页抛错 → JS 内 try/catch 返回 `[]`
- 未知工具名现在返回 `isError:true` 而非普通文本
- `initialize` 固定回 `2025-06-18`（协议协商正确语义，不回显未知版本）

### Verified / 实测（打包产物 `win-unpacked`，非 dev）
- HTTP：`initialize`→握手+protocolVersion；`tools/list`→36；`navigate example.com`→`https://example.com`；`page_text`/`dom_query`/`run_js`→真页面数据；`start_capture`→`network_log` 出 `GET /` Document 记录→`har_export` 真 HAR→`stop_capture`；`screenshot`→14.9KB PNG image 块；`set_cookie`→`list_cookies` 写读一致；无令牌→401
- stdio：管道 `tools/list` 经 `mcp-stdio.js` 全链路往返 ✓
- 设置页 MCP 区块截图入库 `docs/screenshots/mcp-settings.png`（运行中状态、令牌、双配置）

## [1.6.1] — 2025-11-10

### Fixed / 修复
- **网页内右键无反应（Windows 桌面）** — WebContentsView 无默认菜单：页面 webContents 注册 `context-menu` → 主进程构建上下文相关原生菜单（编辑=撤销/剪/贴，链接=新标签打开/复制，图片/媒体=打开/复制/保存，选中=复制/搜索，页面=后退/前进/刷新/另存/查看源码/检查），四语言键；菜单锚定页内点击点 `view.bounds+p.x/p.y`（修复多屏/光标不在窗内时菜单弹到屏幕外）
- **默认书签更新** — 中转站 `api.haizhuai.art` → `api.haizhuai.xyz`，存量书签自动迁移
- **Android 启动崩溃** — `Adblock` 规则表后台编译与 WebView 拦截线程共享可变 ArrayList → `ConcurrentModificationException`（FATAL at Adblock.kt:89）；改为新列表编译+原子引用交换，`test()` 读快照
- **Android 一批真 bug** — 无痕 `setAcceptCookie(false)` 污染全局 CookieManager（改在 activateTab 按当前标签切换）；`view-source:` 菜单项死掉（WebView 不支持该协议，改 OkHttp 拉源码弹窗）；指纹菜单逻辑反了（off 时才 rotate → 改正）；指纹注入从 onPageStarted 竞速改为 `WebViewCompat.addDocumentStartJavaScript` 真·文档起始；user.js 安装后还继续下载（补拦截返回）

### Verified / 实测
- 打包 exe：合成右键 → `[ctx] items=7` + 原生菜单截图（点击点锚定、中文本地化）
- devin-vm 远程模拟器（r35）：安装→启动→DDG/Guardian/BBC 导航→多标签→菜单→capture on→Dev 面板请求列表；logcat `FATAL EXCEPTION` 计数 **0**（修复前必崩）

## [1.6.0] — 2025-11-10

### Design / 设计更新（haizhu-codex-design 设计语言移植）
- **新 Logo** — SDF 重绘：收锋浪线（笔触两端渐细）穿竖柱，斜向深海→青蓝渐变 + 微光晕 + 暗角，`resources/icon.png|.ico`
- **弹簧动效系统** — 设计 token `--ease-spring`/`--ease-out`；新标签弹簧入场（`.new` 仅触发一次）、书签/工具/窗控按钮按压缩放（.88–.92）
- **NTP 入场编排** — 主体升起 + 瓷贴 45ms 错峰入场 + logo 5.5s 轻浮动
- 说明：七库均为 React/Tailwind/RN 组件，浏览器 chrome 为无依赖原生页，未装库、按目录选型移植设计语言（beUI 弹簧/按压、Rare UI 点缀思路），保持 Chrome/Edge 结构不变

## [1.5.4] — 2025-11-10

### Fixed / 修复
- **标签 favicon 破图（同类问题全局修复）** — favicon URL 白名单（仅 `https?`/`data:image`，`chrome://` 等一律回退文档图标）；`document` 捕获阶段统一监听 `error`，标签 `.fav` 破图→文档 SVG、书签破图→地球 SVG，废除不可靠的内联 onerror
- 实测：design.haizhuai.art 加载完成后 favicon 正常渲染，`brokenImgs:0`

## [1.5.3] — 2025-11-10

### Fixed / 修复
- **书签图标破图** — 种子书签猜测的 `/favicon.ico` 不存在导致裂图；改为内联 SVG 语义图标（生图站=图片 / 中转站=交换箭头 / 社区=对话 / 导航页=罗盘，用户新增书签默认=地球），不再依赖网络猜测
- `onerror` 内联转义失效 → 改捕获阶段事件委托替换图标；旧存档的坏 fav URL 自动迁移

## [1.5.2] — 2025-11-10

### New / 新增
- **书签栏（Bookmarks bar）** — Chrome 式第三行书签条，默认显示；`Ctrl+Shift+B` / 菜单勾选切换显隐（窗口高度随动 82↔110）；左键当前页打开、中键新标签、右键原生菜单（新标签打开/删除）
- **默认书签种子** — 首次启动预置：生图站 `design.haizhuai.art`、中转站 `api.haizhuai.art`、HaizhuAI中文社区 `blog.haizhuai.art`、HaizhuAI导航页 `start.haizhuai.art`（favicon 自动加载，失败回退首字母圆标）
- **星标收藏** — omnibox 内星按钮 / `Ctrl+D` 收藏当前页（已收藏显示实心，再点移除）；菜单同步入口
- 四语言菜单/提示键（en/简中/繁中/日）

### Verified / 实测验收（打包产物 + 真人点击）
- 4 种子渲染 ✓｜真点击书签导航到 design.haizhuai.art ✓｜显隐切换 ✓｜星标加/删 count 4↔5 ✓

## [1.5.1] — 2025-11-10

### Fixed / 修复（severity-1：窗口控制全失效）
- **最小化/最大化/关闭按钮真实可用** — 根因：chrome.js 尾部一段旧代码用拼错的 `hz.app.winctrl`（少 t）覆盖了正确的 onclick 绑定，三个按钮自 v1.3.0 起纯装饰。已删除旧绑定并为最大化/还原图标做状态同步（`win-state` 广播 + `win:state` 查询）
- **标题栏拖拽** — `-webkit-app-region:drag` 在 WebContentsView 内是黑洞（吞掉输入却不移动窗口）：改为渲染进程转发 `clientX/Y` + 主进程 `setPosition` 的手动拖拽，支持**最大化下拉还原**（光标等比吸附）与**顶部贴边最大化**（snap）
- **标题栏双击最大化/还原** — 修复 `dblclick` 同时命中 `#dragspace` 与 `#tabrow` 两层监听导致连切两次净零的问题，改为单委托监听；`#dragspace` 高度塌陷为 0（flex-end 布局无内在高度）导致命中测试落空，补 `align-self:stretch`
- `win:ctl` 在窗口销毁后读取状态崩溃（close 路径）加防御
- 测试钩子 `dev:click/dblclick/drag/shot/resize/probe`（仅 `HZ_EVAL` 环境变量存在时注册，不进生产路径）

### Verified / 实测验收（模拟真人点击 sendInputEvent，打包产物上验证）
- 拖拽 `[11,0]→[140,69]` ✓｜双击标题栏最大化 ✓｜再双击还原 ✓｜最小化真隐藏 ✓｜还原 ✓｜关闭进程退出 ✓｜960px 响应式控件完整 ✓

## [1.5.0] — 2025-11-10

### New / 新增
- **独立环境（Environments）** — 商业化指纹浏览器体系（参照比特浏览器/ADS）：每个环境 = 独立 session 分区（cookie/存储/缓存全隔离）+ 独立指纹种子 + 独立代理绑定。面板新增「环境」页：新建（名称/系统人格/代理/分组）、启动、指纹预览、重种子、复制、删除；标签条显示环境色点徽标
- **一致性设备人格** — CPU/内存/GPU/屏幕/DPR/色深按真实硬件打包抽取（不再是独立随机值）：Windows ANGLE/D3D11、macOS Metal（Intel/ARM 分池）、Linux Mesa/OpenGL、Android OpenGL ES。按环境种子确定性选择、跨启动稳定、按宿主机 WebGL 上限过滤
- **原生级覆盖（环境标签）** — CDP `Emulation.setTimezoneOverride` / `setLocaleOverride` / `Network.setUserAgentOverride`（含 UA-CH 元数据 → 真 `sec-ch-ua*` 头 + `navigator.userAgentData`）；免 CSP 的 `Page.addScriptToEvaluateOnNewDocument` 注入；Android 人格附带触摸 + 设备度量仿真；debugger 断连自动恢复
- **全量 JS 指纹面** — navigator（UA/platform/languages/cores/memory/touch/webdriver/真 PDF plugins）、`userAgentData` 高熵值（arch/bitness/platformVersion/fullVersionList）、screen+DPR、时区（Intl+getTimezoneOffset）、canvas 锁定块噪声（高风控站点自动低幅稳定）、WebGL（vendor/renderer + GPU 级参数表 + 厂商扩展过滤 + WebGPU adapterInfo）、音频指纹、clientRects、电池、媒体设备、语音库（按 OS 池+语言评分）、字体探测（拒绝本 OS 不存在的字族）、WebRTC host candidate 改写 + 全局 `default_public_interface_only`
- **线级请求头改写** — 环境 session 的 `User-Agent` / `sec-ch-ua*` 全套 / `Accept-Language` 在 `onBeforeSendHeaders` 重写（webhub 新增该事件分发）
- 面板记住上次打开的页签（DevTools 惯例）

### Security / 安全
- **OpenBrowser 安全审计完成** — `docs/SECURITY-OPENBROWSER.md`：无硬编码外泄域、云同步为用户自配、本地 API 有鉴权、元数据端点属 SSRF 拦截测试装置；AGPL-3.0 许可下**仅采用事实性数据表**（GPU 字符串/字体表/语音名/GL 限值），全部逻辑自研，未复制上游代码

## [1.4.0] — 2025-11-10

### New / 新增
- **主题系统** — 深色 / 浅色 / 跟随系统（`settings.theme`），经 `nativeTheme` 解析后广播到全部 UI 面；浅色主题使用 Edge 亮色变量
- **多语言 i18n** — `en` / `zh-CN` / `zh-TW` / `ja` 字典，自动按系统区域匹配或手动选择；覆盖工具栏、菜单、面板导航、新标签页、设置页；切换即时生效
- **`haizhu://settings` 设置页** — Edge 式双栏：外观（主题三选 + 壁纸开关）、语言、启动主页、搜索引擎（DDG/Google/Bing/Baidu）、隐私（广告拦截开关+统计、清数据）、关于（版本/仓库/许可）
- **沉浸式新标签页** — 必应每日壁纸全屏（主进程取回，免 CORS）+ 毛玻璃搜索 + 快捷瓷贴 + 壁纸版权信息 + 设置入口；可在设置中关闭壁纸
- **新品牌图标** — SDF 程序化渲染的极简线条 logo（竖柱+双浪，海洋渐变 squircle），应用图标 + 页面品牌统一
- 菜单增加 Settings (Ctrl+,) 与 Quit；默认主页改为 `haizhu://newtab`

### Fixed / 修复
- `haizhu://settings/*` 子路径资源（settings.js/style.css）被协议兜底返回 HTML → `Unexpected token '<'`；协议现按 pathname 路由
- 必应壁纸页内 fetch 被 CORS 拦截 → 改主进程 `net.fetch` IPC
- 品牌名修正：海珠 → 海柱

## [1.3.0] — 2025-11-10

### Fixed / 修复
- **菜单打不开** — 菜单原本渲染在仅 82px 高的 chrome 视图里被裁剪；改为 Electron 原生 `Menu.popup()`，永远可见，含导航/隐私/视图/工具全套命令（新标签、无痕、开发者面板、DevTools、抓包开关、刷新、查看源码、缩放、下载页、打印、清浏览数据、退出）
- **"窗口里套窗口"** — 主窗 `BaseWindow` 自带原生标题栏与自绘 chrome 叠成双标题栏；改 `frame:false` + 自绘窗控（最小化/最大化/关闭，拖拽区）
- **新标签页空白** — `haizhu://newtab` 协议原先注册在 `defaultSession`，而标签页实际跑在 `persist:default` 分区 → 永久 `ERR_ABORTED`；现协议处理器注册到每个标签 session（含无痕）
- **假按钮** — 全部工具栏控件都有真实实现：后退/前进（禁用态同步导航栈）、刷新、omnibox 回车/前往、无痕、抓包、DevTools、面板、菜单、新建/关闭标签

### New / 新增
- **夸克式新标签页** `haizhu://newtab` — 渐变 logo、大搜索胶囊（回车导航/搜索）、访问历史瓷贴（自动 favicon + 兜底字母）、快捷键提示
- **无痕徽章** — 匿名标签显示 `INCOG` 徽记
- **原生窗口体验** — 无边框 + 自绘窗控 + `-webkit-app-region` 拖拽

### Improved / 改进
- 标签条视觉重写：活动标签底边外扩曲线与工具栏融合（Chrome 式），非活动标签分隔线、悬停态、favicon 兜底
- Omnibox 图标化（站点状态图标 + 前往箭头），工具栏 SVG 图标统一 16px stroke 风格
- 面板新增头部（标题 + 关闭），导航键高亮态

## [1.2.0] — 2025-11-10

### Fixed / 修复
- **webRequest 监听器互顶** — Electron 每 session 每事件仅允许一个 handler；adblock/sniffer/user.js 三处注册互相覆盖导致拦截从未生效。新增 `webhub.js` 中心化分发（阻塞事件取第一个非空响应），无痕 session 自动挂载
- **抓包主源重构** — session `webRequest` 为主源（主文档+全部子资源 100% 覆盖），CDP 为增强层；body 改用 Fetch 域拦截（`Fetch.requestPaused` → `getResponseBody` → 放行），修复主文档 `No resource with given identifier`
- **广告拦截 `|` 漏洞** — 规则里字面 `|` 未转义变成正则交替符，一条无 domain 限制的 `@@` 例外否决所有拦截

### Verified / 实测
- capture toggle、Document+Script 全量捕获、response body 772B、HAR 导出、adblock 实拦 pagead2、m3u8 嗅探 `hls:200`

## [1.1.0] — 2025-11-10

- UI 重构 v1：Chrome/Edge 风格深色 chrome、SVG 工具栏、胶囊 omnibox

## [1.0.0] — 2025-11-10

- 首版：Electron WebContentsView 多标签、CDP 抓包+HAR、资源嗅探+m3u8 下载、油猴引擎（GM_* API）、广告拦截（EasyList 三表 119k 规则）、代理 profile、指纹 persona、扩展加载、Cookie 面板、Duck.ai 内置 + OpenAI 兼容端点 + agent 工具链；Android WebView 镜像功能；五平台产物
