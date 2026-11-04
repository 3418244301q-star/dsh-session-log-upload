# dsh-session-sync

内置插件 `@deepseek-ai/dsh-session-log-deepseek` 只搭官方适配器的便车：`dsh_session_log`
作为顶层字段挂在官方 chat 请求上。第三方渠道（ollama-local / pi-ai / OpenAI 兼容）不走那条
适配器，日志永远上不去。本插件自己发一次最小请求承载同一个字段，并用**同一个水位事件**
落盘，所以和内置插件共存、不重复。

协议细节来自核心包 `@deepseek-ai/dsh-session-log-deepseek` 与
`@deepseek-ai/dsh-deepseek-llm-api-extensions` 的源码，以及本机实测。

## 配置

`cordis.patch.yml` 给的是默认值，`enabled` 默认 `false`（不发任何东西）。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 关着就零网络活动 |
| `mode` | `deferred` | `manual` / `deferred` / `realtime` |
| `apiKeyRef` | `DEEPSEEK_API_KEY` | 走 `ctx.credentials`；取不到再退回同名环境变量 |
| `model` | `deepseek-flash` | 承载请求用的官方模型 |
| `maxBytes` | `8388608` | 单段上限，与内置插件一致 |
| `idleDelayMs` | `600000` | `deferred` 档空闲判定 |
| `includeSeeded` | `false` | 是否也传 seeded 子会话（只传继承段之后） |
| `budget.maxRequestsPerHour` | `60` | 全局限流，超限排队而非丢弃 |
| `retry.maxAttempts` / `baseDelayMs` | `3` / `2000` | 指数退避重试 |

## 行为

- 只处理**待传区间内出现过非官方 provider** 的会话；整段都是 `deepseek-official`
  的交给内置插件。判定依据是 `request/header` 事件的 `data.header.config.provider`。
- 上传成功后写 `session-log-deepseek/delivery-accepted { sessionId, sessionFormatVersion, throughSeq }`，
  与内置插件共用水位。
- `manual` 档：不注册定时器、不监听 `turn/end`，零网络活动（启动扫描只打日志）。
- `deferred` 档：`turn/end` 后起 `idleDelayMs` 计时，期间有新事件就重置。
- `realtime` 档：每次 `turn/end` 入队，同会话重复入队合并。
- 启动后 5 秒扫一次活着的会话，补崩溃/强杀漏掉的收尾。
- 单段超限只告警一次，水位不前移；失败不写水位（至少一次语义）。
- 卸载时清空队列与所有定时器。

## 设置页（v0.2.0 起，v0.3.0 重做为自绘控件）

「设置 → 通用」里，官方那行「在使用官方模型 API 时上传 Session Log」（order 90）下面新增一行
`order: 91`：左边标题 + 随档位变化的说明，右边是模式下拉（仅手动 / 收尾与空闲 / 每轮实时）
和一个开关。`enabled` 与 `mode` 都是 volatile，选完立即生效，不用重启。

- 未开启时下拉仍可见可操作，下方多一行灰字说明「开启后会把非官方渠道的会话日志发送到 DeepSeek」。
- 左侧文字区下方有「立即上传」按钮：**只有档位选「仅手动」时可用**，其它档位为灰色（带原因提示）。
  点击后按顺序判定：插件未开启 / 已有任务在跑 / 30 秒冷却 / 当前已是最新 / 未配置 key / 已上传 N 个会话。
  结果用一行内联文字显示，6 秒后自动消失。
- 控件是自绘的：按钮 + 浮层（展开后列出三档，当前项打勾）、胶囊开关。
  全部颜色走 `--dsw-alias-*` 主题变量，不用原生 `<select>`/`<input>`——那两个的浮层和
  勾选框由系统绘制，永远是浅色，压不住暗色主题。方向键 / 回车 / Esc / 点外部关闭都支持。

版本变更与每次的验证记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 自检

```bash
node tools/check-core-parity.mjs  # 与核心包逐字节对账（从 app.asar 提取真实现，52 会话 × 4 档）
node tools/check-envelope.mjs     # 分段/水位的回归护栏（与 tools/reference 比对，读真实日志）
node tools/check-runtime.mjs      # Host 行为：mock fetch + mock ctx
node tools/check-client.mjs       # 设置页控件：假 __ModuleLoader__
```

- `tools/check-core-parity.mjs` 是**唯一能证明与核心等价**的检查：它把
  `@deepseek-ai/dsh-session-log-deepseek` 从 `app.asar` 里原样取出（只替换 import），
  跑出核心自己的 `prepare()`，再与本插件的 `segment()` 比对同一批会话、
  同一水位、同一 `maxBytes` 的 JSON 输出。当前 208/208 一致，0 错误。
  **升级 DSH 核心后必须先跑它**：它绑定安装路径与核心包名，stub 也可能失效，
  不跑就会安静地继续通过（或直接报 NOT FOUND）。安装位置不同用 `DSH_ASAR` 指定。
- `tools/envelope.mjs` 那份参考实现只能挡重构回归，不能证明与核心一致。

`tools/reference/` 是用于回归比对的独立参考实现，不参与运行。

## 已知限制

- `manual` 档的入口就是「立即上传」按钮（0.4.0 加入），已可用。
- 启动扫描只覆盖**活着的**会话：非活会话没有 `Session` 对象，无法用 `session.append()`
  落水位，硬传只会每次重发。
- 无法证明服务端入库：与官方客户端一样，2xx 是唯一信号。
- 「立即上传」按钮只在「仅手动」档可用（产品决策，与规格 §4.9 的「任何档位可点」不同，
  已在规格里加注记）。
- `turn/end` 的 `forked` 收尾不触发上传：那是 fork 子会话加载继承段时的合成收尾；
  极端情况下若它正好是最后一条，要等启动扫描或手动点击。
- 「立即上传」端点 `POST /__dsh-session-sync/upload` 是宿主本地 HTTP 路由，
  只校验同源；同机其它页面猜到路径最多能重复触发一次上传（水位与冷却挡住实际重发）。

## 安装

作为 Host 插件安装到某个 profile（需要 `dsh` 的插件管理能力或 `plugin_manager`），
bundle 清单在 `cordis.patch.yml`，默认 `enabled: false`。

## License

MIT — see [LICENSE](./LICENSE).
