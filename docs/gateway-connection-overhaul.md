# 网关连接改造(Gateway Connection Overhaul)

> 目标:把 Tauri 桌面端从自造的 **SSE+POST 代理传输(P-009)** 迁回官方运行时原生的
> **JSON-RPC over WebSocket(`/api/ws`)**,修复掉线 / 重连失败 / 延迟高 / 消息乱序 /
> 回复不可见 / 401 风暴,并大幅降低对 Hermes-CN-Core 的上游 sync 负担。
>
> 分支:`claude/gateway-connection-overhaul`(worktree:`.claude/worktrees/gateway-connection-overhaul`,基线 `main@23ab09a`)
> 本文件是**活文档**,每完成一步就更新「进度跟踪」表与「变更记录」。

---

## 1. 背景与根因(调研结论)

官方 Electron 桌面端与我们的 Tauri 桌面端连的是**同一个运行时**——即 `hermes_cli/web_server.py`
里的 FastAPI dashboard 服务(**不是** `gateway/run.py`,那是出站消息网关)。区别只在传输:

- **官方**:渲染进程直连一条 `JSON-RPC 2.0 over WebSocket` 到 `/api/ws?token=…`,主进程只做控制面。
- **我们**:webview → Tauri IPC → 两层 Rust 代理(`sse_proxy.rs` + `api_proxy.rs`)→ dashboard 的
  **SSE 事件流 + 每次 RPC 一个 POST**(`/api/v2/events` + `/api/v2/rpc`,这是 fork 补丁 **P-009**)。

**关键事实**:`/api/ws`(原生)和 `/api/v2/*`(我们的补丁)由同一个 dashboard 进程提供。官方 WS 端点
本来就在,SSE 是我们多加的,不是替代品。`apps/`、`web/src` 里**零个** EventSource/api/v2 消费者来自官方。

**最讽刺的发现**:我们仓库里 `web/src/lib/gateway-client.ts`(~607 行)已经是一个完整的 WS 客户端
(心跳 30s/10s、指数退避 1→30s、唤醒看门狗),但 `pickTransport()` 因为一句「WS 被 P-003 闸门挡住」
的注释在 Tauri 上强制走 SSE,使这套好代码成了**死代码**。而「P-003 挡住 WS」这个前提经核对**是错的**:
运行时原生在 `/api/ws` 提供服务、`tauri.conf.json` 的 CSP 已放行 `ws://127.0.0.1:*`、dev 模式本来就用这个 URL。

### 症状 → 根因映射

| 症状 | 根因(file:line) |
|---|---|
| 掉线 / 重连失败 | SSE 一次性流出错即退出(`sse_proxy.rs:159`);前端**平 1s 死循环无退避**(`gateway-sse-client.ts:615`);SSE 路径**无心跳**,睡眠唤醒后半开 socket 不被发现 |
| 回复要切走再切回才可见 | 重连后**不重发 `session.resume`** + persistent→gateway-id 多对一映射返回最老的死 id(修复 `e987f22` 未合并) |
| 消息乱序/重复 | 乐观本地消息 + REST 回拉消息客户端合并,**无服务端序号**,需 `createdAt` 重排(修复 `ba313b1` 未合并) |
| 全链路延迟高 | 每 RPC 经 Rust 代理 + `res.text()` 整包缓冲(`api_proxy.rs:407`);慢 turn 再走 SSE 第二跳(异步 ack);30s/120s 超时错配;单 Mutex 每命令锁两次 |
| 401 风暴 | dashboard 重启即轮换 token,我们从 HTML 抓 token;401 静默重试 `body.clone()` 重放(`api_proxy.rs:468`) |
| Token 泄漏 | SSE 端点在 auth 中间件外,token 写进 URL 查询串 |
| 配置侧栏冻结 (#165) | IPC 代理设计 + StrictMode/raceAbort(修复 `0dd1206` 未合并) |

---

## 2. 架构对比(官方 vs 我们 vs 迁移后)

| 维度 | 官方 Electron | 我们 Tauri(现状) | 迁移后 |
|---|---|---|---|
| 传输 | 1 条 WS,JSON-RPC,直连 | SSE 事件 + POST RPC,2 层 Rust 代理 | 1 条 WS,JSON-RPC,直连/Rust 中继 |
| 数据路径跳数 | 0 代理 | 2(IPC+reqwest),整包缓冲 | 0 代理(Rust 仅 bootstrap/REST) |
| RPC 结果 | 同 socket 一帧 | 异步 ack → 另走 SSE | 同 socket 一帧 |
| 重连退避 | 1→15s 指数 + 唤醒触发 | 平 1s 死循环 | 1→30s 指数+jitter(已写好) |
| 心跳/半开 | close+连接超时 | 无 → hang 到 120s | 30s/10s ping(已写好) |
| 重连→恢复 | `session.resume` | **无**(仅下次发送懒触发) | `onState('open')` 重发 `session.resume`(新增) |
| 会话 id | 服务端稳定复用 | 多对一映射累积死 id | 稳定 + 收缩映射 |
| Token | env 注入 / `?token=` | HTML 抓取 + SSE 查询串(泄漏) | `?token=` loopback,无泄漏 |
| 自造 Rust 行数 | n/a | `sse_proxy.rs` 349 + `api_proxy` RPC 半 | `sse_proxy.rs` 删除;`api_proxy` 仅 REST |

---

## 3. 分阶段计划

### P0 —— 止血,高价值、可回滚、不删任何东西
- **P0-1 [S] WS spike**:验证打包后的 Tauri webview 能否直连 `ws://127.0.0.1:<port>/api/ws`。
  CSP 已放行、服务端闸门开、dev 已用此 URL;唯一未证实的是生产 WKWebView/WebView2 + mixed-content 握手。
  失败则走 Plan B(Rust 侧 `tokio-tungstenite` WS 中继)。**此结果决定 P1 走「直连」还是「中继」。**
- **P0-2 [M] 重连后重发 `session.resume`**:两条 transport 今天都缺的最大缺陷,纯客户端遗漏。
  `onState('open')`(非首连)→ 对活跃会话 `session.resume` + `refreshSessions()`;断开标记「重连中」而非
  `terminateAllStreams()`。**即使还在 SSE 上也立刻见效。**
- **P0-3 [S] 合并四个已修复但未合入 main 的分支**:`ba313b1` 乱序、`e987f22` 回复可见性、
  `0dd1206` 侧栏冻结、SSE token 泄漏。与迁移无关,先合(当前从 main 出包会带齐所有 bug)。

### P1 —— 切换默认传输
- **P1-1 [M] Tauri 默认传输翻成 WS**:改 `gateway-client.ts:572-573`,RPC 走 socket,激活已有 `GatewayClient`;
  保留 query/store/env override 作 kill-switch 回滚 SSE。处理 token 轮换后重开 socket。
  - Plan B(若 P0-1 失败):Rust 侧 WS 中继替掉 `sse_proxy.rs`(需加 `tokio-tungstenite` 依赖)。

### P2 —— 清理,固化胜利
- **P2-1 [L] 删 `sse_proxy.rs` + P-009 客户端代码 + state SSE-stop 字段**;`api_proxy.rs` 改为只跑 REST;
  `dashboard_is_compatible` 兼容性探测改为要求 `/api/ws`。**WS 稳定前不删,SSE 是回滚目标。**
- **P2-2 [M] 等所有已发布桌面端切到 WS 后**,从 Core 删 `/api/v2/events`、`/api/v2/rpc`、`tui_gateway/sse.py`,
  更新 `FORK_NOTES.md:16`。

### 配套(Core 侧,降低 sync 负担,另开 PR)
- 退役 P-009(随 P2-2);丢 P-003(已 no-op);收 P-005/P-008 shim;上游化 agent 预热 / P-012 / P-013 / Windows 兼容。
- 必须保留:P-006/P-010 国内 provider、P-014/P-015 冻结运行时打包、模型目录 CN 镜像、签名发布管线。

---

## 4. 进度跟踪

状态:⬜ 未开始 / 🟡 进行中 / ✅ 完成 / ⏸ 阻塞(需用户/外部) / ❌ 放弃

| ID | 任务 | 状态 | 负责 | 备注 |
|---|---|---|---|---|
| 设置 | worktree + `claude/` 分支 + 计划文档 | ✅ | claude | 本文件;分支 `claude/gateway-connection-overhaul` |
| P0-1 | WS spike(打包态 webview 直连 `/api/ws`) | ✅(被 P1-1 吸收) | claude | 不再是迁移的前置闸门:P1-1 的 auto 协商在运行时**自动探测**,结果即 P0-1 答案(看 `getActiveTransport()` / `HERMES_TRANSPORT_LEARNED`) |
| P0-2 | 重连后重发 `session.resume`(断开标记重连中) | 🟡 | claude | 代码+单测完成;**运行时验证待用户实测**(睡眠唤醒 / dashboard 重启) |
| P0-3 | 合并四个修复分支到 main | ⏸ | 用户 | 改 main,需确认后执行;非本 worktree 内改动 |
| P1-1 | Tauri 传输翻 WS(WS-first + SSE 自动回退) | 🟡 | claude | 实现+单测(typecheck + 343 web 测试)+ 4 维对抗式审查通过(15 findings → 1 真实潜在缺陷已修);**运行时验证待实测** |
| P2-1 | 删 SSE 代理 + P-009 客户端 | ⬜ | - | 依赖 P1-1 软化 |
| P2-2 | Core 退役 P-009 端点 | ⬜ | - | 依赖全量桌面端切 WS |

---

## 5. 风险与待验证项

1. **生产 webview 能否开 WS**(P0-1)——唯一硬性未验证项。失败走 Rust WS 中继(仍净胜)。
2. **SSE header-only auth 被拒**(`sse_proxy.rs:25-28`,`a6d680e` 曾被 `37edbe4` 回滚)——切 WS 后无关。
3. **服务端无事件序号/无 replay/无 WS 心跳**——官方与我们一样,恢复全靠客户端**重发 `session.resume`**(P0-2 是迁移正确性的前提)。
4. `session.resume` 后端可能慢(重建 agent「可达几分钟」)——必须异步 + spinner + 按 `session_id` 去抖防风暴。
5. 本地 CN 桌面是 loopback,用长期 `?token=` 即可,**不需要** OAuth ticket(那是远程网关的)。
6. `/v1/capabilities` 在独立 `api_server.py`(8642 端口),**不是** dashboard 聊天链路,别混。

---

## 6. 关键文件索引

桌面端(本仓库):
- `web/src/lib/gateway-client.ts` — 已写好的 WS 客户端(目标传输);`pickTransport()` 在 ~:572 强制 SSE
- `web/src/lib/gateway-sse-client.ts` — SSE+POST 客户端(P-009 客户端侧)
- `web/src/hooks/use-gateway.ts` — 网关桥接(P0-2 落点)
- `web/src/lib/session-map.ts` — persistent→gateway id 映射(`resolveGatewaySessionId`)
- `web/src/stores/chat.ts` — `terminateAllStreams` / `gateway.disconnected` 处理
- `web/src/lib/runtime.ts` — `getGatewayUrl()` 已会构造 `ws://…/api/ws?token=`
- `packages/protocol/src/channels.ts` — `system-resume` IPC(唤醒触发管道已在)
- `src/commands/sse_proxy.rs` / `api_proxy.rs` / `gateway.rs` — Rust 代理(P2 删/改)
- `src/commands/dashboard.rs` — 运行时 spawn/探测(保留,改兼容性检查)

官方参考(`../Hermes-CN-Core`):
- `apps/shared/src/json-rpc-gateway.ts` — 官方 WS 客户端
- `apps/desktop/src/app/gateway/hooks/use-gateway-boot.ts` — 重连编排(退避/唤醒/resync)
- `apps/desktop/src/app/session/hooks/use-session-actions.ts:537` — 重开后 `session.resume`
- `hermes_cli/web_server.py:8522` — `/api/ws` 端点

---

## 7. P0-2 实现说明(已落地)

三处改动,目标:让中途掉线的会话能在重连后恢复,而不是冻结成 "连接已断开" 报错。

- **`web/src/lib/gateway-reconnect.ts`(新)** — 纯函数 `reattachAfterReconnect(deps)`,依赖注入,
  无 jotai/gateway 单例依赖,可单测。逻辑:有活跃会话才动作 → 解析持久 id → `session.resume` →
  成功 `onResumed(新gwId, 持久id)` / 失败或无 id `onResumeFailed`。配套 `gateway-reconnect.test.ts`(5 例)。
- **`web/src/stores/chat.ts`** — 新增 `markStreamsReconnectingAtom`:`terminateAllStreamsAtom` 的
  **可恢复版**。把 streaming 会话转成 transient `connecting` 状态(文案"连接中断,正在重连…"),
  **保留 `activeAssistantId` 与消息**,不标 error。这样重连后 `message.delta` 复用同一条消息继续流式
  (`isStreamingStatus` 含 `connecting`,reducer 复用 id)。配套 chat.test.ts 3 例。
- **`web/src/hooks/use-gateway.ts`** — 网关桥接(单例,单 owner):
  - `onState`:跟踪 open→…→open,识别"重连"(非首连),触发 `reattachActiveSessionAfterReconnect()`
    (走默认 jotai store,带 in-flight 去重防并发 resume)。
  - `gateway.disconnected`:改为 `markStreamsReconnectingAtom`(原来是 `terminateAllStreams`)。
  - resume 失败回退 `terminateAllStreamsAtom`,UI 显示真实错误而非永久"重连中"。

**已知限制 / 后续**:reattach 目前只 resume 活跃会话(`gwSessionIdAtom`);并发的后台流式会话会停在
"重连中",待用户切到该会话时由 `detail.tsx` 的 `ensureGatewaySession` 懒恢复。多会话并发 resume 列为后续增强。

**待办**:运行时验证(`pnpm tauri:dev` + 起 dashboard,模拟睡眠唤醒 / `dashboard` 重启,确认中途 turn
能续上而非冻结);P1 时把 `CLAUDE.md`「Gateway transport」里"WS 被 P-003 闸门阻断"的过时说法一并更正。

## 7b. P1-1 实现说明(已落地)

把 Tauri 默认传输从「强制 SSE」改为 **WS-first + SSE 自动回退**,安全地用上官方原生 `/api/ws`。

- **`web/src/lib/gateway-negotiation.ts`(新)** — `NegotiatingGatewayClient`:首次连接先探测 WS
  (短超时 4s),`/api/ws` 起得来且稳定(1.2s 内不掉)就用 WS;否则关掉 WS、换成现有 SSE 客户端继续。
  决策 sticky 持久化到 `HERMES_TRANSPORT_LEARNED`,下次启动跳过探测。监听器在 wrapper 层维护并跨
  swap 转发,`use-gateway.ts` 桥接对切换无感。**floor 永远是今天能用的 SSE,零回退风险。**
- **`web/src/lib/gateway-client.ts`** — `pickTransport()` 对未选择的 Tauri 返回 `"auto"`
  (原来硬编码 `"sse"`,理由是已被证伪的「P-003 闸门」);`getGatewayClient()` 据此构造协商客户端。
  覆盖优先级:`?transport=` > `HERMES_TRANSPORT`(用户/QA kill-switch) > `HERMES_TRANSPORT_LEARNED`(探测结果) > runtime > env > Tauri auto > web `ws`。
- **`CLAUDE.md`** — 更正过时的「默认 SSE 因 P-003 闸门」说法。

**为什么不硬切 WS**:打包态 WKWebView(`tauri://`)/ WebView2(`http://tauri.localhost`)能否开
`ws://127.0.0.1` 离线无法证实;auto 回退让它**逐机自发现**,WS 能用就吃满收益(单条有序 socket、
不过 Rust 代理、无异步 ack),不能用就退回 SSE。

**对抗式审查**(4 维并行 + 逐条验证,见 workflow `p1-transport-negotiation-review`):15 条 findings 经
验证 14 条为误报/已处理(含初判 blocking 的 `forceReconnect`、`SSE 继承探测超时` 均确认非 bug),
1 条真实但潜在缺陷:`close()` 在探测期不阻止 SSE 回退(当前无 UI 调 `disconnect()`,不可触发)。已加
`intentionalClose` 不变量修复 + 2 个回归测试。

**待办**:运行时验证(打包后看实际走 WS 还是 SSE;若 macOS 打包态 WKWebView 开不了 WS → 实现 Rust 侧
`tokio-tungstenite` WS 中继作为 P1 的 Plan B,彻底不依赖 webview 跨域能力)。

## 8. 变更记录

- 2026-06-09 — 建 worktree + `claude/gateway-connection-overhaul` 分支;沉淀本计划文档。
- 2026-06-09 — **P0-2 实现**:新增 reconnect→`session.resume` 重连恢复 + 断开标记"重连中"(非冻结报错)。
  `gateway-reconnect.ts`(纯函数+单测)、`chat.ts` `markStreamsReconnectingAtom`、`use-gateway.ts` 桥接。
  typecheck 三个 workspace 通过;web 单测 335 全绿。运行时验证待用户实测。
- 2026-06-09 — **P1-1 实现**:Tauri 传输改为 WS-first + SSE 自动回退(`gateway-negotiation.ts`),
  `pickTransport()` 返回 `"auto"`。经 4 维对抗式审查(15 findings → 1 真实潜在缺陷,已加 `intentionalClose`
  修复)。typecheck 通过;web 单测 343 全绿。运行时验证待用户实测。
