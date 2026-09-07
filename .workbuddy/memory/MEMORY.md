# aprilio 项目长期备忘

## 构建环境（Windows 本机，2026-09 确认）

- Rust 侧 cargo 命令需 MSVC 三件套（PATH/INCLUDE/LIB，BuildTools 14.44.35207 + WinSDK 10.0.22621.0）：
  Git Bash 的 /usr/bin/link.exe（coreutils）会遮蔽 MSVC link.exe；缺 LIB 会 LNK1181（如 OleAut32.lib）。
  环境已内置进 `scripts/test-mcp.sh`，工具集升级时同步改脚本里的版本号路径。
- rustc 1.98 incremental 编译反复 ICE → `src-tauri/.cargo/config.toml` 已关闭 incremental，勿删。
- **cargo test 不会重链 bin**：改 Rust 后测 MCP / 跑 app.exe 前必须 `cargo build`，否则测的是旧产物。

## 测试入口

- TS：`npm run typecheck && npm test`；Rust：`cargo test --manifest-path src-tauri/Cargo.toml`（27 用例基线）
- MCP 冒烟：`bash scripts/test-mcp.sh`（build + initialize/tools/list/tools/call 握手）
- **vitest 4.1.11 + Windows 小写盘符坑**（vitest#10692）：Git Bash 会话 cwd 是 `d:\...` 时全量测试必挂
  （每个文件都在首个 describe 抛 `Cannot read properties of undefined (reading 'config')`）。
  跑测试必须先 `cd D:/myspace/job/aprilio`（大写盘符）且与 `npm test` 同一条命令；
  4.x 无修复版，升 vitest 5.0.0 可根治。

## 架构要点

- 能力注册：Rust 用 inventory（`register_capability!`，链接期收集）→ 启动上报 TS 容器合并；
  MCP 工具面（mcp_server.rs）是独立第三视图，新增 Rust 只读工具要同步挂 MCP 执行体
- 日志：GUI 进程走 tauri-plugin-log（target: ai/photos/rag，见 docs/LOGGING.md）；
  MCP serve 模式无 plugin-log，诊断走 stderr（`[aprilio-mcp]` 前缀，不落文件）
- 隐私红线：日志不记 API 密钥、学生隐私字段全文、语义搜索 query 全文
