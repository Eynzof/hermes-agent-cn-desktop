#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: pnpm tauri:dev:external

Starts the legacy dev mode that attaches to an already running dashboard on
HERMES_DESKTOP_API_PORT / 9119 and allows external PATH hermes fallback.`);
  process.exit(0);
}

const child = spawn(pnpm, ["exec", "tauri", "dev"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    HERMES_DESKTOP_DEV_EXTERNAL_DASHBOARD: "1",
    HERMES_DESKTOP_ALLOW_EXTERNAL_AGENT: "1",
    HERMES_DASHBOARD_TUI: process.env.HERMES_DASHBOARD_TUI ?? "1",
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
