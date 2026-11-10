# Changelog / 更新日志

All notable changes to HaizhuBrowser / 海柱浏览器 are documented here.

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
