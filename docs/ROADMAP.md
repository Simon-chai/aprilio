# 路线图与选型记录

README 只描述「现在是什么」，这里记录「为什么这么选、接下来做什么」。

## AI Agent 选型（2026-09 定）

**决策：接 `genai`，手写定制 agent 循环，代码放 `src-tauri`（Rust 侧）。**

### 需求

自然语言 → 应用自己决定调用哪些数据操作（查学生 / 查照片 / 出统计 / 写备注）。
本质是 LLM 函数调用循环（tool calling loop），工具集固定且少（5~8 个）。

### 备选与结论

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| **genai + 手写循环** | ✅ 采纳 | 多提供商统一 API（OpenAI / DeepSeek / GLM / Kimi / Ollama 等），国内模型一等公民；纯积木不绑架构；工具少时重框架无增量价值 |
| Rig (`rig-core`) | 备选 | 最接近 LangChain 的 Rust 框架（8.5k star，活跃，近 90 天下载 142 万）；日后要 RAG / 本地模型（内置 Candle，可跑 Qwen3）时再迁 |
| Swiftide | 参考 | agent harness + human-in-the-loop 模式值得借鉴；支持 Dashscope；v0.32 后更新节奏偏慢 |
| langchain-rust | ❌ 否决 | 2024-10 起停更 |
| Python sidecar | ❌ 暂否决 | 安装包 +80~200MB、PyInstaller 杀软误报、双语言栈维护；仅当必须用 Python 独有库（特定 OCR / 自研 Python 模型）时重启评估 |
| rmcp | 按需 | MCP 官方 Rust SDK；若要接入外部 MCP 工具生态再加 |
| TS 前端直连 API | 仅原型 | API Key 暴露在 WebView，只用于第 1 步验证交互形态 |

活跃度数据（2026-09 查证）：genai 近 90 天下载 12.2 万，v0.7.0-beta 持续维护中。

### 约束

- 学生隐私数据本地优先：优先 Ollama 本地模型；走云 API 时只传脱敏摘要
- API Key 存系统钥匙串，不进 WebView
- 不引入 Python 运行时，安装包体积保持 ~10MB 量级

## 待办

### 第 0 步 · 修复 src-tauri 契约（前置，约半天）

- [x] `Cargo.toml`：补 `tauri-plugin-sql` / `dialog` / `fs` / `opener` 依赖
- [x] `lib.rs`：注册插件 + 迁移（students / photos / profile）+ 恢复 `photos_dir` / `import_photo` / `delete_photo_file` 命令
- [x] `capabilities/default.json`：补 `sql:allow-execute`、`sql:allow-load`、`sql:allow-select`、`dialog:default` 等权限
- [x] `npm test` 转绿（`tauri-capability.test.ts`）
- [x] 清理 `db.ts` / `StudentsView.vue` / `profile.ts` 里的 TEMP-DEBUG `dbg()` 代码

### 第 1 步 · AI 原型（1~2 天）

- [ ] `src/lib/ai.ts`：TS 层直连云端 API（fetch + SSE）
- [ ] 新增 AIAssistant 视图（对话式 UI，风格沿用设计系统）
- [ ] 首个场景：自然语言查学生，逐步替换 StudentsView 的 LIKE 搜索框

### 第 2 步 · Agent 框架落地（2026-09 完成）

实际落地与原计划有两处偏差（决策详见 [AGENT.md](AGENT.md)）：

1. genai 只做协议转换（工具定义透传 + tool_calls 返回），**tool-calling 循环放 TS 侧**
   —— 工具执行体（vue-router 跳转、db 查询、文档检索）都在前端，循环贴近工具零 IPC 成本，
   且 vitest 用 mock provider 可全链路测试。
2. 数据层不在 Rust 重包一遍，工具直接复用 `src/lib/db.ts`（浏览器演示态走内存数据）。

- [x] `Cargo.toml`：`genai`（tokio 随 tauri 已有）
- [x] `src-tauri/src/ai.rs`：tool-calling 协议转换（消息协议 + 工具定义透传 + tool_calls 返回）
- [x] `src/agent/`：循环 + 工具注册表 + system prompt（TS 侧）
- [x] 首期三工具：`navigate`（页面跳转）/ `query_data`（数据查询）/ `find_docs`（文档检索）
- [x] 全局聊天浮层 `AgentChat`（App.vue 挂载，替换原首页 HomeChatBox）
- [x] 浏览器演示态规则 mock，不联网走通全链路
- [ ] `tauri::ipc::Channel` 流式推送 token 到前端
- [ ] 云 API 场景的数据脱敏开关（工具结果含监护人电话等字段，见 AGENT.md 隐私节）
- [ ] 细粒度 UI 动作（页面按钮操作）：页面动作注册表 + `ui_action` 工具

### 以后再说

- [ ] Ollama 本地模型（完全离线模式）
- [ ] 照片语义搜索（RAG + 向量化 → 届时评估迁 Rig + Candle）
- [ ] 接 MCP 工具生态（rmcp）