#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

function usage() {
  console.log(`Usage: node scripts/install-local-runtime.mjs [--source ../hermes-agent-cn] [--force]

Installs a local hermes-agent-cn checkout into the desktop managed runtime
folder as an isolated Python venv, then writes runtime/current.json.
The installed kernel is copied into the venv; it does not run from PATH hermes
or from an editable source checkout.`);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

if (hasFlag("--help") || hasFlag("-h")) {
  usage();
  process.exit(0);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceArg = argValue("--source") ?? process.env.HERMES_AGENT_CN_SOURCE ?? "../hermes-agent-cn";
const sourceRoot = resolve(repoRoot, sourceArg);
const force = hasFlag("--force") || process.env.HERMES_DESKTOP_LOCAL_RUNTIME_FORCE === "1";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function findPython() {
  const candidates = [
    process.env.PYTHON,
    process.platform === "win32" ? "python" : "python3",
    "python",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const version = capture(candidate, ["-c", "import sys; print('.'.join(map(str, sys.version_info[:2])))"]);
    if (!version) continue;
    const [major, minor] = version.split(".").map(Number);
    if (major > 3 || (major === 3 && minor >= 11)) return candidate;
  }
  throw new Error("Python 3.11+ was not found. Set PYTHON=/path/to/python3.11 and retry.");
}

function dataDir() {
  if (process.env.HERMES_DESKTOP_RUNTIME_ROOT) {
    return dirname(process.env.HERMES_DESKTOP_RUNTIME_ROOT);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }
  if (process.platform === "win32") {
    return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  }
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

function runtimeRoot() {
  return process.env.HERMES_DESKTOP_RUNTIME_ROOT
    ? resolve(process.env.HERMES_DESKTOP_RUNTIME_ROOT)
    : join(dataDir(), "cn.hermes.agent.desktop", "runtime");
}

function platformName() {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

function archName() {
  if (process.arch === "x64") return "x64";
  if (process.arch === "arm64") return "arm64";
  return process.arch;
}

function readProjectVersion() {
  const pyproject = readFileSync(join(sourceRoot, "pyproject.toml"), "utf8");
  const match = pyproject.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error(`Cannot find [project].version in ${join(sourceRoot, "pyproject.toml")}`);
  return match[1];
}

function venvPython(venv) {
  return process.platform === "win32"
    ? join(venv, "Scripts", "python.exe")
    : join(venv, "bin", "python");
}

function hermesExecutable(venv) {
  return process.platform === "win32"
    ? join(venv, "Scripts", "hermes.exe")
    : join(venv, "bin", "hermes");
}

function readCurrent(currentPath) {
  try {
    return JSON.parse(readFileSync(currentPath, "utf8"));
  } catch {
    return null;
  }
}

if (!existsSync(join(sourceRoot, "pyproject.toml"))) {
  throw new Error(`hermes-agent-cn source checkout not found: ${sourceRoot}`);
}

const root = runtimeRoot();
const versionsRoot = join(root, "versions");
const currentPath = join(root, "current.json");
const version = readProjectVersion();
const commit = capture("git", ["-C", sourceRoot, "rev-parse", "HEAD"]) || "unknown";
const shortCommit = commit.slice(0, 12);
// pip's wheel build creates <source>/build. Ignore and clean it so repeated
// local runtime installs are deterministic instead of producing a new dirty
// runtime on every run.
rmSync(join(sourceRoot, "build"), { recursive: true, force: true });
const sourcePathspec = [".", ":!build"];
const dirtyStatus = capture("git", ["-C", sourceRoot, "status", "--porcelain=v1", "--", ...sourcePathspec]);
const dirty = Boolean(dirtyStatus);
const dirtyHash = dirty
  ? createHash("sha256")
      .update(dirtyStatus)
      .update("\n")
      .update(capture("git", ["-C", sourceRoot, "diff", "--binary", "HEAD", "--", ...sourcePathspec]))
      .digest("hex")
      .slice(0, 12)
  : null;
const dirtySuffix = dirtyHash ? `-dirty-${dirtyHash}` : "";
const installVersion = `dev-local-${version}-${shortCommit}${dirtySuffix}`;
const target = join(versionsRoot, installVersion);
const executable = hermesExecutable(join(target, "venv"));
const current = readCurrent(currentPath);

if (
  !force
  && current?.source === "local-source"
  && current?.upstreamCommit === commit
  && (current?.localDirtyHash ?? null) === dirtyHash
  && existsSync(current.executablePath)
) {
  console.log(`managed runtime already points at local ${version} ${shortCommit}: ${current.executablePath}`);
  process.exit(0);
}

mkdirSync(versionsRoot, { recursive: true });
if (force || existsSync(target)) {
  rmSync(target, { recursive: true, force: true });
}

mkdirSync(target, { recursive: true });

const python = findPython();
const venv = join(target, "venv");

console.log(`Installing local hermes-agent-cn runtime`);
console.log(`source:  ${sourceRoot}`);
console.log(`target:  ${target}`);
console.log(`python:  ${python}`);

run(python, ["-m", "venv", venv]);
const py = venvPython(venv);
run(py, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"]);
run(py, ["-m", "pip", "install", `${sourceRoot}[web]`]);
rmSync(join(sourceRoot, "build"), { recursive: true, force: true });

if (!existsSync(hermesExecutable(venv))) {
  throw new Error(`hermes console script was not created at ${hermesExecutable(venv)}`);
}

run(hermesExecutable(venv), ["dashboard", "--help"], {
  env: {
    ...process.env,
    HERMES_HOME: join(target, "smoke-home"),
    HERMES_DASHBOARD_TUI: "1",
  },
});

const installedExecutable = hermesExecutable(join(target, "venv"));
const record = {
  version: installVersion,
  platform: platformName(),
  arch: archName(),
  path: target,
  executablePath: installedExecutable,
  source: "local-source",
  installedAt: new Date().toISOString(),
  upstreamRepo: sourceRoot,
  upstreamCommit: commit,
  localDirtyHash: dirtyHash,
  artifactSha256: null,
  previousVersion: current?.version ?? null,
};

writeFileSync(join(target, "manifest.json"), `${JSON.stringify({
  kind: "local-source-runtime",
  sourceRoot,
  projectVersion: version,
  commit,
  dirty,
  dirtyHash,
  createdAt: record.installedAt,
}, null, 2)}\n`);
mkdirSync(dirname(currentPath), { recursive: true });
writeFileSync(currentPath, `${JSON.stringify(record, null, 2)}\n`);

console.log(`wrote ${currentPath}`);
console.log(`managed runtime executable: ${installedExecutable}`);
