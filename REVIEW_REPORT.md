# hermes-cn-desktop-v2 Review Report

> 审阅范围：全量代码审查 — Rust 后端（~4500 行）、React 前端（~190 文件）、共享包、CI/CD、项目配置。

---

## 1. 项目概述

`hermes-cn-desktop-v2` 是一个 **Tauri v2 + React** 桌面客户端，用于替代上一代 Electron 壳（`hermes-cn-ui-v1`）。其核心职责是：

- 管理 `hermes-agent-cn` Dashboard 子进程的完整生命周期（探测 / 启动 / 端口回退 / 热重载）
- 提供 managed runtime（下载、签名验证、SHA-256 校验、smoke test、安装、回滚）
- 通过 Rust IPC 层代理所有 HTTP 和 SSE 流量，绕过 WebView 的 CORS 限制
- 多 Profile 支持（含启动失败自动回退）
- 本地会话归档、日志读取、Memory / Skill CRUD

**技术栈**：Rust (Tauri v2) / React 19 / Vite 6 / TanStack Query 5 / Jotai 2 / pnpm monorepo

---

## 2. 架构评价

### 2.1 整体架构 — ✅ 优秀

项目架构清晰地分为三层：

| 层 | 职责 | 核心文件 |
|---|------|---------|
| **Rust 后端** | 进程管理、IPC 命令、安全代理、状态管理 | `src/main.rs`, `src/commands/*`, `src/process/*` |
| **Frontend Bridge** | Tauri invoke 封装、运行时配置注入、传输层抽象 | `web/src/lib/tauri-bridge.ts`, `transport.ts`, `runtime.ts` |
| **React UI** | 路由、组件、状态、Hook | `web/src/routes/*`, `web/src/hooks/*`, `web/src/components/*` |

**设计亮点**：
- **hermesDesktop shim 模式**：`tauri-bridge.ts` 在启动时把所有 Tauri invoke 挂载到 `window.hermesDesktop`，使得现有 Electron 时代的调用点 **零修改** 即可工作。这是一个非常巧妙的渐进迁移策略。
- **Dev/Prod 双模式透明切换**：Dev 模式下走 Vite proxy + 相对 URL；生产模式下走 Rust IPC 代理。前端代码通过 `shouldUseNativeIpc()` 和 `isTauriProduction()` 自动判断，不需要条件编译。
- **SSE+POST 取代 WebSocket**：`gateway-sse-client.ts` 放弃了 WebSocket 的复杂心跳/半开检测/重连逻辑，用原生 EventSource 自动重连 + 独立 POST RPC，大幅降低客户端复杂度。

### 2.2 Rust 后端 — ✅ 优秀（少量可改进点）

**错误处理 — 优秀**：`AppError` 枚举按领域分类（Dashboard / SSE / Runtime / Profile / API / File / State），配合 `thiserror` + 自定义 `Serialize`，错误信息直达前端。`From` trait 覆盖了常见类型（`PoisonError`, `reqwest::Error`, `io::Error`, `url::ParseError`），不会出现 unwrap panic。

**状态管理 — 良好**：`AppState` 使用 `Mutex<AppStateInner>`，所有字段通过 `tauri::State` 注入。`switch_profile_in_flight` 标志防止并发 profile 切换。`gateway_sse_stop` 使用 `Arc<AtomicBool>` 实现优雅停止。

**安全性 — 优秀**：
- `external_request` 实现了 SSRF 防护（scheme 白名单、私有 IP 拒绝、DNS 解析验证）
- `api_request` 阻止调用方覆盖 auth header
- `extract_zip` 防止 zip-slip（path traversal）攻击，限制文件数量和总大小
- Runtime update 使用 Ed25519 签名验证 + SHA-256 校验
- `session_log.rs` 使用严格的 session ID 白名单（`[A-Za-z0-9_-]`）防止路径穿越
- `read_skill_markdown` 通过 canonical path 验证确保文件不逃逸 skill 目录

### 2.3 前端 — ✅ 良好

**路由系统**：18 个路由，涵盖核心功能（对话、历史、项目、技能、模型、MCP、Profile、Memory、定时任务、健康、分析、日志、调试、高级设置）。Dev 模式有 `dev-primitives` 路由。

**状态管理**：TanStack Query 管理服务端状态，Jotai 管理本地/实时状态。`activeProfileAtom` 通过 `atomWithStorage` 实现多标签同步。

**传输层**：`transport.ts` 统一了 native IPC 和 fetch 两种路径，auth header 集中注入，外部请求有 15s 超时保护。

---

## 3. 代码质量

### 3.1 测试覆盖 — ✅ 优秀

Rust 后端的测试覆盖是本项目最突出的优势之一：

| 模块 | 单元测试 | 集成测试 |
|------|---------|---------|
| `dashboard.rs` | 7 个（URL 构建、端口回退边界、WebSocket URL 编码、外部 agent 标志拒绝） | — |
| `runtime.rs` | 25+ 个（SHA-256、签名验证/篡改检测、zip 提取/安全、版本段清洗、配置 URL 构建、legacy schema 迁移、文件查找、进程超时） | `tests/runtime_manifest.rs` |
| `session_archive.rs` | 15 个（CRUD、路径匹配、归档过滤、容错） | — |
| `session_log.rs` | 7 个（路径穿越、注入、边界） | — |
| `memory.rs` | 3 个（解析、序列化、Unicode 字符计数） | — |
| `skills.rs` | 2 个（路径解析、非法文件名拒绝） | — |
| `api_proxy.rs` | — | `tests/api_proxy.rs`（11 个：跨域拒绝、token 注入、header 覆盖防护、body 转发、本地拦截、归档过滤、文件上传、multipart 验证） |
| `dashboard_probe.rs` | — | `tests/dashboard_probe.rs` |
| `dashboard_token.rs` | — | `tests/dashboard_token.rs` |

**测试风格一致**：
- 所有文件系统测试使用 `tempfile::TempDir`
- HTTP 测试使用 `wiremock::MockServer`
- env 依赖测试标记 `#[serial]`
- 断言统一使用 `pretty_assertions::assert_eq`

### 3.2 CI/CD — ✅ 完善

- `rust-test.yml`：`cargo fmt --check` + `cargo clippy -D warnings` + `cargo test --all-features`
- `web-test.yml`：前端测试
- `release-desktop.yml`：发布构建

### 3.3 文档 — ✅ 优秀

- `README.md`：完整的快速开始、项目结构、技术栈说明
- `AGENTS.md`：详尽的开发者指南（~200 行），涵盖架构约定、端口、启动顺序、禁止事项、commit 风格、Rust 测试约定、Windows 特殊环境配置
- Rust 模块头部注释说明其替代的 v1 对应文件

---

## 4. 发现的问题与改进建议

### 4.1 潜在问题（建议修复）

**P1: `chrono_now()` 生成的时间戳不可读**
```rust
// runtime.rs:1225-1231
fn chrono_now() -> String {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}Z", duration.as_secs())
}
```
输出类似 `"1718000000Z"` — 不是 ISO 8601 格式，与注释（"Simple ISO 8601 timestamp"）和 `installed_at` 字段的语义不符。v1 的 legacy record 使用标准 ISO 字符串（如 `"2026-05-19T00:00:00.000Z"`），这会导致新旧记录混在一起时格式不一致。建议引入轻量级时间格式化或使用 `time` crate 的 `OffsetDateTime::now_utc().format()`。

**P2: `write_file_safe` 非原子写入风险**
```rust
// memory.rs:134-145
fn write_file_safe(path: &Path, content: &str) -> AppResult<()> {
    // ...
    fs::write(&tmp_path, content)?;
    if path.exists() {
        fs::remove_file(path)?;     // ← 这里如果 crash，数据丢失
    }
    fs::rename(tmp_path, path)?;
    Ok(())
}
```
在同一个文件系统上，`fs::rename` 本身是原子的，不需要先 `remove_file`。先删后重命名反而引入了一个崩溃窗口：如果 `remove_file` 成功但 `rename` 之前进程被杀，原文件丢失而临时文件还没归位。建议直接 `fs::rename(tmp_path, path)` — POSIX 的 `rename(2)` 会原子地替换目标文件。

**P3: `Mutex` 毒化后不可恢复**
`AppState` 使用 `std::sync::Mutex`，任何 panic 都会导致锁毒化。当前 `From<PoisonError>` 实现会把它转成 `AppError::StateLockPoisoned`，但所有后续操作都会失败，用户只能重启。考虑使用 `parking_lot::Mutex`（无毒化）或在 `lock()` 时使用 `.unwrap_or_else(|e| e.into_inner())` 恢复。

### 4.2 改进建议（非阻塞）

**S1: `external_request` 允许了 `http://` scheme**
```rust
// api_proxy.rs — validate_external_url
// 当前仅在 external_request 函数文档注释中说 "HTTPS"
// 但实际也允许 http://（通过 wiremock 测试可见）
```
虽然有 IP 校验，但允许 HTTP 意味着明文传输。如果安全模型要求 HTTPS-only，应在 `validate_external_url` 中加 scheme 检查。

**S2: memory 命令缺少并发保护**
`read_memory` / `add_memory_entry` / `update_memory_entry` / `remove_memory_entry` 都直接读写文件，没有文件锁。如果两个 IPC 调用并发写入同一个 `MEMORY.md`，可能产生数据竞争。建议用文件锁（`flock`）或在 `AppState` 中加一个专用的 memory Mutex。

**S3: `connect_gateway_sse` 的 SSE 解析在极端情况下可能缓冲区膨胀**
```rust
// sse_proxy.rs — buffer 从不被上限截断
let mut buffer: Vec<u8> = Vec::new();
```
如果服务端发送了一个不包含换行符的超大 SSE 消息，`buffer` 会无限增长。建议加一个最大缓冲区限制（如 16 MiB）。

**S4: `create_workspace_project` 的竞态条件**
```rust
// file_dialogs.rs:95-113
for i in 0..100 {
    if !path.exists() { break; }  // check
}
fs::create_dir_all(&path)?;        // create — TOCTOU gap
```
存在 TOCTOU（Time-of-Check-Time-of-Use）窗口。虽然在桌面端场景下概率极低，但可以改用 `fs::create_dir(&path)` 然后检查返回值来消除竞态。

**S5: Vite dev 插件中的 session archive 逻辑与 Rust 重复**
`vite.config.ts` 中有 ~120 行 TypeScript 实现的 archive CRUD + filter 逻辑（`hermesSessionArchivePlugin`），与 `src/session_archive.rs` 中的 Rust 实现功能完全对等。虽然 Dev 模式需要独立运行，但这种重复增加了维护成本，未来可能出现行为分歧。建议在 Dev 模式下也走 Rust 后端处理（通过 Vite 中间件转发到 Rust 端），或至少在文档中明确标注两份实现的对应关系。

**S6: 部分中文硬编码在 Rust 后端**
```rust
// memory.rs
error: Some("记忆内容不能为空".to_string()),
error: Some(format!("超过记忆上限（{} / {} 字符）", ...)),
```
错误信息直接返回中文字符串。如果未来需要多语言支持，这些应该使用 error code 让前端决定显示文本。当前阶段不影响功能，但值得在技术债清单中记录。

### 4.3 架构风险

**R1: 单 Mutex 瓶颈**
所有 IPC 命令共享一个 `Mutex<AppStateInner>`，包括高频的 `api_request`（每次请求都要读 `api_base_url` 和 `session_token`）。目前 lock 持有时间很短（只读字段然后 clone），但如果未来 state 变复杂（如加入缓存），可能成为性能瓶颈。可以考虑将频繁读取的字段（如 URL 和 token）用 `Arc<RwLock>` 或 `ArcSwap` 分离。

**R2: Dashboard 进程管理的边界情况**
`ensure_hermes_dashboard` 在主端口被占用时会尝试 20 个端口偏移。但 `wait_for_dashboard` 使用固定 25s 超时，在首次启动时（需要下载 runtime）可能不够。此外，如果子进程的 stdout/stderr pipe 缓冲满了（`drain_dashboard_output` 的线程被阻塞），可能导致子进程写入阻塞。当前使用独立线程读取 stdout/stderr，已经处理了这个问题。

---

## 5. 代码统计

| 模块 | 语言 | 行数（含测试） | 文件数 |
|------|-----|------|-------|
| `src/` (Rust 后端) | Rust | ~4500 | 12 |
| `tests/` (Rust 集成测试) | Rust | ~830 | 4 |
| `web/src/` (React 前端) | TypeScript/TSX | 大量 | ~190 |
| `packages/protocol/` | TypeScript | ~35k | 5 |
| `packages/shared-ui/` | TypeScript/CSS | 若干 | ~13 |

---

## 6. 总结评分

| 维度 | 评分 | 说明 |
|------|------|------|
| **架构设计** | ⭐⭐⭐⭐⭐ | 分层清晰，Dev/Prod 双模式透明切换，hermesDesktop shim 实现优雅 |
| **代码质量** | ⭐⭐⭐⭐½ | Rust 端严谨，错误处理完善；少量 TOCTOU 和非原子写入需修复 |
| **安全性** | ⭐⭐⭐⭐⭐ | SSRF 防护、签名验证、zip-slip 防护、路径穿越防护全面 |
| **测试覆盖** | ⭐⭐⭐⭐⭐ | 单元测试 + 集成测试覆盖率高，测试风格统一，CI 流水线完善 |
| **文档** | ⭐⭐⭐⭐⭐ | README + AGENTS.md 质量极高，几乎可以作为新人入职文档 |
| **可维护性** | ⭐⭐⭐⭐ | Monorepo 结构合理，但 Vite/Rust 的 archive 双实现增加维护负担 |

### 总体评价

这是一个 **工程质量极高** 的桌面应用项目。从 Electron 到 Tauri v2 的迁移策略（hermesDesktop shim）非常聪明，Rust 后端的安全性考量全面且落地（不是纸上谈兵），测试覆盖在同类项目中属于上游水准。发现的问题多属于低风险可改进项（P2 的 `write_file_safe` 建议优先处理），整体架构经得起后续功能扩展。

---

*审阅人：Cascade AI · 审阅日期：2026-05-20*
