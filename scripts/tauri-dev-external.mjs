#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: pnpm tauri:dev:external

Deprecated compatibility alias. The desktop is locked to its managed runtime,
so this now starts the same managed dev path as pnpm tauri:dev.`);
  process.exit(0);
}

const child = spawn(pnpm, ["exec", "tauri", "dev"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    HERMES_DESKTOP_ALLOW_EXTERNAL_AGENT: "0",
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
