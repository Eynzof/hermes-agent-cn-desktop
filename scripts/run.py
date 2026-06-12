#!/usr/bin/env python3
"""
run.py — Hermes Agent CN Desktop 运行脚本

启动开发环境的各种模式。

Usage:
    python scripts/run.py dev [--source PATH] [--force]  完整开发模式 (managed runtime)
    python scripts/run.py web                             仅启动 Web dev server (Vite)
    python scripts/run.py tauri                           仅启动 Tauri 后端 (cargo run)
    python scripts/run.py dashboard [--port PORT] [--source PATH]  仅启动 Hermes Dashboard
    python scripts/run.py check                           运行检查 (typecheck + test + cargo check)

Options:
    --source PATH     Hermes-CN-Core 源码路径 (dev / dashboard 模式)
    --force           强制重新安装本地 runtime (dev 模式)
    --port PORT       Dashboard 端口 (默认 9120)
    --no-open         不自动打开浏览器 (dashboard 模式)
"""

import argparse
import os
import platform
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# 确保 scripts 目录在 sys.path 中，以便 from build import ... 能可靠工作
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))


def pnpm(args_list, **kwargs):
    """调用 pnpm (Windows 兼容)"""
    pnpm_cmd = "pnpm.cmd" if platform.system() == "Windows" else "pnpm"
    # Windows 下 .cmd 文件需要 shell=True
    if platform.system() == "Windows":
        kwargs.setdefault("shell", True)
    print(f"> {pnpm_cmd} {' '.join(args_list)}")
    return subprocess.run([pnpm_cmd] + args_list, cwd=REPO_ROOT, **kwargs)


# ── 命令实现 ──────────────────────────────────────────────────────────────


def cmd_dev(source=None, force=False):
    """
    完整开发模式：
    1. 同步版本号
    2. 安装本地 managed runtime (可选)
    3. 启动 Tauri dev (自动加载 Vite dev server)
    """
    print("=" * 60)
    print("  启动 Hermes Agent CN Desktop 开发模式 (managed)")
    print("=" * 60)

    # 同步版本号（tauri-dev-managed.mjs 不会自动 sync version）
    pnpm(["run", "version:sync"])

    # 构造参数
    extra_args = []
    if source:
        extra_args.extend(["--source", str(Path(source).resolve())])
    if force:
        extra_args.append("--force")

    script = REPO_ROOT / "scripts" / "tauri-dev-managed.mjs"
    cmd = ["node", str(script)] + extra_args
    print(f"> {' '.join(cmd)}")
    r = subprocess.run(cmd, cwd=REPO_ROOT)
    sys.exit(r.returncode)


def cmd_web():
    """
    仅启动 Web dev server (Vite)。
    需要先启动 Hermes Dashboard。
    """
    print("=" * 60)
    print("  启动 Web dev server (Vite)")
    print("  Dashboard -> http://127.0.0.1:9120")
    print("  Vite      -> http://localhost:9545")
    print("=" * 60)
    print("  提示: 确保 Hermes Dashboard 已在运行")
    print()

    r = pnpm(["run", "web:dev"])
    sys.exit(r.returncode)


def cmd_tauri():
    """
    仅启动 Tauri 后端 (cargo run)。
    需要先启动 Web dev server (Vite) 和 Hermes Dashboard。
    """
    print("=" * 60)
    print("  启动 Tauri 后端 (cargo run)")
    print("  提示: 确保以下服务已在运行:")
    print("    1. Hermes Dashboard (端口 9120)")
    print("    2. Vite dev server (端口 9545)")
    print("=" * 60)

    r = pnpm(["run", "tauri:run"])
    sys.exit(r.returncode)


def cmd_dashboard(port=9120, no_open=False, source=None):
    """
    启动 Hermes Dashboard。
    优先使用 --source 指定的 Hermes-CN-Core 源码路径 (uv run hermes)；
    若未指定或路径不存在，则回退到 PATH / dev-runtime 查找 hermes 可执行文件。
    """
    print("=" * 60)
    print(f"  启动 Hermes Dashboard (端口 {port})")
    print("=" * 60)

    def find_hermes():
        # PATH 查找
        try:
            r = subprocess.run(
                ["hermes", "--version"],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode == 0:
                return "hermes"
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        # 检查 dev-runtime
        if platform.system() == "Darwin":
            base = os.path.expanduser("~/Library/Application Support")
        elif platform.system() == "Windows":
            base = os.environ.get("APPDATA", os.path.expanduser("~/AppData/Roaming"))
        else:
            base = os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share"))

        current_json = Path(base) / "cn.org.hermesagent.desktop" / "dev-runtime" / "current.json"
        if current_json.exists():
            try:
                import json
                data = json.loads(current_json.read_text())
                executable = data.get("executablePath")
                if executable and Path(executable).exists():
                    return executable
            except (json.JSONDecodeError, KeyError):
                pass

        return None

    # 若 --source 指定且存在 → 使用 uv run hermes
    hermes_source = Path(source).resolve() if source else None
    if hermes_source and hermes_source.exists():
        cmd = ["uv", "run", "hermes", "dashboard", f"--port={port}"]
        if no_open:
            cmd.append("--no-open")
        print(f"> {' '.join(cmd)}")
        print(f"  (cwd: {hermes_source})")
        r = subprocess.run(cmd, cwd=str(hermes_source))
        if r.returncode != 0:
            print(f"  ❌ Dashboard 退出码: {r.returncode}")
        sys.exit(r.returncode)

    # 否则回退到 find_hermes
    hermes = find_hermes()
    if not hermes:
        print("  ❌ 未找到 hermes 可执行文件")
        print("  -> 请先安装 Hermes-CN-Core，或使用 --source 指定源码路径")
        sys.exit(1)

    cmd = [hermes, "dashboard", f"--port={port}"]
    if no_open:
        cmd.append("--no-open")

    print(f"> {' '.join(cmd)}")
    r = subprocess.run(cmd)
    if r.returncode != 0:
        print(f"  ❌ Dashboard 退出码: {r.returncode}")
    sys.exit(r.returncode)


def cmd_check():
    """运行检查: typecheck + test:unit + cargo check"""
    from build import cmd_check as _run_check
    _run_check()


# ── 主入口 ────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Hermes Agent CN Desktop 运行脚本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    parser.add_argument(
        "command",
        nargs="?",
        default="dev",
        choices=["dev", "web", "tauri", "dashboard", "check"],
        help="运行模式 (默认: dev)",
    )
    parser.add_argument("--source", help="Hermes-CN-Core 源码路径 (dev / dashboard 模式)")
    parser.add_argument("--force", action="store_true", help="强制重新安装本地 runtime (dev 模式)")
    parser.add_argument("--port", type=int, default=9120, help="Dashboard 端口 (默认 9120)")
    parser.add_argument("--no-open", action="store_true", help="不自动打开浏览器 (dashboard 模式)")

    args = parser.parse_args()

    if args.command == "dev":
        cmd_dev(source=args.source, force=args.force)
    elif args.command == "web":
        cmd_web()
    elif args.command == "tauri":
        cmd_tauri()
    elif args.command == "dashboard":
        cmd_dashboard(port=args.port, no_open=args.no_open, source=args.source)
    elif args.command == "check":
        cmd_check()
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
