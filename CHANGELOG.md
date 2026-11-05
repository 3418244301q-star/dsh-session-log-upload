# 产出档案 / 更新日志

**插件**：`dsh-session-sync`（跨渠道会话日志上传）
**包名变更**：1.0.0 起改名为 `dsh-session-log-upload`（GitHub 仓库仍为 `dsh-session-sync`）。
历史上曾用名：`dsh-session-log-anywhere`（0.1.0–0.4.0）、`dsh-session-sync`（0.5.x）。
下方早期条目中的旧名与本地路径属于当时的记录，未回改。
**规格来源**：`D:\dsh\3\SPEC-跨渠道会话日志上传.md`
**首次实现**：2026-11-04
**当前版本**：1.1.2

---

## 这个插件解决什么问题

内置插件 `@deepseek-ai/dsh-session-log-deepseek` 只搭官方适配器的便车：它把 `dsh_session_log`
作为顶层字段挂到官方 chat 请求上。第三方渠道（ollama-local、pi-ai、OpenAI 兼容）走别的适配器，
没有那个扩展点，日志永远不会上传。

本插件自己发一次最小 chat 请求承载同一个字段，并且用**和内置插件完全相同的水位事件**
（`session-log-deepseek/delivery-accepted`）落盘。因此两条路径共存、互不重复。

---

## 版本总表

| 版本 | 时间 | 一句话 |
|---|---|---|
| 0.1.0 | 11-04 19:41 | Host 插件初版：三档触发、水位、限流、退避、seeded 策略、启动扫描 |
| 0.1.1 | 11-04 19:47 | 修两个真 bug：上传自我喂食、重试定时器未托管 |
| 0.2.0 | 11-04 19:52 | 设置页：Config schema（volatile）+ 客户端行，挂在官方上传行下面 |
| 0.3.0 | 11-04 19:59 | 控件重做：弃用原生 select/checkbox，改自绘主题化控件 |
| 0.4.0 | 11-04 20:12 | 左侧「立即上传」按钮 + 冷却/最新判定 + 结果提示 |
| 0.5.0 | 11-04 20:50 | 对抗性审查后的修复：多段续传、渠道边界、失败上报、限流口径 |
| 0.5.1 | 11-04 21:05 | 复审四项：官方优先窗口告警、段数耗尽续传、在途点击报忙、失败重排封顶 |
| 0.5.2 | 11-04 21:10 | R1 收尾（归内置单独冒泡）+ 与核心的实测等价证明 |
| 0.5.3 | 11-04 21:14 | R5：单条事件超上限时不再报「已是最新」；`ok` 字段与结果码对齐 |
| 0.5.4 | 11-04 21:20 | 补齐三处：验证工具表陈旧、新结果码在客户端无覆盖、harness 支持重渲染 |
| 0.5.5 | 11-04 21:35 | M6：manual 档续传语义说实话；断言升级为校验真实文案与占位符 |
| 0.5.6 | 11-04 21:45 | 文档数字守卫：`tools/check-docs.mjs`，防止总表再次腐化 |
| 0.5.7 | 11-04 21:50 | 排版：中文提示句连接处多了一个 ASCII 空格 |
| 0.5.8 | 11-04 22:30 | 文档：README 补「版本要求」与预发布 semver 盲区 |
| 0.5.9 | 11-04 22:45 | 文档：与同类插件的差异化声明 + 失效场景清单 |
| 1.0.0 | 11-04 22:30 | 正式版：改名 `dsh-session-log-upload`，准备发布 npm |
| 1.1.0 | 11-05 12:20 | 首次开启加风险确认（1.1.2 起改为每次询问）：复用官方 `RiskConfirmation` |
| 1.1.1 | 11-05 12:40 | 复审修复：确认改成可失败的串联写、补 `disabled` 门禁、空语料不再判绿 |
| **1.1.2** | 11-05 12:52 | 确认改成「每次启用都问」：只剩一次写，`acknowledged` 键删除；关闭失败不再静默 |

---

## 0.1.0 — Host 插件初版

**新增文件**

```
dsh-session-log-anywhere/
├─ index.js            Host 半场（全部逻辑）
├─ package.json        bundle 清单
├─ cordis.patch.yml    默认配置（enabled: false）
├─ locale/{zh,en}.json 插件显示名与描述
├─ icon.svg            自绘图标
└─ README.md           使用说明
```

**实现了什么**

1. **三档触发**
   - `manual`：不注册定时器、不监听 `turn/end`，加载后零网络活动
   - `deferred`（默认）：`turn/end` 后起 `idleDelayMs`（10 分钟）计时，期间有新事件就重置
   - `realtime`：每次 `turn/end` 入队，同会话重复入队合并
2. **渠道判定**：只处理待传区间里出现过**非官方 provider** 的会话。依据是
   `request/header` 事件的 `data.header.config.provider`；整段都是 `deepseek-official`
   就交给内置插件，插件完全不插手。
3. **线格式**：`wireHeader` / `wireEvent` / `segmentEnvelope` 与核心包逐行对齐——
   键顺序、`surfaceOp` 展开规则、`ignorable` 透传、字节记账法（含 `-1` 那个细节）全部一致。
4. **水位**：扫描 `delivery-accepted` 事件，只认 `sessionId` 相同且 `sessionFormatVersion`
   相同的记录，折叠取最大 `throughSeq`；用 WeakMap 缓存已扫过的长度，避免每轮全量扫。
5. **并发与限流**：全局串行链（默认 concurrency 1）、同会话单飞、滑动窗口
   `maxRequestsPerHour`（默认 60），超限**排队**而不是丢弃（60 秒后重试）。
6. **失败处理**：网络错误与 5xx 指数退避重试；401/403 不重试直接告警；失败不写水位
   （至少一次语义）；单段超 `maxBytes` 只告警一次且水位不前移；所有异常捕获，绝不抛进会话。
7. **seeded 子会话**：默认跳过；`includeSeeded: true` 时从
   `max(acceptedThrough, inheritedEventCount - 1)` 起传，继承段一律不重发。
8. **启动扫描**：加载 5 秒后扫一遍活着的会话，按待传事件数从少到多排队，补崩溃/强杀
   漏掉的收尾。
9. **卸载清理**：清空队列、所有 setTimeout、在飞集合，保证无残留定时器。

**验证**

- `plugin/check-envelope.mjs`：51 个真实会话 × 5 种 `maxBytes`（8 MiB / 64 KiB / 4 KiB / 1 KiB / 200 B）
  = **255 组，与参考实现 `lib/envelope.mjs` 字节级完全一致**（含被截断时的 `blockedSeq`）
- `plugin/check-runtime.mjs`：mock fetch + mock ctx 跑 14 项，覆盖上传、水位、官方会话不误发、
  seeded 跳过、`includeSeeded` 只传尾段、限流、manual 零请求
- 安装：`install_bundle` → `application: applied`

---

## 0.1.1 — 两个 bug 修复

**Bug 1（严重）：上传自我喂食**

上传成功后 `session.append()` 写的 `delivery-accepted` 事件，本身又成了"下一条待传事件"，
循环立刻把它当新内容发出去，一圈一圈直到 `MAX_SEGMENTS_PER_RUN`（8）。实测一次触发连发
8 个请求、写 8 条水位。

- 修复：只有**本段是被 `maxBytes` 截断的**才继续发下一段；未截断就收工。
- 加固：记录 `previousThrough`，下一段 `throughSeq` 没有前进就直接退出，避免死循环。
- 说明：最后那条 acceptance 小事件仍会在**下一次**触发时随下一段一起上送——这与核心包
  "搭下一趟官方请求的便车"是同一性质，属预期行为。

**Bug 2：重试等待的定时器没被托管**

初版的 `sleep()` 写错了（用随机 key 往 `timers` 里塞），卸载时清不干净。

- 修复：独立 `sleepTimers` Set，卸载时一并 clear。

**其他**

- 新增 `export const __internals`：把 `segment` / `acceptedThrough` / `effectiveAfter` /
  `classify` 等纯函数暴露给对照脚本，运行路径不读它。
- 修测试夹具：seeded 用例里 `request/header` 原本落在继承段内，导致误判"官方会话"，
  改成正确的子会话布局（继承段之后再出现自己的 request）。

**验证**：14/14 通过；对账 255 组仍全一致。

---

## 0.2.0 — 设置页

**背景**：v0.1 只能用 `cordis.patch.yml` 改配置、改完重启。按 SPEC §4.9，设置页要有一行
「上传模式」下拉，位置在「常规」里语言/外观之后。

**Host 侧改动**

- 新增 `Config`（schemastery）：`enabled` 与 `mode` 标记 `volatile()`，
  **改完立即生效，不需要重启**；`maxBytes` / `idleDelayMs` / `includeSeeded` / `budget` / `retry`
  一并纳入 schema，设置页才能展示与校验。
- `readConfig()` 新增 `pick()`：volatile 字段运行时是 accessor（`.get()`），普通字段是裸值，
  两种都读成裸值，避免 schema 变化后配置读空。
- `package.json` 增加 `dependencies: { "@deepseek-ai/schemastery": "^3.18.4" }`。

**Client 侧新增**

- `client.js`：注册到 `settings.general.item`，`id: session-log-anywhere`，**`order: 91`**
  （官方那行是 90，所以正好在它下面）。
- 通过 `ctx.configForms.get('session-log-anywhere')` 拿配置表单，
  `ctx.configForms.whileServed()` 等 Host 把 schema 服务出来再挂行，避免渲染出空控件。
- 行结构：左标题 + 随档位变化的说明；右侧档位控件 + 开启开关；未开启时多一行灰字隐私提示。

**为什么开发期会有个 `node_modules` 目录**

包是以 `link:` 方式装进 profile 的（`D:\dsh\3\plugin\...`），Node 会按**真实路径**解析依赖，
而那个目录下没有 `node_modules`，`import '@deepseek-ai/schemastery'` 会解析失败。
所以放了一个 junction 指到 profile 的 `node_modules`：开发期可直接 `node -e` 验证，
打包时 `files` 不含它，不影响分发。

**安装过程**

`install_bundle` 报 `already-installed`（link 包已在依赖里）→ 走 `remove_bundle` + `install_bundle`，
让 Host 重新加载一份模块世代。结果 `application: applied`，
`Config.listConfigs` 的 status 由 `absent` 变为 `schema`，确认新 Host 代码生效。

**验证**：`plugin/check-client.mjs` 覆盖 factory 产出、槽位与 order、组件渲染、写配置，全部通过。

---

## 0.3.0 — 控件重做（主题兼容）

**背景**：截图显示官方暗色主题下，原生 `<select>` 弹出的是**系统浅色面板**，原生 checkbox
是白方块，与整体割裂。

**根因**：原生 `<select>` 的下拉浮层和 `<input type=checkbox>` 的勾选框由操作系统绘制，
CSS 改不动。这不是配色问题，是控件选型问题。

**改动**

- 弃用原生 `<select>` 与 `<input type=checkbox>`。
- 自绘下拉：`<button aria-haspopup="listbox">` + 绝对定位浮层 `<ul role="listbox">`，
  每项 `role="option"`，当前项打勾（`aria-selected`）。
- 自绘开关：`<button role="switch" aria-checked>`，胶囊轨道 + 滑块，开启时用品牌色。
- 交互补全：点击外部关闭（capture 阶段 mousedown）、Esc 关闭、Tab 关闭、
  方向键移动候选、回车/空格选中、`:focus-visible` 焦点环、hover 高亮。
- 颜色**只用主题 token，不写死任何色值**：
  `--dsw-alias-label-primary` / `label-secondary` / `bg-overlay` / `border-l2` /
  `interactive-bg-hover` / `brand-primary` / `label-primary-foreground`（滑块）。
  token 由宿主按亮/暗/皮肤提供，所以官方亮色、官方暗色、以及任意皮肤的自动匹配。
- 图标（箭头、勾）用 `currentColor` 描边，跟随文字颜色。
- 升版本号至 0.3.0。

**验证**：`check-client.mjs` 扩到 21 项，含硬性断言「行内不得出现原生 select/checkbox」，
以及三档齐全、当前项唯一勾选、展开浮层带本地化文案、写配置成功 —— **21/21 通过**。
真实浏览器渲染需刷新页面后目视确认。

---

## 0.3.1 — 选中态样式修正（同日晚）

**现象**：下拉展开后，当前项被填成一条白底，白字白底 → 文字消失；菜单面板也偏浅灰，
与官方「权限」那行的下拉对不上。

**根因**：用 `--dsw-alias-interactive-bg-hover` 当「选中/悬停」的填充色。这个 token 在
当前皮肤里解析成浅色，与 `--dsw-alias-label-primary`（白字）撞车。菜单面板用
`--dsw-alias-bg-overlay` 也在该皮肤下变成半透明灰。

**改动**

- 选中/悬停**不再填充底色**，改为 `box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2)`
  的内描边——不依赖任何可能被皮肤改写的填充 token。
- 菜单底色改用 `--dsw-alias-bg-layer-1`（与下拉按钮同一个面），去掉半透明叠色问题。
- 当前项只保留右侧 ✓（勾用 `--dsw-alias-brand-primary` 着色），与官方「权限」行的表达一致。
- 这一步也是「通用」的关键：不再假设 token 的语义，只依赖文字色与边框色两种不易冲突的量。

**验证**：`check-client.mjs` 21/21 仍通过。

---

## 0.4.0 — 立即上传按钮

**需求**：设置页那一行的左侧加一个「立即上传」按钮；只有档位选「仅手动」时才点亮；
点击后如果当前不该上传，要给出原因（冷却中 / 已是最新）。

**位置**：左侧文字区，说明文字下方。未开启插件、或档位不是「仅手动」时按钮为灰
（`opacity: .4`，不是另外配一种灰——跟其它控件的禁用态一致，任何主题都成立）。

**Host 侧**

- 新增 HTTP 端点 `POST /__session-log-anywhere/upload`（`ctx.webServer.register`）。
  浏览器侧按钮就是打这个口。
- `manualUpload()` 的判定顺序与返回码：

  | 码 | 条件 | 界面提示 |
  |---|---|---|
  | `disabled` | 插件总开关关着 | 插件未开启 |
  | `busy` | 已有手动上传在跑 | 已有上传在进行中 |
  | `cooldown` | 距上次成功上传不足 30 秒 | 刚上传过，N 秒后可再试 |
  | `up-to-date` | 所有活会话都没有待传的非官方内容 | 当前已是最新，无需上传 |
  | `no-key` | 解析不到 API Key | 未配置 API Key |
  | `uploaded` | 实际上传成功 | 已上传 N 个会话，共 M KB |
  | `error` | 异常 | 上传失败，详情看宿主日志 |

- 候选会话与启动扫描共用一个 `collectCandidates()`，判据完全一致（水位之后有事件、
  且区间内出现过非官方 provider），避免两处逻辑漂移。
- 单会话上传包成 `uploadOne()`，用全局计数差算出「这次到底传了几个请求、多少字节」，
  不必改动 `uploadSession()` 本体。
- 冷却只在**真的传了东西**之后计时；「已是最新」不冷却，可以立刻再点。

**安全**：端点是本机 HTTP 路由，只接受 `POST`，并校验 `Origin` 与 `Host` 同源，
跨源返回 403。即便被本机其它页面猜到路径，最坏结果也只是重复触发一次上传——
水位与冷却保证不会重复发送内容。

**Client 侧**

- 按钮三态：可用 / 灰（档位不对）/ 「上传中…」。
- 结果以内联一行文字展示（成功绿、失败红、其余次要色），6 秒后自动消失。
- 档位不是「仅手动」时按钮带 `title` 提示「切到『仅手动』档后可用」。
- 用的都是文字色/状态色 token，不引入新的填充 token。

**验证**

- `check-runtime.mjs` 扩到 **21 项**：路由注册、`uploaded` 真的发了一个请求、
  30 秒内第二次点击返回 `cooldown`、无内容返回 `up-to-date`、关闭时 `disabled`、跨源 403。
- `check-client.mjs` 扩到 **29 项**：按钮存在、非手动档禁用、手动档点亮、插件关闭时禁用、
  点击 POST 到正确路径、提示行渲染并带 tone。

---

## 0.5.0 — 审查修复

一份独立的对抗性审查（`AUDIT-dsh-session-sync.md`）在仓库外做了逐行审读和实验，
报告 1 严重 / 6 中等 / 8 轻微 / 8 观察项。本版按报告修掉绝大部分。

### 严重

**S1 多段续传从不发生** —— `segment()` 成功分支硬编码 `blockedSeq: null`，调用方把 `null`
当成「没被截断，收工」。待传内容超过 `maxBytes` 时，尾巴永远停在那里，无日志、无告警，
界面还显示「已是最新」。

- 修：成功分支返回真实的 `blockedSeq`（`null` 仅表示全部装下）。
- 回归测试：40 条事件 / `maxBytes: 2000` → 请求 8 段、区间首尾相接、水位推进到第 32 条。

**同源缺陷：渠道判定只在循环外做一次** —— 报告指出，只修 S1 会让「前半段非官方、
后半段官方」的尾巴被本插件发出，与内置插件重复。所以同时重做了判定：

- 新增 `governingProvider()`：水位之后第一个 `request/header` 决定这一段归谁；
  没有就沿用之前最近的渠道（`carryProvider`）。
- 新增 `firstOfficialHeader()`：从非官方段往后传，遇到第一条官方 header 就停，
  官方那部分留给内置插件。
- 回归测试：混合渠道会话，「没有任何请求跨过官方边界」。

### 中等

| 编号 | 问题 | 处理 |
|---|---|---|
| M1 | 手动上传不参与 `inflight`，与定时上传撞车会同一段发两遍 | `uploadOne()` 走同一个 `inflight` 集合；测试「手动与定时并发只发一次」 |
| M2 | 切到「仅手动」后，已排队的定时器仍会上传 | 定时器到点重读配置，档位变了直接作废 |
| M3 | 限流按「段」计，重试不扣额度（配 60 实际可打 180） | 额度改到每次真实 HTTP 尝试前扣 |
| M4 | 429 不重试、不重排，段被饿死到下次触发 | 429 与 5xx 一样重试，读 `Retry-After`；重试耗尽后 `schedule()` 重排 |
| M6 | 全部失败仍报「当前已是最新」 | `manualUpload` 区分 `uploaded` / `failed` / `up-to-date`；界面新增失败文案 |

**M5 未改**（默认档位下按钮仍只在「仅手动」时可用）：这是产品方的明确选择，
与规格 §4.9「任何档位都可点」不同，已记录在案。

### 轻微

- **L1** 会话被销毁后仍上传 → `uploadSession` 先查 `ctx.sessions.get()`，找不到就跳过并清队列项
- **L2** 卸载不中止在途请求、卸载后仍写水位 → `activeControllers` 集合，卸载时全部 abort；
  `append` 前再查一次 `disposed`
- **L3** `manualBusy` 的 TOCTOU → 先占位再 `await`
- **L4** `session.append()` 抛错时账实不符 → 计入 `stats.fail`，手动上传会报失败而不是「已是最新」
- **L5** `inheritedEventCount` 缺失时 seeded 会话被静默跳过 → 计算前做 `Number.isFinite` 兜底
- **L6** 配置为 `NaN` 时（`maxBytes`/`maxAttempts`/`maxRequestsPerHour`）行为失控 → `num()` 统一兜底
- **L8** 客户端 fetch 无超时 → 120 秒 `AbortController`

### 观察项

- 端点增加 `x-dsh-sync: 1` 自定义头校验（同源脚本才发得出来），`OPTIONS` 返回 204
- 500 响应不再回传内部异常原文（只进宿主日志）
- `blockedWarned` 改 `WeakMap`，会话销毁即回收
- `wireEvent` 的 `ignorable` 分支补上 `KNOWN_EVENT_TYPES` 判定，与核心条件一致
- 失败日志不再重复打印 key 指纹
- `check-runtime.mjs` 的重试配置原本放错层级（顶层 `maxAttempts`，而代码读 `retry.maxAttempts`），
  导致重试路径从未被覆盖——已改正，并补了 500 / 429 / 并发 / 降档 / 卸载共 6 组回归测试

### 测试数量

| 脚本 | 之前 | 现在 |
|---|---|---|
| `check-runtime.mjs` | 21 | **33** |
| `check-client.mjs` | 29 | 29 |
| `check-envelope.mjs` | 51 会话 | 52 会话，0 差异 |

### 仍未解决

- **`check-envelope.mjs` 是自比较**：`tools/reference/envelope.mjs` 与插件同源，
  它能挡回归，但不能证明与核心实现等价。要真正对账得在能读 `app.asar` 的环境里跑。
- **L7** `turn/end` 的 `forked` 跳过保留原样：核心的 forked 是给继承段补的合成收尾，
  跳过基本无害；极端情况下会话最后一条正是它时不会获得定时触发。

---

## 0.5.1 — 复审修复

0.5.0 交给同一套对抗性流程复审。九项修复被逐条跑实验确认成立，但指出四个新的边界问题。
本版全部处理。

### R1（中等）官方优先窗口导致会话永久停摆

**现象**：如果水位之后第一条 `request/header` 就是官方渠道，本插件跳过这一段且不动水位。
只要内置插件没在推水位（用户关了内置上传开关，或内置 `accept()` 失败），这条会话
——包括用户之后切回第三方渠道的部分——再也不会被上传，而界面会回「已是最新」。

**改动**：
- 这条路从 `debug` 提到 `warn`，文案直说「内置上传插件拥有这一段且没有推进水位，
  如果一直不动请检查内置开关」，每个会话只提醒一次；
- `collectCandidates()` 用与上传路径相同的口径（`governingProvider`）排除这类会话，
  手动点击不再对着一条永远不会被自己上传的会话谎报「已是最新」。

### R3（轻微）在途上传时点按钮报「已是最新」

`uploadOne()` 撞上 `inflight` 时既不计成功也不计失败，结果落到 `up-to-date`。
现在单独统计 `skippedInflight`，返回 `busy`，界面用已有的「已有上传在进行中」文案。

### R2（轻微）段数用尽后不再排程，尾巴无限期留着

`MAX_SEGMENTS_PER_RUN`（8 段）跑满后原本直接收工，安静会话等于永久停在半路。
现在会自动续传，但有上限：

- 每次触发最多续 `MAX_DRAIN_ROUNDS`（4）轮 → 32 段；
- 必须有上限，因为每传一段都会追加 `delivery-accepted`，传完真实内容后它会自己成为
  下一轮的待传事件，没有上限就会一直转；
- 外部 `turn/end` 会把续传计数清零，用户的新一轮对话能重新排空。

### R4（轻微）失败重排没有上限

服务端持续 5xx 时原本每 60 秒永久重排，持续争抢滑动窗口的额度，可能饿死其它会话。
现在按会话记连续失败次数：指数退避（60s × min(streak,5)），超过 3 次停止自动重排并
`warn` 一次，等下一次 `turn/end` 或手动点击再试；成功一次即清零。

### 观察项

- **`KNOWN_EVENT_TYPES` 标注来源**：注明对照 `@deepseek-ai/dsh-session 0.2.1-rc.5`，
  并记录实测（本机 2423 条 `ignorable` 事件全部是插件自定义类型，没有一条命中该表，
  因此当前不产生字节分叉）。核心新增事件类型时需要同步。
- **`carryProvider` 增量缓存**：水位只增不减，改为按会话缓存「扫到哪 + 最后一个 provider」，
  正常路径只做增量扫描，不再每次倒走全表（大日志下 `collectCandidates` 的放大问题）。
- **`activeControllers` 从模块级改为实例级**：卸载不再误伤同进程其它实例的在途请求。
- **`wireHeader` 的 `seedLength` 兜底**：`inheritedEventCount` 非有限数时直接不带这个字段，
  不再可能写出 `"seedLength": null`。

### 测试

`check-runtime.mjs` 从 33 条扩到 **40** 条，新增：

- 官方优先窗口：不产生请求、有 warn、手动点击不谎报
- 段数耗尽：请求数超过 8 且原始事件全部覆盖
- 在途点击：返回 `busy`
- `inheritedEventCount` 缺失：载荷里不出现 `seedLength`

现状：runtime **40/40**、client **29/29**、envelope **52 会话 0 差异**。

### 仍未处理

- **M5**：默认档位下「立即上传」按钮仍只在「仅手动」时可用（产品决策，与规格 §4.9 不同）
- **L7**：`turn/end` 的 `forked` 跳过保留
- **`check-envelope.mjs` 自比较**：仍不能证明与核心等价

---

## 0.5.2 — R1 收尾与核心等价证明

第三次复审（增量）确认 R2/R3/R4 修到位，同时推翻了我此前的两个判断，也暴露了 R1 只完成 2/3。

### R1 收尾：把「归内置」和「已是最新」分开说

0.5.1 把官方优先窗口的会话从候选里排除了，但排除之后候选数为 0，手动点击仍然返回
`up-to-date` —— 界面结论和修复前逐字节相同。等于只省了一次无用上传，没说清原因。

现在：

- `collectCandidates()` 单独统计 `officialOwned`；
- 候选为空但存在归内置的会话时，返回新结果码 **`official-owned`** 并带上数量；
- 客户端新增文案：「有 N 个会话的待传内容归内置插件上传，请检查上面官方那行的开关」；
- 启动扫描也会打一行 info 说明有 N 个会话留给内置上传器。

测试：官方优先窗口的会话，手动点击现返回 `{"code":"official-owned","officialOwned":1}`。

### 采纳与核心的实测等价证明

我此前说「`app.asar` 里的核心包读不出来，所以只能自比较」——**这个前提是错的**。
`app.asar` 是 pickle（8 字节头 + JSON 目录 + 连续文件块），按偏移 `readSync` 就能取到任意文件。

复审交付了 `tools/check-core-parity.mjs`（本版收进仓库）：

1. 从 `app.asar` 取出 `@deepseek-ai/dsh-session-log-deepseek/lib/index.js`；
2. 只把三个 `@deepseek-ai` import 换成等价 stub，**其余逐字保留**；
3. 用假 ctx 捕获核心自己的 `prepare()`；
4. 与本插件的 `segment()` 对同一批会话、同一水位、同一 `maxBytes` 比对完整 JSON（含 `afterSeq`，
   所以水位算法也一并对上）。

```
sessions            52
comparisons         208      （52 会话 × 4 档 maxBytes）
core errors         0
mismatches          0
```

**「线格式与核心等价」这条从推定变成了实测证据。** 该脚本绑定 DSH 安装路径与核心包名，
核心大版本变更后要跟着修 stub；安装位置不同用 `DSH_ASAR` 环境变量指定。
它不覆盖插件独有的官方边界截断与触发调度——那些本来就不属于核心。

### 两处改判（维持原状，但理由记下来）

- **M5**：上一轮判它是「与规格的偏差」，这一轮复审改判为**需求覆盖规格**，代码不动。
  唯一的残留是文档一致性——已在本仓库的 `SPEC-跨渠道会话日志上传.md` §4.9 加注记，
  写明「v0.4.0 起按钮仅 manual 档启用（产品决策），本条『任何档位都可点』作废」，
  省掉下一轮审查再报一次同样的偏差。
- **L7**：`turn/end` 的 `forked` 跳过保留。为它排程会让每次 fork 都给父子会话各添一次
  上传触发，内容大半是 `includeSeeded=false` 本来就要跳过的继承段，属于负收益。

### 测试

| 脚本 | 数量 | 现状 |
|---|---|---|
| `check-core-parity.mjs` | 52 会话 × 4 档 | 208/208 一致 |
| `check-runtime.mjs` | 40 | 全过 |
| `check-client.mjs` | 29 | 全过 |
| `check-envelope.mjs` | 52 会话 | 0 差异（回归护栏） |

---

## 0.5.3 — R5 与结果码口径

第四次复审确认 0.5.2 的全部声明成立（R1 三条子项到位、核心对账脚本可跑、
SPEC 注记落地、四套测试通过），并指出最后一个「结论码与事实相反」的成员。

### R5（轻微）单条事件超 `maxBytes` 时手动点击报「已是最新」

**现象**：待传区间的第一条事件自己就超过上限时，一个请求都发不出去，
`uploadSession` 返回 `blocked`，但 `uploadOne` 只统计成功/失败计数——两者都是 0，
于是落到 `up-to-date`。界面说「当前已是最新，无需上传」，唯一线索是宿主日志里一条 warn。

**改动**

- `uploadOne()` 把 `uploadSession` 的结果状态透出来（`status` / `blockedSeq`）；
- `manualUpload()` 单独统计 `blocked`，返回新结果码 **`blocked`** 并带计数与首个阻塞 seq；
- 客户端新增文案与红色 tone：「有 N 个会话存在超过大小上限的单个事件，本次一个请求都没发。
  请调大上限或处理该事件。」；
- 结果码优先级补全：`uploaded` → `failed` → `blocked` → `busy` → `official-owned` → `up-to-date`。

### 观察项：`ok` 字段与结果码同口径

路由原先只把 `uploaded` / `up-to-date` 认作 `ok: true`，导致 `busy`、`official-owned`
这两个「info 语气」的码回 `ok: false`。客户端只看 `code`，所以此前没有可见影响，
但任何按 `ok` 判断的调用方（将来的 CLI、外部脚本）都会读错。

改成白名单取反：

```js
const ok = !['disabled', 'no-key', 'failed', 'cooldown', 'error', 'blocked'].includes(result.code);
```

### 另一个同族漏洞（观察项 2）

`official-owned` 原先只在候选为空时返回；若候选非空但全部零请求（`no-provider` 之类），
最终会落到 `up-to-date` 并把计数丢掉。现在末尾分支也会检查 `officialOwned`。

### 测试

`check-runtime.mjs` 从 40 条扩到 **45** 条，新增：

- 超大首事件：返回 `blocked`、`ok: false`、零请求；
- `ok` 口径：`cooldown` 为 `false`、`uploaded` 为 `true`。

现状：parity **208/208**、runtime **45/45**、client **29/29**、envelope **52 会话 0 差异**。

---

## 0.5.4 — 文档与测试覆盖补齐

第五次复审确认 R5 关闭、R1–R5 全部结案，只剩两条非代码问题，都在这版处理。

### 文档：验证工具一览是旧数字

那段表头写着「现在的状态」，内容却停在 0.3.0：`255 组`、`14/14`、`21/21`，命令还指向
`plugin/check-*.mjs`（旧目录）。这是全篇最容易被信任的一段，已按当前实测重写为
`208/208`、`45/45`、`32/32`、52 会话 0 差异，路径改为 `tools/`，并补上核心对账脚本
及其 `DSH_ASAR` 说明。

### 测试：三个新结果码在客户端零覆盖

`blocked` / `busy` / `official-owned` 的 `describeResult` 分支与文案替换此前没进
`check-client.mjs`——文案是手写的、`{n}` 是手工替换的，正是最容易在下次改动里错位的地方。

要让它们可测，先把 harness 的 React 替身从「hooks 返回固定初值」升级为
**持久化 slot + 重渲染**：`useState` 的 setter 会写回 slot 并标记重渲染，于是
「点击按钮 → 处理响应 → 结果提示出现在界面上」这条链第一次能在离线环境里断言。

新增 3 条：

- `blocked` → error 色调 + `noticeBlocked`
- `busy` → info 色调 + `noticeBusy`
- `official-owned` → info 色调 + `noticeOfficialOwned`

顺带发现并修正了 harness 自己的一个问题：`SettingsRow` 里有一个 `useEffect`，
所以 hooks 槽位顺序是 `busy → notice → effect → open → active`，之前的槽位表少算了
effect 那一格（当时靠固定初值掩盖了）。

### 测试

| 脚本 | 现状 |
|---|---|
| `check-core-parity.mjs` | 208/208 |
| `check-runtime.mjs` | 45/45 |
| `check-client.mjs` | **32/32**（新增 3 条） |
| `check-envelope.mjs` | 52 会话 0 差异 |

### 审查侧的一条长期提醒（已记入仓库 README）

`check-core-parity.mjs` 绑定 DSH 安装路径与核心包名，**核心升级后 stub 要跟着改**，
否则它会安静地继续通过（或直接报 NOT FOUND）。建议把「跑一次核心对账」加进核心升级清单。

---

## 0.5.5 — manual 档续传语义与断言强度

第六次复审确认 0.5.4 三条声明全部成立、四套数字与实跑一致，指出两个问题：
manual 档的续传语义说了假话，以及测试断言只到"键名"这一层。

### M6（轻微）manual 档点一次只发 8 段，日志谎报"继续中"，回复不含剩余量

**现象**：manual 档点「立即上传」，`uploadSession` 连发 8 段就停，尾部照常打印
`segment budget spent, continuing (1/4)`；但 `schedule()` 在 manual 档第一行就返回，
实际不会继续。回复只有 `{requests: 8}`，界面说「已上传 1 个会话」，不告诉用户还剩多少。

**改动**：

- manual 档走到尾部时不再走续传分支，改打真实日志
  `segment budget spent (8), N event(s) left — click "Upload now" again to continue`；
- 剩余量随结果返回：`uploadOne` → `manualUpload` → HTTP 响应 `remaining`；
- 客户端「已上传」文案在 `remaining > 0` 时追加
  「还有 N 条待传，再点一次『立即上传』可继续」。

### L8 / L9（观察项）一并处理

- 新增 `countPendingContent()`：算"还剩多少"时排除本插件自己写的 `delivery-accepted`。
  之前用 `session.seq - after - 1` 会把水位事件也数进去，既撑大剩余量，也会白占一轮续传额度。
  注意这**只影响日志与展示**，发送窗口仍必须连续，不能跳着取。
- manual 档不再自增 `drainRounds`：原来连点 5 次会打出一条不存在的
  `stopped draining after 4 rounds` 警告。

### 断言强度

复审指出 `t: (key) => key` 让 `collectText()` 拿到的是**键名**，
`text.includes('noticeBlocked')` 只证明"选了哪个键"，文案正文和 `{n}` 替换都不在校验范围。

改法：`check-client.mjs` 从 `client.js` 源码里抽出真实的 `zh` 文案表作为 `t()`，
所有断言改为比对真实正文，并新增占位符检查：

- `blocked` → `noticeBlocked` 的正文里 `{n}` 已被替换成计数；
- `official-owned` → 同样校验；
- `uploaded` + `remaining: 7` → 正文必须是「已上传 2 个会话，共 20 KB。还有 7 条待传，再点一次…」。

`check-client.mjs` 从 32 条涨到 **35** 条。

**仍未覆盖**：组件里的两个 `useEffect`（关闭浮层、提示自动消失）不执行——替身的
`useEffect` 只占位不跑回调，因为执行它们需要 `document` 与定时器的完整 mock。
复审已记下，留给以后。

### 测试

| 脚本 | 现状 |
|---|---|
| `check-core-parity.mjs` | 208/208 |
| `check-runtime.mjs` | **49/49**（新增 manual 续传 4 条） |
| `check-client.mjs` | **35/35**（断言改为真实文案 + 占位符） |
| `check-envelope.mjs` | 52 会话 0 差异 |

---

## 0.5.6 — 文档数字守卫

「验证工具一览」这张表连着腐化两次：0.5.4 刚对齐完，0.5.5 加了测试又只改了版本段、
忘了改总表（45/45、32/32 对不上 49/49、35/35）。人工同步显然不可靠。

本版做了两件事：

1. 表内数字改回实测值（parity 208/208、runtime 49/49、client 35/35、envelope 52 会话 0 差异）；
2. 新增 `tools/check-docs.mjs`：跑一遍四个套件，从各自输出里解析实际数字，
   与 CHANGELOG 里这张表逐项比对，不一致就退出码 1 并打印差在哪一行。

```
$ node tools/check-docs.mjs
PASS  check-core-parity.mjs  {"sessions":52,"comparisons":208,"mismatches":0}
PASS  check-runtime.mjs  49
PASS  check-client.mjs  35
PASS  check-envelope.mjs  {"sessions":52,"mismatches":0}

文档数字与实测一致
```

它只守护这一张表，不校验版本段里的历史数字——那些是当时的记录，本来就该保持不动。
`--no-run` 可以跳过执行、只做结构检查。

---

## 0.5.7 — 一处排版

成功提示由两段文案拼成：`noticeUploaded` + `noticeUploadedMore`。原来用
`` `${base} ${t('noticeUploadedMore')}` `` 拼接，连接处固定一个 ASCII 空格，
中文就成了「…共 20 KB。 还有 7 条待传…」——句号后面多一个半角空格。

改法不是简单删空格（英文那句需要它），而是**把空格交给各自的文案模板**：

- `zh.noticeUploadedMore` = `还有 {n} 条待传，再点一次「立即上传」可继续。`（无前导空格）
- `en.noticeUploadedMore` = ` {n} event(s) still pending — …`（有前导空格）
- 拼接处改为直接相连

`check-client.mjs` 的期望串同步改为同一拼法，输出现在锁的是
「已上传 2 个会话，共 20 KB。还有 7 条待传，再点一次「立即上传」可继续。」

至此第七次复审提出的意见全部处理（该轮只提了这一条）。

---

## 0.5.8 — 版本依赖写进 README

代码没动。把散在脑子里的版本约束写进 `README.md` 的「版本要求」一节：

- 三层依赖：`engines.dsh`、`@deepseek-ai/schemastery ^3.18.4`（`.volatile()` 需 3.18.2+）、
  客户端 `inject` 的两个包（缺了设置行静默不出现）；
- **预发布 semver 盲区**：`>=0.2.1-rc.3` 匹配 `0.2.1-rc.5`，但**不匹配** `0.2.2-rc.1`，
  因为 node-semver 只放行「范围里有同 tuple 预发布比较符」的版本。被排除的后果是从市场的
  兼容筛选里静默消失，不报错、不告警；
- 维护动作与示例范围（`">=0.2.1-rc.3 <0.2.2-0 || >=0.2.2-rc.1"`），并说明它不是一劳永逸的。

项目自身的版本号仍在 0.5.x（npm 语义），与上面的宿主版本要求无关。

---

## 0.5.9 — 差异化声明与失效场景

代码没动。补两份文档，都是需要在被质疑之前先说清楚的事。

### 与同类插件的差异

调研发现 [`yihefeikong-rgb/dsh-session-log-universal`](https://github.com/yihefeikong-rgb/dsh-session-log-universal)
解决的是同一个问题：第三方 provider 驱动的会话日志进不了官方收集端。它直连官方 OTLP 收集端，
全量重传（含子会话），并且**与内置插件各记一份**（作者说明是为覆盖面而有意为之）。

本插件选了相反的取舍，README 里写明了这是**有意的**，不是没考虑过：

- 通道不追求"更干净"，追求"不会重复"——承载的仍是内置插件那个 `dsh_session_log` 字段；
- 水位与内置插件完全共享，所以零重复；代价是官方窗口那一段本插件推不动；
- 三档触发而非事件级实时，默认"收尾与空闲"以控制请求量。

### 失效场景

新增一张表，列出让它**不工作或只工作一部分**的情形：服务端不再解析该字段（200 但什么都没入库）、
水位后首个请求走官方且内置不在推水位（会话永久停摆）、单条事件超 `maxBytes`、key 失效、
会话已不活跃（启动扫描只覆盖活会话）、手动档每次最多 8 段、内置开关被关掉。

表里每条都给了"该怎么办"，并把"无法证明服务端入库"重申了一次。

### 调研顺带确认的事实

`https://dsh-otel-collector.deepseeksvc.com/v1/logs` 实测可访问：空 JSON 直接 POST 返回 **200**，
不需要鉴权。也就是说确实存在一条比"借道 chat 请求"更直接的官方通道。**本版不切换**——
OTLP 那边没有水位概念，内置插件仍会照发它那一份，切过去必然从"零重复"变成"必然重复"，
与本插件的设计目标相反。

---

## 1.0.0 — 正式版

第一个稳定版。功能集与 0.5.9 相同，改动是发布准备：

### 改名

包名从 `dsh-session-sync` 改为 **`dsh-session-log-upload`**。

原因是 npm 上的 `dsh-session-sync` 已被占用——是 `PerryLink` 的「跨设备会话 git 同步」插件
（0.2.31，功能完全不同：它把会话库做成 git 镜像做多机同步，本插件是把会话日志送到 DeepSeek）。
npm 包名全局唯一，只能换名；顺带也避开了「GitHub 上两个同名仓库、功能却不同」的混淆。

随之同步改动的标识（必须一致，否则加载失败）：

| 位置 | 新值 |
|---|---|
| `package.json` 的 `name` | `dsh-session-log-upload` |
| `cordis.patch.yml` 的 `id` / `name` | `dsh-session-log-upload` |
| `client.js` 的 module loader id、locale 命名空间、样式标签 | `dsh-session-log-upload` |
| `index.js` 的插件 `name` 导出、日志前缀 | `dsh-session-log-upload` |
| 手动上传端点 | `POST /__dsh-session-log-upload/upload` |

GitHub 仓库同步改名为 `dsh-session-log-upload`（旧地址由 GitHub 自动重定向），`repository` 字段跟着指向新地址。

### 版本语义

1.0.0 表示接口与行为定型：配置键、结果码、水位写法、插槽位置都不再随小版本变。
后续遵循 semver——行为修正走 patch，新能力走 minor，破坏兼容才动 major。

### 验证

四套全绿（parity 208/208、runtime 49/49、client 35/35、envelope 52 会话 0 差异），
改名后复跑确认没有把标识改漏。

### 文档：README 顶部免责声明

按「非官方插件」的定位补了一段声明，覆盖：与官方无隶属关系、上传内容范围、不做脱敏与合规审查、
默认关闭、自动化请求可能被认定为非人工流量、依赖未公开的 API 行为因此不保证可用、MIT 按原样提供。

修订了草稿里的两处事实错误：包名从 `dsh-session-upload` 更正为 `dsh-session-log-upload`；
「上传至 DSH 官方 API 通道」改为「用你自己配置的 DeepSeek API 凭据向 `api.deepseek.com` 发送一次最小 chat 请求」，
并补明只上传非官方渠道那一段（官方渠道归内置插件）。

---

## 1.1.0 — 首次开启的风险确认

1.0.0 补上了「默认关闭 + README 免责声明」，但开关本身仍是**一点就开**：用户看到的是
「跨渠道会话日志上传」、「开启跨渠道上传」，不一定意识到这一步就等于把会话日志发往
DeepSeek。本版在开关前面加一道确认。

### 形态

点开关由「关」到「开」时，先弹官方那个风险确认对话框——与「设置 → 权限」里切
「完全权限」用的是同一个组件（`@deepseek-ai/dsh-client-ui-primitives` 的
`RiskConfirmation`）。外观、遮罩、Esc、焦点管理、亮暗主题因此全部与官方一致，
插件这边没有自绘任何弹层样式。

内容比权限那个短，只讲这一次授权：

- 标题：确认启用跨渠道上传？
- 正文三行：日志去哪（用你已配置的 DSH API 凭据发往 DeepSeek）／不做脱敏且自动触发／
  授权与合规由用户自己承担
- 勾选框：我已了解风险，并愿意继续（未勾选时「启用上传」是禁用态）
- 按钮：取消 / 启用上传

### 判定

- **只在首次**：确认过就把 `acknowledged: true` 写进配置，之后开关直通，不再打扰。
- **关不确认**：由「开」到「关」直接生效。
- **取消等于没点**：不写 `enabled`，开关保持原状，也不写 `acknowledged`。
- **确认是一次原子动作**：`acknowledged` 与 `enabled` 一起写，不留下「已授权但没开」或
  「开着但没授权」的中间态。

### 兼容退路

`RiskConfirmation` 是核心 Web 前端的静态模块导出。更老的核心若没有导出它，插件退化成
**行内确认面板**（标题 + 三行 + 自绘勾选框 + 两个按钮，样式仍走主题变量），判定逻辑一字不差。
两条路径在 `check-client.mjs` 里都跑过：假模块提供 `RiskConfirmation` 时断言弹层，
不提供时断言行内面板。

### 新增配置键

`acknowledged: boolean`，默认 `false`，非 volatile（随配置持久化）。
Host 侧不拿它做准入判断，它只是「用户确认过」的标记——要是拿它挡上传，
手改配置启用插件的人会突然传不上去。

### 验证

parity 54 会话 × 4 档 = 216/216、runtime 49/49、client **51/51**（35 → 51，
新增 16 条覆盖首次确认、取消、二次启用、关闭、退路面板）、envelope 54 会话 0 差异，
`check-docs.mjs` 通过。

---

## 1.1.1 — 复审修复（原子性、门禁、空语料）——已被 1.1.2 取代一部分

1.1.0 的复审结论是：判定逻辑成立、官方组件契约也对得上，但对外部世界有两个假设撑不住。
本版只修这些，不加功能。

### F1（中等）确认不是原子的，失败还全被吞掉

`confirmRisk` 原本连续调两个互不等待的 `form.set`，各自的 rejection 都被 `.catch(() => {})`
吃掉。只要有一步失败，就落进一个没人提示的中间态：最常见的是「授权记下了、启用没落盘」——
开关看着没反应，而且下次再点也不会弹确认了。

改成可串联、可失败的写：

- `setMode` / `setEnabled` / `setAcknowledged` 不再自己吞错，返回值原样冒泡；
  「改了就行」的调用点用 `swallow()` 显式忽略，确认流程 `await` 每一步。
- **先启后记**：顺序是 `enabled` → `acknowledged`。中途断掉时宁可留「开着但没授权」
  （下次还会问），也不留「已授权但没开」。
- 任一步失败 → 把 `enabled` 退回 `false`，并显示一条错误提示
  （新文案 `noticeConfirmFailed`：配置没写进去，本次未启用）。

最坏情况从「静默半截状态」变成「什么都没变 + 一条错误提示」。
（1.1.2 起这条两步写被简化成单次写，见下一节。）

### F2'（附带）`disabled` 门禁没传

官方 `RiskConfirmation` 的确认按钮是 `disabled: disabled || !acknowledged`，勾选框也吃
`disabled`；官方消费者会传 `disabled: !writable`。插件原来没传，默认 `false`——配置只读时
弹层照常能点，点完就是 F1 那条静默失败。

现在传 `disabled: !ready`；退路面板的「启用上传」也一起加上 `|| !ready`。

### F3（轻微）`check-envelope` 在 0 会话时判绿

`listSessionFiles()` 会吞掉 `readdirSync` 的错误，读不到 `~/.dsh` 时返回空数组，
于是「什么都没查」和「全部一致」输出完全相同，都 `exit 0`。换机器、换 `DSH_HOME`、
或者关键词把语料筛空，都会复现。

现在 `checked === 0` 直接打印 `ENVELOPE-NOT-RUN` 并以 **exit 2** 退出，消息里带上
会话目录与两种原因（一个文件都没找到 / 文件全部读取失败）。

### F4 / F5（轻微）文档

- 本文件抬头「当前版本」还停在 1.0.0（F4）。
- 「超大历史会话：单次运行最多连发 8 段」与 0.5.1 起的 4 轮续传、0.5.5 起 manual 档
  「再点一次继续」相反（F5），已改成实际语义。

### F6（观察）退路面板的键盘

自绘的退路面板补了 `Escape` 取消与勾选框 `autoFocus`；官方弹层的焦点管理本来就有。
另外把 1.1.0 弹层的目视验收记录写进了「已知限制」——已确认真实浏览器下可用，
亮色主题仍未逐项确认。

### 验证

parity 55 会话 × 4 档 = 220/220、runtime 49/49、client **55/55**（51 → 55，
新增只读门禁、写失败回滚、失败提示）、envelope 55 会话 0 差异、`check-docs.mjs` 通过。
另外手动跑了一次 `DSH_HOME=/nonexistent`，确认 envelope 现在 exit 2 而不是绿色。

---

## 1.1.2 — 确认改成「每次启用都问」

产品决定，不是缺陷修复：不再区分首次与之后，开关每次由「关」到「开」都要重新确认。

这么改不只是"多问一次"。1.1.1 里的确认是两步写（`enabled` + `acknowledged`），宿主侧做不成事务，
只能靠"先启后记 + 失败回滚"兜底。改成每次都问之后，`acknowledged` 这个键整个消失，
确认动作只剩**一次写**（`enabled: true`）——单次写本身就是原子的，
「授权记下了但没启用」这类半截状态从结构上就不存在，兜底代码也可以删掉。

### 变更

- 开关「关 → 开」一律先弹确认；取消不写任何东西。
- `confirmRisk` 只剩 `await setEnabled(true)`；失败显示 `noticeConfirmFailed`，不静默。
- 删除配置键 `acknowledged`（Host `Config`、`DEFAULTS`、客户端 setter 一起删）。
  老配置里残留的这个键不会再被读；schemastery 不剥未知键，它会原样留在解析结果里
  （没人读、也不影响行为），所以**不需要手工清理**，但它也不会"消失"。
- 「开 → 关」依然不弹。

### 代价

每次开启多点两下（勾选 + 确认）。若哪天觉得烦，可以换成「只有切到自动档才问」的变体
（`仅手动` 档不点不发，风险低得多），判定逻辑大概多一层。

### 复审后的两处小修（F7 / F8）

- **F7 关闭失败曾被静默吞掉**：`requestEnable(false)` 走的是 `swallow()`，注释写着「改了就行」——
  可「关掉上传」不是改了就行：写失败时插件仍开着、继续按策略发日志，而开关停在原位、没有任何提示。
  这是 fail-open，方向与安全意图相反。现在关闭也 `await`，失败显示 `noticeDisableFailed`
  （关闭失败：配置没写进去，插件可能仍在运行）。
- **F8 文档措辞**：上一版写「loader 会按未知键丢掉」不成立，schemastery 不剥未知键，
  它会原样留在解析结果里。改成事实描述，并点明不需要手工清理。

### 验证

client **56/56**（确认只写一个键、再开一次还会问、关不弹、开启失败不写也不静默、
关闭失败不写也不静默）。parity 220/220、runtime 49/49、envelope 55 会话 0 差异、
`check-docs` 通过。

---

## 验证工具一览

| 脚本 | 作用 | 现在的状态 |
|---|---|---|
| `tools/check-core-parity.mjs` | 从 `app.asar` 取出核心包原样跑，与本插件逐字节对账 | **55 会话 × 4 档 = 220/220**，0 错误 |
| `tools/check-runtime.mjs` | mock fetch + mock ctx 跑 Host 行为（结果码、并发、重试、卸载） | **49/49** |
| `tools/check-client.mjs` | 假 `__ModuleLoader__` 里跑设置页控件，含点击、结果提示、每次开启的确认、开启/关闭写失败 | **56/56** |
| `tools/check-envelope.mjs` | 分段/水位的回归护栏（与 `tools/reference/` 比对，读真实日志） | 55 会话，0 差异；0 会话时 exit 2 |
| `tools/check-docs.mjs` | 跑上面四个套件，与上面这张表比对数字 | 文档数字与实测一致 |

> `node tools/check-docs.mjs` 会跑一遍套件并与本表比对。它盯的是**能被我改错的部分**：
> runtime / client 的断言条数、parity 与 envelope 的内部一致性（会话数 × 档数 = 比对组数）以及
> 必须是 0 的差异数。**会话数本身不做硬比对**——它随本机日志增长，今天 55、明天可能 58，
> 那是环境在变，不是文档写错。

复跑（在仓库根目录）：

```bash
node tools/check-core-parity.mjs   # 需要 app.asar；位置不同用 DSH_ASAR 指定
node tools/check-runtime.mjs
node tools/check-client.mjs
node tools/check-envelope.mjs
node tools/check-docs.mjs          # 上面这张表与本文件数字的守卫
```

---

## 设计决策与取舍

1. **不 import 任何库解决「能不能跑起来」**：起初完全零依赖，靠运行时数值就是普通
   number（branded 类型只在编译期有意义）。0.2.0 为了设置页才引入 schemastery。
2. **无构建步骤**：`client.js` 手写 `window.__ModuleLoader__.load({id, factory})`，
   与官方客户端包同构，不需要打包器，也不需要 `pnpm run dev:web`。
3. **水位只在插件里写**：脚本（`bin/sessionlog.mjs`）刻意不写水位，避免去改 zstd 活文件；
   真正的 `delivery-accepted` 一定由插件用 `session.append()` 落盘。
4. **启动扫描只覆盖活会话**：非活会话没有 `Session` 对象，无法 `session.append()` 落水位，
   硬传只会每次重发。宁可漏，不重复。
5. **至少一次而非恰好一次**：接受即 2xx，没有服务端回执，崩溃后重放是设计允许的。

---

## 已知限制（未完成项）

- **`manual` 档只有一个入口**：设置页的「立即上传」按整轮跑，不能指定某个会话单独补传。
- **待传概览 / 单会话补传**：SPEC §4.9 里的建议行（`7 个会话待传，合计 1.2 MB`）未做。
- **只有一行设置项，没有独立页面**：够用，但不是「会话日志上传」整块分区。
- **无法证明服务端入库**：与官方客户端一样，2xx 是唯一信号。
- **超大历史会话**：一次触发最多连发 4 轮 × 8 段（`manual` 档一次点击只跑 1 轮 8 段），
  剩下的等下一次触发或再点一次。触发器不会无限自转，这是故意的。
- **真实浏览器下的视觉验收**：设置行与 1.1.0 的确认弹层已在真实浏览器里目视确认
  （自定义暗色皮肤，含勾选、取消、开关状态不变）；**亮色主题仍未逐项目视确认**。

---

## 变更文件索引

```
D:\dsh\3\dsh-session-sync\
├─ index.js               Host 半场：判定、分段、上传、水位、限流、触发
├─ client.js              设置页那一行：自绘下拉 + 开关 + 风险确认
├─ package.json           bundle + client 声明 + schemastery 依赖
├─ cordis.patch.yml       默认配置，enabled: false
├─ tools\
│  ├─ check-core-parity.mjs  与核心包逐字节对账
│  ├─ check-runtime.mjs      宿主行为
│  ├─ check-client.mjs       客户端行为（含每次开启的确认）
│  ├─ check-envelope.mjs     分段对账
│  └─ check-docs.mjs         文档数字守卫
├─ README.md              用法、差异与失效场景
├─ CHANGELOG.md           本文件
└─ LICENSE                MIT
```
