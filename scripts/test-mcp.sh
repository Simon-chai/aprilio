#!/usr/bin/env bash
# MCP server 一键冒烟测试：
#   1. cargo build 确保 app.exe 与当前源码一致（cargo test 不会重链 bin，直接测可能踩旧产物）
#   2. 向 `app.exe mcp serve` 的 stdio 灌入标准 MCP 握手（initialize → tools/list → tools/call）
# 通过标准：stdout 打出三段 JSON-RPC result，无 error 响应。
set -e
cd "$(dirname "$0")/.."

# 本机 MSVC 环境（BuildTools 14.44.35207 + WinSDK 10.0.22621.0，路径升级时同步改这里）：
# 1) Git Bash 的 /usr/bin/link.exe（coreutils）会遮蔽 MSVC link.exe → 报 `missing operand after '\377\376'`
# 2) 链接期找不到 SDK 库 → LNK1181 无法打开输入文件 OleAut32.lib
# 两者都要显式设 PATH/INCLUDE/LIB；工具集路径升级时同步更新。
export MSVC="/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC/14.44.35207"
export SDK="/c/Program Files (x86)/Windows Kits/10"
export PATH="$MSVC/bin/Hostx64/x64:$PATH"
export INCLUDE="C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207\\include;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.22621.0\\ucrt;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.22621.0\\um;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.22621.0\\shared"
export LIB="C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207\\lib\\x64;C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\10.0.22621.0\\ucrt\\x64;C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\10.0.22621.0\\um\\x64"

cargo build --manifest-path src-tauri/Cargo.toml

printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_stats","arguments":{}}}' \
| ./src-tauri/target/debug/app.exe mcp serve 2>/dev/null
