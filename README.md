# Hermes Agent CN Desktop

Hermes Agent 中文社区桌面客户端 — 基于 [Tauri v2](https://v2.tauri.app/) + React 构建。

对接 [hermes-agent-cn](https://github.com/Eynzof/hermes-agent-cn) 后端 Dashboard，提供原生桌面体验：原生窗口、文件对话框、系统托盘、自动更新。

## 特性

- **轻量打包** — Tauri 使用系统 WebView（macOS WebKit / Windows WebView2），安装包 ~15MB（Electron 版 ~150MB）
- **完整功能** — 多轮对话、流式输出、文件附件、MCP 工具、多 Profile 切换、Runtime 自动更新
- **跨平台** — macOS（DMG）、Windows（NSIS 安装器）

## 前置条件

- [Rust](https://rustup.rs/) 1.75+
- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 9+
- [hermes-agent-cn](https://github.com/Eynzof/hermes-agent-cn)（后端）

macOS 额外需要 Xcode Command Line Tools：
```bash
xcode-select --install
```

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 启动后端（另开终端）
hermes dashboard --no-open

# 3. 开发模式（Vite 热更新 + Tauri 原生窗口）
pnpm web:dev          # 终端 A：启动 Vite (localhost:9545)
cargo run             # 终端 B：启动 Tauri 窗口
```

打开 Tauri 窗口后即可使用。代码修改后 Vite 自动热更新前端，Rust 修改需重新 `cargo run`。

## 构建

```bash
# Release 构建（产出 .app + .dmg / .exe）
pnpm tauri:build

# Debug 构建（带调试信息）
pnpm tauri:build:debug
```

产物位于 `target/release/bundle/`（或 `target/debug/bundle/`）。

## 项目结构

```
├── src/                    Rust 后端（Tauri commands + 进程管理）
├── web/                    React 前端（Vite + TanStack Query + Jotai）
├── packages/
│   ├── protocol/           API schemas (Zod) + IPC 类型定义
│   └── shared-ui/          设计 token + 共享 UI 组件
├── Cargo.toml              Rust 依赖
├── tauri.conf.json         Tauri 窗口/打包配置
└── package.json            pnpm workspace root
```

## 开发命令

| 命令 | 说明 |
|------|------|
| `pnpm web:dev` | 启动 Vite dev server (localhost:9545) |
| `cargo run` | 编译并启动 Tauri 窗口 |
| `pnpm typecheck` | TypeScript 类型检查（全部 workspace） |
| `pnpm test:unit` | 运行 vitest 单元测试 |
| `cargo check` | Rust 编译检查 |
| `pnpm tauri:build` | 生产构建 |

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 19 + TypeScript |
| 构建 | Vite 6 |
| 服务端状态 | TanStack Query v5 |
| 本地状态 | Jotai |
| 样式 | CSS Modules |
| HTTP 客户端 | reqwest (Rust) |
| 打包 | Tauri Bundler (DMG / NSIS) |

## 许可

私有项目，仅限授权使用。
