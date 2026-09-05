# 日志规范

应用的日志体系与排查指南。日志由 `tauri-plugin-log` 驱动，**所有构建（含 release）都启用**。

## 日志文件在哪

| 环境 | 位置 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\com.tauri.dev\logs\aprilio.log`（即 `C:\Users\<用户名>\AppData\Local\com.tauri.dev\logs\aprilio.log`） |
| macOS | `~/Library/Logs/com.tauri.dev/aprilio.log` |
| Linux | `~/.local/share/com.tauri.dev/logs/aprilio.log` |

> 目录中的 `com.tauri.dev` 来自 `src-tauri/tauri.conf.json` 的 `identifier`；文件名 `aprilio.log` 取自 `productName`。发布前若修改了这两项，日志位置会随之变化。Windows 上注意是 `Local` 而不是 `Roaming`（数据库在 Roaming，日志在 Local）。

## 日志行为

- 注册在 `src-tauri/src/lib.rs`，双写：终端（stdout）+ 文件（上表路径）
- 级别：debug 构建 = Debug 级；release 构建 = Info 级
- 文件里的时间戳是 **UTC**（tauri-plugin-log 默认行为），和本地时间差 8 小时，排查时注意换算
- 单文件超过 40KB 触发轮转（`KeepOne`：删除旧文件重新开始），**不保留历史归档**；日志只适合排查近期问题
- panic 由 `std::panic::set_hook` 捕获并写入日志，崩溃排查先看这里
- 前端权限来自 `src-tauri/capabilities/default.json` 的 `log:default`

## 已覆盖的记录点

- 后端命令（target 标签区分模块）：
  - `ai`：AI 请求开始 / 成功 / 失败（记录 provider、model、轮次、回复字符数，**不记录 API 密钥**）。
    流式路径（ai_chat_stream）同样覆盖：发起失败 / 中途失败 `error!`、成功 `info!`、
    Channel 增量推送失败 `warn!`（只放弃展示、不影响聚合结果）
  - `photos`：照片目录创建、导入 / 删除成功与失败（含源文件路径）
  - `roster`：花名册文件读取成功 / 失败（含源路径、编码、大小守卫拒绝；xlsx/xls 由
    calamine 在 Rust 端解码为矩阵，CSV/TSV 为 UTF-8/GBK 文本）；表头/姓名列识别与
    导入落库在前端完成，前端只记成功/跳过/失败计数（`[renderer]` 前缀，**不记学生姓名等隐私字段**）
  - `rag`：索引重建开始 / 完成 / 失败（含耗时、模型、条目数、维度）；
    语义搜索失败 `error!`、完成 `debug!`（只记 query 字符数，**不记 query 全文**——可能含学生姓名）
- MCP serve 模式（`aprilio mcp serve`）**不走日志文件**：该模式无 Tauri 上下文，plugin-log 未初始化，
  诊断统一 `eprintln` 到 **stderr**（MCP 客户端可见），内容带 `[aprilio-mcp]` 前缀：
  启动失败 / 会话结束 / 能力对账提示 / 工具调用成败与耗时（不记工具参数全文，避免学生隐私进客户端日志）
- 前端（`src/lib/logger.ts`，消息统一带 `[renderer]` 前缀）：
  - 劫持 `console.error` / `console.warn`：照常打印并同时落盘
  - `window.error` 与 `unhandledrejection` 全局捕获
  - Vue 组件异常：`src/main.ts` 里的 `app.config.errorHandler` 走 `console.error`，间接落盘
  - Agent 执行失败（含流式链路抛错）：`useAgent.ts` 顶层 `logError` 落盘，界面只展示友好文案

## 如何新增日志

Rust 端：

```rust
use log::{error, info};
info!(target: "ai", "AI 请求开始：provider={} model={}", provider, model);
error!(target: "photos", "导入照片失败：{e}");
```

注意：`log` 宏只支持 `{}` 格式化参数，不支持 `tracing` 的 `key = %value` 结构化写法。

前端（浏览器演示态与单测下自动失效，不报错）：

```ts
import { logDebug, logInfo, logWarn, logError } from "./lib/logger";
logError("上传失败", err); // 参数可为任意值，Error 会带 stack
```

约定：

- 新的后端模块用 `target: "<模块名>"`，与现有 `ai` / `photos` 风格一致
- 用户可见的失败路径必须 `error!`，成功的关键操作 `info!`，调试细节 `debug!`
- 永远不记录 API 密钥、学生隐私字段全文

## 排查问题的推荐流程

1. 先看日志尾部：

   ```powershell
   Get-Content $env:LOCALAPPDATA\com.tauri.dev\logs\aprilio.log -Tail 50
   ```

2. `[renderer]` 前缀 = 前端错误；`target: ai` / `target: photos` / `target: rag` = 对应后端模块；
   `[aprilio-mcp]` = MCP serve 模式的 stderr 输出（不落文件，在客户端的 server 日志里看）
3. 涉及崩溃 / 白屏时搜索 `panic`
