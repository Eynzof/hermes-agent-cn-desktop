#!/usr/bin/env python3
"""
build.py — Hermes Agent CN Desktop 构建与配置脚本

Usage:
    python scripts/build.py config             显示当前项目配置
    python scripts/build.py config --sync      同步版本号到所有文件
    python scripts/build.py check              运行 typecheck + 单元测试 + cargo check
    python scripts/build.py dev                开发构建 (tauri:dev)
    python scripts/build.py release            生产构建 (tauri:build)
    python scripts/build.py debug              调试构建 (tauri:build:debug)

Options:
    --source PATH     Hermes-CN-Core 源码路径 (仅 dev 模式)
    --force           强制重新安装本地 runtime (仅 dev 模式)
"""

import argparse
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def run(cmd, **kwargs):
    """打印并执行命令"""
    print(f"> {' '.join(cmd)}")
    return subprocess.run(cmd, cwd=REPO_ROOT, **kwargs)


def pnpm(args, **kwargs):
    """调用 pnpm (Windows 兼容)"""
    pnpm_cmd = "pnpm.cmd" if platform.system() == "Windows" else "pnpm"
    # Windows 下 .cmd 文件需要 shell=True
    if platform.system() == "Windows":
        kwargs.setdefault("shell", True)
    return run([pnpm_cmd] + args, **kwargs)


def cargo(args, **kwargs):
    """调用 cargo"""
    return run(["cargo"] + args, **kwargs)


# ── 配置信息 ──────────────────────────────────────────────────────────────

def load_json(rel_path):
    with open(REPO_ROOT / rel_path, "r", encoding="utf-8") as f:
        return json.load(f)


def read_file(rel_path):
    with open(REPO_ROOT / rel_path, "r", encoding="utf-8") as f:
        return f.read()


def show_config():
    """显示当前项目配置"""
    pkg = load_json("package.json")
    tauri_conf = load_json("tauri.conf.json")
    cargo_toml = read_file("Cargo.toml")

    # 从 Cargo.toml 提取版本
    import re
    m = re.search(r'^version\s*=\s*"([^"]+)"', cargo_toml, re.MULTILINE)
    cargo_version = m.group(1) if m else "unknown"

    print("╔══════════════════════════════════════════════╗")
    print("║     Hermes Agent CN Desktop 配置信息         ║")
    print("╚══════════════════════════════════════════════╝")
    print(f"  Package version : {pkg.get('version', 'N/A')}")
    print(f"  Cargo version   : {cargo_version}")
    print(f"  Tauri version   : {tauri_conf.get('version', 'N/A')}")
    print(f"  Product name    : {tauri_conf.get('productName', 'N/A')}")
    print(f"  Identifier      : {tauri_conf.get('identifier', 'N/A')}")
    print(f"  Dev URL         : {tauri_conf.get('build', {}).get('devUrl', 'N/A')}")
    print(f"  Frontend dist   : {tauri_conf.get('build', {}).get('frontendDist', 'N/A')}")
    print(f"  Package manager : {pkg.get('packageManager', 'N/A')}")
    print()

    # 端口信息
    print("── 端口 ──")
    print(f"  Vite dev server : 9545 (strictPort)")
    print(f"  Dashboard       : 9120 (managed runtime)")
    print()

    # 运行时信息
    print("── 运行时 ──")
    runtime_root = os.environ.get("HERMES_DESKTOP_RUNTIME_ROOT")
    if runtime_root:
        print(f"  Runtime root (env): {runtime_root}")
    else:
        if platform.system() == "Darwin":
            default_runtime = os.path.expanduser("~/Library/Application Support/cn.org.hermesagent.desktop/dev-runtime")
        elif platform.system() == "Windows":
            appdata = os.environ.get("APPDATA", os.path.expanduser("~/AppData/Roaming"))
            default_runtime = os.path.join(appdata, "cn.org.hermesagent.desktop", "dev-runtime")
        else:
            xdg = os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share"))
            default_runtime = os.path.join(xdg, "cn.org.hermesagent.desktop", "dev-runtime")
        print(f"  Runtime root (default): {default_runtime}")

    dashboard_origin = os.environ.get("HERMES_DASHBOARD_ORIGIN", "http://127.0.0.1:9120")
    print(f"  Dashboard origin: {dashboard_origin}")
    print()

    # 依赖检查
    print("── 依赖检查 ──")
    tools = {
        "node": ["node", "--version"],
        "pnpm": ["pnpm.cmd" if platform.system() == "Windows" else "pnpm", "--version"],
        "rustc": ["rustc", "--version"],
        "cargo": ["cargo", "--version"],
    }
    for name, cmd in tools.items():
        try:
            result = subprocess.run(
                cmd,
                capture_output=True, text=True, timeout=10,
                shell=platform.system() == "Windows",
            )
            if result.returncode == 0:
                print(f"  \u2713 {name}: {result.stdout.strip()}")
            else:
                print(f"  \u2717 {name}: not found")
        except FileNotFoundError:
            print(f"  \u2717 {name}: not found")
    print()


def sync_version():
    """同步版本号到所有文件 (version:sync)"""
    print("正在同步版本号...")
    result = pnpm(["run", "version:sync"])
    return result.returncode == 0


# ── 构建命令 ──────────────────────────────────────────────────────────────

def cmd_check():
    """运行所有检查"""
    ok = True

    print("=" * 60)
    print("  Step 1: pnpm typecheck")
    print("=" * 60)
    r = pnpm(["run", "typecheck"])
    if r.returncode != 0:
        print("  ❌ typecheck 失败")
        ok = False
    else:
        print("  ✅ typecheck 通过")

    print()
    print("=" * 60)
    print("  Step 2: pnpm test:unit")
    print("=" * 60)
    r = pnpm(["run", "test:unit"])
    if r.returncode != 0:
        print("  ❌ 单元测试失败")
        ok = False
    else:
        print("  ✅ 单元测试通过")

    print()
    print("=" * 60)
    print("  Step 3: cargo check")
    print("=" * 60)
    r = cargo(["check"])
    if r.returncode != 0:
        print("  ❌ cargo check 失败")
        ok = False
    else:
        print("  ✅ cargo check 通过")

    print()
    if ok:
        print("  ✅ 所有检查通过")
    else:
        print("  ❌ 部分检查失败，请修复后重试")
        sys.exit(1)


def cmd_dev(source=None, force=False):
    """开发构建 (tauri:dev)"""
    print("正在启动开发模式...")

    # 始终先同步版本号（相当于 pnpm run version:sync）
    pnpm(["run", "version:sync"])

    extra_args = []
    if source:
        extra_args.extend(["--source", str(source)])
    if force:
        extra_args.append("--force")

    # 统一委托给 tauri-dev-managed.mjs（安装 local runtime + 启动 tauri dev）
    cmd = ["node", str(REPO_ROOT / "scripts" / "tauri-dev-managed.mjs")] + extra_args
    print(f"> {' '.join(cmd)}")
    r = subprocess.run(cmd, cwd=REPO_ROOT)
    return r.returncode == 0


def cmd_release():
    """生产构建 (tauri:build)"""
    print("正在执行生产构建...")
    print("  -> license:sync + version:sync + tauri build")
    r = pnpm(["run", "tauri:build"])
    return r.returncode == 0


def cmd_debug():
    """调试构建 (tauri:build:debug)"""
    print("正在执行调试构建...")
    print("  -> license:sync + version:sync + tauri build --debug")
    r = pnpm(["run", "tauri:build:debug"])
    return r.returncode == 0


# ── 主入口 ────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Hermes Agent CN Desktop 构建与配置脚本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    parser.add_argument(
        "command",
        nargs="?",
        default="config",
        choices=["config", "check", "dev", "release", "debug"],
        help="操作类型 (默认: config)",
    )
    parser.add_argument("--sync", action="store_true", help="同步版本号 (仅 config 模式)")
    parser.add_argument("--source", help="Hermes-CN-Core 源码路径 (仅 dev 模式)")
    parser.add_argument("--force", action="store_true", help="强制重新安装本地 runtime (仅 dev 模式)")

    args = parser.parse_args()

    if args.command == "config":
        show_config()
        if args.sync:
            sync_version()
            print()
            print("版本同步后的配置:")
            show_config()
    elif args.command == "check":
        cmd_check()
    elif args.command == "dev":
        ok = cmd_dev(source=args.source, force=args.force)
        if not ok:
            sys.exit(1)
    elif args.command == "release":
        ok = cmd_release()
        if not ok:
            sys.exit(1)
    elif args.command == "debug":
        ok = cmd_debug()
        if not ok:
            sys.exit(1)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
